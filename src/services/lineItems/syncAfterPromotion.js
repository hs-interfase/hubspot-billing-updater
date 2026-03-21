// src/services/lineItems/syncAfterPromotion.js
import { hubspotClient } from '../../hubspotClient.js';
import {
  TICKET_PIPELINE,
  AUTOMATED_TICKET_PIPELINE,
  FORECAST_MANUAL_STAGES,
  FORECAST_AUTO_STAGES,
} from '../../config/constants.js';
import logger from '../../../lib/logger.js';
import { reportHubSpotError } from '../../utils/hubspotErrorCollector.js';

/**
 * Helper anti-spam: reporta a HubSpot solo errores 4xx accionables (≠ 429).
 * 429 y 5xx son transitorios → solo logger.error, sin reporte.
 */
function reportIfActionable({ objectType, objectId, message, err }) {
  const status = err?.response?.status ?? err?.statusCode ?? null;
  if (status === null) {
    reportHubSpotError({ objectType, objectId, message });
    return;
  }
  if (status === 429 || status >= 500) return;
  if (status >= 400 && status < 500) {
    reportHubSpotError({ objectType, objectId, message });
  }
}

/**
 * Devuelve el YYYY-MM-DD más chico > afterYMD para tickets FORECAST
 * del mismo lineItemKey, dentro de un pipeline específico.
 *
 * - Sin asociaciones
 * - Solo Search API
 * - Toma fecha desde fecha_resolucion_esperada o fallback parseando of_ticket_key
 */
async function findNextForecastYMDForLineItemKeyInPipeline({
  lineItemKey,
  afterYMD,
  forecastStageIds,
  pipelineId,
}) {
  if (!lineItemKey) return '';
  if (!afterYMD) return '';

  let res;
  try {
    res = await hubspotClient.crm.tickets.searchApi.doSearch({
      filterGroups: [
        {
          filters: [
            { propertyName: 'of_line_item_key', operator: 'EQ', value: String(lineItemKey) },
            { propertyName: 'hs_pipeline', operator: 'EQ', value: String(pipelineId) },
            { propertyName: 'hs_pipeline_stage', operator: 'IN', values: forecastStageIds },
          ],
        },
      ],
      properties: ['fecha_resolucion_esperada', 'of_ticket_key', 'hs_pipeline_stage'],
      limit: 100,
    });
  } catch (err) {
    logger.warn({ module: 'syncAfterPromotion', fn: 'findNextForecastYMDForLineItemKeyInPipeline', lineItemKey, afterYMD, pipelineId, err }, '[findNextForecastYMD] search error');
    return '';
  }

  const tickets = res?.results || [];
  if (!tickets.length) return '';

  const dates = [];
  for (const t of tickets) {
    const p = t?.properties || {};

    // 1) preferimos la fecha explícita si existe
    let ymd = (p.fecha_resolucion_esperada || '').slice(0, 10);

    // 2) fallback: parsear of_ticket_key = dealId::LIK:<lineItemKey>::YYYY-MM-DD
    if (!ymd && p.of_ticket_key) {
      const parts = String(p.of_ticket_key).split('::');
      const last = parts[parts.length - 1];
      if (last && /^\d{4}-\d{2}-\d{2}$/.test(last)) ymd = last;
    }

    if (!ymd) continue;
    if (ymd > afterYMD) dates.push(ymd);
  }

  if (!dates.length) return '';
  dates.sort(); // lexicográfico sirve para YYYY-MM-DD
  return dates[0] || '';
}

export async function syncLineItemAfterPromotion({
  dealId,
  lineItemId,
  lineItemKey,  // LIK
  expectedYMD,  // fecha_resolucion_esperada del ticket promovido (YYYY-MM-DD)
}) {
  if (!lineItemId) throw new Error('syncLineItemAfterPromotion: lineItemId requerido');
  if (!lineItemKey) throw new Error('syncLineItemAfterPromotion: lineItemKey requerido');
  if (!expectedYMD) return;

  // 1) Leer line item (mínimo)
  let lineItem;
  try {
    lineItem = await hubspotClient.crm.lineItems.basicApi.getById(String(lineItemId), [
      'billing_next_date',
      'last_ticketed_date',
      'hs_recurring_billing_number_of_payments',
      'pagos_restantes',
    ]);
  } catch (err) {
    logger.warn({ module: 'syncAfterPromotion', fn: 'syncLineItemAfterPromotion', lineItemId, err }, '[syncLineItemAfterPromotion] No se pudo leer line item');
    return;
  }

  const lp = lineItem?.properties || {};
  const currentLast = (lp.last_ticketed_date || '').slice(0, 10);
  const currentNext = (lp.billing_next_date || '').slice(0, 10);

  // ====== PAGOS RESTANTES (promesas) ======
  const totalPaymentsRaw = lp.hs_recurring_billing_number_of_payments;
  const totalPayments = Number.parseInt(String(totalPaymentsRaw ?? ''), 10);
  const hasTotalPayments = Number.isFinite(totalPayments) && totalPayments > 0;

  const currentRemainingRaw = lp.pagos_restantes;
  const currentRemaining = Number.parseInt(String(currentRemainingRaw ?? ''), 10);

  // init: si pagos_restantes no está seteado, lo arrancamos en totalPayments
  let newRemaining = currentRemaining;
  if (!Number.isFinite(currentRemaining) || currentRemaining < 0) {
    newRemaining = hasTotalPayments ? totalPayments : currentRemaining; // si no hay total, no inventamos
  }

  // decrement por promoción (consume 1 promesa)
  if (Number.isFinite(newRemaining)) {
    newRemaining = Math.max(0, newRemaining - 1);
  }

  // 2) last_ticketed_date monotónico
  let newLast = currentLast;
  if (!currentLast || expectedYMD > currentLast) newLast = expectedYMD;

  // 3) stages forecast (unión de ambos sets)
  const forecastStageIds = [
    ...FORECAST_MANUAL_STAGES,
    ...FORECAST_AUTO_STAGES,
  ].map(String);

  // 4) nextForecastYMD: buscar en manual y auto, quedarnos con la más próxima
  const [nextManual, nextAuto] = await Promise.all([
    findNextForecastYMDForLineItemKeyInPipeline({
      lineItemKey,
      afterYMD: expectedYMD,
      forecastStageIds,
      pipelineId: TICKET_PIPELINE,
    }),
    findNextForecastYMDForLineItemKeyInPipeline({
      lineItemKey,
      afterYMD: expectedYMD,
      forecastStageIds,
      pipelineId: AUTOMATED_TICKET_PIPELINE,
    }),
  ]);

  let nextForecastYMD = '';
  if (nextManual && nextAuto) nextForecastYMD = nextManual < nextAuto ? nextManual : nextAuto;
  else nextForecastYMD = nextManual || nextAuto || '';

  // 5) Guardrail: next no puede ser igual a last
  if (nextForecastYMD && nextForecastYMD === newLast) {
    const [m2, a2] = await Promise.all([
      findNextForecastYMDForLineItemKeyInPipeline({
        lineItemKey,
        afterYMD: newLast,
        forecastStageIds,
        pipelineId: TICKET_PIPELINE,
      }),
      findNextForecastYMDForLineItemKeyInPipeline({
        lineItemKey,
        afterYMD: newLast,
        forecastStageIds,
        pipelineId: AUTOMATED_TICKET_PIPELINE,
      }),
    ]);

    if (m2 && a2) nextForecastYMD = m2 < a2 ? m2 : a2;
    else nextForecastYMD = m2 || a2 || '';
  }

  let newNext = nextForecastYMD || '';

  // 6) Monotonicidad suave de next: si ya tenías un next más adelantado, no lo bajes
  if (currentNext && currentNext > newLast) {
    if (!newNext || currentNext > newNext) newNext = currentNext;
  }

  // Regla dura final
  if (newNext && newNext === newLast) newNext = '';

  // 7) Update mínimo
  const updates = {};
  if (newLast !== currentLast) updates.last_ticketed_date = newLast;
  if (newNext !== currentNext) updates.billing_next_date = newNext;

  // guardar pagos_restantes si es válido
  if (Number.isFinite(newRemaining)) {
    const cur = Number.isFinite(currentRemaining) ? currentRemaining : null;
    if (cur === null || newRemaining !== cur) {
      updates.pagos_restantes = String(newRemaining);
    }
  }

  if (!Object.keys(updates).length) {
    logger.info({
      module: 'syncAfterPromotion',
      fn: 'syncLineItemAfterPromotion',
      dealId,
      lineItemId,
      lineItemKey,
      expectedYMD,
      currentLast,
      currentNext,
    }, '[syncLineItemAfterPromotion] no action');
    return;
  }

  try {
    await hubspotClient.crm.lineItems.basicApi.update(String(lineItemId), { properties: updates });
    logger.info({
      module: 'syncAfterPromotion',
      fn: 'syncLineItemAfterPromotion',
      dealId,
      lineItemId,
      lineItemKey,
      expectedYMD,
      updates,
    }, '[syncLineItemAfterPromotion] LineItem actualizado');
  } catch (err) {
    logger.error({ module: 'syncAfterPromotion', fn: 'syncLineItemAfterPromotion', lineItemId, err }, '[syncLineItemAfterPromotion] No se pudo actualizar line item');
    reportIfActionable({
      objectType: 'line_item',
      objectId: lineItemId,
      message: `line_item_update_failed (syncLineItemAfterPromotion): ${err?.message || err}`,
      err,
    });
  }
}

/*
 * ─────────────────────────────────────────────────────────────
 * CATCHES con reportHubSpotError agregados:
 *
 * 1. syncLineItemAfterPromotion() — hubspotClient.crm.lineItems.basicApi.update()
 *    update final de last_ticketed_date / billing_next_date / pagos_restantes
 *    → objectType: "line_item", objectId: lineItemId
 *    → NO lleva continue (no está dentro de un loop)
 *
 * NO reportados (fuera de criterio o no accionables):
 * - findNextForecastYMDForLineItemKeyInPipeline() catch de searchApi
 *   → es una búsqueda, no un update de objeto; solo logger.warn
 * - syncLineItemAfterPromotion() catch de getById (lectura inicial)
 *   → es una lectura, no un update accionable; solo logger.warn
 *
 * Confirmación: "No se reportan warns a HubSpot;
 *                solo errores 4xx (≠429)" — implementado en reportIfActionable().
 * ─────────────────────────────────────────────────────────────
 */
