// src/services/lineItems/recalcFromTickets.js
//
// Recalcula las propiedades de fecha del line item mirando los tickets
// reales que existen en HubSpot para ese lineItemKey.
//
// Propiedades recalculadas:
//   - last_ticketed_date       ← fecha_resolucion_esperada más reciente de tickets PROMOTED (READY+)
//   - last_billing_period      ← fecha_resolucion_esperada más reciente de tickets EMITTED
//   - billing_last_billed_date ← fecha_real_de_facturacion más reciente de tickets EMITTED
//   - billing_next_date        ← fecha_resolucion_esperada más próxima de tickets FORECAST (futuro)
//
// Invariantes enforced:
//   I1: Forecast con fecha pasada → promover a READY (si facturacionActiva=true)
//   I2: billing_next_date nunca puede ser < last_ticketed_date
//   I3: billing_next_date = '' cuando promotedCount + emittedCount >= numberOfPayments
//   I4: Si no hay forecasts visibles → NO borrar billing_next_date existente
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
  BILLING_AUTOMATED_CANCELLED,
} from '../../config/constants.js';
import { getTodayYMD } from '../../utils/dateUtils.js';
import logger from '../../../lib/logger.js';

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
 * Retorna array de { id, stage, pipelineId, fechaEsperada, fechaReal }.
 */
async function fetchTicketsForLIK({ lineItemKey, pipelineId }) {
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
      ],
      sorts: [{ propertyName: 'fecha_resolucion_esperada', direction: 'ASCENDING' }],
      limit: 100,
    };

    if (after) {
      searchBody.after = after;
    }

    let res;
    try {
      res = await hubspotClient.crm.tickets.searchApi.doSearch(searchBody);
    } catch (err) {
      logger.warn({ module: MOD, fn: 'fetchTicketsForLIK', lineItemKey, pipelineId, err },
        'Error buscando tickets para LIK');
      return allTickets;
    }

    const results = res?.results || [];
    for (const t of results) {
      const p = t?.properties || {};
      const stage = String(p.hs_pipeline_stage || '');

      // Excluir cancelados
      if (cancelledStages.has(stage)) continue;

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
// I1: Promover forecasts con fecha pasada a READY
// ─────────────────────────────────────────────

/**
 * Resuelve el stage READY destino según el pipeline del ticket.
 */
function resolveReadyStage(pipelineId) {
  if (String(pipelineId) === String(AUTOMATED_TICKET_PIPELINE)) {
    return BILLING_AUTOMATED_READY;
  }
  // Manual pipeline → TICKET_STAGES.NEW (entrada al flujo manual)
  return TICKET_STAGES.NEW;
}

/**
 * Promueve un ticket forecast con fecha pasada a READY.
 * Retorna true si se promovió, false si falló.
 */
async function promotePastDueForecast({ ticketId, pipelineId, fechaEsperada, lineItemKey, dealId }) {
  const readyStage = resolveReadyStage(pipelineId);
  if (!readyStage) {
    logger.warn({ module: MOD, fn: 'promotePastDueForecast', ticketId, pipelineId },
      'No se pudo resolver READY stage para pipeline');
    return false;
  }

  try {
    await hubspotClient.crm.tickets.basicApi.update(String(ticketId), {
      properties: { hs_pipeline_stage: String(readyStage) },
    });

    logger.warn({
      module: MOD, fn: 'promotePastDueForecast',
      ticketId, pipelineId, readyStage, fechaEsperada, lineItemKey, dealId,
    }, 'FORECAST_PAST_DUE_PROMOTED: ticket forecast con fecha pasada promovido a READY');

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
 * @returns {object} { lastTicketedDate, lastBillingPeriod, billingLastBilledDate, billingNextDate,
 *                     updates, changed, skipped, promotedCount, emittedCount, forecastCount,
 *                     pastDuePromoted }
 */
export async function recalcFromTickets({
  lineItemKey,
  dealId = '',
  lineItemId = '',
  applyUpdate = true,
  lineItemProps = null,
  facturacionActiva = false,
}) {
  const fn = 'recalcFromTickets';
  const todayYmd = getTodayYMD();
  const EMPTY_RESULT = {
    lastTicketedDate: '', lastBillingPeriod: '', billingLastBilledDate: '',
    billingNextDate: '', updates: {}, changed: false, skipped: true,
    promotedCount: 0, emittedCount: 0, forecastCount: 0, pastDuePromoted: 0,
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
    fetchTicketsForLIK({ lineItemKey, pipelineId: TICKET_PIPELINE }),
    fetchTicketsForLIK({ lineItemKey, pipelineId: AUTOMATED_TICKET_PIPELINE }),
  ]);

  const allTickets = [...ticketsManual, ...ticketsAuto];

  logger.debug({ module: MOD, fn, lineItemKey, dealId, totalTickets: allTickets.length },
    'Tickets encontrados para recalc');

  // ====== I1: Promover forecasts con fecha pasada a READY ======
  let pastDuePromoted = 0;

  if (facturacionActiva) {
    for (const t of allTickets) {
      const isForecast = FORECAST_MANUAL_STAGES.has(t.stage) || FORECAST_AUTO_STAGES.has(t.stage);
      if (!isForecast) continue;
      if (!t.fechaEsperada) continue;
      if (t.fechaEsperada > todayYmd) continue; // futuro → no tocar

      // Fecha pasada o de hoy en FORECAST → promover
      const promoted = await promotePastDueForecast({
        ticketId: t.id,
        pipelineId: t.pipelineId,
        fechaEsperada: t.fechaEsperada,
        lineItemKey,
        dealId,
      });

      if (promoted) {
        // Reclasificar en memoria para que el cálculo de abajo lo trate como PROMOTED
        t.stage = resolveReadyStage(t.pipelineId);
        pastDuePromoted++;
      }
    }
  }

  // 2) Clasificar tickets por grupo de stages
  let lastTicketedDate = '';     // max fecha_resolucion_esperada de PROMOTED
  let lastBillingPeriod = '';    // max fecha_resolucion_esperada de EMITTED
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

    // EMITTED: INVOICED, LATE, PAID (para last_billing_period y billing_last_billed_date)
    if (EMITTED_STAGES.has(stage)) {
      if (fechaEsperada && fechaEsperada > lastBillingPeriod) {
        lastBillingPeriod = fechaEsperada;
      }
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

  // ====== I2: billing_next_date nunca puede ser < last_ticketed_date ======
  if (billingNextDate && lastTicketedDate && billingNextDate < lastTicketedDate) {
    logger.warn({
      module: MOD, fn, lineItemKey, dealId,
      billingNextDate, lastTicketedDate,
    }, 'INVARIANT_I2: billing_next_date < last_ticketed_date → buscando siguiente válido');

    // Buscar el primer forecast con fecha > lastTicketedDate
    const valid = forecastDatesAll.filter(d => d > lastTicketedDate);
    billingNextDate = valid.length > 0 ? valid[0] : '';
  }

  // ====== CONTEO ======
  const promotedCount = allTickets.filter(t => PROMOTED_STAGES.has(t.stage)).length;
  const emittedCount = allTickets.filter(t => EMITTED_STAGES.has(t.stage)).length;
  const forecastCount = forecastDatesAll.length;

  // ====== I3: billing_next_date = '' cuando el plan terminó ======
  if (numberOfPayments > 0) {
    const totalResolved = promotedCount + emittedCount;
    // Nota: promotedCount incluye emittedCount (EMITTED ⊂ PROMOTED),
    // pero lo que importa es: ¿ya hay suficientes tickets no-forecast?
    // promotedCount ya cuenta READY + INVOICED + LATE + PAID,
    // por lo que promotedCount >= emittedCount siempre.
    // Usamos solo promotedCount (que incluye todos los no-forecast no-cancelled).
    if (promotedCount >= numberOfPayments) {
      if (billingNextDate) {
        logger.info({
          module: MOD, fn, lineItemKey, dealId,
          promotedCount, numberOfPayments, billingNextDate,
        }, 'INVARIANT_I3: plan completo (promoted >= payments) → billing_next_date = vacío');
      }
      billingNextDate = '';
    }
  }

  logger.debug({
    module: MOD, fn, lineItemKey, dealId,
    promotedCount, emittedCount, forecastCount, pastDuePromoted,
    lastTicketedDate, lastBillingPeriod, billingLastBilledDate, billingNextDate,
  }, 'Recalc ticket summary');

  // 3) Leer valores actuales del line item para comparar (update mínimo)
  let currentProps = {};
  if (lineItemId && applyUpdate) {
    try {
      const liResp = await hubspotClient.crm.lineItems.basicApi.getById(String(lineItemId), [
        'last_ticketed_date',
        'last_billing_period',
        'billing_last_billed_date',
        'billing_next_date',
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

  // 4) Construir update mínimo (solo propiedades que cambiaron)
  const updates = {};
  if (lastTicketedDate !== currentLast) {
    updates.last_ticketed_date = lastTicketedDate;
  }
  if (lastBillingPeriod !== currentBillingPeriod) {
    updates.last_billing_period = lastBillingPeriod;
  }
  if (billingLastBilledDate !== currentBillingLastBilled) {
    updates.billing_last_billed_date = billingLastBilledDate;
  }

  // ====== I4: billing_next_date — no vaciar si no hay forecasts visibles ======
  if (forecastCount > 0 || (numberOfPayments > 0 && promotedCount >= numberOfPayments)) {
    // Hay forecasts, O el plan está completo (I3 ya puso billingNextDate='')
    // → usar el valor calculado
    if (billingNextDate !== currentNext) {
      updates.billing_next_date = billingNextDate;
    }
  } else if (currentNext && !billingNextDate) {
    // No hay forecasts y no podemos confirmar plan completo → proteger
    logger.info({ module: MOD, fn, lineItemKey, dealId, lineItemId, currentNext },
      'INVARIANT_I4: billing_next_date protegido: no hay forecasts visibles, manteniendo valor actual');
  } else if (billingNextDate !== currentNext) {
    updates.billing_next_date = billingNextDate;
  }

  const changed = Object.keys(updates).length > 0;

  // 5) Aplicar update si corresponde
  if (changed && lineItemId && applyUpdate) {
    try {
      await hubspotClient.crm.lineItems.basicApi.update(String(lineItemId), { properties: updates });
      logger.info({ module: MOD, fn, lineItemKey, dealId, lineItemId, updates },
        'Line item actualizado desde tickets');
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
  };
}