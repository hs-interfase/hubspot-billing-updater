// src/services/lineItems/recalcFromTickets.js
//
// Recalcula las propiedades de fecha del line item mirando los tickets
// reales que existen en HubSpot para ese lineItemKey.
//
// Propiedades recalculadas:
//   - last_ticketed_date       ← fecha_resolucion_esperada más reciente de tickets PROMOTED (READY+)
//   - last_billing_period      ← fecha_resolucion_esperada más reciente de tickets PROMOTED (derivados)//   - billing_last_billed_date ← fecha_real_de_facturacion más reciente de tickets EMITTED
//   - billing_next_date        ← fecha_resolucion_esperada más próxima de tickets FORECAST (futuro)
//
// Invariantes enforced:
//   I1: Forecast con fecha pasada → promover a READY (si facturacionActiva=true)
//   I2: billing_next_date nunca puede ser < last_ticketed_date
//   I3: billing_next_date = '' cuando promotedCount + emittedCount >= numberOfPayments
//   I4: Si no hay forecasts visibles → NO borrar billing_next_date existente
//
// ═══════════════════════════════════════════════════════════════════════════
// TANDA C — CON ETAPA_UNICA_ENABLED PRENDIDA, ESTE MÓDULO ES LA FUENTE ÚNICA
// ═══════════════════════════════════════════════════════════════════════════
// Ver definitivos/PLAN_proximos_cambios_tickets_2026-07-29.md §2.5. Las cuatro
// fechas pasan a ser TRES y los contadores dejan de ser estado acumulado:
//
//   PRÓXIMA    billing_next_date        = la próxima fecha NO NOTIFICADA
//   NOTIFICADO last_billing_period      = la última que cruzó la frontera
//   CONFIRMADO billing_last_billed_date = la última fecha REAL de Nodum (sin cambio)
//   last_ticketed_date                  → YA NO SE ESCRIBE (se elimina)
//   pagos_restantes                     = total − consumidos (DERIVADO, no decremental)
//
// El punto donde se descuenta una cuota pasa a ser EL PASO A «NOTIFICADO»
// (decisión de la usuaria, 31-jul): como el número se deriva del conteo de
// tickets que cruzaron la frontera, el descuento ocurre exactamente ahí, sin
// evento que perder ni doble descuento que arrastrar.
//
// 🙋 No hay suscripción de webhook sobre `ticket.propertyChange /
// hs_pipeline_stage` (ver docs/WEBHOOK_SUBSCRIPTIONS_prod_2026-07-14.md): el
// motor se entera de la notificación en su próxima pasada sobre el negocio
// (cron diario / fin de semana / «Actualizar»), no en el instante. Para un
// número derivado eso es latencia, no error — converge solo.
//
// Diseñada para ser llamada desde:
//   - Phase 1 (recalcula al inicio del ciclo, corrige drift)
//   - Phase 2 / Phase 3 (después de promover un ticket)
//   - missedBillingGuard / urgentBillingService (pendiente integración)

import { hubspotClient } from '../../hubspotClient.js';
import {
  TICKET_PIPELINE,
  AUTOMATED_TICKET_PIPELINE,
  TICKET_STAGES,
  BILLING_AUTOMATED_READY,
  FORECAST_MANUAL_STAGES,
  FORECAST_AUTO_STAGES,
  EMITTED_STAGES,
  PROMOTED_STAGES,
  DERIVED_STAGES,
  BILLING_AUTOMATED_CANCELLED,
  PROXIMOS_A_FACTURAR_STAGE,
} from '../../config/constants.js';
import { parseBool } from '../../utils/parsers.js'
import { getTodayYMD } from '../../utils/dateUtils.js';
import logger from '../../../lib/logger.js';
import { createTicketAssociations, getDealCompanies, getDealContacts } from '../tickets/ticketService.js';
import { syncLineItemAfterPromotion } from './syncAfterPromotion.js';
import { etapaUnicaEnabled } from '../../config/etapaUnicaFlags.js';
import {
  fechaUltimaNotificada,
  fechaProximaNoNotificada,
  contarConsumidos,
  isTicketEngineManaged,
} from '../../utils/ticketFrontera.js';
import { alertPagosCompletos } from '../notifications/dealAlerts.js';

const MOD = 'recalcFromTickets';

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

/**
 * Extrae YYYY-MM-DD de una propiedad de HubSpot.
 * Maneja epoch ms (string), YYYY-MM-DD directo, y YYYY-MM-DDThh:mm:ss.
 */
function toYmd(raw) {
  if (!raw) return '';
  const s = String(raw).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return s.slice(0, 10);
  const ms = Number(s);
  if (!Number.isNaN(ms) && ms > 0) {
    const d = new Date(ms);
    return d.toISOString().slice(0, 10);
  }
  return '';
}

/**
 * Busca TODOS los tickets no-cancelados para un lineItemKey en un pipeline.
 * Retorna array de { id, stage, pipelineId, fechaEsperada, fechaReal, properties }.
 *
 * TANDA C — con ETAPA_UNICA_ENABLED los CANCELADO **dejan de descartarse en
 * bloque**: el cancelado CON `of_invoice_id` es un período CERRADO por
 * cancelación definitiva de su factura, así que consumió su cuota y fija la
 * fecha NOTIFICADO igual que un emitido. Descartarlo acá haría que el motor
 * volviera a armar esa fecha y refacturara el período. Quién es quién lo
 * decide `hasTicketCrossedFrontier` (utils/ticketFrontera.js), no este filtro.
 * Con la llave apagada se siguen excluyendo todos, como hoy.
 *
 * `properties` viaja con la fecha ya normalizada a YYYY-MM-DD para que los
 * helpers de la frontera lean exactamente el mismo valor que este módulo (el
 * search puede devolver epoch ms).
 */
async function fetchTicketsForLIK({ lineItemKey, pipelineId, client = hubspotClient }) {
  const excluirCancelados = !etapaUnicaEnabled();
  const cancelledStages = new Set([
    TICKET_STAGES.CANCELLED,
    BILLING_AUTOMATED_CANCELLED,
  ].filter(Boolean));

  const allTickets = [];
  let after = undefined;
  const MAX_PAGES = 5; // seguridad: máximo 500 tickets por LIK

  for (let page = 0; page < MAX_PAGES; page++) {
    const searchBody = {
      filterGroups: [
        {
          filters: [
            { propertyName: 'of_line_item_key', operator: 'EQ', value: String(lineItemKey) },
            { propertyName: 'hs_pipeline', operator: 'EQ', value: String(pipelineId) },
          ],
        },
      ],
      properties: [
        'hs_pipeline_stage',
        'fecha_resolucion_esperada',
        'fecha_real_de_facturacion',
        'of_ticket_key',
        'of_invoice_id',   // TANDA C: separa el CANCELADO con período cerrado del que canceló el motor
      ],
      sorts: [{ propertyName: 'fecha_resolucion_esperada', direction: 'ASCENDING' }],
      limit: 100,
    };

    if (after) {
      searchBody.after = after;
    }

    let res;
    try {
      res = await client.crm.tickets.searchApi.doSearch(searchBody);
    } catch (err) {
      logger.warn({ module: MOD, fn: 'fetchTicketsForLIK', lineItemKey, pipelineId, err },
        'Error buscando tickets para LIK');
      return allTickets;
    }

    const results = res?.results || [];
    for (const t of results) {
      const p = t?.properties || {};
      const stage = String(p.hs_pipeline_stage || '');

      // Excluir cancelados (flag OFF: todos, como hoy)
      if (excluirCancelados && cancelledStages.has(stage)) continue;

      // Extraer fecha esperada (preferir propiedad, fallback a ticket key)
      let fechaEsperada = toYmd(p.fecha_resolucion_esperada);
      if (!fechaEsperada && p.of_ticket_key) {
        const parts = String(p.of_ticket_key).split('::');
        const last = parts[parts.length - 1];
        if (last && /^\d{4}-\d{2}-\d{2}$/.test(last)) fechaEsperada = last;
      }

      allTickets.push({
        id: String(t.id),
        stage,
        pipelineId, // sabemos el pipeline porque el search filtra por él
        fechaEsperada,
        fechaReal: toYmd(p.fecha_real_de_facturacion),
        properties: {
          ...p,
          hs_pipeline: String(pipelineId),
          fecha_resolucion_esperada: fechaEsperada,
        },
      });
    }

    // Paginación
    const nextAfter = res?.paging?.next?.after;
    if (!nextAfter || results.length < 100) break;
    after = nextAfter;
  }

  return allTickets;
}

// ─────────────────────────────────────────────
// I1: Promover forecasts con fecha pasada
//     (auto→READY emisible / manual→PRÓXIMOS A FACTURAR)
// ─────────────────────────────────────────────

/**
 * Resuelve el stage destino de promoción según el pipeline del ticket.
 * ASIMETRÍA INTENCIONAL — no "unificar":
 *   - auto   → BILLING_AUTOMATED_READY (emisible: promueve y emite en el mismo paso)
 *   - manual → PRÓXIMOS A FACTURAR (TICKET_STAGES.NEW; NO emisible,
 *              requiere confirmación del admin para pasar a "Listo para Facturar")
 */
function resolveTargetPromotionStage(pipelineId) {
  if (String(pipelineId) === String(AUTOMATED_TICKET_PIPELINE)) {
    return BILLING_AUTOMATED_READY;
  }
  // Manual pipeline → "Próximos a Facturar" (entrada al flujo manual)
  return PROXIMOS_A_FACTURAR_STAGE;
}

/**
 * Promueve un ticket forecast con fecha pasada (auto→READY / manual→PRÓXIMOS).
 * Retorna true si se promovió, false si falló.
 */
async function promotePastDueForecast({ ticketId, pipelineId, fechaEsperada, lineItemKey, dealId, lineItemId, client = hubspotClient }) {
  const targetStage = resolveTargetPromotionStage(pipelineId);
  if (!targetStage) {
    logger.warn({ module: MOD, fn: 'promotePastDueForecast', ticketId, pipelineId },
      'No se pudo resolver stage destino para pipeline');
    return false;
  }

  try {
    await client.crm.tickets.basicApi.update(String(ticketId), {
      properties: { hs_pipeline_stage: String(targetStage) },
    });

    logger.warn({
      module: MOD, fn: 'promotePastDueForecast',
      ticketId, pipelineId, targetStage, fechaEsperada, lineItemKey, dealId,
    }, 'FORECAST_PAST_DUE_PROMOTED: forecast con fecha pasada promovido (auto→READY emisible / manual→PRÓXIMOS A FACTURAR)');

    // Asociar al deal + line item (igual que Phase 2)
    if (dealId && lineItemId) {
      try {
        const companyIds = await getDealCompanies(String(dealId)).catch(() => []);
        const contactIds = await getDealContacts(String(dealId)).catch(() => []);
        await createTicketAssociations(
          String(ticketId),
          String(dealId),
          String(lineItemId),
          companyIds || [],
          contactIds || []
        );
      } catch (assocErr) {
        logger.warn(
          { module: MOD, fn: 'promotePastDueForecast', ticketId, dealId, lineItemId, err: assocErr },
          'Error asociando ticket past-due al deal (no bloquea)'
        );
      }

      // Sync fechas en line item
      try {
        await syncLineItemAfterPromotion({
          dealId,
          lineItemId,
          lineItemKey,
          expectedYMD: fechaEsperada,
        });
      } catch (syncErr) {
        logger.warn(
          { module: MOD, fn: 'promotePastDueForecast', ticketId, lineItemId, err: syncErr },
          'syncLineItemAfterPromotion falló (no bloquea)'
        );
      }
    }

    return true;
  } catch (err) {
    logger.error({
      module: MOD, fn: 'promotePastDueForecast',
      ticketId, pipelineId, fechaEsperada, err,
    }, 'Error promoviendo forecast past-due a READY');
    return false;
  }
}
// ─────────────────────────────────────────────
// Función principal
// ─────────────────────────────────────────────

/**
 * Recalcula las propiedades de fecha de un line item mirando sus tickets reales.
 *
 * @param {object} params
 * @param {string} params.lineItemKey - LIK del line item
 * @param {string} [params.dealId] - para logging
 * @param {string} [params.lineItemId] - si se pasa, actualiza el line item en HubSpot
 * @param {boolean} [params.applyUpdate=true] - si false, solo retorna los valores sin escribir
 * @param {object} [params.lineItemProps] - propiedades del line item ya leídas (evita un getById extra)
 * @param {boolean} [params.facturacionActiva=false] - si true, habilita I1 (promover forecasts pasados)
 * @param {object} [params.client] - cliente de HubSpot inyectable (default: el de producción).
 *   Existe para poder ejercitar el camino real en los tests, igual que en las tandas A y B.
 * @param {string} [params.overrideToday] - YYYY-MM-DD para fijar "hoy" (tests).
 *   Misma convención que buildDesiredDates en phasep.js.
 * @returns {object} { lastTicketedDate, lastBillingPeriod, billingLastBilledDate, billingNextDate,
 *                     updates, changed, skipped, promotedCount, emittedCount, forecastCount,
 *                     pastDuePromoted, consumidos, pagosRestantes }
 */
export async function recalcFromTickets({
  lineItemKey,
  dealId = '',
  lineItemId = '',
  applyUpdate = true,
  lineItemProps = null,
  facturacionActiva = false,
  client = hubspotClient,
  overrideToday = '',
}) {
  const fn = 'recalcFromTickets';
  const todayYmd = overrideToday || getTodayYMD();
  const EMPTY_RESULT = {
    lastTicketedDate: '', lastBillingPeriod: '', billingLastBilledDate: '',
    billingNextDate: '', updates: {}, changed: false, skipped: true,
    promotedCount: 0, emittedCount: 0, forecastCount: 0, pastDuePromoted: 0,
    consumidos: 0, pagosRestantes: null,
  };

  if (!lineItemKey) {
    logger.warn({ module: MOD, fn, dealId, lineItemId }, 'lineItemKey vacío, skip');
    return EMPTY_RESULT;
  }

  // ====== GUARD: fechas_completas = true → no recalcular ======
  if (lineItemProps) {
    const fechasCompletas = String(lineItemProps.fechas_completas || '').trim().toLowerCase() === 'true';
    if (fechasCompletas) {
      logger.debug({ module: MOD, fn, lineItemKey, dealId, lineItemId },
        'fechas_completas=true → skip recalc (plan completado)');
      return EMPTY_RESULT;
    }
  }

  // ====== LEER numberOfPayments de lineItemProps (para I3) ======
  let numberOfPayments = 0;
  if (lineItemProps) {
    const raw = lineItemProps.hs_recurring_billing_number_of_payments
      ?? lineItemProps.number_of_payments;
    const parsed = Number.parseInt(String(raw ?? ''), 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      numberOfPayments = parsed;
    }
  }

  // 1) Traer todos los tickets de ambos pipelines
  const [ticketsManual, ticketsAuto] = await Promise.all([
    fetchTicketsForLIK({ lineItemKey, pipelineId: TICKET_PIPELINE, client }),
    fetchTicketsForLIK({ lineItemKey, pipelineId: AUTOMATED_TICKET_PIPELINE, client }),
  ]);

  const allTickets = [...ticketsManual, ...ticketsAuto];

  logger.debug({ module: MOD, fn, lineItemKey, dealId, totalTickets: allTickets.length },
    'Tickets encontrados para recalc');

  // ====== I1: Promover forecasts con fecha pasada a READY ======
  let pastDuePromoted = 0;

  // ====== I1: Promover forecasts con fecha pasada a READY ======
  // Guard: no promover automáticamente en deals mirror UY — el PY controla el flujo
  let skipPastDuePromotion = false;
  if (facturacionActiva && dealId) {
    try {
      const dealForMirrorCheck = await client.crm.deals.basicApi.getById(
        String(dealId), ['es_mirror_de_py']
      );
      if (parseBool(dealForMirrorCheck?.properties?.es_mirror_de_py)) {
        skipPastDuePromotion = true;
        logger.info({ module: MOD, fn, dealId, lineItemKey },
          'Deal es mirror UY — saltando promotePastDueForecast (el PY controla el flujo)');
      }
    } catch (err) {
      logger.warn({ module: MOD, fn, dealId, err },
        'Error leyendo es_mirror_de_py, continuando sin skip');
    }
  }

  if (facturacionActiva && !skipPastDuePromotion) {
    for (const t of allTickets) {
      const isForecast = FORECAST_MANUAL_STAGES.has(t.stage) || FORECAST_AUTO_STAGES.has(t.stage);
      if (!isForecast) continue;
      if (!t.fechaEsperada) continue;
      if (t.fechaEsperada > todayYmd) continue;

      const promoted = await promotePastDueForecast({
        ticketId: t.id,
        pipelineId: t.pipelineId,
        fechaEsperada: t.fechaEsperada,
        lineItemKey,
        dealId,
        lineItemId,   // ← nuevo
        client,
      });

      if (promoted) {
        // Reclasificar en memoria para que el cálculo de abajo lo trate como PROMOTED.
        // `properties` va en el mismo movimiento: es lo que leen los helpers de
        // la frontera, y si queda con la etapa vieja el ticket recién promovido
        // se contaría del lado equivocado.
        t.stage = resolveTargetPromotionStage(t.pipelineId);
        t.properties = { ...t.properties, hs_pipeline_stage: t.stage };
        pastDuePromoted++;
      }
    }
  }

  // 2) Clasificar tickets por grupo de stages
  let lastTicketedDate = '';     // max fecha_resolucion_esperada de PROMOTED
  let lastBillingPeriod = '';    // max fecha_resolucion_esperada de DERIVED (Listo para Facturar+)
  let billingLastBilledDate = ''; // max fecha_real_de_facturacion de EMITTED
  let billingNextDate = '';      // min fecha_resolucion_esperada de FORECAST (futuro)

  const forecastDatesAll = [];

  for (const t of allTickets) {
    const { stage, fechaEsperada, fechaReal } = t;

    // PROMOTED: READY + post-READY (para last_ticketed_date)
    if (PROMOTED_STAGES.has(stage)) {
      if (fechaEsperada && fechaEsperada > lastTicketedDate) {
        lastTicketedDate = fechaEsperada;
      }
    }

// DERIVED: READY + post-READY (para last_billing_period = última cuota derivada)
    if (DERIVED_STAGES.has(stage)) {
      if (fechaEsperada && fechaEsperada > lastBillingPeriod) {
        lastBillingPeriod = fechaEsperada;
      }
    }

    // EMITTED: INVOICED, LATE, PAID (para billing_last_billed_date = última factura real Nodum)
    if (EMITTED_STAGES.has(stage)) {
      if (fechaReal && fechaReal > billingLastBilledDate) {
        billingLastBilledDate = fechaReal;
      }
    }

    // FORECAST: para billing_next_date (solo fechas futuras)
    if (FORECAST_MANUAL_STAGES.has(stage) || FORECAST_AUTO_STAGES.has(stage)) {
      if (fechaEsperada && fechaEsperada > todayYmd) {
        forecastDatesAll.push(fechaEsperada);
      }
    }
  }

  // billing_next_date: la más próxima fecha forecast FUTURA
  if (forecastDatesAll.length > 0) {
    forecastDatesAll.sort();
    billingNextDate = forecastDatesAll[0];
  }

  // ══════════════════════════════════════════════════════════════════════
  // TANDA C — LAS TRES FECHAS (reemplazan lo calculado arriba, flag ON)
  // ══════════════════════════════════════════════════════════════════════
  const etapaUnica = etapaUnicaEnabled();

  // Candidatas NO NOTIFICADAS y futuras (equivalente de forecastDatesAll bajo
  // la frontera nueva) — se necesita la lista, no sólo el mínimo, para I2.
  const noNotificadasFuturas = etapaUnica
    ? allTickets
        .filter(t => isTicketEngineManaged(t) && t.fechaEsperada && t.fechaEsperada > todayYmd)
        .map(t => t.fechaEsperada)
        .sort()
    : forecastDatesAll;

  if (etapaUnica) {
    // NOTIFICADO — la última fecha que cruzó la frontera. Es el mismo número
    // que el piso del cronograma (resolveFloorSourceYmd en phasep.js).
    lastBillingPeriod = fechaUltimaNotificada(allTickets);
    // PRÓXIMA — la próxima fecha no notificada.
    billingNextDate = fechaProximaNoNotificada(allTickets, todayYmd);
    // last_ticketed_date SE ELIMINA: no se calcula ni se escribe.
    lastTicketedDate = '';
    // CONFIRMADO (billingLastBilledDate) queda como está: la fecha real de Nodum
    // no depende de la frontera.
  }

  // ====== I2: la PRÓXIMA nunca puede ser anterior a lo ya NOTIFICADO ======
  // (flag OFF: billing_next_date >= last_ticketed_date, igual que hoy)
  const pisoI2 = etapaUnica ? lastBillingPeriod : lastTicketedDate;
  if (billingNextDate && pisoI2 && billingNextDate < pisoI2) {
    logger.warn({
      module: MOD, fn, lineItemKey, dealId,
      billingNextDate, piso: pisoI2, etapaUnica,
    }, 'INVARIANT_I2: billing_next_date anterior al piso → buscando siguiente válido');

    const valid = noNotificadasFuturas.filter(d => d > pisoI2);
    billingNextDate = valid.length > 0 ? valid[0] : '';
  }

  // ====== CONTEO ======
  const promotedCount = allTickets.filter(t => PROMOTED_STAGES.has(t.stage)).length;
  const emittedCount = allTickets.filter(t => EMITTED_STAGES.has(t.stage)).length;
  const forecastCount = noNotificadasFuturas.length;

  // CONSUMIDOS — cuántas cuotas del plan ya se gastaron.
  // Flag OFF: `promotedCount`, que cuenta PROMOTED_STAGES e **incluye «Próximos
  // a facturar»**. Con la etapa única eso es el bloqueante #1 anotado en
  // etapaUnicaFlags.js: todo el cronograma de un plan ganado vive en «Próximos»
  // ⇒ promotedCount = 12 ≥ 12 ⇒ I3 da el plan por completo y vacía
  // billing_next_date SIN HABER FACTURADO NADA.
  // Flag ON: consumido = cruzó la frontera (notificado, emitido, o período
  // cerrado). Misma cuenta que el `maxCount` de buildDesiredDates.
  const consumidos = etapaUnica ? contarConsumidos(allTickets) : promotedCount;

  // ====== I3: billing_next_date = '' cuando el plan terminó ======
  if (numberOfPayments > 0) {
    // Nota (flag OFF): promotedCount incluye emittedCount (EMITTED ⊂ PROMOTED),
    // por lo que alcanza con promotedCount (todos los no-forecast no-cancelled).
    if (consumidos >= numberOfPayments) {
      if (billingNextDate) {
        logger.info({
          module: MOD, fn, lineItemKey, dealId,
          consumidos, numberOfPayments, billingNextDate, etapaUnica,
        }, 'INVARIANT_I3: plan completo (consumidos >= payments) → billing_next_date = vacío');
      }
      billingNextDate = '';
    }
  }

  logger.debug({
    module: MOD, fn, lineItemKey, dealId,
    promotedCount, emittedCount, forecastCount, pastDuePromoted, consumidos,
    lastTicketedDate, lastBillingPeriod, billingLastBilledDate, billingNextDate,
  }, 'Recalc ticket summary');

  // 3) Leer valores actuales del line item para comparar (update mínimo)
  let currentProps = {};
  if (lineItemId && applyUpdate) {
    try {
      const liResp = await client.crm.lineItems.basicApi.getById(String(lineItemId), [
        'last_ticketed_date',
        'last_billing_period',
        'billing_last_billed_date',
        'billing_next_date',
        'pagos_restantes',
        // TANDA C: varios call sites (phase2/phase3) llaman sin `lineItemProps`,
        // y sin el total no se puede derivar pagos_restantes. Va en el GET que
        // ya se hacía: cero llamadas extra.
        'hs_recurring_billing_number_of_payments',
      ]);
      currentProps = liResp?.properties || {};
    } catch (err) {
      logger.warn({ module: MOD, fn, lineItemId, err },
        'No se pudo leer line item actual, se hará update completo');
    }
  }

  const currentLast = toYmd(currentProps.last_ticketed_date);
  const currentBillingPeriod = toYmd(currentProps.last_billing_period);
  const currentBillingLastBilled = toYmd(currentProps.billing_last_billed_date);
  const currentNext = toYmd(currentProps.billing_next_date);

  // ====== PAGOS RESTANTES — DERIVADO (TANDA C, sólo flag ON) ======
  // Deja de ser el contador decremental de syncAfterPromotion (que descontaba
  // en la promoción de Phase 2 — bajo la llave ya no ocurre, bloqueante #3 de
  // etapaUnicaFlags.js) y pasa a ser total − consumidos. El descuento cae
  // entonces exactamente en el paso a «Notificado», que es la decisión tomada.
  // Sólo para plan fijo: en auto-renew no hay total y no se inventa un número.
  //
  // El total se toma de `lineItemProps` y, si el call site no las pasó, de la
  // lectura de arriba. Se mantiene APARTE de `numberOfPayments` a propósito:
  // esa variable alimenta I3/I4 y cambiarle la fuente movería el
  // comportamiento con la llave APAGADA.
  const totalPagosDerivado = (() => {
    if (numberOfPayments > 0) return numberOfPayments;
    const parsed = Number.parseInt(String(currentProps.hs_recurring_billing_number_of_payments ?? ''), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  })();

  let pagosRestantes = null;
  if (etapaUnica && totalPagosDerivado > 0) {
    pagosRestantes = Math.max(0, totalPagosDerivado - consumidos);
  }

  // 4) Construir update mínimo (solo propiedades que cambiaron)
  const updates = {};
  // `last_ticketed_date` SE ELIMINA con la llave prendida: no se escribe ni
  // para vaciarla. Vaciarla sería un write masivo sobre todo el portal y
  // rompería la red de seguridad de resolveFloorSourceYmd (phasep.js), que la
  // usa como último recurso cuando la búsqueda de tickets vuelve vacía.
  if (!etapaUnica && lastTicketedDate !== currentLast) {
    updates.last_ticketed_date = lastTicketedDate;
  }
  if (lastBillingPeriod !== currentBillingPeriod) {
    updates.last_billing_period = lastBillingPeriod;
  }
  if (billingLastBilledDate !== currentBillingLastBilled) {
    updates.billing_last_billed_date = billingLastBilledDate;
  }

  // ====== I4: billing_next_date — no vaciar si no hay candidatos visibles ======
  if (forecastCount > 0 || (numberOfPayments > 0 && consumidos >= numberOfPayments)) {
    // Hay candidatos no notificados, O el plan está completo (I3 ya puso
    // billingNextDate='') → usar el valor calculado
    if (billingNextDate !== currentNext) {
      updates.billing_next_date = billingNextDate;
    }
  } else if (currentNext && !billingNextDate) {
    // No hay candidatos y no podemos confirmar plan completo → proteger
    logger.info({ module: MOD, fn, lineItemKey, dealId, lineItemId, currentNext },
      'INVARIANT_I4: billing_next_date protegido: no hay candidatos visibles, manteniendo valor actual');
  } else if (billingNextDate !== currentNext) {
    updates.billing_next_date = billingNextDate;
  }

  // pagos_restantes derivado — sólo si cambió, y sólo con la llave prendida.
  const currentPagosRestantesRaw = currentProps.pagos_restantes;
  const currentPagosRestantes = Number.parseInt(String(currentPagosRestantesRaw ?? ''), 10);
  const pagosRestantesCambio =
    pagosRestantes !== null &&
    (!Number.isFinite(currentPagosRestantes) || currentPagosRestantes !== pagosRestantes);
  if (pagosRestantesCambio) {
    updates.pagos_restantes = String(pagosRestantes);
  }

  const changed = Object.keys(updates).length > 0;

  // 5) Aplicar update si corresponde
  if (changed && lineItemId && applyUpdate) {
    try {
      await client.crm.lineItems.basicApi.update(String(lineItemId), { properties: updates });
      logger.info({ module: MOD, fn, lineItemKey, dealId, lineItemId, updates },
        'Line item actualizado desde tickets');

      // Alerta «pagos completos»: la disparaba syncAfterPromotion al llegar el
      // decremento a 0. Con el contador derivado ese decremento ya no pasa por
      // ahí, así que la alerta se emite acá — SÓLO EN LA TRANSICIÓN a 0, igual
      // que antes (si ya estaba en 0 y se reconfirma, no se avisa: es la misma
      // lección del re-disparo sin transición que costó el fix del 22-jul).
      // `alertPagosCompletos` respeta DEAL_ALERTS_ENABLED por su cuenta.
      if (
        etapaUnica &&
        pagosRestantes === 0 &&
        pagosRestantesCambio &&
        Number.isFinite(currentPagosRestantes)
      ) {
        alertPagosCompletos({ dealId, lineItemId, lineItemName: null })
          .catch(err => logger.warn({ module: MOD, fn, lineItemId, err: err?.message },
            'alertPagosCompletos falló (no bloquea)'));
      }
    } catch (err) {
      logger.error({ module: MOD, fn, lineItemKey, dealId, lineItemId, updates, err },
        'Error actualizando line item desde tickets');
    }
  } else if (!changed) {
    logger.debug({ module: MOD, fn, lineItemKey, dealId, lineItemId },
      'Sin cambios necesarios');
  }

  return {
    lastTicketedDate,
    lastBillingPeriod,
    billingLastBilledDate,
    billingNextDate,
    updates,
    changed,
    skipped: false,
    promotedCount,
    emittedCount,
    forecastCount,
    pastDuePromoted,
    consumidos,
    pagosRestantes,
  };
}