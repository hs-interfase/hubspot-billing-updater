// src/phases/phaseP.js

import { hubspotClient } from '../hubspotClient.js';
import { getEffectiveBillingConfig } from '../billingEngine.js';
import { parseLocalDate, formatDateISO, addInterval } from '../utils/dateUtils.js';
import { parseBool } from '../utils/parsers.js';
import { buildTicketKeyFromLineItemKey } from '../utils/ticketKey.js';
import { updateTicket } from '../services/tickets/ticketService.js';
import { buildTicketFullProps } from '../services/tickets/ticketService.js';
import { safeCreateTicket } from '../services/tickets/ticketService.js';
import logger from '../../lib/logger.js';
import { reportHubSpotError } from '../utils/hubspotErrorCollector.js';

const BILLING_TZ = 'America/Montevideo';

// ==============================
// Forecast stages (EDITABLES) — reales
// ==============================
const STAGE = {
  MANUAL_FORECAST_25: '1294744238',
  MANUAL_FORECAST_50: '1294744239',
  MANUAL_FORECAST_75: '1296492870',
  MANUAL_FORECAST_95: '1296492871',
  AUTO_FORECAST_25: '1294745999',
  AUTO_FORECAST_50: '1294746000',
  AUTO_FORECAST_75: '1296489840',
  AUTO_FORECAST_95: '1296362566',
};
const BILLING_TICKET_PIPELINE_ID = '832539959';
const BILLING_AUTOMATED_PIPELINE_ID = '829156883';

const FORECAST_TICKET_STAGES = new Set(Object.values(STAGE));

function reportIfActionable({ objectType, objectId, message, err }) {
  const status = err?.response?.status ?? err?.statusCode ?? null;
  if (status === null) { reportHubSpotError({ objectType, objectId, message }); return; }
  if (status === 429 || status >= 500) return;
  if (status >= 400 && status < 500) reportHubSpotError({ objectType, objectId, message });
}

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

async function cleanupOrphanForecastTicketsForDeal({ dealId, validLiks }) {
  const body = {
    filterGroups: [
      {
        filters: [
          { propertyName: 'of_deal_id', operator: 'EQ', value: String(dealId) },
        ],
      },
    ],
    properties: ['hs_pipeline_stage', 'of_ticket_key'],
    limit: 100,
  };

  const resp = await hubspotClient.crm.tickets.searchApi.doSearch(body);
  const allTickets = resp?.results || [];
  const forecastTickets = allTickets.filter(isForecastTicket);

  let orphanDeleted = 0;

  for (const t of forecastTickets) {
    try {
    const ticketId = t.id;
    const ticketKey = String(t?.properties?.of_ticket_key || '').trim();
    if (!ticketKey) continue;

    const lik = parseLikFromTicketKey(ticketKey);
    if (!lik) continue;

    if (!validLiks.has(lik)) {
      await deleteTicket(ticketId);
      orphanDeleted++;
      logger.info(
        { module: 'phaseP', fn: 'cleanupOrphanForecastTicketsForDeal', dealId, ticketId, ticketKey },
        'Orphan forecast ticket eliminado'
      );
    }} catch (err) {
     logger.error({ module: 'phaseP', fn: 'cleanupOrphanForecastTicketsForDeal', dealId, ticketId: t?.id, err }, 'unit_failed');
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
  if (s === 'closedwon') return '95';
  return null;
}

function resolveForecastStage({ dealStage, automated }) {
  const bucket = resolveBucketFromDealStage(dealStage);
  if (!bucket) return null;

  if (!automated) {
    if (bucket === '50') return STAGE.MANUAL_FORECAST_50;
    if (bucket === '75') return STAGE.MANUAL_FORECAST_75;
    if (bucket === '95') return STAGE.MANUAL_FORECAST_95;
    return STAGE.MANUAL_FORECAST_25;
  }

  if (bucket === '50') return STAGE.AUTO_FORECAST_50;
  if (bucket === '75') return STAGE.AUTO_FORECAST_75;
  if (bucket === '95') return STAGE.AUTO_FORECAST_95;
  return STAGE.AUTO_FORECAST_25;
}

/**
 * Construye fechas deseadas según contrato.
 */
function buildDesiredDates(lineItem) {
  const p = lineItem?.properties || {};
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

  const termRaw = p.hs_recurring_billing_number_of_payments ?? p.number_of_payments ?? null;
  const term = safeInt(termRaw);

  const hardMax = 24;
  const maxCount = term && term > 0 ? Math.min(term, hardMax) : hardMax;

  const todayYmd = nowMontevideoYmd();
  const lastTicketedYmd = toYmd(p.last_ticketed_date);
  const billingNextYmd = toYmd(p.billing_next_date);

  const isAutoRenew =
    cfg?.isAutoRenew === true ||
    cfg?.autorenew === true ||
    String(p.renovacion_automatica || '').toLowerCase() === 'true' ||
    !(safeInt(p.hs_recurring_billing_number_of_payments ?? p.number_of_payments ?? null) > 0);

  let effectiveTodayYmd = todayYmd;
  if (lastTicketedYmd) {
    const d0 = parseLocalDate(lastTicketedYmd);
    if (d0 && Number.isFinite(d0.getTime())) {
      d0.setDate(d0.getDate() + 1);
      const plusOne = formatDateISO(d0);
      if (plusOne > effectiveTodayYmd) effectiveTodayYmd = plusOne;
    }
  }

  let seriesStartYmd = startYmd;

  if (isAutoRenew) {
    seriesStartYmd = effectiveTodayYmd;
    if (billingNextYmd && billingNextYmd > seriesStartYmd) seriesStartYmd = billingNextYmd;
    if (startYmd && startYmd > seriesStartYmd) seriesStartYmd = startYmd;
  }

  const startDate = parseLocalDate(seriesStartYmd);
  if (!startDate) return { desiredCount: 0, dates: [] };

  const horizonDate = new Date(startDate.getTime());
  horizonDate.setFullYear(horizonDate.getFullYear() + 2);

  const dates = [];
  let d = new Date(startDate.getTime());

  while (dates.length < maxCount) {
    if (!d || !Number.isFinite(d.getTime())) break;
    if (d.getTime() > horizonDate.getTime()) break;

    dates.push(formatDateISO(d));

    const next = addInterval(d, interval);
    if (!next || !Number.isFinite(next.getTime())) break;
    if (next.getTime() === d.getTime()) break;

    d = next;
  }

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
    ],
    limit: 100,
  };

  const resp = await hubspotClient.crm.tickets.searchApi.doSearch(body);
  return resp?.results || [];
}

function isForecastTicket(ticket) {
  const stage = String(ticket?.properties?.hs_pipeline_stage || '');
  return FORECAST_TICKET_STAGES.has(stage);
}

function getTicketKeyOrDerive({ ticket, dealId, lineItemKey }) {
  const k = String(ticket?.properties?.of_ticket_key || '').trim();
  if (k) return k;
  const ymd = toYmd(ticket?.properties?.fecha_resolucion_esperada);
  if (!ymd) return '';
  return buildTicketKeyFromLineItemKey(dealId, lineItemKey, ymd);
}

/*
export async function createForecastTicket({
  dealId,
  lineItemKey,
  ticketKey,
  expectedYmd,
  targetStage,
  lineItemId,
  hsPipeline,
  empresaId,
  empresaNombre,
  productoNombre,
  unidadDeNegocio,
  rubro,
}) {
  const billDateYMD = String(expectedYmd);
  const subject = `${empresaNombre || 'SIN_EMPRESA'} - ${productoNombre || 'SIN_PRODUCTO'} - ${billDateYMD}`;
  const properties = {
    hs_pipeline: String(hsPipeline),
    hs_pipeline_stage: String(targetStage),
    of_deal_id: String(dealId),
    of_line_item_key: String(lineItemKey),
    of_ticket_key: String(ticketKey),
    of_line_item_ids: String(lineItemId || ''),
    fecha_resolucion_esperada: billDateYMD,
    subject,
    empresa_id: empresaId || '',
    nombre_empresa: empresaNombre || '',
    unidad_de_negocio: unidadDeNegocio || '',
    of_producto_nombres: productoNombre || '',
    of_rubro: rubro || '',
  };
  return hubspotClient.crm.tickets.basicApi.create({ properties });
}
*/

async function deleteTicket(ticketId) {
  return hubspotClient.crm.tickets.basicApi.archive(String(ticketId));
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
export async function runPhaseP({ deal, lineItems }) {
  const dealId = deal?.id || deal?.objectId || deal?.properties?.hs_object_id;
  const dealStage = deal?.properties?.dealstage || '';

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

/*
const companyIds = await getDealCompanies(String(dealId));
const empresaId = companyIds?.[0] ? String(companyIds[0]) : '';
let empresaNombre = '';
if (empresaId) {
  const c = await hubspotClient.crm.companies.basicApi.getById(empresaId, ['name']);
  empresaNombre = c?.properties?.name || '';
}
*/

  // Construir set de LIKs válidos actuales
  const validLiks = new Set();
  for (const li of lineItems || []) {
    const p = li?.properties || {};
    const lik = p.line_item_key || p.of_line_item_key || '';
    if (lik) validLiks.add(String(lik).trim());
  }

  await cleanupOrphanForecastTicketsForDeal({ dealId, validLiks });

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
    const { desiredCount, dates } = buildDesiredDates(li);

    logger.debug(
      { module: 'phaseP', fn: 'runPhaseP', dealId, lineItemId: li.id, lik: lineItemKey, desiredCount, count: dates.length, first: dates[0] || null, last: dates[dates.length - 1] || null },
      'Fechas deseadas para line item'
    );

    // 2) Traer existentes
    const allTickets = await findTicketsByLineItemKey(lineItemKey);
    const forecastTickets = allTickets.filter(isForecastTicket);

    // 3) Si desiredCount=0 → borrar SOLO forecast existentes
    if (desiredCount === 0) {
      if (forecastTickets.length) {
        logger.info(
          { module: 'phaseP', fn: 'runPhaseP', dealId, lineItemId: li.id, lineItemKey, count: forecastTickets.length },
          'Sin start_date: eliminando tickets forecast existentes'
        );
        for (const t of forecastTickets) {
          await deleteTicket(t.id);
          deleted++;
        }
        await updateLineItemLastGeneratedAt(li.id);
      }
      continue;
    }

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

    for (const t of allTickets) {
      const k = getTicketKeyOrDerive({ ticket: t, dealId, lineItemKey });
      if (!k) continue;

      if (isForecastTicket(t)) {
        if (!existingForecastByKey.has(k)) existingForecastByKey.set(k, t);
      } else {
        if (!existingProtectedByKey.has(k)) existingProtectedByKey.set(k, t);
      }
    }

    // 6) Upsert: crear faltantes; actualizar solo si es forecast editable
    for (const key of desiredKeys) {
      const expectedYmd = desiredByKey.get(key);

      const existingForecast = existingForecastByKey.get(key);
      const existingProtected = existingProtectedByKey.get(key);

      if (!existingForecast) {
        // Si ya existe protected para esa key, NO crear duplicado
        if (existingProtected) {
          logger.debug(
            { module: 'phaseP', fn: 'runPhaseP', dealId, lineItemId: li.id, key, expectedYmd, protectedTicketId: existingProtected.id },
            'Key cubierta por ticket protegido, saltando creación'
          );
          continue;
        }

        logger.info(
          { module: 'phaseP', fn: 'runPhaseP', dealId, lineItemId: li.id, lineItemKey, expectedYmd, targetStage },
          'Creando ticket forecast'
        );

        const hsPipeline = automated ? BILLING_AUTOMATED_PIPELINE_ID : BILLING_TICKET_PIPELINE_ID;

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
            hs_pipeline_stage: String(targetStage),
            of_motivo_pausa: p.pausa === 'true' || p.pausa === true ? (p.motivo_de_pausa || '') : '',
          },
        });

        created++;
        changed = true;
        continue;
      }

// Existe forecast => STAGE-ONLY
      const existing = existingForecast;
      const patch = {};

      const hsPipeline = automated ? BILLING_AUTOMATED_PIPELINE_ID : BILLING_TICKET_PIPELINE_ID;
      if (String(existing?.properties?.hs_pipeline || '') !== String(hsPipeline)) {
        patch.hs_pipeline = String(hsPipeline);
      }

      if (String(existing?.properties?.hs_pipeline_stage || '') !== String(targetStage)) {
        patch.hs_pipeline_stage = String(targetStage);
      }

      if (!String(existing?.properties?.of_ticket_key || '').trim()) {
        patch.of_ticket_key = String(key);
      }

      // Sincronizar motivo de pausa
      const motivoPausa = parseBool(p.pausa) ? (p.motivo_de_pausa || '') : '';
      if (String(existing?.properties?.of_motivo_pausa || '') !== motivoPausa) {
        patch.of_motivo_pausa = motivoPausa;
      }

      if (Object.keys(patch).length) {
        await updateTicket(existing.id, patch);
        updated++;
        changed = true;
      }
    }

    // 7) Borrar sobrantes: SOLO forecast editables cuyo key no esté en desiredKeys
    for (const t of forecastTickets) {
      const k = getTicketKeyOrDerive({ ticket: t, dealId, lineItemKey });
      if (!k) continue;
      if (!desiredKeys.has(k)) {
        try {
        logger.info(
          { module: 'phaseP', fn: 'runPhaseP', dealId, lineItemId: li.id, ticketId: t.id, ticketKey: k },
          'Eliminando ticket forecast sobrante'
        );
        await deleteTicket(t.id);
        deleted++;
        changed = true;
        } catch (err) {
       logger.error({ module: 'phaseP', fn: 'runPhaseP', dealId, lineItemId: li?.id, ticketId: t?.id, err }, 'unit_failed');
     }
      }
    }

    if (changed) {
      await updateLineItemLastGeneratedAt(li.id);
    }
    } catch (err) {
     logger.error({ module: 'phaseP', fn: 'runPhaseP', dealId, lineItemId: li?.id, err }, 'unit_failed');
   }
  }

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