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
