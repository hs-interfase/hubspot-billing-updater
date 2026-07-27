// src/services/invoices/nodumGate.js
//
// Gate Nodum del flujo cancelar/revertir (bloque 2).
//
// Regla de negocio: una factura ya ASENTADA en Nodum (id_factura_nodum con
// valor) NO se puede cancelar/revertir desde el editor — el camino correcto
// es emitir una nota de crédito. Este módulo solo DECIDE; el bloqueo (409)
// lo aplica el endpoint POST /:id/cancelar cuando CANCEL_REVERT_FLOW_ENABLED
// está prendida.
//
// FAIL-CLOSED: si la lectura de la invoice falla, se responde
// { revertible: false, error: true } — ante la duda, NO se permite cancelar.

import { hubspotClient } from '../../hubspotClient.js';
import logger from '../../../lib/logger.js';

const MODULE = 'nodumGate';
const INVOICE_OBJECT_TYPE = 'invoices';

/**
 * ¿Se puede cancelar/revertir esta invoice? (no está asentada en Nodum)
 *
 * @param {string|number} invoiceId
 * @param {Object} [deps] - inyección de dependencias (tests)
 * @param {Object} [deps.client] - hubspotClient
 * @returns {Promise<{revertible: boolean, nodumId: string|null, error?: true}>}
 */
export async function checkInvoiceRevertible(invoiceId, deps = {}) {
  const { client = hubspotClient } = deps;
  const fn = 'checkInvoiceRevertible';

  try {
    const invoice = await client.crm.objects.basicApi.getById(
      INVOICE_OBJECT_TYPE,
      String(invoiceId),
      ['id_factura_nodum']
    );
    const nodumId = String(invoice?.properties?.id_factura_nodum ?? '').trim() || null;

    if (nodumId) {
      logger.info(
        { module: MODULE, fn, invoiceId, nodumId },
        'Invoice asentada en Nodum: NO revertible (corresponde nota de crédito)'
      );
      return { revertible: false, nodumId };
    }
    return { revertible: true, nodumId: null };
  } catch (err) {
    // FAIL-CLOSED: sin lectura confiable no se habilita la cancelación.
    logger.error(
      { module: MODULE, fn, invoiceId, err: err?.message },
      'Error leyendo id_factura_nodum — gate fail-closed (no revertible)'
    );
    return { revertible: false, nodumId: null, error: true };
  }
}

/**
 * Mensaje de bloqueo para el usuario cuando la factura ya está en Nodum.
 * NC_TUTORIAL_URL se lee POR LLAMADA (testeable sin orden de import).
 *
 * @param {string|number|null} nodumId
 * @returns {string}
 */
export function buildNodumBlockMessage(nodumId) {
  const tutorial = (process.env.NC_TUTORIAL_URL ?? '').trim() || '(tutorial pendiente)';
  return (
    `Esta factura ya está asentada en Nodum (id ${nodumId}). ` +
    `No se puede cancelar/revertir: emití una nota de crédito. ` +
    `Tutorial: ${tutorial}`
  );
}
