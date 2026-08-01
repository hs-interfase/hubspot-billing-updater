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
import { etapaUnicaEnabled } from '../config/etapaUnicaFlags.js';

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

  // ETAPA ÚNICA (flag ON): la frontera es la notificación, así que el recálculo
  // del VALOR alcanza TODO el pipeline manual — lo no notificado (que ahora
  // incluye «Próximos a facturar» y los viejos 85/95) y lo ya notificado, que
  // hoy también pasa. Es una AMPLIACIÓN del set de hoy, no un reemplazo:
  // recortarlo a "sólo lo no notificado" apagaría el recálculo para los tickets
  // emitidos, que hoy sí lo dispara.
  //
  // El guard anti-tormenta deja de hacer falta acá: bajo la misma flag, Phase P
  // ya no re-snapshotea los tickets manuales no notificados (phasep.js), que era
  // la fuente de los writes masivos sobre monto_unitario_real / cantidad_real /
  // of_costo_usd / dolar.
  if (etapaUnicaEnabled()) return true;

  return !FORECAST_MANUAL_STAGES.has(String(stage));
}

// ─── associationChange (RUTA 8: etiquetas de empresa del ticket) ──────────────
//
// Los eventos de asociación tienen OTRA forma que los propertyChange: NO traen
// `objectId` ni `propertyName`; el objeto que cambió viene en `fromObjectId`, y el
// tipo de vínculo en `associationType` (p.ej. "DEAL_TO_COMPANY"). Por eso el router
// los atiende ANTES del guard de objectId — un 400 haría que HubSpot reintente 10
// veces y pueda deshabilitar la suscripción.

/** ¿Es un evento de cambio de asociación (cualquier objeto)? */
export function esEventoAssociationChange(payload) {
  return String(payload?.subscriptionType || '').endsWith('.associationChange');
}

/**
 * Decide si un associationChange debe disparar el re-sync de etiquetas del ticket.
 * Sólo aplica a negocio↔empresa: es el vínculo del que salen las etiquetas
 * "Empresa Factura" / "Partner" que el ticket espeja.
 *
 * @param {Object} payload - evento crudo de HubSpot
 * @returns {{aplica:boolean, dealId:string|null, associationType:string,
 *   associationRemoved:boolean, motivo?:string}}
 */
export function rutearAssociationChangeDealCompany(payload) {
  const objectType = String(payload?.subscriptionType || '').split('.')[0];
  const associationType = String(payload?.associationType || '').toUpperCase();
  const dealId = String(payload?.fromObjectId ?? payload?.objectId ?? '').trim();
  const associationRemoved = Boolean(payload?.associationRemoved);

  if (objectType !== 'deal' || !associationType.includes('COMPANY')) {
    return { aplica: false, motivo: 'no_es_negocio_empresa', dealId: null, associationType, associationRemoved };
  }
  if (!dealId) {
    return { aplica: false, motivo: 'sin_from_object_id', dealId: null, associationType, associationRemoved };
  }
  // Tanto el alta como la baja de la asociación importan: si sacaron del negocio a
  // la empresa que facturaba, el ticket tiene que perder esa etiqueta.
  return { aplica: true, dealId, associationType, associationRemoved };
}
