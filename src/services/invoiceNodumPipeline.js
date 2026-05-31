// src/services/invoiceNodumPipeline.js
//
// Pipeline único post-asignación de id_factura_nodum a una factura.
// Corre EN ORDEN las operaciones que el editor hace tras guardar un nodum id,
// para que el resultado sea idéntico venga de donde venga (editor, API, migración):
//
//   1. syncInvoiceToTicket          → copia campos factura→ticket (id_factura_nodum → numero_de_factura)
//   2. propagateInvoiceStateToTicket → stage / of_invoice_status / fechas del ticket
//   3. tryAdvanceDealToEnEjecucion   → avanza el deal Ganado → En Ejecución
//
// NO estampa el id_factura_nodum ni la etapa en la factura: eso es del caller
// (el editor en su PATCH, la migración en setNodumIdAndPropagate). Este módulo
// asume la factura ya con nodum id seteado y dispara la cadena de propagación.

import axios from 'axios';
import { hubspotClient } from '../hubspotClient.js';
import logger from '../../lib/logger.js';

const MOD = 'services/invoiceNodumPipeline';
const INVOICE_OBJECT_TYPE = 'invoices';

// Factory del cliente axios que espera syncInvoiceToTicket (mismo patrón que el editor).
function hs() {
  return axios.create({
    baseURL: 'https://api.hubapi.com',
    headers: { Authorization: `Bearer ${process.env.HUBSPOT_PRIVATE_TOKEN}` },
    timeout: 10000,
  });
}

/**
 * Corre la cadena completa de propagación de una factura con nodum id.
 *
 * @param {string} invoiceId
 * @param {Object|null} changedProps
 *   Campos de la factura recién cambiados (para syncInvoiceToTicket).
 *   Si es null, usa { id_factura_nodum } leído de la propia factura.
 * @returns {Object} { invoiceId, ticketId, steps }
 */
export async function runInvoiceNodumPipeline(invoiceId, changedProps = null) {
  const fn = 'runInvoiceNodumPipeline';
  const steps = { sync: null, propagate: null, advance: null };

  if (!invoiceId) {
    logger.warn({ module: MOD, fn }, 'invoiceId vacío, skip');
    return { invoiceId: null, ticketId: null, steps };
  }

  // Imports dinámicos: syncInvoiceToTicket y tryAdvanceDealToEnEjecucion viven en
  // api/invoice-editor. Dinámico para evitar ciclos y seguir el patrón ya usado.
  const { syncInvoiceToTicket } = await import('../../api/invoice-editor/syncInvoiceToTicket.js');
  const { propagateInvoiceStateToTicket } = await import('../propagacion/invoice.js');
  const { tryAdvanceDealToEnEjecucion } = await import('../../api/invoice-editor/advanceDealToEnEjecucion.js');

  // Resolver ticketId (y, si hace falta, los campos a sincronizar) desde la factura.
  let ip = {};
  try {
    const invoice = await hubspotClient.crm.objects.basicApi.getById(
      INVOICE_OBJECT_TYPE,
      String(invoiceId),
      ['ticket_id', 'id_factura_nodum', 'etapa_de_la_factura']
    );
    ip = invoice?.properties || {};
  } catch (err) {
    logger.error({ module: MOD, fn, invoiceId, err }, 'Error leyendo factura');
    throw err;
  }

  let ticketId = (ip.ticket_id || '').trim() || null;
  const propsToSync = changedProps || { id_factura_nodum: ip.id_factura_nodum };

  // 1. syncInvoiceToTicket — copia id_factura_nodum → numero_de_factura.
  //    Tiene try/catch interno: loguea y no lanza.
  try {
    await syncInvoiceToTicket(ticketId, propsToSync, String(invoiceId), hs);
    steps.sync = ticketId ? 'ok' : 'skipped_no_ticket_id';
  } catch (err) {
    logger.error({ module: MOD, fn, invoiceId, ticketId, err }, 'Error en syncInvoiceToTicket');
    steps.sync = 'error';
  }

  // 2. propagateInvoiceStateToTicket — stage / of_invoice_status / fechas.
  //    Devuelve el ticketId resuelto por of_invoice_key (fallback confiable).
  try {
    const propagate = await propagateInvoiceStateToTicket(String(invoiceId));
    steps.propagate = propagate?.status || 'ok';
    if (!ticketId && propagate?.ticketId) ticketId = String(propagate.ticketId);
  } catch (err) {
    logger.error({ module: MOD, fn, invoiceId, err }, 'Error en propagateInvoiceStateToTicket');
    steps.propagate = 'error';
  }

  // 3. tryAdvanceDealToEnEjecucion — Ganado → En Ejecución. Idempotente.
  if (ticketId) {
    try {
      await tryAdvanceDealToEnEjecucion(ticketId);
      steps.advance = 'ok';
    } catch (err) {
      logger.error({ module: MOD, fn, invoiceId, ticketId, err }, 'tryAdvanceDealToEnEjecucion falló (no bloquea)');
      steps.advance = 'error';
    }
  } else {
    steps.advance = 'skipped_no_ticket_id';
  }

  logger.info({ module: MOD, fn, invoiceId, ticketId, steps }, 'Pipeline nodum completado');
  return { invoiceId: String(invoiceId), ticketId, steps };
}