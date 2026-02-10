// src/services/lineItems/syncAfterPromotion.js
import { hubspotClient } from '../../hubspotClient.js';
import { findNextForecastYMDForLineItemKey } from '../tickets/ticketService.js';
import {
  BILLING_TICKET_PIPELINE_ID,
  BILLING_TICKET_FORECAST_MANUAL_STAGE_ID,
  BILLING_TICKET_FORECAST_AUTO_STAGE_ID,
} from '../../config/constants.js';

export async function syncLineItemAfterPromotion({
  dealId,       // opcional: logs
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
    ]);
  } catch (e) {
    console.warn('[syncLineItemAfterPromotion] No se pudo leer line item:', e?.message);
    return;
  }

  const lp = lineItem?.properties || {};
  const currentLast = (lp.last_ticketed_date || '').slice(0, 10);
  const currentNext = (lp.billing_next_date || '').slice(0, 10);

  // 2) last_ticketed_date monotónico
  let newLast = currentLast;
  if (!currentLast || expectedYMD > currentLast) newLast = expectedYMD;

  // 3) nextForecastYMD (por tickets forecast del mismo LIK)
  const forecastStages = [
    String(BILLING_TICKET_FORECAST_MANUAL_STAGE_ID),
    String(BILLING_TICKET_FORECAST_AUTO_STAGE_ID),
  ];

  let nextForecastYMD = await findNextForecastYMDForLineItemKey({
    lineItemKey,
    afterYMD: expectedYMD,
    forecastStageIds: forecastStages,
    pipelineId: BILLING_TICKET_PIPELINE_ID,
  });

  // 4) Guardrail: next no puede ser igual a last
  if (nextForecastYMD && nextForecastYMD === newLast) {
    nextForecastYMD = await findNextForecastYMDForLineItemKey({
      lineItemKey,
      afterYMD: newLast,
      forecastStageIds: forecastStages,
      pipelineId: BILLING_TICKET_PIPELINE_ID,
    });
  }

  let newNext = nextForecastYMD || '';

  // 5) Monotonicidad suave de next: si ya tenías un next más adelantado, no lo bajes
  // (esto evita "retrocesos" por re-runs o por tickets forecast que todavía no se ven en search)
  if (currentNext && currentNext > newLast) {
    if (!newNext || currentNext > newNext) newNext = currentNext;
  }

  // Regla dura final
  if (newNext && newNext === newLast) newNext = '';

  // 6) Update mínimo
  const updates = {};
  if (newLast !== currentLast) updates.last_ticketed_date = newLast;
  if (newNext !== currentNext) updates.billing_next_date = newNext;

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
