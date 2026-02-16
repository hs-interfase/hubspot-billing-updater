// src/services/lineItems/syncAfterPromotion.js
import { hubspotClient } from '../../hubspotClient.js';
import {
  TICKET_PIPELINE,
  AUTOMATED_TICKET_PIPELINE,
  FORECAST_MANUAL_STAGES,
  FORECAST_AUTO_STAGES,
} from '../../config/constants.js';

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
            // HubSpot Search API: "IN" usa "values"
            { propertyName: 'hs_pipeline_stage', operator: 'IN', values: forecastStageIds },
          ],
        },
      ],
      properties: ['fecha_resolucion_esperada', 'of_ticket_key', 'hs_pipeline_stage'],
      limit: 100,
    });
  } catch (e) {
    console.warn('[findNextForecastYMD] search error:', e?.message);
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
    // o si tu key es dealId::LIK:xxx::YYYY-MM-DD y no trae fecha_resolucion_esperada
    if (!ymd && p.of_ticket_key) {
      const parts = String(p.of_ticket_key).split('::');
      // usualmente el último es YYYY-MM-DD
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
  } catch (e) {
    console.warn('[syncLineItemAfterPromotion] No se pudo leer line item:', e?.message);
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
    console.log('[syncLineItemAfterPromotion] no action', {
      dealId,
      lineItemId,
      lineItemKey,
      expectedYMD,
      currentLast,
      currentNext,
    });
    return;
  }

  try {
    await hubspotClient.crm.lineItems.basicApi.update(String(lineItemId), { properties: updates });
    console.log('[syncLineItemAfterPromotion] LineItem actualizado:', {
      dealId,
      lineItemId,
      lineItemKey,
      expectedYMD,
      updates,
    });
  } catch (e) {
    console.warn('[syncLineItemAfterPromotion] No se pudo actualizar line item:', e?.message);
  }
}
