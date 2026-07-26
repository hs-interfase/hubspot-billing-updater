// src/utils/webhookRouteRules.js
//
// Reglas PURAS de ruteo de webhooks (sin red, sin db) — testeables en aislamiento.
//
// ticket.propertyChange → valor_recalc:
// Para plan fijo / pago único el VALOR del deal = Σ subtotal_real de sus TICKETS
// (ver src/services/deal/recalcValorTotal.js). Si el responsable corrige montos
// de un ticket editable (monto_unitario_real, cantidad_real, of_costo_usd, dolar),
// el VALOR debe recalcularse.
//
// GUARD ANTI-TORMENTA (esTicketEditableParaValor):
// El motor escribe estas mismas props en los tickets FORECAST durante el
// re-snapshot masivo de phasep — cada corrida dispararía decenas/cientos de
// webhooks ticket.propertyChange que volverían acá. Por eso SOLO se encola si
// el ticket pertenece al pipeline MANUAL y su etapa NO es forecast (es decir,
// la ventana en que administración lo edita a mano). Los pocos writes del motor
// al promover (ticket ya en etapa no-forecast) pueden pasar el guard: aceptable,
// la cola dedupea por (deal_id, action_type) y recalcValorTotal es idempotente.

import { TICKET_PIPELINE, FORECAST_MANUAL_STAGES } from '../config/constants.js';

/**
 * Props del TICKET cuyo cambio afecta el VALOR del deal (subtotal_real derivado).
 * Las 4 están suscritas en la app de HubSpot (ver docs/WEBHOOK_SUBSCRIPTIONS_prod_2026-07-14.md).
 * NO incluir props que escribe el motor en emisión (subtotal_real, of_costo, of_margen).
 */
export const TICKET_VALOR_RECALC_PROPS = new Set([
  'monto_unitario_real',
  'cantidad_real',
  'of_costo_usd',
  'dolar',
]);

/**
 * ¿Este evento de webhook es una edición de monto de ticket que afecta el VALOR?
 * @param {string} objectType   - tipo del objeto del evento ('ticket' | 'line_item' | ...)
 * @param {string} propertyName - prop cambiada
 * @returns {boolean}
 */
export function esEventoTicketValor(objectType, propertyName) {
  return objectType === 'ticket' && TICKET_VALOR_RECALC_PROPS.has(propertyName);
}

/**
 * ¿El ticket está en la ventana editable por administración?
 * true ⇔ pipeline MANUAL y etapa NO forecast.
 * Guard anti-tormenta: los writes del motor sobre tickets forecast (re-snapshot
 * de phasep) NO deben encolar valor_recalc.
 * undefined/null en pipeline o stage → false (ante la duda, no encolar).
 * @param {Object} info
 * @param {string|number} [info.pipeline] - hs_pipeline del ticket
 * @param {string|number} [info.stage]    - hs_pipeline_stage del ticket
 * @returns {boolean}
 */
export function esTicketEditableParaValor({ pipeline, stage } = {}) {
  if (pipeline == null || stage == null) return false;
  if (String(pipeline) !== String(TICKET_PIPELINE)) return false;
  return !FORECAST_MANUAL_STAGES.has(String(stage));
}
