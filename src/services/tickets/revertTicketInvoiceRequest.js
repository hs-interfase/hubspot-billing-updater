// src/services/tickets/revertTicketInvoiceRequest.js
//
// Handler de la casilla `revertir_factura` del ticket (Bloque 3 del flujo
// cancelar/revertir). Espejo del patrón de cancelTicketRequest (DI + reset en
// finally + solo el GET inicial puede lanzar).
//
// Semántica REVERTIR: cancelar la factura viva del ticket y dejar el ticket
// listo para refacturar (la limpieza la hace propagateInvoiceStateToTicket con
// cancelIntent 'revert' → prepareTicketForRebillingAfterCancellation, que
// además incrementa el contador of_refacturaciones).
//
// Guards (en orden):
//   1. parseBool(revertir_factura) — false → skip sin escrituras.
//   2. CANCEL_REVERT_FLOW_ENABLED apagada → aviso + reset (sin este aviso, un
//      click con la prop ya suscrita moriría en silencio).
//   3. Pipeline AUTOMÁTICO → aviso + reset, NO se toca la factura.
//   4. Sin factura viva (of_invoice_id vacío o status 'Cancelada') → aviso + reset.
//   5. Gate Nodum (fail-closed) → aviso + reset, factura intacta.
//
// Camino feliz: PATCH invoice → Cancelada (mismas props que el editor:
// etapa_de_la_factura + fecha_de_cancelacion) → propagate con intent 'revert'.
//
// La casilla se resetea SIEMPRE (finally), aunque falle el resto.

import { hubspotClient } from '../../hubspotClient.js';
import logger from '../../../lib/logger.js';
import { reportIfActionable } from '../../utils/errorReporting.js';
import { writeTicketBillingError } from '../notifications/dealAlerts.js';
import { parseBool } from '../../utils/parsers.js';
import { cancelRevertFlowEnabled } from '../../config/cancelRevertFlags.js';
import { checkInvoiceRevertible, buildNodumBlockMessage } from '../invoices/nodumGate.js';
import { propagateInvoiceStateToTicket } from '../../propagacion/invoice.js';
import { AUTOMATED_TICKET_PIPELINE } from '../../config/constants.js';

const MODULE = 'revertTicketInvoiceRequest';

const INVOICE_OBJECT_TYPE = 'invoices';

const MSG_FLOW_DISABLED =
  'La reversión de facturas todavía no está habilitada en el sistema. Hablá con administración.';

const MSG_SIN_FACTURA =
  'No hay factura emitida para revertir en este ticket.';

/**
 * Aviso para tickets automáticos. NC_TUTORIAL_URL se lee POR LLAMADA
 * (patrón buildNodumBlockMessage: testeable sin orden de import).
 * @returns {string}
 */
export function buildAutomatedRevertMessage() {
  const tutorial = (process.env.NC_TUTORIAL_URL ?? '').trim() || '(tutorial pendiente)';
  return (
    'Los tickets automáticos no se revierten. Hablá con administración o emití ' +
    `una nota de crédito. Tutorial: ${tutorial}`
  );
}

/**
 * Procesa el pedido de reversión de la factura de un ticket vía la casilla
 * `revertir_factura`.
 *
 * @param {string} ticketId
 * @param {Object} [deps] - inyección de dependencias (tests)
 * @param {Object}   [deps.client]               - hubspotClient
 * @param {Function} [deps.updateTicketFn]       - (ticketId, props) => Promise
 * @param {Function} [deps.updateInvoiceFn]      - (invoiceId, props) => Promise
 * @param {Function} [deps.writeTicketErrorFn]   - writeTicketBillingError
 * @param {Function} [deps.reportFn]             - reportIfActionable
 * @param {Function} [deps.flowEnabledFn]        - cancelRevertFlowEnabled
 * @param {Function} [deps.checkRevertibleFn]    - checkInvoiceRevertible
 * @param {Function} [deps.nodumBlockMessageFn]  - buildNodumBlockMessage
 * @param {Function} [deps.automatedMessageFn]   - buildAutomatedRevertMessage
 * @param {Function} [deps.propagateFn]          - propagateInvoiceStateToTicket
 * @param {string}   [deps.automatedPipelineId]  - AUTOMATED_TICKET_PIPELINE
 * @param {Function} [deps.todayEpochFn]         - () => epoch ms de hoy (00:00 UTC)
 * @returns {Promise<Object>} { reverted?, skipped?, reason?, invoiceId? }
 */
export async function processRevertTicketRequest(ticketId, deps = {}) {
  const {
    client = hubspotClient,
    writeTicketErrorFn = writeTicketBillingError,
    reportFn = reportIfActionable,
    flowEnabledFn = cancelRevertFlowEnabled,
    checkRevertibleFn = checkInvoiceRevertible,
    nodumBlockMessageFn = buildNodumBlockMessage,
    automatedMessageFn = buildAutomatedRevertMessage,
    propagateFn = propagateInvoiceStateToTicket,
    automatedPipelineId = AUTOMATED_TICKET_PIPELINE,
    todayEpochFn = () => {
      const hoy = new Date();
      hoy.setUTCHours(0, 0, 0, 0);
      return hoy.getTime();
    },
  } = deps;

  const updateTicketFn = deps.updateTicketFn || (async (id, properties) => {
    await client.crm.tickets.basicApi.update(String(id), { properties });
  });

  // Mismas props que el editor de facturas (POST /:id/cancelar).
  const updateInvoiceFn = deps.updateInvoiceFn || (async (id, properties) => {
    await client.crm.objects.basicApi.update(INVOICE_OBJECT_TYPE, String(id), { properties });
  });

  const fn = 'processRevertTicketRequest';

  // 1. GET inicial — único punto donde el job puede fallar limpio (throw).
  let props;
  try {
    const ticket = await client.crm.tickets.basicApi.getById(String(ticketId), [
      'revertir_factura', 'hs_pipeline', 'hs_pipeline_stage', 'of_invoice_id',
      'of_invoice_status', 'of_deal_id', 'subject', 'motivo_del_ajuste',
    ]);
    props = ticket?.properties || {};
  } catch (err) {
    logger.error({ module: MODULE, fn, ticketId, err: err?.message }, 'Error obteniendo ticket, el job falla limpio');
    throw err;
  }

  // Guard de intención (patrón cancelar_ticket): si la casilla ya no está en
  // true, no hay nada que hacer ni que resetear.
  if (!parseBool(props.revertir_factura)) {
    logger.info({ module: MODULE, fn, ticketId }, 'revertir_factura no está en true, ignorando');
    return { skipped: true, reason: 'revertir_factura_false' };
  }

  const pipeline = String(props.hs_pipeline || '').trim();
  const invoiceId = String(props.of_invoice_id || '').trim();
  const invoiceStatus = String(props.of_invoice_status || '').trim();
  // Motivo de la reversión: prop EXISTENTE del ticket `motivo_del_ajuste`
  // (no se crea prop nueva; solo se loguea, no se escribe).
  const motivo = String(props.motivo_del_ajuste || '').trim() || null;

  try {
    // 2. Llave maestra apagada → aviso claro (sin esto, el click muere mudo).
    if (!flowEnabledFn()) {
      logger.info(
        { module: MODULE, fn, ticketId },
        'CANCEL_REVERT_FLOW_ENABLED off: aviso + reset, sin tocar la factura'
      );
      await writeTicketErrorFn(ticketId, MSG_FLOW_DISABLED);
      return { skipped: true, reason: 'flow_disabled' };
    }

    // 3. Pipeline AUTOMÁTICO → los automáticos no entran al circuito manual.
    if (automatedPipelineId && pipeline === String(automatedPipelineId)) {
      logger.info(
        { module: MODULE, fn, ticketId, pipeline },
        'Ticket automático: no se revierte desde la casilla, aviso + reset'
      );
      await writeTicketErrorFn(ticketId, automatedMessageFn());
      return { skipped: true, reason: 'automated_pipeline' };
    }

    // 4. Sin factura viva → nada que revertir.
    const facturaViva = Boolean(invoiceId) && invoiceStatus !== 'Cancelada';
    if (!facturaViva) {
      logger.info(
        { module: MODULE, fn, ticketId, invoiceId, invoiceStatus },
        'Sin factura viva: nada que revertir, aviso + reset'
      );
      await writeTicketErrorFn(ticketId, MSG_SIN_FACTURA);
      return { skipped: true, reason: 'no_live_invoice' };
    }

    // 5. Gate Nodum (fail-closed): asentada en Nodum → nota de crédito.
    const gate = await checkRevertibleFn(invoiceId);
    if (!gate.revertible) {
      const reason = gate.error ? 'nodum_gate_error' : 'nodum_asentada';
      const msg = gate.error
        ? 'No se pudo verificar si la factura está asentada en Nodum. Reintentá en unos minutos.'
        : nodumBlockMessageFn(gate.nodumId);
      logger.warn(
        { module: MODULE, fn, ticketId, invoiceId, nodumId: gate.nodumId, reason },
        'Reversión bloqueada por gate Nodum'
      );
      await writeTicketErrorFn(ticketId, msg);
      return { skipped: true, reason, invoiceId };
    }

    // 6. Camino feliz: cancelar la factura (mismas props que el editor) y
    //    propagar con intent 'revert' (el propagate limpia el ticket, lo vuelve
    //    a stage facturable e incrementa of_refacturaciones).
    try {
      await updateInvoiceFn(invoiceId, {
        etapa_de_la_factura: 'Cancelada',
        fecha_de_cancelacion: String(todayEpochFn()),
      });
      logger.info(
        { module: MODULE, fn, ticketId, invoiceId, motivo },
        'Factura cancelada por casilla revertir_factura, propagando al ticket'
      );
    } catch (err) {
      logger.error(
        { module: MODULE, fn, ticketId, invoiceId, err: err?.message },
        'Error cancelando la factura (la casilla se resetea igual)'
      );
      reportFn({ objectType: 'ticket', objectId: String(ticketId), message: `Error cancelando factura ${invoiceId} (revertir_factura)`, err });
      return { reverted: false, reason: 'invoice_patch_failed', invoiceId };
    }

    try {
      await propagateFn(String(invoiceId), { cancelIntent: 'revert' });
    } catch (err) {
      logger.error(
        { module: MODULE, fn, ticketId, invoiceId, err: err?.message },
        'Factura cancelada pero la propagación al ticket falló'
      );
      reportFn({ objectType: 'ticket', objectId: String(ticketId), message: `Factura ${invoiceId} cancelada pero la propagación falló (revertir_factura)`, err });
      return { reverted: false, reason: 'propagate_failed', invoiceId };
    }

    logger.info(
      { module: MODULE, fn, ticketId, invoiceId },
      'Reversión completada: factura cancelada + ticket preparado para refacturar'
    );
    return { reverted: true, invoiceId };
  } finally {
    // 7. Resetear la casilla SIEMPRE, aunque falle el resto.
    try {
      await updateTicketFn(ticketId, { revertir_factura: 'false' });
      logger.info({ module: MODULE, fn, ticketId }, 'Casilla revertir_factura reseteada (finally)');
    } catch (err) {
      logger.error(
        { module: MODULE, fn, ticketId, err: err?.message },
        'Error reseteando la casilla revertir_factura'
      );
      reportFn({ objectType: 'ticket', objectId: String(ticketId), message: 'Error reseteando casilla revertir_factura', err });
    }
  }
}
