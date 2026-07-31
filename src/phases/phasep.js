// src/phases/phaseP.js

import { hubspotClient } from '../hubspotClient.js';
import { getEffectiveBillingConfig, snapEndOfMonth } from '../billingEngine.js';
import { parseLocalDate, formatDateISO, addInterval } from '../utils/dateUtils.js';
import { parseBool } from '../utils/parsers.js';
import { buildTicketKeyFromLineItemKey } from '../utils/ticketKey.js';
import { updateTicket } from '../services/tickets/ticketService.js';
import { buildTicketFullProps } from '../services/tickets/ticketService.js';
import { safeCreateTicket } from '../services/tickets/ticketService.js';
import logger from '../../lib/logger.js';
import { withRetry } from '../utils/withRetry.js';
import { reportIfActionable } from '../utils/errorReporting.js';
import { reportHubSpotWarn } from '../utils/hubspotErrorCollector.js';
import { syncBillingNextDateFromTickets } from '../services/billing/syncBillingNextDateFromTickets.js';
import { notifyMirrorDealOnPauseChange } from '../services/mirrorUtils.js';
import { createLineItemWriteBuffer } from '../services/lineItems/lineItemWriteBuffer.js';
import {
  buildMansoftSnapshot,
  parseMansoftSnapshot,
  diffMansoftSnapshots,
  hasPreviousSnapshot,
} from '../services/billing/mansoftSnapshot.js';
import {
  AUTOMATED_TICKET_PIPELINE,
  BILLING_TICKET_FORECAST,
  BILLING_TICKET_FORECAST_50,
  BILLING_TICKET_FORECAST_75,
  BILLING_TICKET_FORECAST_85,
  BILLING_TICKET_FORECAST_95,
  BILLING_AUTOMATED_FORECAST,
  BILLING_AUTOMATED_FORECAST_50,
  BILLING_AUTOMATED_FORECAST_75,
  BILLING_AUTOMATED_FORECAST_85,
  BILLING_AUTOMATED_FORECAST_95,
  BILLING_AUTOMATED_READY,
  TICKET_PIPELINE,
  FORECAST_TICKET_STAGES,
  DEAL_STAGE_EN_EJECUCION,
  DEAL_STAGE_FINALIZADO,
  TICKET_STAGES,
  BILLING_AUTOMATED_CANCELLED,
  PROXIMOS_A_FACTURAR_STAGE,
  CANCELLED_STAGE_BY_PIPELINE,
} from '../config/constants.js';
import { etapaUnicaEnabled } from '../config/etapaUnicaFlags.js';
import {
  isTicketEngineManaged,
  isTicketProtegido,
  hasTicketCrossedFrontier,
  esTicketManual,
  fechaDelTicket,
} from '../utils/ticketFrontera.js';
import { notifyTicketsCancelledByEngine } from '../services/notifications/ticketCancelledByEngineAlert.js';

const BILLING_TZ = 'America/Montevideo';

// ==============================
// Forecast stages — leídos desde constants.js (vía process.env)
// ==============================
const STAGE = {
  MANUAL_FORECAST_25: BILLING_TICKET_FORECAST,
  MANUAL_FORECAST_50: BILLING_TICKET_FORECAST_50,
  MANUAL_FORECAST_75: BILLING_TICKET_FORECAST_75,
  MANUAL_FORECAST_85: BILLING_TICKET_FORECAST_85,
  MANUAL_FORECAST_95: BILLING_TICKET_FORECAST_95,
  AUTO_FORECAST_25:   BILLING_AUTOMATED_FORECAST,
  AUTO_FORECAST_50:   BILLING_AUTOMATED_FORECAST_50,
  AUTO_FORECAST_75:   BILLING_AUTOMATED_FORECAST_75,
  AUTO_FORECAST_85:   BILLING_AUTOMATED_FORECAST_85,
  AUTO_FORECAST_95:   BILLING_AUTOMATED_FORECAST_95,
};


function isMirrorLineItem(p = {}) {
  return String(p.of_line_item_py_origen_id || '').trim().length > 0;
}

/**
 * Decide si un cambio de pausa en un LI debe avisarse al mirror UY, y en qué
 * dirección. Función pura (no toca HubSpot) — testeable de forma aislada.
 *
 * Avisa solo si TODAS se cumplen:
 *   - facturación automática
 *   - es un LI PY (no espejo)
 *   - tiene uy=true (línea operada en UY)
 *   - la prop 'pausa' realmente cambió de estado (no un re-aviso del mismo estado)
 *
 * @param {Object} li  line item con .properties
 * @param {Object|undefined} pausaDiff  diff de la prop 'pausa' ({ before, after }) o undefined
 * @returns {{ paused: boolean } | null}  null si no corresponde avisar
 */
export function shouldNotifyMirrorOnPauseChange(li, pausaDiff) {
  const p = li?.properties || {};
  if (!pausaDiff) return null;
  if (!isAutomatedBilling(li)) return null;
  if (isMirrorLineItem(p)) return null;
  if (!parseBool(p.uy)) return null;

  const ahoraPausado = parseBool(pausaDiff.after) === true;
  const antesPausado = parseBool(pausaDiff.before) === true;
  if (ahoraPausado === antesPausado) return null;

  return { paused: ahoraPausado };
}

function isMantsoftAltaStage(dealStage) {
  const bucket = resolveBucketFromDealStage(dealStage);
  return bucket === '85' || bucket === '95' || bucket === '100';
}

function shouldMarkMantsoftAlta({ li, automated, dealStage, desiredCount }) {
  const p = li?.properties || {};
  const currentTipo = String(p.mansoft_tipo_aviso || '').trim().toLowerCase();

  if (!automated) return false;
  if (isMirrorLineItem(p)) return false;
  if (!isMantsoftAltaStage(dealStage)) return false;
  if (desiredCount <= 0) return false;

  // Si ya fue notificado alguna vez, no es alta.
  if (hasPreviousSnapshot(li)) return false;

  // No pisar baja ni pendiente ya existente.
  if (currentTipo === 'baja') return false;
  if (parseBool(p.mansoft_pendiente)) return false;

  return true;
}
// Unión de stages forecast manuales + automáticos

function nowMontevideoYmd() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: BILLING_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function toYmd(value) {
  return (value || '').toString().slice(0, 10);
}

function safeInt(v) {
  const n = Number.parseInt(String(v ?? '').trim(), 10);
  return Number.isFinite(n) ? n : null;
}

// ==============================
// DEAL-LEVEL CLEANUP (orphan forecast)
// ==============================

function parseLikFromTicketKey(ticketKey) {
  const k = String(ticketKey || '').trim();
  if (!k) return '';
  const marker = '::LIK:';
  const i = k.indexOf(marker);
  if (i === -1) return '';
  const rest = k.slice(i + marker.length);
  const j = rest.indexOf('::');
  if (j === -1) return '';
  return rest.slice(0, j).trim();
}

async function cleanupOrphanForecastTicketsForDeal({ dealId, validLiks, deal = null }) {
  const body = {
    filterGroups: [
      {
        filters: [
          { propertyName: 'of_deal_id', operator: 'EQ', value: String(dealId) },
        ],
      },
    ],
    properties: [
      'hs_pipeline_stage',
      'of_ticket_key',
      'hs_pipeline',
      // Bajo la flag hacen falta para decidir y para avisar: of_invoice_id
      // separa el cancelado-con-período-cerrado del cancelado por el motor.
      'of_invoice_id',
      'fecha_resolucion_esperada',
      'hubspot_owner_id',
    ],
    limit: 100,
  };

  const resp = await withRetry(
    () => hubspotClient.crm.tickets.searchApi.doSearch(body),
    { module: 'phaseP', fn: 'cleanupOrphanForecastTicketsForDeal', dealId }
  );
  const allTickets = resp?.results || [];
  const forecastTickets = allTickets.filter(isManagedTicket);

  let orphanDeleted = 0;
  const orphanCancelados = [];

  for (const t of forecastTickets) {
    try {
      const ticketId = t.id;
      const ticketKey = String(t?.properties?.of_ticket_key || '').trim();
      if (!ticketKey) continue;

      const lik = parseLikFromTicketKey(ticketKey);
      if (!lik) continue;

      if (!validLiks.has(lik)) {
        const r = await retirarTicket(t, {
          motivo: 'El elemento de pedido ya no existe en el negocio — cronograma rearmado por el motor',
          dealId,
          contexto: 'orphan_lik',
        });
        if (!r.retirado) continue;
        orphanDeleted++;
        if (r.cancelado) {
          orphanCancelados.push({
            ticketId: String(ticketId),
            fecha: fechaDelTicket(t) || null,
            ownerId: t?.properties?.hubspot_owner_id || null,
          });
        }
        logger.info(
          { module: 'phaseP', fn: 'cleanupOrphanForecastTicketsForDeal', dealId, ticketId, ticketKey, cancelado: r.cancelado },
          r.cancelado ? 'Orphan ticket CANCELADO (el motor no borra)' : 'Orphan forecast ticket eliminado'
        );
      }
    } catch (err) {
      logger.error({ module: 'phaseP', fn: 'cleanupOrphanForecastTicketsForDeal', dealId, ticketId: t?.id, err }, 'unit_failed');
    }
  }

  // Aviso único por negocio (§2.4). Nunca bloquea la limpieza.
  if (orphanCancelados.length) {
    try {
      await notifyTicketsCancelledByEngine({
        dealId,
        dealName: deal?.properties?.dealname || null,
        dealOwnerId: deal?.properties?.hubspot_owner_id || null,
        cancelados: orphanCancelados,
        motivo: 'El elemento de pedido al que pertenecían ya no está en el negocio',
      });
    } catch (err) {
      logger.warn(
        { module: 'phaseP', fn: 'cleanupOrphanForecastTicketsForDeal', dealId, err },
        'Aviso de huérfanos cancelados falló (no bloquea)'
      );
    }
  }
// Cleanup: tickets sin of_ticket_key en pipelines de facturación
  const BILLING_PIPELINES = new Set([TICKET_PIPELINE, AUTOMATED_TICKET_PIPELINE].filter(Boolean));

  for (const t of allTickets) {
    const tk = String(t?.properties?.of_ticket_key || '').trim();
    if (tk) continue;

    const pipeline = String(t?.properties?.hs_pipeline || '').trim();
    if (!BILLING_PIPELINES.has(pipeline)) continue;

    // Bajo la flag, un ticket ya CANCELADO (o notificado en adelante) sin key no
    // se toca: sólo se limpia lo que el motor maneja.
    if (etapaUnicaEnabled() && !isManagedTicket(t)) continue;

    try {
      const r = await retirarTicket(t, {
        motivo: 'Ticket sin clave de facturación en un pipeline del motor',
        dealId,
        contexto: 'sin_of_ticket_key',
      });
      if (!r.retirado) continue;
      orphanDeleted++;
      logger.info(
        { module: 'phaseP', fn: 'cleanupOrphanForecastTicketsForDeal', dealId, ticketId: t.id, pipeline, cancelado: r.cancelado },
        r.cancelado
          ? 'Ticket sin of_ticket_key CANCELADO (el motor no borra)'
          : 'Ticket sin of_ticket_key en pipeline de facturación eliminado'
      );
    } catch (err) {
      logger.warn(
        { module: 'phaseP', fn: 'cleanupOrphanForecastTicketsForDeal', dealId, ticketId: t.id, err },
        'Error retirando ticket sin key'
      );
    }
  }
  logger.info(
    { module: 'phaseP', fn: 'cleanupOrphanForecastTicketsForDeal', dealId, forecastTotal: forecastTickets.length, orphanDeleted },
    'Cleanup de orphans completado'
  );
}


function isAutomatedBilling(lineItem) {
  const p = lineItem?.properties || {};
  const raw =
    p.facturacion_automatica ??
    p.billing_automatico ??
    p.facturacion_automatica__c ??
    p.of_facturacion_automatica ??
    '';

  const v = String(raw).trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'si' || v === 'sí' || v === 'yes';
}

function resolveBucketFromDealStage(dealStage) {
  const s = String(dealStage || '');
  if (s === 'appointmentscheduled') return '25';
  if (s === 'qualifiedtobuy') return '25';
  if (s === 'presentationscheduled') return '25';
  if (s === 'decisionmakerboughtin') return '50';
  if (s === 'contractsent') return '75';
  if (s === 'closedwon') return '85';
  if (s === DEAL_STAGE_EN_EJECUCION) return '95';
  if (s === DEAL_STAGE_FINALIZADO) return '100';

  return null;
}

export function resolveForecastStage({ dealStage, automated }) {
  const bucket = resolveBucketFromDealStage(dealStage);
  if (!bucket) return null;

  if (!automated) {
    // ETAPA ÚNICA (flag ON): del cierre ganado en adelante hay UNA sola etapa
    // manual antes de «Notificado» — «Próximos a facturar». Los buckets 85/95/100
    // dejan de tener etapa forecast propia (en PROD «Backlog cierre ganado» y
    // «Backlog avanzado»): el ticket NACE en la etapa única. Los ids viejos
    // siguen reconocidos como "no notificado" (constants.js) para poder
    // reubicar los tickets que quedaron parados ahí.
    const unificado = etapaUnicaEnabled() && Boolean(PROXIMOS_A_FACTURAR_STAGE);
    if (bucket === '50') return STAGE.MANUAL_FORECAST_50;
    if (bucket === '75') return STAGE.MANUAL_FORECAST_75;
    if (bucket === '85') return unificado ? PROXIMOS_A_FACTURAR_STAGE : STAGE.MANUAL_FORECAST_85;
    if (bucket === '95') return unificado ? PROXIMOS_A_FACTURAR_STAGE : STAGE.MANUAL_FORECAST_95;
    if (bucket === '100') return unificado ? PROXIMOS_A_FACTURAR_STAGE : STAGE.MANUAL_FORECAST_95; // 100% usa mismo stage que 95
    return STAGE.MANUAL_FORECAST_25;
  }

  if (bucket === '50') return STAGE.AUTO_FORECAST_50;
  if (bucket === '75') return STAGE.AUTO_FORECAST_75;
  if (bucket === '85') return STAGE.AUTO_FORECAST_85;
  if (bucket === '95') return STAGE.AUTO_FORECAST_95;
  if (bucket === '100') return STAGE.AUTO_FORECAST_95; // 100% usa mismo stage que 95
  return STAGE.AUTO_FORECAST_25;
}

// ── Aviso al vendedor: facturación próxima/vencida en negocio no ganado ─────
// Escribe billing_error en el deal (vía collector, con billing_error_at para
// que el workflow de HubSpot notifique al vendedor) cuando un line item tiene
// una fecha de facturación a ≤ N días, o ya vencida, y el negocio todavía no
// está en Cierre ganado (buckets 25/50/75).
const DIAS_AVISO_FACTURACION_NO_GANADO =
  Number(process.env.DIAS_AVISO_FACTURACION_NO_GANADO || 10);

const BUCKETS_GANADO = new Set(['85', '95', '100']);

function diffDias(desdeYmd, hastaYmd) {
  return Math.round((Date.parse(hastaYmd) - Date.parse(desdeYmd)) / 86400000);
}

export function warnFacturacionDealNoGanado({ deal, dealId, dealStage, li, dates, todayYmd, report = reportHubSpotWarn }) {
  try {
    const bucket = resolveBucketFromDealStage(dealStage);
    if (!bucket || BUCKETS_GANADO.has(bucket)) return null;

    const p = li?.properties || {};
    if (parseBool(p.pausa)) return null;

    const vencidas = (dates || []).filter(d => d <= todayYmd);
    const proximas = (dates || []).filter(
      d => d > todayYmd && diffDias(todayYmd, d) <= DIAS_AVISO_FACTURACION_NO_GANADO
    );
    if (!vencidas.length && !proximas.length) return null;

    const dealName = deal?.properties?.dealname || `deal ${dealId}`;
    const liName = p.name || `LI ${li.id}`;

    const msg = vencidas.length
      ? `La fecha de facturación ${vencidas[0]} del elemento de pedido "${liName}" (${li.id}) ya llegó y el negocio "${dealName}" no está en Cierre ganado. No se facturará hasta ganar el negocio y activar la facturación.`
      : `El elemento de pedido "${liName}" (${li.id}) factura el ${proximas[0]} (en ${diffDias(todayYmd, proximas[0])} día(s)) y el negocio "${dealName}" no está en Cierre ganado. Ganar el negocio y activar la facturación antes de esa fecha.`;

    report({ objectType: 'deal', objectId: String(dealId), message: msg });

    logger.warn(
      { module: 'phaseP', fn: 'warnFacturacionDealNoGanado', dealId, lineItemId: li?.id, dealStage, vencidas: vencidas.length, proximas: proximas.length },
      'Facturación próxima/vencida en negocio no ganado — aviso en billing_error del deal'
    );
    return msg;
  } catch (err) {
    logger.warn(
      { module: 'phaseP', fn: 'warnFacturacionDealNoGanado', dealId, lineItemId: li?.id, err },
      'Error en aviso de facturación no ganado — no bloquea'
    );
    return null;
  }
}

/**
 * EL PISO del cronograma (plan fijo).
 *
 * Hoy sale de `last_ticketed_date`, que recalcFromTickets deriva de
 * PROMOTED_STAGES — un set que INCLUYE «Próximos a facturar». Con la etapa
 * única eso es fatal: el ticket próximo a facturar levanta el piso por encima
 * de su propia fecha, esa fecha no entra en desiredKeys y el paso 7 lo borra
 * (hallazgo rojo #1 del plan, §2.3).
 *
 * Bajo ETAPA_UNICA_ENABLED el piso pasa a ser LA ÚLTIMA FECHA QUE CRUZÓ LA
 * FRONTERA (notificada o posterior, o período cerrado), derivada de los tickets
 * reales — no de la prop. Las tres fechas nuevas son TANDA C; acá no se tocan.
 *
 * Red de seguridad: si la búsqueda de tickets vino vacía (lag del Search API,
 * error absorbido) pero el line item tiene historial en `last_ticketed_date`,
 * se usa la prop. Sin eso, un search vacío regeneraría el cronograma desde el
 * arranque del contrato.
 *
 * Flag apagada ⇒ devuelve `last_ticketed_date`, igual que siempre.
 *
 * @returns {string} YYYY-MM-DD o '' si no hay piso
 */
export function resolveFloorSourceYmd(lineItemProps = {}, allTickets = []) {
  const lastTicketedYmd = toYmd(lineItemProps?.last_ticketed_date);
  if (!etapaUnicaEnabled()) return lastTicketedYmd;

  const tickets = allTickets || [];
  if (!tickets.length) return lastTicketedYmd;

  let ultimaCruzada = '';
  for (const t of tickets) {
    if (!hasTicketCrossedFrontier(t)) continue;
    const ymd = fechaDelTicket(t);
    if (ymd && ymd > ultimaCruzada) ultimaCruzada = ymd;
  }
  return ultimaCruzada;
}

/**
 * Construye fechas deseadas según contrato.
 */
export function buildDesiredDates(lineItem, allTickets = [], { overrideToday } = {}) {  const p = lineItem?.properties || {};
  const cfg = getEffectiveBillingConfig(lineItem);

  const startYmd =
    toYmd(p.hs_recurring_billing_start_date) ||
    (cfg?.startDate ? formatDateISO(cfg.startDate) : '') ||
    toYmd(p.recurringbillingstartdate) ||
    toYmd(p.fecha_inicio_de_facturacion) ||
    '';

  if (!startYmd) return { desiredCount: 0, dates: [] };

  const hasFreqProps =
    String(p.recurringbillingfrequency ?? p.hs_recurring_billing_frequency ?? '').trim() !== '';

  if (!hasFreqProps) {
    return { desiredCount: 1, dates: [startYmd] };
  }

  const interval = cfg?.interval ?? null;

  if (!interval) {
    logger.warn(
      {
        module: 'phaseP',
        fn: 'buildDesiredDates',
        lineItemId: lineItem?.id,
        lik: p.line_item_key || p.of_line_item_key || '',
        recurringbillingfrequency: p.recurringbillingfrequency,
        hs_recurring_billing_frequency: p.hs_recurring_billing_frequency,
        hs_recurring_billing_number_of_payments: p.hs_recurring_billing_number_of_payments,
      },
      'Tiene frecuencia pero interval es null, fallback a 1 fecha'
    );
    return { desiredCount: 1, dates: [startYmd] };
  }

  // fin_de_mes: la regla del último día hábil vive en billingEngine; acá la aplicamos
  // también al planificar fechas, si no Phase P generaría la factura en el día del ancla
  // (~2 semanas antes) todos los meses. Iteramos la fecha CRUDA (addInterval preserva el
  // mes) y snapeamos solo al comparar/emitir — igual que computeNextFromInterval.
  const endOfMonth = cfg?.isEndOfMonth === true;
  const emitYmd = (dd) => formatDateISO(snapEndOfMonth(dd, interval, endOfMonth));

  const termRaw = p.hs_recurring_billing_number_of_payments ?? p.number_of_payments ?? null;
  const term = safeInt(termRaw);

const isAutoRenew =
  cfg?.isAutoRenew === true ||
  cfg?.autorenew === true ||
  String(p.renovacion_automatica || '').toLowerCase() === 'true' ||
  !(term > 0);

  // Plan fijo con todos los tickets ya promovidos → early return
  if (!isAutoRenew && safeInt(p.pagos_restantes) === 0) {
    logger.debug(
      { module: 'phaseP', fn: 'buildDesiredDates', lineItemId: lineItem?.id, pagos_restantes: 0 },
      '[buildDesiredDates] PLAN_FIJO: pagos_restantes=0, early return'
    );
    return { desiredCount: 0, dates: [] };
  }

  const hardMax = 24;

  // CAMBIO: descontar pagos ya emitidos para plan fijo
  //
  // ETAPA ÚNICA (flag ON) — CONSUMIDO ES LO QUE CRUZÓ LA FRONTERA.
  // Hoy se cuenta "todo lo que no es forecast", y con la etapa única el ticket
  // en «Próximos a facturar» dejaría de descontarse ⇒ un plan de 12 termina en
  // 13 (hallazgo rojo #2 del plan, §2.3). Pasa a contar lo NOTIFICADO o
  // posterior, más los períodos cerrados por cancelación definitiva de factura
  // (esos no se refacturan: consumieron su cuota igual).
  let maxCount;
  if (!isAutoRenew && term > 0) {
    const yaCruzo = etapaUnicaEnabled()
      ? (t) => hasTicketCrossedFrontier(t)
      : (t) => !isManagedTicket(t);
    const consumidos = allTickets.filter(
      t => yaCruzo(t) && String(t?.properties?.of_ticket_key || '').trim()
    ).length;
    maxCount = Math.min(Math.max(0, term - consumidos), hardMax);
  } else {
    maxCount = hardMax;
  }
if (maxCount === 0) return { desiredCount: 0, dates: [] };

  const todayYmd = overrideToday || nowMontevideoYmd();
  const lastTicketedYmd = resolveFloorSourceYmd(p, allTickets);
  const billingNextYmd = toYmd(p.billing_next_date);
  const anchorYmd = toYmd(p.billing_anchor_date);

// ── AUTO RENEW ──────────────────────────────────────────
  if (isAutoRenew) {
  const currentYear = overrideToday
    ? Number.parseInt(overrideToday.slice(0, 4), 10)
    : new Date(
        new Intl.DateTimeFormat('en-CA', {
          timeZone: BILLING_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
        }).format(new Date())
      ).getFullYear();
    const windowStart = `${currentYear - 1}-01-01`;
    const windowEnd   = `${currentYear + 1}-12-31`;
    const todayYmdLocal = overrideToday || nowMontevideoYmd();

    const seriesOrigin = parseLocalDate(anchorYmd || startYmd);
    if (!seriesOrigin) return { desiredCount: 0, dates: [] };

    // Generar todas las fechas dentro de la ventana
    const pastDates = [];
    const futureDates = [];
    let d = new Date(seriesOrigin.getTime());
    let safety = 0;

    while (safety < 1200) {
      safety++;
      if (!d || !Number.isFinite(d.getTime())) break;
      const ymd = emitYmd(d);

      if (ymd > windowEnd) break;

      if (ymd >= windowStart) {
        if (ymd < todayYmdLocal) {
          pastDates.push(ymd);
        } else {
          futureDates.push(ymd);
        }
      }

      const next = addInterval(d, interval);
      if (!next || !Number.isFinite(next.getTime())) break;
      if (next.getTime() === d.getTime()) break;
      d = next;
    }

    // Recortar cada sección a max 24
    const maxPerSection = 24;
    const trimmedPast = pastDates.slice(-maxPerSection);   // últimos 24 del pasado
    const trimmedFuture = futureDates.slice(0, maxPerSection); // primeros 24 del futuro

    const dates = [...trimmedPast, ...trimmedFuture];

    logger.debug(
      {
        module: 'phaseP',
        fn: 'buildDesiredDates',
        windowStart,
        windowEnd,
        seriesOrigin: formatDateISO(seriesOrigin),
        pastCount: trimmedPast.length,
        futureCount: trimmedFuture.length,
        total: dates.length,
        first: dates[0] || null,
        last: dates[dates.length - 1] || null,
      },
      '[buildDesiredDates] AUTO_RENEW: ventana fija con split pasado/futuro'
    );

    return { desiredCount: dates.length, dates };
  }

  // ── PLAN FIJO ───────────────────────────────────────────
  // floorYmd = max(todayYmd, lastTicketedYmd + 1 día)
// anchor manual = existe Y es distinto de startDate
const anchorEsManual = anchorYmd && anchorYmd !== startYmd;

let floorYmd;
if (anchorEsManual) {
  // anchor puesto a mano → respetar hoy como piso
  floorYmd = todayYmd;
  if (lastTicketedYmd) {
    const d0 = parseLocalDate(lastTicketedYmd);
    if (d0 && Number.isFinite(d0.getTime())) {
      d0.setDate(d0.getDate() + 1);
      const plusOne = formatDateISO(d0);
      if (plusOne > floorYmd) floorYmd = plusOne;
    }
  }
} else {
  // sin anchor manual → piso es lastTicketed+1, o startDate si no hay historial
  floorYmd = lastTicketedYmd
    ? (() => {
        const d0 = parseLocalDate(lastTicketedYmd);
        d0.setDate(d0.getDate() + 1);
        return formatDateISO(d0);
      })()
    : startYmd;
}

const seriesStartYmd = anchorYmd || startYmd;
const startDate = parseLocalDate(seriesStartYmd);
if (!startDate) return { desiredCount: 0, dates: [] };

// Avanzar por la serie hasta encontrar primera fecha >= floorYmd
let d = new Date(startDate.getTime());
let safety = 0;
while (emitYmd(d) < floorYmd) {
  const next = addInterval(d, interval);
  if (!next || !Number.isFinite(next.getTime())) break;
  if (next.getTime() === d.getTime()) break;
  d = next;
  if (++safety > 1200) break;
}


  // Desde la primera fecha válida, generar exactamente maxCount fechas
  const dates = [];
  while (dates.length < maxCount) {
    if (!d || !Number.isFinite(d.getTime())) break;
    const ymd = emitYmd(d);
    dates.push(ymd);
    const next = addInterval(d, interval);
    if (!next || !Number.isFinite(next.getTime())) break;
    if (next.getTime() === d.getTime()) break;
    d = next;
  }

  logger.debug(
    {
      module: 'phaseP',
      fn: 'buildDesiredDates',
      todayYmd,
      lastTicketedYmd,
      floorYmd,
      firstValidYmd: dates[0] ?? null,
      maxCount,
      afterFilter: dates.length,
      seriesStartYmd,
    },
    '[buildDesiredDates] PLAN_FIJO: fechas generadas'
  );

  return { desiredCount: dates.length, dates };
}

/**
 * Trae TODOS los tickets del LIK (forecast + reales).
 */
async function findTicketsByLineItemKey(lineItemKey) {
  if (!lineItemKey) return [];

  const body = {
    filterGroups: [
      {
        filters: [
          { propertyName: 'of_line_item_key', operator: 'EQ', value: String(lineItemKey) },
        ],
      },
    ],
    properties: [
      'hs_pipeline',
      'hs_pipeline_stage',
      'fecha_resolucion_esperada',
      'of_line_item_key',
      'of_deal_id',
      'of_ticket_key',
      'subject',
      'of_snapshot_source_modified',
      // of_invoice_id: separa el ticket CANCELADO con período cerrado (protege
      // su fecha, cuenta como consumido) del que canceló el motor (no protege).
      'of_invoice_id',
      // hubspot_owner_id: responsable a avisar cuando el motor cancela (§2.4).
      'hubspot_owner_id',
    ],
    limit: 100,
  };

  const resp = await withRetry(
    () => hubspotClient.crm.tickets.searchApi.doSearch(body),
    { module: 'phaseP', fn: 'findTicketsByLineItemKey', lineItemKey }
  );
  return resp?.results || [];
}

/**
 * ¿El motor manda sobre la ESTRUCTURA de este ticket (existe / en qué fecha)?
 *
 * Flag apagada: exactamente los stages FORECAST — el comportamiento de siempre.
 * Flag prendida: además «Próximos a facturar», que pasa a ser la etapa única
 * del tramo no notificado (ver config/constants.js, sección de la frontera).
 *
 * El predicado vive en utils/ticketFrontera.js (una sola definición de la
 * frontera para Phase P, cancelForecastTickets y el sync quirúrgico).
 */
function isManagedTicket(ticket) {
  return isTicketEngineManaged(ticket);
}

/**
 * ¿Este ticket PROTEGE su clave (el upsert no crea otro para esa fecha)?
 *
 * Flag apagada: todo lo que no es forecast protege — incluidos los CANCELADO
 * (comportamiento de hoy, textual).
 * Flag prendida: un ticket cancelado SIN factura detrás (lo canceló el motor o
 * la pérdida del negocio) deja de proteger, para que esa fecha se pueda volver
 * a armar más adelante (§2.4). El cancelado CON factura (período cerrado)
 * sigue protegiendo.
 */
function protegeSuClave(ticket) {
  return etapaUnicaEnabled() ? isTicketProtegido(ticket) : !isManagedTicket(ticket);
}

function getTicketKeyOrDerive({ ticket, dealId, lineItemKey }) {
  const k = String(ticket?.properties?.of_ticket_key || '').trim();
  if (k) return k;
  const ymd = toYmd(ticket?.properties?.fecha_resolucion_esperada);
  if (!ymd) return '';
  return buildTicketKeyFromLineItemKey(dealId, lineItemKey, ymd);
}

async function deleteTicket(ticketId) {
  return hubspotClient.crm.tickets.basicApi.archive(String(ticketId));
}

/**
 * REGLA PURA — cómo se retira un ticket que le sobra al motor (PLAN §2.4).
 *
 * Flag apagada  → 'archivar'  (comportamiento de siempre).
 * Flag prendida → 'cancelar'  a la etapa CANCELADO de su pipeline.
 * Sin etapa CANCELADO conocida para ese pipeline → 'omitir': ante la duda no se
 * pierde el ticket. Un ticket migrado o promovido a mano que desaparece no se
 * nota hasta el mes siguiente.
 *
 * @returns {{modo:'archivar'|'cancelar'|'omitir', cancelledStage?:string}}
 */
export function resolveRetiroDeTicket(ticket) {
  if (!etapaUnicaEnabled()) return { modo: 'archivar' };

  const pipeline = String(ticket?.properties?.hs_pipeline || '');
  const cancelledStage = CANCELLED_STAGE_BY_PIPELINE[pipeline];
  if (!cancelledStage) return { modo: 'omitir' };

  return { modo: 'cancelar', cancelledStage: String(cancelledStage) };
}

/**
 * REGLA PURA — ¿el contenido de este ticket lo maneja el sync quirúrgico y no
 * el re-snapshot masivo? (PLAN §2.2: el motor manda sobre la ESTRUCTURA).
 * Sólo tickets MANUALES no notificados, y sólo bajo la flag.
 */
export function debeOmitirResnapshot(ticket) {
  return etapaUnicaEnabled() && esTicketManual(ticket) && isTicketEngineManaged(ticket);
}

/**
 * REGLA PURA — ¿hay que dejarle la etapa como está aunque no coincida con la
 * que le tocaría por el bucket del negocio? Sí cuando ya está en «Próximos a
 * facturar»: la etapa no retrocede (migrados, espejo UY, promoción a mano).
 */
export function debeConservarEtapa(ticket) {
  if (!etapaUnicaEnabled() || !PROXIMOS_A_FACTURAR_STAGE) return false;
  return String(ticket?.properties?.hs_pipeline_stage || '') === String(PROXIMOS_A_FACTURAR_STAGE);
}

/**
 * EL MOTOR NO BORRA (PLAN §2.4). Aplica resolveRetiroDeTicket.
 *
 * @returns {Promise<{retirado:boolean, cancelado:boolean}>}
 */
async function retirarTicket(ticket, { motivo, dealId = null, lineItemId = null, contexto = '' }) {
  const ticketId = ticket?.id;
  const { modo, cancelledStage } = resolveRetiroDeTicket(ticket);
  const pipeline = String(ticket?.properties?.hs_pipeline || '');

  if (modo === 'archivar') {
    await deleteTicket(ticketId);
    return { retirado: true, cancelado: false };
  }

  if (modo === 'omitir') {
    logger.warn(
      { module: 'phaseP', fn: 'retirarTicket', dealId, lineItemId, ticketId, pipeline, contexto },
      'Pipeline sin etapa CANCELADO conocida: el ticket sobrante NO se toca (el motor no borra)'
    );
    return { retirado: false, cancelado: false };
  }

  await updateTicket(ticketId, {
    hs_pipeline_stage: String(cancelledStage),
    motivo_cancelacion_del_ticket: motivo,
  });

  logger.info(
    { module: 'phaseP', fn: 'retirarTicket', dealId, lineItemId, ticketId, pipeline, cancelledStage, contexto },
    'Ticket sobrante CANCELADO por el motor (no archivado)'
  );
  return { retirado: true, cancelado: true };
}

async function updateLineItemLastGeneratedAt(lineItemId) {
  const ymd = nowMontevideoYmd();
  try {
    await hubspotClient.crm.lineItems.basicApi.update(String(lineItemId), {
      properties: { forecast_last_generated_at: ymd },
    });
  } catch (err) {
    reportIfActionable({ objectType: 'line_item', objectId: String(lineItemId), message: 'Error actualizando forecast_last_generated_at', err });
    throw err;
  }
}

/**
 * Phase P (por deal)
 */
export async function runPhaseP({ deal, lineItems, writeBuffer = null }) {
  const dealId = deal?.id || deal?.objectId || deal?.properties?.hs_object_id;
  const dealStage = deal?.properties?.dealstage || '';
  const dealFacturacionActiva = parseBool(deal?.properties?.facturacion_activa);

  // Buffer de escrituras de LIs (solo avisos mansoft): sin buffer del caller
  // → modo inmediato (enabled:false = comportamiento previo).
  const liBuf = writeBuffer ?? createLineItemWriteBuffer({ enabled: false, context: { dealId } });

  let created = 0, updated = 0, deleted = 0, skipped = 0;

  if (!dealId) {
    logger.info(
      { module: 'phaseP', fn: 'runPhaseP' },
      'dealId faltante, saltando Phase P'
    );
    return { success: false, reason: 'missing_dealId', created: 0, updated: 0, deleted: 0, skipped: 0 };
  }

  logger.info(
    { module: 'phaseP', fn: 'runPhaseP', dealId, dealStage, lineItemsCount: lineItems?.length || 0 },
    'Inicio Phase P'
  );

  // Construir set de LIKs válidos actuales
  const validLiks = new Set();
  for (const li of lineItems || []) {
    const p = li?.properties || {};
    const lik = p.line_item_key || p.of_line_item_key || '';
    if (lik) validLiks.add(String(lik).trim());
  }

  await cleanupOrphanForecastTicketsForDeal({ dealId, validLiks, deal });

  for (const li of lineItems || []) {
    try {
      let changed = false;

      const p = li?.properties || {};
      const lineItemKey = p.line_item_key || p.of_line_item_key || '';

      if (!lineItemKey) {
        logger.debug(
          { module: 'phaseP', fn: 'runPhaseP', dealId, lineItemId: li.id },
          'Line item sin line_item_key, saltando'
        );
        skipped++;
        continue;
      }

      const automated = isAutomatedBilling(li);
      const targetStage = resolveForecastStage({ dealStage, automated });
      const cfg = getEffectiveBillingConfig(li);

       // ── Guard Mantsoft: detectar edición de LI automático ──
// Si el LI ya tiene snapshot previo Y alguna watched prop cambió,
// marcar mansoft_pendiente=true + tipo 'edicion' para que el cron
// lo tome esta noche.
// Las altas también se marcan en Phase P, cuando el deal ya está
// en stage activo y existen fechas deseadas.
      if (automated && hasPreviousSnapshot(li)) {
        try {
          const prevSnap = parseMansoftSnapshot(p.mansoft_ultimo_snapshot);
          const currSnap = buildMansoftSnapshot(li);
          const diffs = diffMansoftSnapshots(prevSnap, currSnap);
 
// DESPUÉS
          if (diffs.length > 0) {
            const currentTipo = String(p.mansoft_tipo_aviso || '').trim().toLowerCase();

            // Detectar transición de pausa false → true
            const pausaDiff = diffs.find(d => d.prop === 'pausa');
            const transicionAPausa =
              pausaDiff &&
              parseBool(pausaDiff.after) === true &&
              parseBool(pausaDiff.before) !== true;

            // ── Aviso al mirror UY ────────────────────────────────────────
            // PY automático, no-espejo y con uy=true: si la pausa cambió de
            // estado (en cualquier dirección), avisar al deal UY espejo para
            // que pause/reactive su facturación manual.
            // Fire-and-forget: nunca bloquea el forecast.
            const mirrorPauseDecision = shouldNotifyMirrorOnPauseChange(li, pausaDiff);
            if (mirrorPauseDecision) {
              const ahoraPausado = mirrorPauseDecision.paused;
              const esRenovacion =
                String(p.renovacion_automatica || '').toLowerCase() === 'true';
              const inicio =
                toYmd(p.hs_recurring_billing_start_date) ||
                toYmd(p.billing_anchor_date) || '';

              notifyMirrorDealOnPauseChange(li.id, {
                paused: ahoraPausado,
                details: {
                  pyDealId: dealId,
                  cliente: deal?.properties?.cliente_beneficiario
                    || deal?.properties?.dealname || '',
                  negocio: deal?.properties?.dealname || '',
                  producto: p.name || '',
                  tipo: esRenovacion ? 'Renovación automática' : 'Plan fijo',
                  inicio,
                  vencimiento: esRenovacion ? '' : (toYmd(p.fecha_vencimiento_contrato) || ''),
                  frecuencia: p.recurringbillingfrequency || p.hs_recurring_billing_frequency || '',
                  monto: p.amount || '',
                  motivo: ahoraPausado ? (p.motivo_de_pausa || '') : '',
                },
              }).catch(err => {
                logger.warn(
                  { module: 'phaseP', fn: 'runPhaseP', dealId, lineItemId: li.id, err },
                  'notifyMirrorDealOnPauseChange falló — no bloquea'
                );
              });
            }

            // Si la línea YA está de baja (en pausa) y este cambio NO es la
            // transición que la dio de baja, no se reavisar al admin: la baja
            // ya se notificó una vez. Los avisos se reactivan recién cuando le
            // sacan la pausa (pausa vuelve a false).
            const yaEnPausa = parseBool(p.pausa) === true;
            if (yaEnPausa && !transicionAPausa) {
              logger.debug(
                {
                  module: 'phaseP',
                  fn: 'runPhaseP',
                  dealId,
                  lineItemId: li.id,
                  changedProps: diffs.map(d => d.prop),
                },
                'Mantsoft: LI ya en pausa (de baja), aviso suprimido hasta que le saquen la pausa'
              );
            } else {
              // Regla de prioridad: baja > alta > edicion
              let tipoFinal;
              if (currentTipo === 'baja' || transicionAPausa) {
                tipoFinal = 'baja';
              } else if (currentTipo === 'alta') {
                tipoFinal = 'alta';
              } else {
                tipoFinal = 'edicion';
              }

              await liBuf.queueUpdate(String(li.id), {
                mansoft_pendiente: 'true',
                mansoft_tipo_aviso: tipoFinal,
              }, { label: 'mansoft_edicion' });
              logger.info(
                {
                  module: 'phaseP',
                  fn: 'runPhaseP',
                  dealId,
                  lineItemId: li.id,
                  changedProps: diffs.map(d => d.prop),
                  tipo: tipoFinal,
                  transicionAPausa: !!transicionAPausa,
                },
                'Mantsoft: cambio detectado en LI automático'
              );
            }
          }
        } catch (err) {
          logger.warn(
            { module: 'phaseP', fn: 'runPhaseP', dealId, lineItemId: li.id, err },
            'Error detectando edición Mantsoft — no bloquea'
          );
        }
      }
 
      logger.debug(
        {
          module: 'phaseP',
          fn: 'runPhaseP',
          dealId,
          lineItemId: li.id,
          lik: lineItemKey,
          dealStage,
          automated,
          targetStage,
          startDate: cfg?.startDate ? formatDateISO(cfg.startDate) : null,
          interval: cfg?.interval ?? null,
          numberOfPayments: safeInt(p.hs_recurring_billing_number_of_payments ?? p.number_of_payments ?? null),
          autorenew: cfg?.isAutoRenew ?? cfg?.autorenew ?? null,
        },
        'Line item config'
      );

      if (!targetStage) {
        logger.debug(
          { module: 'phaseP', fn: 'runPhaseP', dealId, lineItemId: li.id, dealStage, reason: 'dealstage_not_in_forecast_buckets' },
          'Line item saltado: dealstage fuera de buckets de forecast'
        );
        skipped++;
        continue;
      }

      // 1) Fechas deseadas
      const allTickets = await findTicketsByLineItemKey(lineItemKey);
      const { desiredCount, dates } = buildDesiredDates(li, allTickets);

      if (shouldMarkMantsoftAlta({ li, automated, dealStage, desiredCount })) {
  try {
    await liBuf.queueUpdate(String(li.id), {
      mansoft_pendiente: 'true',
      mansoft_tipo_aviso: 'alta',
    }, { label: 'mansoft_alta' });

    li.properties = {
      ...(li.properties || {}),
      mansoft_pendiente: 'true',
      mansoft_tipo_aviso: 'alta',
    };

    logger.info(
      {
        module: 'phaseP',
        fn: 'runPhaseP',
        dealId,
        lineItemId: li.id,
        lik: lineItemKey,
        dealStage,
        desiredCount,
        firstDate: dates[0] || null,
      },
      'Mantsoft: alta marcada en Phase P'
    );
  } catch (err) {
    logger.warn(
      { module: 'phaseP', fn: 'runPhaseP', dealId, lineItemId: li.id, err },
      'Error marcando alta Mantsoft en Phase P — no bloquea forecast'
    );
  }
}

      logger.debug(
        { module: 'phaseP', fn: 'runPhaseP', dealId, lineItemId: li.id, lik: lineItemKey, desiredCount, count: dates.length, first: dates[0] || null, last: dates[dates.length - 1] || null },
        'Fechas deseadas para line item'
      );
      const forecastTickets = allTickets.filter(isManagedTicket);

      // 3) Si desiredCount=0 → retirar SOLO los que maneja el motor
      //    (flag ON: cancelar y avisar; flag OFF: borrar, como siempre)
      if (desiredCount === 0) {
        if (forecastTickets.length) {
          const cancelados = [];
          for (const t of forecastTickets) {
            const r = await retirarTicket(t, {
              motivo: 'El elemento de pedido ya no tiene fechas de facturación pendientes',
              dealId,
              lineItemId: li.id,
              contexto: 'desired_count_0',
            });
            if (!r.retirado) continue;
            deleted++;
            if (r.cancelado) {
              cancelados.push({
                ticketId: String(t.id),
                fecha: fechaDelTicket(t) || null,
                ownerId: t?.properties?.hubspot_owner_id || null,
              });
            }
          }
          if (cancelados.length) {
            await notifyTicketsCancelledByEngine({
              dealId,
              dealName: deal?.properties?.dealname || null,
              dealOwnerId: deal?.properties?.hubspot_owner_id || null,
              lineItemName: p.name || null,
              lineItemId: li.id,
              cancelados,
              motivo: 'El elemento de pedido ya no tiene fechas de facturación pendientes',
            });
          }
          await updateLineItemLastGeneratedAt(li.id);
        }
        // Sin tickets deseados → billing_next_date debe quedar vacío
        await syncBillingNextDateFromTickets({
          lineItemId: li.id,
          allTickets: [],          // forzar vacío — ya borramos los forecasts
          todayYmd: nowMontevideoYmd(),
          lastTicketedYmd: toYmd(p.last_ticketed_date),
          currentBillingNextDate: toYmd(p.billing_next_date),
        });
        continue;
      }

      // Aviso al vendedor: fecha de facturación próxima (≤10 días) o vencida
      // con el negocio aún no ganado → billing_error en el deal.
      warnFacturacionDealNoGanado({
        deal, dealId, dealStage, li, dates, todayYmd: nowMontevideoYmd(),
      });

      // 4) Armar set de keys deseadas
      const desiredKeys = new Set();
      const desiredByKey = new Map();

      for (const ymd of dates) {
        const key = buildTicketKeyFromLineItemKey(dealId, lineItemKey, ymd);
        desiredKeys.add(key);
        desiredByKey.set(key, ymd);
      }

      // 5) Mapear existentes por key (forecast vs protegidos)
      const existingForecastByKey = new Map();
      const existingProtectedByKey = new Map();
      // FIX: mapa secundario por of_ticket_key explícito para detectar tickets
      // con of_line_item_key desincronizado (ej: deals mirror, clones)
      const existingByTicketKey = new Map();

for (const t of allTickets) {
        const k = getTicketKeyOrDerive({ ticket: t, dealId, lineItemKey });
        if (!k) continue;

        if (isManagedTicket(t)) {
          if (existingForecastByKey.has(k)) {
            // Duplicado para la misma key (ej: cambio de dealstage generó un
            // segundo ticket en distinto stage sin retirar el anterior). Se
            // retira acá para que el paso 6 trabaje con un único canónico.
            // SIN aviso a propósito: la fecha sigue viva en el ticket que queda
            // — avisar "se canceló" sería engañoso (§2.4 es para lo que sobra).
            try {
              const r = await retirarTicket(t, {
                motivo: 'Duplicado del cronograma: ya existe otro ticket para esa misma fecha',
                dealId,
                lineItemId: li.id,
                contexto: 'duplicado_misma_key',
              });
              if (r.retirado) {
                deleted++;
                logger.info(
                  { module: 'phaseP', fn: 'runPhaseP', dealId, lineItemId: li.id, ticketId: t.id, key: k, cancelado: r.cancelado },
                  'Ticket duplicado retirado (misma key, stage distinto)'
                );
              }
            } catch (err) {
              logger.error({ module: 'phaseP', fn: 'runPhaseP', dealId, lineItemId: li?.id, ticketId: t?.id, err }, 'unit_failed');
            }
          } else {
            existingForecastByKey.set(k, t);
          }
        } else if (protegeSuClave(t)) {
          if (!existingProtectedByKey.has(k)) existingProtectedByKey.set(k, t);
        }
        // else: cancelado por el motor / por la pérdida del negocio → ni lo
        // maneja ni protege su fecha: esa fecha se puede volver a armar (§2.4).

        // Indexar por of_ticket_key explícito independientemente del LIK
        const explicitKey = String(t?.properties?.of_ticket_key || '').trim();
        if (explicitKey && !existingByTicketKey.has(explicitKey)) {
          existingByTicketKey.set(explicitKey, t);
        }
      }

// 6) Upsert: crear faltantes; actualizar solo si es forecast editable
      for (const key of desiredKeys) {
        const expectedYmd = desiredByKey.get(key);

        const existingForecast = existingForecastByKey.get(key);
        const existingProtected = existingProtectedByKey.get(key);

        if (!existingForecast) {
          const existingByKey = existingByTicketKey.get(key);
          const foundProtected = existingProtected ||
            (existingByKey && protegeSuClave(existingByKey) ? existingByKey : null);

          if (foundProtected) {
            const storedLik = String(foundProtected?.properties?.of_line_item_key || '').trim();
            if (storedLik !== lineItemKey) {
              logger.info(
                { module: 'phaseP', fn: 'runPhaseP', dealId, lineItemId: li.id, key, ticketId: foundProtected.id, storedLik, currentLik: lineItemKey },
                'Reparando of_line_item_key desincronizado en ticket protegido'
              );
              try {
                await updateTicket(foundProtected.id, { of_line_item_key: lineItemKey });
              } catch (err) {
                logger.warn(
                  { module: 'phaseP', fn: 'runPhaseP', dealId, lineItemId: li.id, key, ticketId: foundProtected.id, err },
                  'No se pudo reparar of_line_item_key en ticket protegido'
                );
              }
            }
            logger.debug(
              { module: 'phaseP', fn: 'runPhaseP', dealId, lineItemId: li.id, key, expectedYmd, protectedTicketId: foundProtected.id },
              'Key cubierta por ticket protegido, saltando creación'
            );
            continue;
          }

          logger.info(
            { module: 'phaseP', fn: 'runPhaseP', dealId, lineItemId: li.id, lineItemKey, expectedYmd, targetStage },
            'Creando ticket forecast'
          );

          const hsPipeline = automated ? AUTOMATED_TICKET_PIPELINE : TICKET_PIPELINE;

          // Tickets automáticos del pasado nacen directo en "Listo para facturar"
          // SOLO si el deal ya factura (facturacion_activa=true): Phase 3 no emite
          // sin esa llave, y un ticket en READY que nunca se emitirá dispara la
          // alerta zero-emission en loop.
          const todayForStage = nowMontevideoYmd();
          let effectiveStage = targetStage;
          if (automated && expectedYmd < todayForStage) {
            if (dealFacturacionActiva) {
              effectiveStage = BILLING_AUTOMATED_READY;
              logger.info(
                { module: 'phaseP', fn: 'runPhaseP', dealId, lineItemId: li.id, expectedYmd, todayForStage },
                'Ticket automático del pasado → nace en BILLING_AUTOMATED_READY'
              );
            } else {
              logger.info(
                { module: 'phaseP', fn: 'runPhaseP', dealId, lineItemId: li.id, expectedYmd, todayForStage, targetStage },
                'Ticket automático del pasado pero deal sin facturacion_activa → nace en stage forecast'
              );
            }
          }

          const fullProps = await buildTicketFullProps({
            deal,
            lineItem: li,
            dealId,
            lineItemId: li.id,
            lineItemKey,
            ticketKey: key,
            expectedYMD: expectedYmd,
            orderedYMD: null,
          });

          await safeCreateTicket(hubspotClient, {
            properties: {
              ...fullProps,
              hs_pipeline: String(hsPipeline),
              hs_pipeline_stage: String(effectiveStage),
              of_motivo_pausa: p.pausa === 'true' || p.pausa === true ? (p.motivo_de_pausa || '') : '',
              of_snapshot_source_modified: String(p.hs_lastmodifieddate || ''),
            },
          });
          created++;
          changed = true;
          continue;
        } // ← cierra if (!existingForecast)

        // FIX: si existe forecast PERO también existe un ticket protegido para
        // la misma key, el forecast es redundante y debe eliminarse.
        {
          const existingByKey = existingByTicketKey.get(key);
          const foundProtected = existingProtected ||
            (existingByKey && protegeSuClave(existingByKey) ? existingByKey : null);

          if (foundProtected) {
            logger.info(
              { module: 'phaseP', fn: 'runPhaseP', dealId, lineItemId: li.id, key, forecastTicketId: existingForecast.id, protectedTicketId: foundProtected.id },
              'Ticket redundante: la key ya está cubierta por un ticket protegido'
            );
            // Sin aviso a propósito: la fecha sigue cubierta por el protegido,
            // no se está perdiendo nada del cronograma.
            try {
              const r = await retirarTicket(existingForecast, {
                motivo: 'Redundante: esa fecha ya está cubierta por un ticket notificado o cerrado',
                dealId,
                lineItemId: li.id,
                contexto: 'redundante_key_protegida',
              });
              if (r.retirado) {
                deleted++;
                changed = true;
              }
            } catch (err) {
              logger.error({ module: 'phaseP', fn: 'runPhaseP', dealId, lineItemId: li?.id, ticketId: existingForecast?.id, err }, 'unit_failed');
            }
            continue;
          }
        }

        // Existe forecast => actualizar stage + re-snapshot si line item cambió
        const existing = existingForecast;
        const patch = {};

        const hsPipeline = automated ? AUTOMATED_TICKET_PIPELINE : TICKET_PIPELINE;
        if (String(existing?.properties?.hs_pipeline || '') !== String(hsPipeline)) {
          patch.hs_pipeline = String(hsPipeline);
        }

        // La etapa NUNCA retrocede desde «Próximos a facturar» (flag ON).
        // El ticket llega a la etapa única por tres caminos legítimos que el
        // motor no puede deshacer: la migración deja ahí a los manuales
        // (promoverManualForecast.mjs), el espejo UY se promueve a propósito
        // para que el admin lo revise (mirrorUtils.js:232-238) y administración
        // lo mueve a mano. Sin este guard, un negocio en bucket 25/50/75 lo
        // arrastraría de vuelta a forecast en cada pasada (hallazgo rojo #4).
        const stageActual = String(existing?.properties?.hs_pipeline_stage || '');
        const yaEnEtapaUnica = debeConservarEtapa(existing);

        if (stageActual !== String(targetStage)) {
          if (yaEnEtapaUnica) {
            logger.debug(
              { module: 'phaseP', fn: 'runPhaseP', dealId, lineItemId: li.id, ticketId: existing.id, stageActual, targetStage },
              'Ticket ya en «Próximos a facturar»: la etapa no retrocede'
            );
          } else {
            patch.hs_pipeline_stage = String(targetStage);
          }
        }

        if (!String(existing?.properties?.of_ticket_key || '').trim()) {
          patch.of_ticket_key = String(key);
        }

        // Sincronizar motivo de pausa
        const motivoPausa = parseBool(p.pausa) ? (p.motivo_de_pausa || '') : '';
        if (String(existing?.properties?.of_motivo_pausa || '') !== motivoPausa) {
          patch.of_motivo_pausa = motivoPausa;
        }

        // Re-snapshot: si el line item fue modificado después del último snapshot
        const ticketSnapshotMod = String(existing?.properties?.of_snapshot_source_modified || '').trim();
        const liLastMod = String(p.hs_lastmodifieddate || '').trim();

        // EL MOTOR MANDA SOBRE LA ESTRUCTURA, NO SOBRE EL CONTENIDO (§2.2).
        // Bajo la flag, el re-snapshot deja de escribir la hoja entera en los
        // tickets MANUALES no notificados: ahí manda la edición a mano, y el
        // contenido se propaga renglón por renglón desde el line item vía el
        // sync quirúrgico (syncLineItemPropToTicket). Los automáticos y todo lo
        // que ya cruzó la frontera siguen igual.
        const contenidoLoManejaElSync = debeOmitirResnapshot(existing);

        if (contenidoLoManejaElSync && liLastMod && liLastMod !== ticketSnapshotMod) {
          logger.info(
            { module: 'phaseP', fn: 'runPhaseP', dealId, lineItemId: li.id, ticketId: existing.id },
            'Re-snapshot OMITIDO: ticket manual no notificado — el contenido lo maneja el sync quirúrgico'
          );
        }

        if (!contenidoLoManejaElSync && liLastMod && liLastMod !== ticketSnapshotMod) {
          const freshProps = await buildTicketFullProps({
            deal,
            lineItem: li,
            dealId,
            lineItemId: li.id,
            lineItemKey,
            ticketKey: key,
            expectedYMD: expectedYmd,
            orderedYMD: null,
          });

          const snapshotKeys = Object.keys(freshProps);
          for (const sk of snapshotKeys) {
            const freshVal = String(freshProps[sk] ?? '');
            const existingVal = String(existing?.properties?.[sk] ?? '');
            if (freshVal !== existingVal) {
              patch[sk] = freshProps[sk];
            }
          }

          patch.of_snapshot_source_modified = liLastMod;

          logger.info(
            { module: 'phaseP', fn: 'runPhaseP', dealId, lineItemId: li.id, ticketId: existing.id, diffKeys: Object.keys(patch).filter(k => k !== 'of_snapshot_source_modified') },
            'Re-snapshot aplicado a ticket forecast'
          );
        }

        if (Object.keys(patch).length) {
          await updateTicket(existing.id, patch);
          updated++;
          changed = true;
        }
      } 

      // 7) Sobrantes: los que maneja el motor y cuya key no está en desiredKeys.
      //    Flag OFF: se archivan (comportamiento de siempre).
      //    Flag ON : SE CANCELAN Y SE AVISA — el motor no borra (§2.4).
      const sobrantesCancelados = [];
      for (const t of forecastTickets) {
        const k = getTicketKeyOrDerive({ ticket: t, dealId, lineItemKey });
        if (!k) continue;
        if (!desiredKeys.has(k)) {
          try {
            logger.info(
              { module: 'phaseP', fn: 'runPhaseP', dealId, lineItemId: li.id, ticketId: t.id, ticketKey: k },
              'Retirando ticket sobrante del cronograma'
            );
            const r = await retirarTicket(t, {
              motivo: 'El cronograma se rearmó y esta fecha ya no corresponde',
              dealId,
              lineItemId: li.id,
              contexto: 'sobrante_paso7',
            });
            if (!r.retirado) continue;
            deleted++;
            changed = true;
            if (r.cancelado) {
              sobrantesCancelados.push({
                ticketId: String(t.id),
                fecha: fechaDelTicket(t) || null,
                ownerId: t?.properties?.hubspot_owner_id || null,
              });
            }
          } catch (err) {
            logger.error({ module: 'phaseP', fn: 'runPhaseP', dealId, lineItemId: li?.id, ticketId: t?.id, err }, 'unit_failed');
          }
        }
      }

      if (sobrantesCancelados.length) {
        try {
          await notifyTicketsCancelledByEngine({
            dealId,
            dealName: deal?.properties?.dealname || null,
            dealOwnerId: deal?.properties?.hubspot_owner_id || null,
            lineItemName: p.name || null,
            lineItemId: li.id,
            cancelados: sobrantesCancelados,
            motivo: 'El cronograma del elemento de pedido se rearmó (cambió la frecuencia, el plazo o la fecha de inicio)',
          });
        } catch (err) {
          logger.warn(
            { module: 'phaseP', fn: 'runPhaseP', dealId, lineItemId: li.id, err },
            'Aviso de tickets cancelados falló (no bloquea)'
          );
        }
      }

      try {
        await syncBillingNextDateFromTickets({
          lineItemId: li.id,
          allTickets,
          todayYmd: nowMontevideoYmd(),
          lastTicketedYmd: toYmd(p.last_ticketed_date),
          currentBillingNextDate: toYmd(p.billing_next_date),
        });
      } catch (err) {
        logger.error(
          { module: 'phaseP', fn: 'runPhaseP', dealId, lineItemId: li.id, err },
          'Error en syncBillingNextDateFromTickets, continuando'
        );
      }

 if (changed) {
        await updateLineItemLastGeneratedAt(li.id);
      }
 
    } catch (err) {
      logger.error({ module: 'phaseP', fn: 'runPhaseP', dealId, lineItemId: li?.id, err }, 'unit_failed');
    }
  }

  // FLUSH POINT: persistir los avisos mansoft bacheados antes de salir de
  // Phase P. Noop con flag off. flush() nunca lanza.
  await liBuf.flush();

  logger.info(
    { module: 'phaseP', fn: 'runPhaseP', dealId, created, updated, deleted, skipped },
    'Phase P completada'
  );

  return { success: true, created, updated, deleted, skipped };
}

/*
 * CATCHES con reportHubSpotError agregados:
 *   - updateLineItemLastGeneratedAt: lineItems.basicApi.update() → objectType="line_item", re-throw
 *
 * NO reportados:
 *   - updateTicket() en loop upsert → ya tiene reportIfActionable interno (ticketService.js migrado)
 *   - safeCreateTicket() → creación, no update accionable
 *   - deleteTicket() → archive, excluido (Regla 4)
 *   - tickets.searchApi.doSearch → lectura
 *   - lineItems.basicApi.update() en guard no_billing_period_date → cleanup interno, no accionable
 *
 * Confirmación: "No se reportan warns a HubSpot; solo errores 4xx (≠429)"
 */