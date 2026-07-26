// src/services/tickets/cancelTicketRequest.js
//
// Handler MÍNIMO de la casilla `cancelar_ticket` del ticket (26-jul).
//
// Regla de oro de esta etapa: NO se toca factura, NO se toca cupo, NO se toca
// el espejo. Eso llega con el flujo completo de cancelar/revertir (en diseño).
// Este handler solo cubre el caso simple (ticket manual sin factura viva →
// etapa CANCELADO) y deja aviso en of_billing_error en los demás casos.
//
// Decisiones:
//   - Tickets del pipeline AUTOMÁTICO no entran al circuito manual (decisión de
//     la usuaria): aviso + reset, sin tocar la etapa.
//   - La casilla se resetea SIEMPRE (finally), aunque falle el resto — patrón
//     del flujo facturar_ahora de ticket (urgentBillingService).
//   - El job solo puede fallar limpio (throw) si el GET inicial falla; el resto
//     de los errores se reportan (reportIfActionable/logger) sin lanzar.

import { hubspotClient } from '../../hubspotClient.js';
import logger from '../../../lib/logger.js';
import { reportIfActionable } from '../../utils/errorReporting.js';
import { writeTicketBillingError } from '../notifications/dealAlerts.js';
import { parseBool } from '../../utils/parsers.js';
import {
  AUTOMATED_TICKET_PIPELINE,
  CANCELLED_STAGE_BY_PIPELINE,
  TICKET_STAGES,
} from '../../config/constants.js';

const MODULE = 'cancelTicketRequest';

const MSG_AUTOMATICO =
  'Los tickets automáticos no se cancelan desde esta casilla. Hablá con administración.';

const MSG_FACTURA_VIVA =
  'Este ticket tiene una factura emitida. La cancelación completa (factura + cupo) llega ' +
  'con el flujo nuevo de cancelar/revertir; por ahora cancelá la factura desde el editor ' +
  'de facturas y el motor prepara la refacturación.';

/**
 * Procesa el pedido de cancelación de un ticket vía la casilla `cancelar_ticket`.
 *
 * Casos:
 *   1. Pipeline AUTOMÁTICO       → aviso en of_billing_error + reset (no se cancela).
 *   2. Ya en etapa CANCELADO     → solo reset de la casilla.
 *   3. Sin factura viva          → mover a la etapa CANCELADO de su pipeline
 *                                  (+ motivo_cancelacion_del_ticket, conserva of_ticket_key) + reset.
 *   4. Con factura viva          → aviso en of_billing_error + reset (no se toca nada más).
 *
 * "Factura viva" = of_invoice_id presente Y of_invoice_status !== 'Cancelada'.
 *
 * @param {string} ticketId
 * @param {Object} [deps] - inyección de dependencias (tests)
 * @param {Object}   [deps.client]                   - hubspotClient
 * @param {Function} [deps.updateTicketFn]           - (ticketId, props) => Promise
 * @param {Function} [deps.writeTicketErrorFn]       - writeTicketBillingError
 * @param {Function} [deps.reportFn]                 - reportIfActionable
 * @param {string}   [deps.automatedPipelineId]      - AUTOMATED_TICKET_PIPELINE
 * @param {Object}   [deps.cancelledStageByPipeline] - CANCELLED_STAGE_BY_PIPELINE
 * @param {string}   [deps.fallbackCancelledStage]   - TICKET_STAGES.CANCELLED (si el pipeline no está en el map)
 * @param {Function} [deps.todayYMDFn]               - () => 'YYYY-MM-DD'
 * @returns {Promise<Object>} { cancelled?, skipped?, reason?, ... }
 */
export async function processCancelTicketRequest(ticketId, deps = {}) {
  const {
    client = hubspotClient,
    writeTicketErrorFn = writeTicketBillingError,
    reportFn = reportIfActionable,
    automatedPipelineId = AUTOMATED_TICKET_PIPELINE,
    cancelledStageByPipeline = CANCELLED_STAGE_BY_PIPELINE,
    fallbackCancelledStage = TICKET_STAGES.CANCELLED,
    todayYMDFn = () => new Date().toISOString().slice(0, 10),
  } = deps;

  const updateTicketFn = deps.updateTicketFn || (async (id, properties) => {
    await client.crm.tickets.basicApi.update(String(id), { properties });
  });

  const fn = 'processCancelTicketRequest';

  // 1. GET inicial — único punto donde el job puede fallar limpio (throw).
  let props;
  try {
    const ticket = await client.crm.tickets.basicApi.getById(String(ticketId), [
      'hs_pipeline', 'hs_pipeline_stage', 'of_invoice_id', 'of_invoice_status',
      'of_deal_id', 'subject', 'cancelar_ticket', 'content',
    ]);
    props = ticket?.properties || {};
  } catch (err) {
    logger.error({ module: MODULE, fn, ticketId, err: err?.message }, 'Error obteniendo ticket, el job falla limpio');
    throw err;
  }

  // Guard de intención (patrón facturar_ahora): si la casilla ya no está en true,
  // no hay nada que hacer ni que resetear.
  if (!parseBool(props.cancelar_ticket)) {
    logger.info({ module: MODULE, fn, ticketId }, 'cancelar_ticket no está en true, ignorando');
    return { skipped: true, reason: 'cancelar_ticket_false' };
  }

  const pipeline = String(props.hs_pipeline || '').trim();
  const currentStage = String(props.hs_pipeline_stage || '').trim();
  const invoiceId = String(props.of_invoice_id || '').trim();
  const invoiceStatus = String(props.of_invoice_status || '').trim();

  try {
    // 2. Pipeline AUTOMÁTICO → los automáticos no entran al circuito manual.
    if (automatedPipelineId && pipeline === String(automatedPipelineId)) {
      logger.info(
        { module: MODULE, fn, ticketId, pipeline },
        'Ticket automático: no se cancela desde la casilla, aviso + reset'
      );
      await writeTicketErrorFn(ticketId, MSG_AUTOMATICO);
      return { skipped: true, reason: 'automated_pipeline' };
    }

    // Etapa CANCELADO del pipeline del ticket
    const cancelledStage = String(
      cancelledStageByPipeline[pipeline] || fallbackCancelledStage || ''
    ).trim();

    // 3. Ya está en CANCELADO → solo resetear la casilla.
    if (cancelledStage && currentStage === cancelledStage) {
      logger.info(
        { module: MODULE, fn, ticketId, currentStage },
        'Ticket ya está en etapa CANCELADO, solo se resetea la casilla'
      );
      return { skipped: true, reason: 'already_cancelled' };
    }

    // "Factura viva" = of_invoice_id presente y no cancelada.
    const facturaViva = Boolean(invoiceId) && invoiceStatus !== 'Cancelada';

    // 5. Con factura viva → NO tocar nada, avisar + reset.
    if (facturaViva) {
      logger.info(
        { module: MODULE, fn, ticketId, invoiceId, invoiceStatus },
        'Ticket con factura viva: no se cancela en esta etapa, aviso + reset'
      );
      await writeTicketErrorFn(ticketId, MSG_FACTURA_VIVA);
      return { skipped: true, reason: 'invoice_alive', invoiceId };
    }

    // 4. Sin factura viva → mover a la etapa CANCELADO de su pipeline.
    //    (Patrón cancelForecastTickets: CONSERVA of_ticket_key — solo se escriben
    //    hs_pipeline_stage y motivo_cancelacion_del_ticket.)
    if (!cancelledStage) {
      const msg = 'Pipeline desconocido, no se puede determinar la etapa de cancelación';
      logger.warn({ module: MODULE, fn, ticketId, pipeline }, msg);
      reportFn({ objectType: 'ticket', objectId: String(ticketId), message: `${msg} (cancelar_ticket)`, err: new Error(msg) });
      return { skipped: true, reason: 'unknown_cancel_stage', pipeline };
    }

    const motivo = `Cancelado por el usuario (casilla cancelar_ticket) — ${todayYMDFn()}`;

    try {
      await updateTicketFn(ticketId, {
        hs_pipeline_stage: cancelledStage,
        motivo_cancelacion_del_ticket: motivo,
      });
      logger.info(
        { module: MODULE, fn, ticketId, pipeline, cancelledStage, motivo },
        'Ticket movido a etapa CANCELADO por la casilla cancelar_ticket'
      );
      return { cancelled: true, stage: cancelledStage };
    } catch (err) {
      logger.error(
        { module: MODULE, fn, ticketId, cancelledStage, err: err?.message },
        'Error moviendo el ticket a CANCELADO (la casilla se resetea igual)'
      );
      reportFn({ objectType: 'ticket', objectId: String(ticketId), message: 'Error moviendo ticket a CANCELADO (cancelar_ticket)', err });
      return { cancelled: false, reason: 'stage_update_failed', error: err?.message };
    }
  } finally {
    // 6. Resetear la casilla SIEMPRE, aunque falle el resto.
    try {
      await updateTicketFn(ticketId, { cancelar_ticket: 'false' });
      logger.info({ module: MODULE, fn, ticketId }, 'Casilla cancelar_ticket reseteada (finally)');
    } catch (err) {
      logger.error(
        { module: MODULE, fn, ticketId, err: err?.message },
        'Error reseteando la casilla cancelar_ticket'
      );
      reportFn({ objectType: 'ticket', objectId: String(ticketId), message: 'Error reseteando casilla cancelar_ticket', err });
    }
  }
}
