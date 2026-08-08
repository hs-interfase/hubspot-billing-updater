// src/utils/ticketFrontera.js
//
// LA FRONTERA ES LA NOTIFICACIÓN — helpers a nivel TICKET.
//
// Los predicados por STAGE viven en config/constants.js (isEngineManagedStage /
// isPastFrontierStage / isCancelledTicketStage). Acá está lo que necesita mirar
// el ticket entero, que es un solo caso pero es el que evita perder plata:
// distinguir el ticket CANCELADO por el motor del ticket CANCELADO porque su
// factura se anuló definitivamente (período cerrado).
//
// Fuente única para Phase P, cancelForecastTickets y el sync quirúrgico: si la
// frontera se define en dos lados, en algún momento van a diferir.
//
// Ver definitivos/PLAN_proximos_cambios_tickets_2026-07-29.md §2.0 y §2.4.

import {
  isEngineManagedStage,
  isCancelledTicketStage,
  TICKET_PIPELINE,
} from '../config/constants.js';
import { etapaUnicaEnabled } from '../config/etapaUnicaFlags.js';

/** hs_pipeline_stage del ticket, normalizado a string. */
export function stageOf(ticket) {
  return String(ticket?.properties?.hs_pipeline_stage || '');
}

/** hs_pipeline del ticket, normalizado a string. */
export function pipelineOf(ticket) {
  return String(ticket?.properties?.hs_pipeline || '');
}

/** ¿Es del pipeline MANUAL? (vacío/desconocido ⇒ false) */
export function esTicketManual(ticket) {
  return Boolean(TICKET_PIPELINE) && pipelineOf(ticket) === String(TICKET_PIPELINE);
}

/**
 * ¿El motor manda sobre la estructura de este ticket?
 * Flag OFF ⇒ los forecast de siempre. Flag ON ⇒ + «Próximos a facturar».
 */
export function isTicketEngineManaged(ticket) {
  return isEngineManagedStage(stageOf(ticket));
}

/**
 * Ticket CANCELADO cuyo período quedó CERRADO por la cancelación definitiva de
 * su factura (finalizeTicketAfterDefinitiveCancellation conserva `of_invoice_id`
 * a propósito, justamente para que el período no se re-abra).
 * Cuenta como consumido y protege su fecha: NO se vuelve a armar.
 */
export function isTicketPeriodoCerrado(ticket) {
  if (!isCancelledTicketStage(stageOf(ticket))) return false;
  return String(ticket?.properties?.of_invoice_id || '').trim().length > 0;
}

/**
 * Ticket CANCELADO por el motor o por perder/suspender el negocio (sin factura
 * detrás). Ni protege su fecha ni cuenta como consumido: si esa fecha vuelve a
 * ser parte del cronograma, se arma un ticket nuevo (§2.4).
 */
export function isTicketCanceladoSinFactura(ticket) {
  return isCancelledTicketStage(stageOf(ticket)) && !isTicketPeriodoCerrado(ticket);
}

/**
 * ¿Este ticket ya cruzó la frontera? = notificado o posterior, o período
 * cerrado. Es lo que define el PISO del cronograma y el conteo de CONSUMIDOS.
 */
export function hasTicketCrossedFrontier(ticket) {
  const stage = stageOf(ticket);
  if (!stage) return false;
  if (isEngineManagedStage(stage)) return false;
  if (isCancelledTicketStage(stage)) return isTicketPeriodoCerrado(ticket);
  return true;
}

/**
 * ¿Este ticket PROTEGE su clave frente al upsert de Phase P?
 * Todo lo que no maneja el motor, menos los cancelados sin factura.
 * (Equivale a hasTicketCrossedFrontier; se expone aparte porque el call site
 * pregunta otra cosa y conviene que se lea como lo que pregunta.)
 */
export function isTicketProtegido(ticket) {
  return hasTicketCrossedFrontier(ticket);
}

/** fecha_resolucion_esperada (YYYY-MM-DD) o, si falta, la del of_ticket_key. */
export function fechaDelTicket(ticket) {
  const directa = String(ticket?.properties?.fecha_resolucion_esperada || '').slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(directa)) return directa;
  const partes = String(ticket?.properties?.of_ticket_key || '').split('::');
  const ultima = partes[partes.length - 1];
  return /^\d{4}-\d{2}-\d{2}$/.test(ultima || '') ? ultima : '';
}

// ═══════════════════════════════════════════════════════════════════════════
// LAS TRES FECHAS (TANDA C) — derivadas de los tickets, no de la etapa
// ═══════════════════════════════════════════════════════════════════════════
//
// Ver definitivos/PLAN_proximos_cambios_tickets_2026-07-29.md §2.5. Las cuatro
// fechas de hoy pasan a ser tres, alineadas con la frontera:
//
//   PRÓXIMA    → billing_next_date        = la próxima fecha NO NOTIFICADA
//   NOTIFICADO → last_billing_period      = la última fecha que cruzó la frontera
//   CONFIRMADO → billing_last_billed_date = la última fecha REAL de Nodum (no
//                                           se toca acá: la escribe propagacion/invoice.js)
//
// `last_ticketed_date` SE ELIMINA: era «la última fecha promovida», y su set
// (PROMOTED_STAGES) incluye «Próximos a facturar» — el mismo agujero del
// hallazgo rojo #1. Quien la leía pasa a leer NOTIFICADO
// (fechaNotificadaDelLineItem). No se reemplaza por ninguna prop nueva.
//
// Las tres funciones son PURAS y toman tickets con forma de HubSpot
// (`{properties:{…}}`). Son la ÚNICA definición: Phase P, recalcFromTickets y
// los contadores tienen que contar lo mismo o vuelven a divergir.

/**
 * NOTIFICADO — la última fecha que cruzó la frontera (notificada, emitida, o
 * período cerrado por cancelación definitiva de su factura).
 *
 * Es también EL PISO del cronograma: por eso vive acá y no en cada call site.
 *
 * @param {Array} tickets
 * @returns {string} YYYY-MM-DD o '' si todavía no se notificó nada
 */
export function fechaUltimaNotificada(tickets = []) {
  let ultima = '';
  for (const t of tickets || []) {
    if (!hasTicketCrossedFrontier(t)) continue;
    const ymd = fechaDelTicket(t);
    if (ymd && ymd > ultima) ultima = ymd;
  }
  return ultima;
}

/**
 * PRÓXIMA — la próxima fecha NO NOTIFICADA, automático o manual indistinto.
 *
 * Se conserva el filtro «estrictamente futura» que rige hoy para
 * billing_next_date: lo que cambia es la PARTICIÓN (forecast → no notificado),
 * no la ventana temporal. Un ticket vencido y sin notificar no adelanta la
 * próxima fecha; lo levanta el barrido de vencidos, no esta propiedad.
 *
 * @param {Array} tickets
 * @param {string} todayYmd YYYY-MM-DD
 * @returns {string} YYYY-MM-DD o ''
 */
export function fechaProximaNoNotificada(tickets = [], todayYmd = '') {
  let proxima = '';
  for (const t of tickets || []) {
    if (!isTicketEngineManaged(t)) continue;
    const ymd = fechaDelTicket(t);
    if (!ymd) continue;
    if (todayYmd && ymd <= todayYmd) continue;
    if (!proxima || ymd < proxima) proxima = ymd;
  }
  return proxima;
}

/**
 * CONSUMIDOS — cuántas cuotas del plan ya se gastaron.
 *
 * Consumido = cruzó la frontera. El punto de descuento de una cuota es EL PASO
 * A «NOTIFICADO» (decisión de la usuaria, 31-jul): antes de eso el ticket es
 * futuro y el motor todavía puede rearmarlo, así que no gastó nada.
 *
 * Se exige `of_ticket_key` por la misma razón que lo exigía el conteo viejo de
 * phasep: un ticket sin clave no es una cuota del cronograma.
 *
 * @param {Array} tickets
 * @returns {number}
 */
export function contarConsumidos(tickets = []) {
  let n = 0;
  for (const t of tickets || []) {
    if (!hasTicketCrossedFrontier(t)) continue;
    if (!String(t?.properties?.of_ticket_key || '').trim()) continue;
    n++;
  }
  return n;
}

/**
 * La fecha NOTIFICADA tal como quedó persistida en el LINE ITEM.
 *
 * Es el reemplazo de `last_ticketed_date` para los lectores que NO tienen los
 * tickets a mano (billingEngine, resolvePlanYMD, ticketService). Con la llave
 * prendida `last_ticketed_date` ya no se escribe, así que leerla devolvería un
 * valor congelado — y encima contaminado con «Próximos a facturar», que es
 * justo lo que la tanda B tuvo que sacar del piso del cronograma.
 *
 * 🔴 SIN fallback a `last_ticketed_date` cuando la llave está prendida, y es
 * deliberado: los valores viejos siguen en el portal (no se borran: sería un
 * write masivo y destructivo), así que un fallback los dejaría ganando para
 * siempre y reintroduciría el hallazgo #1. El único lugar con red de seguridad
 * es `resolveFloorSourceYmd` en phasep.js, donde el riesgo es el inverso
 * (búsqueda de tickets vacía ⇒ regenerar el cronograma desde el arranque del
 * contrato) y donde no hay ticket vivo que proteger.
 *
 * Llave apagada ⇒ devuelve `last_ticketed_date`, igual que siempre.
 *
 * @param {object} lineItemProps
 * @returns {string} YYYY-MM-DD o ''
 */
export function fechaNotificadaDelLineItem(lineItemProps = {}) {
  const prop = etapaUnicaEnabled()
    ? lineItemProps?.last_billing_period
    : lineItemProps?.last_ticketed_date;
  return String(prop || '').slice(0, 10);
}
