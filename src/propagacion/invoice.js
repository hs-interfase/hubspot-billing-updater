/**
 * src/propagacion/invoice.js
 *
 * Propagación de cambios de estado de Invoice (real/Nodum) → Ticket asociado.
 *
 * Responsabilidades:
 *   1. Mapear etapa_de_la_factura → stage del ticket (manual o automático)
 *   2. Sincronizar of_invoice_status en el ticket
 *   3. Escribir fecha_de_facturacion en el ticket (desde hs_createdate de la invoice)
*   4. Escribir fecha_real_de_facturacion en el ticket (desde fecha_de_emision)
*   5. Actualizar last_billing_period en el line item con la fecha REAL de emisión
*   6. Mover ticket a CREATED cuando se setea id_factura_nodum (si no hay etapa posterior)
 *
 * Punto de entrada principal: propagateInvoiceStateToTicket(invoiceId)
 * Llamado desde: api/invoice-editor/invoices.js (PATCH y /cancelar)
 */

import { hubspotClient } from '../hubspotClient.js';
import { toYMDInBillingTZ, toHubSpotDateOnly } from '../utils/dateUtils.js';
import logger from '../../lib/logger.js';
import {
  TICKET_PIPELINE,
  AUTOMATED_TICKET_PIPELINE,
  TICKET_STAGES,
  BILLING_AUTOMATED_CANCELLED,
  BILLING_TICKET_STAGE_ID_CREATED,
  BILLING_TICKET_STAGE_ID_LATE,
  BILLING_TICKET_STAGE_ID_PAID,
  BILLING_AUTOMATED_CREATED,
  BILLING_AUTOMATED_LATE,
  BILLING_AUTOMATED_PAID,
  FORECAST_MANUAL_STAGES,
  FORECAST_AUTO_STAGES,
  INVOICED_STAGES,
  CANCELLED_STAGE_BY_PIPELINE,
} from '../config/constants.js';
import { recalcFacturasRestantes } from '../services/billing/recalcFacturasRestantes.js';
import { buildPagoDisplay } from '../services/billing/syncBillingState.js';
import { revertCupoForInvoice } from '../services/cupo/revertCupo.js';
import {
  cancelRevertFlowEnabled,
  cupoRevertOnCancelEnabled,
} from '../config/cancelRevertFlags.js';
import { notifyAdminOnRevert } from '../services/notifications/adminRevertAlert.js';
import { notifyMirrorDealOnCancelOrRevert } from '../services/mirrorUtils.js';



const INVOICE_OBJECT_TYPE = 'invoices';

// Etapas de factura que tienen una fecha de emisión "real" asociada.
// Se usa para decidir cuándo escribir fecha_real_de_facturacion en el ticket
// y billing_last_billed_date en el line item.
const ETAPAS_CON_FECHA_REAL = ['Emitida', 'Enviada', 'Paga'];

// ─────────────────────────────────────────────
// Helpers internos
// ─────────────────────────────────────────────

/**
 * Convierte fecha de HubSpot (epoch ms como string o YYYY-MM-DD) a YMD.
 */
function invoiceDateToYMD(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  // YYYY-MM-DD directo
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // epoch ms
  const ms = Number(s);
  if (!Number.isNaN(ms) && ms > 0) return toYMDInBillingTZ(ms);
  return null;
}

/**
 * Set de stages que se consideran "en o más allá de CREATED".
 * Usados para evitar retroceder el ticket.
 */
function buildPostCreatedStages() {
  return new Set([
    BILLING_TICKET_STAGE_ID_CREATED,
    BILLING_TICKET_STAGE_ID_LATE,
    BILLING_TICKET_STAGE_ID_PAID,
    TICKET_STAGES.INVOICED,       // BILLED (compatible con stages anteriores)
    TICKET_STAGES.CANCELLED,
    BILLING_AUTOMATED_CREATED,
    BILLING_AUTOMATED_LATE,
    BILLING_AUTOMATED_PAID,
    BILLING_AUTOMATED_CANCELLED,
  ].filter(Boolean));
}

/**
 * Devuelve true si el ticket todavía está en etapa forecast o ready
 * (es decir, NO llegó a CREATED ni más allá).
 */
function isBeforeCreated(currentStage) {
  const postCreated = buildPostCreatedStages();
  return !postCreated.has(String(currentStage || ''));
}

/**
 * Dado el estado de la factura y si el pipeline es automático,
 * devuelve el stage destino del ticket (o null si no debe cambiar).
 *
 * Regla de nodum_id: si está presente y el ticket aún no llegó a CREATED → mover a CREATED.
 * Regla de etapa: mapeamos directamente, con excepción de Pendiente (sin cambio).
 */
function resolveTargetStage({ etapa, nodumId, currentStage, isAutomated }) {
  const CREATED   = isAutomated ? BILLING_AUTOMATED_CREATED   : BILLING_TICKET_STAGE_ID_CREATED;
  const PAID      = isAutomated ? BILLING_AUTOMATED_PAID       : BILLING_TICKET_STAGE_ID_PAID;
  const LATE      = isAutomated ? BILLING_AUTOMATED_LATE       : BILLING_TICKET_STAGE_ID_LATE;
  const CANCELLED = isAutomated ? BILLING_AUTOMATED_CANCELLED  : TICKET_STAGES.CANCELLED;

  // Si existe id_factura_nodum y el ticket todavía no llegó a CREATED → mover
  if (nodumId && isBeforeCreated(currentStage)) return CREATED;

  switch (etapa) {
    case 'Emitida':
    case 'Enviada':
      // Solo movemos si el ticket aún no está en CREATED o más allá
      return isBeforeCreated(currentStage) ? CREATED : null;

    case 'Paga':
      return PAID;

    case 'Atrasada':
      return LATE;

    case 'Cancelada':
      return CANCELLED;

    case 'Pendiente':
    default:
      return null; // sin cambio de stage
  }
}

/**
 * Resuelve la RAMA de la lógica de cancelación (bloque 5b). Helper PURO.
 *
 * - 'cancel'  → cancelación DEFINITIVA: el ticket va a etapa CANCELADO y el
 *               período queda cerrado (finalizeTicketAfterDefinitiveCancellation).
 * - 'revert'  → revertir-y-refacturar (COMPORTAMIENTO ACTUAL, default): el
 *               ticket vuelve a un stage facturable, limpio
 *               (prepareTicketForRebillingAfterCancellation).
 *
 * null/undefined/cualquier otro valor → 'revert' (= comportamiento actual).
 *
 * @param {Object} [params]
 * @param {'cancel'|'revert'|null} [params.cancelIntent]
 * @returns {'cancel'|'revert'}
 */
export function resolveCancellationBranch({ cancelIntent } = {}) {
  return cancelIntent === 'cancel' ? 'cancel' : 'revert';
}

/**
 * Contador of_refacturaciones (Bloque 3). Helper PURO.
 *
 * SOLO incrementa cuando el cancelIntent EXPLÍCITO es 'revert' (reversión
 * deliberada para refacturar). Con intent null (webhook genérico, cron sweep
 * propagateCancelledInvoicesForDeal — que re-propaga la MISMA invoice en cada
 * corrida) devuelve null → no se escribe nada, si no el contador se inflaría
 * solo. Con la llave maestra apagada el intent ya llega forzado a null →
 * neutralidad garantizada.
 *
 * @param {Object} [params]
 * @param {'cancel'|'revert'|null} [params.cancelIntent]
 * @param {string|number|null} [params.actual] - valor actual de of_refacturaciones
 * @returns {number|null} nuevo valor del contador, o null si no debe escribirse
 */
export function computeContadorRefacturaciones({ cancelIntent, actual } = {}) {
  if (cancelIntent !== 'revert') return null;
  const n = Number(String(actual ?? '').trim());
  const base = Number.isFinite(n) && n > 0 ? n : 0;
  return base + 1;
}

/**
 * Bloque 5b — "preparar ticket para refacturación" tras cancelarse una factura.
 *
 * ⚠️ COMPORTAMIENTO ACTUAL CONSERVADO TAL CUAL (extracción pura desde
 * propagateInvoiceStateToTicket, 2026-07-26): mismas variables, mismos efectos,
 * mismo orden de escrituras, mismos logs. Solo cambió la firma.
 *
 * Con el flujo nuevo de cancelar/revertir ticket, esta es la rama REVERTIR
 * (revertir-y-refacturar: el ticket vuelve a un stage facturable, limpio).
 * La rama CANCELAR (ticket a etapa CANCELADO, definitivo) es
 * finalizeTicketAfterDefinitiveCancellation (abajo).
 *
 * Única extensión (2026-07-26, retrocompatible): `cupoResult` opcional
 * (default null = texto de aviso actual). Cuando CUPO_REVERT_ON_CANCEL_ENABLED
 * está prendida, el orquestador pasa el resultado REAL de revertCupoForInvoice
 * y el aviso textual de cupo se reemplaza por ese resultado.
 *
 * Efectos actuales:
 *   - El ticket NUNCA va a CANCELLED por cancelación de factura:
 *     manual → vuelve a NEW ("Próximos a Facturar"); automático → vuelve a READY.
 *   - Limpia props de factura (of_invoice_id/status, fechas) y escribe of_billing_error.
 *   - Escribe billing_error en el deal.
 *   - Recalcula facturas_restantes + progreso_pagos del line item.
 *
 * @param {Object} params
 * @param {string} params.invoiceId       - id de la invoice cancelada
 * @param {string} params.ticketId        - id del ticket asociado
 * @param {Object} params.tp              - properties del ticket (of_deal_id, of_aplica_para_cupo)
 * @param {boolean} params.isAutomated    - ticket del pipeline automático
 * @param {string|null} params.fechaCreacionYMD - fecha de creación de la invoice (YMD)
 * @param {string|null} params.lineItemId - primer line item del ticket (of_line_item_ids)
 * @param {Object|null} [params.cupoResult] - resultado de revertCupoForInvoice
 *                                  (null = llave apagada → aviso textual actual)
 * @param {number|null} [params.contadorNuevo] - nuevo valor de of_refacturaciones
 *                                  (null = no escribir el contador — default,
 *                                  solo viene con valor en reversión explícita)
 */
async function prepareTicketForRebillingAfterCancellation({
  invoiceId,
  ticketId,
  tp,
  isAutomated,
  fechaCreacionYMD,
  lineItemId,
  cupoResult = null,
  contadorNuevo = null,
}) {
  const mod = 'propagacion/invoice';
  const fn  = 'propagateInvoiceStateToTicket';

  const dealId = (tp.of_deal_id || '').trim() || null;
  const periodoYMD = fechaCreacionYMD || 'desconocido';

  // Aviso de cupo:
  //   - cupoResult null (default, CUPO_REVERT_ON_CANCEL_ENABLED off): texto
  //     actual basado en of_aplica_para_cupo — retrocompatible tal cual.
  //   - cupoResult presente: el aviso refleja el resultado REAL de la reversión.
  let avisoCupo;
  if (cupoResult == null) {
    const aplicaCupo = (tp.of_aplica_para_cupo || '').trim();
    avisoCupo = aplicaCupo
      ? ` ⚠️ Este ticket tenía cupo (${aplicaCupo}). Verificar que el cupo del deal se haya restablecido correctamente.`
      : '';
  } else if (cupoResult.reverted) {
    avisoCupo = ` Cupo re-acreditado: +${cupoResult.credito}. Restante: ${cupoResult.cupoRestanteNuevo}.`;
  } else if (cupoResult.reason === 'no_consumio_o_ya_revertido') {
    avisoCupo = ''; // no había consumo de esta invoice → sin mención de cupo
  } else {
    avisoCupo = ` ⚠️ NO se pudo re-acreditar el cupo automáticamente (${cupoResult.reason}). Reconciliar a mano.`;
  }

  // Mensaje específico por pipeline
  const cancelMsg = isAutomated
    ? `Factura ${invoiceId} cancelada el ${new Date().toISOString().slice(0, 10)}. ` +
      `Período: ${periodoYMD}. ` +
      `El ticket vuelve a Listo para facturar y será refacturado automáticamente en el próximo ciclo del cron. ` +
      `Si NO desea refacturar este período, pause el line item, o modifique o cancele el ticket antes del próximo ciclo.` +
      avisoCupo
    : `Factura ${invoiceId} cancelada el ${new Date().toISOString().slice(0, 10)}. ` +
      `Período: ${periodoYMD}. ` +
      `El ticket vuelve a Próximos a Facturar, limpio y listo para refacturación. ` +
      `Use 'facturar ahora' en el ticket cuando desee emitir la nueva factura. ` +
      `Si NO desea refacturar este período, cancele el ticket.` +
      avisoCupo;

  // Stage destino: NEW para manual, READY para automático
  const cancelTargetStage = isAutomated
    ? process.env.BILLING_AUTOMATED_READY
    : TICKET_STAGES.NEW;

  // Limpiar props de facturación y mover a stage facturable
  const cancelCleanup = {
    of_invoice_id: '',
    of_invoice_status: '',
    of_fecha_de_facturacion: '',
    fecha_real_de_facturacion: '',
    of_billing_error: cancelMsg.slice(0, 250),
    of_billing_error_at: String(Date.now()),
  };
  if (cancelTargetStage) {
    cancelCleanup.hs_pipeline_stage = String(cancelTargetStage);
    cancelCleanup.hs_pipeline = String(
      isAutomated ? AUTOMATED_TICKET_PIPELINE : TICKET_PIPELINE
    );
  }
  // Contador of_refacturaciones: solo se escribe en reversión EXPLÍCITA
  // (contadorNuevo !== null) y dentro del mismo update — sin writes extra.
  if (contadorNuevo !== null) {
    cancelCleanup.of_refacturaciones = String(contadorNuevo);
  }

  try {
    await hubspotClient.crm.tickets.basicApi.update(ticketId, { properties: cancelCleanup });
    logger.info(
      { module: mod, fn, invoiceId, ticketId, isAutomated, cancelTargetStage, cancelCleanup },
      'Ticket limpiado y movido a stage facturable post-cancelación'
    );
  } catch (err) {
    logger.warn(
      { module: mod, fn, invoiceId, ticketId, err },
      'Error limpiando ticket post-cancelación (no bloquea)'
    );
  }

  // Billing error en el deal
  if (dealId) {
    try {
      await hubspotClient.crm.deals.basicApi.update(String(dealId), {
        properties: { billing_error: cancelMsg.slice(0, 250) },
      });
      logger.info({ module: mod, fn, invoiceId, dealId },
        'Billing error escrito en deal post-cancelación');
    } catch (err) {
      logger.warn({ module: mod, fn, invoiceId, dealId, err },
        'Error escribiendo billing error en deal (no bloquea)');
    }
  }

  // Recalcular contadores (facturas_restantes, progreso_pagos)
  if (lineItemId && dealId) {
    try {
      const recalcResult = await recalcFacturasRestantes({ hubspotClient, lineItemId, dealId });
      if (recalcResult.cuotasTotales > 0) {
        try {
          const nuevoProgreso = buildPagoDisplay(recalcResult.countTickets, recalcResult.cuotasTotales);
          await hubspotClient.crm.lineItems.basicApi.update(lineItemId, {
            properties: { progreso_pagos: nuevoProgreso },
          });
          logger.info({ module: mod, fn, invoiceId, lineItemId, to: nuevoProgreso },
            'progreso_pagos actualizado post-cancelación');
        } catch (err) {
          logger.warn({ module: mod, fn, invoiceId, lineItemId, err },
            'progreso_pagos falló post-cancelación (no bloquea)');
        }
      }
      logger.info({ module: mod, fn, invoiceId, ticketId, lineItemId, dealId, ...recalcResult },
        'recalcFacturasRestantes ejecutado post-cancelación');
    } catch (err) {
      logger.warn({ module: mod, fn, invoiceId, ticketId, lineItemId, err },
        'recalcFacturasRestantes falló post-cancelación (no bloquea)');
    }
  }
}

/**
 * Bloque 5b — rama CANCELAR (definitiva) del flujo cancelar/revertir.
 * Solo alcanzable con CANCEL_REVERT_FLOW_ENABLED prendida y cancelIntent='cancel'.
 *
 * El período queda CERRADO: el ticket va a la etapa CANCELADO de su pipeline
 * y NO se refactura.
 *
 * ⚠️ CRÍTICO — NO borrar of_invoice_id, of_invoice_status ni fechas de
 * facturación: missedBillingGuard da por RESUELTO un período cuando el ticket
 * tiene of_invoice_id (skip). Si se limpiara, el guard re-emitiría el período
 * anulado — exactamente lo que esta rama quiere evitar.
 *
 * @param {Object} params
 * @param {string} params.invoiceId
 * @param {string} params.ticketId
 * @param {Object} params.tp          - properties del ticket (hs_pipeline, of_deal_id)
 * @param {boolean} params.isAutomated
 * @param {Object|null} [params.cupoResult] - resultado de revertCupoForInvoice (o null)
 * @param {string|null} [params.lineItemId] - primer line item del ticket
 */
async function finalizeTicketAfterDefinitiveCancellation({
  invoiceId,
  ticketId,
  tp,
  isAutomated,
  cupoResult = null,
  lineItemId = null,
}) {
  const mod = 'propagacion/invoice';
  const fn  = 'finalizeTicketAfterDefinitiveCancellation';

  const dealId = (tp.of_deal_id || '').trim() || null;
  const hoy = new Date().toISOString().slice(0, 10);

  // Etapa CANCELADO del pipeline del ticket (patrón cancelTicketRequest):
  // por map de pipeline, con fallback a TICKET_STAGES.CANCELLED.
  const pipeline = String(tp.hs_pipeline || '').trim();
  const cancelledStage = String(
    CANCELLED_STAGE_BY_PIPELINE[pipeline] || TICKET_STAGES.CANCELLED || ''
  ).trim();

  // Texto del resultado de cupo para el mensaje de cierre.
  let cupoTexto;
  if (!cupoResult || cupoResult.reason === 'no_consumio_o_ya_revertido') {
    cupoTexto = 'no aplica';
  } else if (cupoResult.reverted) {
    cupoTexto = `re-acreditado +${cupoResult.credito} (restante ${cupoResult.cupoRestanteNuevo})`;
  } else {
    cupoTexto = `NO re-acreditado (${cupoResult.reason}) — reconciliar a mano`;
  }

  const closeMsg =
    `Factura ${invoiceId} cancelada DEFINITIVAMENTE el ${hoy}. ` +
    `Período cerrado: NO se refactura. Cupo: ${cupoTexto}.`;

  // ⚠️ Deliberadamente NO se tocan of_invoice_id / of_invoice_status /
  // of_fecha_de_facturacion / fecha_real_de_facturacion (ver docstring).
  const finalProps = {
    motivo_cancelacion_del_ticket: `Cancelación definitiva de la factura ${invoiceId} — ${hoy}`,
    of_billing_error: closeMsg.slice(0, 250),
    of_billing_error_at: String(Date.now()),
  };
  if (cancelledStage) {
    finalProps.hs_pipeline_stage = cancelledStage;
  } else {
    logger.warn(
      { module: mod, fn, invoiceId, ticketId, pipeline },
      'Pipeline sin etapa CANCELADO conocida: se escribe motivo/aviso sin mover de etapa'
    );
  }

  try {
    await hubspotClient.crm.tickets.basicApi.update(ticketId, { properties: finalProps });
    logger.info(
      { module: mod, fn, invoiceId, ticketId, isAutomated, cancelledStage, cupoTexto },
      'Ticket cerrado en etapa CANCELADO por cancelación definitiva de la factura'
    );
  } catch (err) {
    logger.warn(
      { module: mod, fn, invoiceId, ticketId, err },
      'Error cerrando ticket en cancelación definitiva (no bloquea)'
    );
  }

  // Recalcular contadores (facturas_restantes, progreso_pagos) — mismo bloque
  // que la rama revertir (prepareTicketForRebillingAfterCancellation).
  if (lineItemId && dealId) {
    try {
      const recalcResult = await recalcFacturasRestantes({ hubspotClient, lineItemId, dealId });
      if (recalcResult.cuotasTotales > 0) {
        try {
          const nuevoProgreso = buildPagoDisplay(recalcResult.countTickets, recalcResult.cuotasTotales);
          await hubspotClient.crm.lineItems.basicApi.update(lineItemId, {
            properties: { progreso_pagos: nuevoProgreso },
          });
          logger.info({ module: mod, fn, invoiceId, lineItemId, to: nuevoProgreso },
            'progreso_pagos actualizado post-cancelación definitiva');
        } catch (err) {
          logger.warn({ module: mod, fn, invoiceId, lineItemId, err },
            'progreso_pagos falló post-cancelación definitiva (no bloquea)');
        }
      }
      logger.info({ module: mod, fn, invoiceId, ticketId, lineItemId, dealId, ...recalcResult },
        'recalcFacturasRestantes ejecutado post-cancelación definitiva');
    } catch (err) {
      logger.warn({ module: mod, fn, invoiceId, ticketId, lineItemId, err },
        'recalcFacturasRestantes falló post-cancelación definitiva (no bloquea)');
    }
  }
}

// ─────────────────────────────────────────────
// Función principal
// ─────────────────────────────────────────────

/**
 * Propaga el estado de una invoice al ticket asociado.
 *
 * Actualiza en el ticket:
 *   - hs_pipeline_stage      → según mapeo de etapa y nodum_id
 *   - of_invoice_status      → espejo de etapa_de_la_factura
 *   - fecha_de_facturacion    → desde hs_createdate de la invoice
 * - fecha_real_de_facturacion → desde fecha_de_emision (si aplica)
 *
 * Actualiza en el line item:
 *   - last_billing_period    → fecha real de emisión (si aplica)
 *
 * @param {string} invoiceId
 * @param {Object} [options]
 * @param {'cancel'|'revert'|null} [options.cancelIntent] - intención para la rama
 *        Cancelada: 'cancel' = definitivo (ticket a CANCELADO), 'revert' o null =
 *        revertir-y-refacturar (comportamiento actual). Solo tiene efecto con
 *        CANCEL_REVERT_FLOW_ENABLED prendida; apagada se fuerza a null.
 * @returns {object} { status, invoiceId, ticketId?, updates? }
 */
export async function propagateInvoiceStateToTicket(invoiceId, { cancelIntent = null } = {}) {
  const mod = 'propagacion/invoice';
  const fn  = 'propagateInvoiceStateToTicket';

  // Llave maestra apagada → se ignora cualquier intent (comportamiento actual).
  if (cancelIntent != null && !cancelRevertFlowEnabled()) {
    logger.debug(
      { module: mod, fn, invoiceId, cancelIntent },
      'CANCEL_REVERT_FLOW_ENABLED off — cancelIntent ignorado (se fuerza null)'
    );
    cancelIntent = null;
  }

  // 1. Leer invoice
  let invoice;
  try {
    invoice = await hubspotClient.crm.objects.basicApi.getById(
      INVOICE_OBJECT_TYPE,
      invoiceId,
      ['etapa_de_la_factura', 'of_invoice_key', 'ticket_id', 'id_factura_nodum', 'fecha_de_emision', 'hs_createdate', 'dolar']    );
  } catch (err) {
    logger.error({ module: mod, fn, invoiceId, err }, 'Error al obtener invoice');
    throw err;
  }

  const ip       = invoice.properties || {};
  const etapa    = ip.etapa_de_la_factura;
  const invoiceKey = ip.of_invoice_key;
  const nodumId  = (ip.id_factura_nodum || '').trim() || null;
  const fechaEmisionRaw = ip.fecha_de_emision || null;
  const fechaEmisionYMD = invoiceDateToYMD(fechaEmisionRaw);
  const fechaCreacionYMD = invoiceDateToYMD(ip.hs_createdate || null);
  
  logger.info({ module: mod, fn, invoiceId, etapa, nodumId, invoiceKey, fechaEmisionYMD }, 'Iniciando propagación');

  // 2. Buscar ticket — primero por of_invoice_key, fallback a ticket_id en invoice
  let ticket = null;

  if (invoiceKey) {
    try {
      const resp = await hubspotClient.crm.tickets.searchApi.doSearch({
        filterGroups: [{ filters: [{ propertyName: 'of_invoice_key', operator: 'EQ', value: invoiceKey }] }],
        properties: ['of_invoice_status', 'hs_pipeline', 'hs_pipeline_stage', 'of_line_item_ids', 'fecha_real_de_facturacion', 'of_deal_id', 'of_aplica_para_cupo', 'of_refacturaciones', 'motivo_del_ajuste'],        limit: 1,
      });
      ticket = resp?.results?.[0] || null;
    } catch (err) {
      logger.warn({ module: mod, fn, invoiceId, invoiceKey, err }, 'Error buscando ticket por of_invoice_key');
    }
  }

  if (!ticket && ip.ticket_id) {
    try {
      ticket = await hubspotClient.crm.tickets.basicApi.getById(
        String(ip.ticket_id),
        ['of_invoice_status', 'hs_pipeline', 'hs_pipeline_stage', 'of_line_item_ids', 'fecha_real_de_facturacion', 'of_deal_id', 'of_refacturaciones', 'motivo_del_ajuste']
      );
    } catch (err) {
      logger.warn({ module: mod, fn, invoiceId, ticketId: ip.ticket_id, err }, 'Error obteniendo ticket por ticket_id');
    }
  }

  if (!ticket) {
    logger.warn({ module: mod, fn, invoiceId, invoiceKey }, 'No se encontró ticket asociado, skip');
    return { status: 'skipped', reason: 'no_ticket_found', invoiceId };
  }

  const ticketId     = String(ticket.id);
  const tp           = ticket.properties || {};
  const currentStage = tp.hs_pipeline_stage;
  const currentPipeline = tp.hs_pipeline;
  const lineItemId   = String(tp.of_line_item_ids || '').split(',')[0].trim() || null;
  const isAutomated  = String(currentPipeline) === String(AUTOMATED_TICKET_PIPELINE);

  // 3. Resolver stage destino
  const targetStage = resolveTargetStage({ etapa, nodumId, currentStage, isAutomated });

  // 4. Construir update del ticket
  const ticketUpdate = {};

  // Sincronizar of_invoice_status si cambió
  if (tp.of_invoice_status !== etapa) {
    ticketUpdate.of_invoice_status = etapa;
  }

  // Mover stage si corresponde y es diferente al actual
  if (targetStage && String(targetStage) !== String(currentStage)) {
    ticketUpdate.hs_pipeline_stage = String(targetStage);
  }

  // fecha_de_facturacion: fecha de creación de la invoice en HubSpot
   if (fechaCreacionYMD) {
     ticketUpdate.fecha_de_facturacion = toHubSpotDateOnly(fechaCreacionYMD);
   }
  if (fechaEmisionYMD && ETAPAS_CON_FECHA_REAL.includes(etapa)) {
    const fechaHubSpot = toHubSpotDateOnly(fechaEmisionYMD);
    if (tp.fecha_real_de_facturacion !== fechaHubSpot) {
      ticketUpdate.fecha_real_de_facturacion = fechaHubSpot;
    }
  }
  // También si tenemos nodumId pero etapa es Pendiente, igual tomamos la fecha si existe
  if (nodumId && fechaEmisionYMD && !ETAPAS_CON_FECHA_REAL.includes(etapa)) {
    const fechaHubSpot = toHubSpotDateOnly(fechaEmisionYMD);
    if (tp.fecha_real_de_facturacion !== fechaHubSpot) {
      ticketUpdate.fecha_real_de_facturacion = fechaHubSpot;
    }
  }

  // Dólar de facturación: cuando la factura viene de Nodum (nodumId presente), su `dolar`
  // es el TC real del momento de facturación → pisa el TC sellado del ticket. Así lo ya
  // facturado se valúa al dólar del día de la factura y lo pendiente sigue con el sellado.
  const dolarFactura = Number(ip.dolar);
  if (nodumId && dolarFactura > 0) {
    ticketUpdate.dolar = dolarFactura;
  }

  // 5. Aplicar update en ticket
  if (Object.keys(ticketUpdate).length > 0) {
    try {
      await hubspotClient.crm.tickets.basicApi.update(ticketId, { properties: ticketUpdate });
      logger.info({ module: mod, fn, invoiceId, ticketId, ticketUpdate }, 'Ticket actualizado');
    } catch (err) {
      logger.error({ module: mod, fn, invoiceId, ticketId, ticketUpdate, err }, 'Error actualizando ticket');
      throw err;
    }
  } else {
    logger.info({ module: mod, fn, invoiceId, ticketId }, 'Ticket sin cambios necesarios, skip update');
  }

// 5b. Lógica de cancelación — bifurcación cancel/revert:
  //   - 'revert' (default, comportamiento actual): el ticket NUNCA va a
  //     CANCELLED por cancelación de factura. Manual → vuelve a NEW.
  //     Automático → vuelve a READY. (prepareTicketForRebillingAfterCancellation)
  //   - 'cancel' (solo con CANCEL_REVERT_FLOW_ENABLED + cancelIntent='cancel'):
  //     cancelación definitiva, ticket a etapa CANCELADO, período cerrado.
  //     (finalizeTicketAfterDefinitiveCancellation)
  if (etapa === 'Cancelada') {
    // Reversión REAL de cupo (hallazgo #1, doble consumo): solo con la llave
    // CUPO_REVERT_ON_CANCEL_ENABLED prendida. Apagada → cupoResult=null y el
    // aviso textual actual de cupo queda intacto.
    let cupoResult = null;
    if (cupoRevertOnCancelEnabled()) {
      const dealIdCupo = (tp.of_deal_id || '').trim() || null;
      if (dealIdCupo) {
        // revertCupoForInvoice NUNCA lanza: siempre devuelve { reverted, ... }.
        cupoResult = await revertCupoForInvoice({ dealId: dealIdCupo, ticketId, invoiceId });
      } else {
        logger.warn(
          { module: mod, fn, invoiceId, ticketId },
          'Sin of_deal_id en el ticket: no se puede revertir cupo automáticamente'
        );
        cupoResult = { reverted: false, reason: 'sin_deal_id' };
      }
    }

    const branch = resolveCancellationBranch({ cancelIntent });
    let contadorNuevo = null;
    if (branch === 'cancel') {
      await finalizeTicketAfterDefinitiveCancellation({
        invoiceId,
        ticketId,
        tp,
        isAutomated,
        cupoResult,
        lineItemId,
      });
    } else {
      // Contador of_refacturaciones: SOLO con cancelIntent EXPLÍCITO 'revert'
      // (reversión deliberada). Con intent null (webhook genérico, cron sweep
      // que re-propaga la misma invoice cancelada en cada corrida) devuelve
      // null y NO se escribe — si no, el contador se inflaría solo.
      contadorNuevo = computeContadorRefacturaciones({
        cancelIntent,
        actual: tp.of_refacturaciones,
      });
      await prepareTicketForRebillingAfterCancellation({
        invoiceId,
        ticketId,
        tp,
        isAutomated,
        fechaCreacionYMD,
        lineItemId,
        cupoResult,
        contadorNuevo,
      });
    }

    // Avisos (Bloque 4) — SOLO con cancelIntent EXPLÍCITO ('cancel'/'revert').
    // ⚠️ NUNCA con intent null: el cron sweep propagateCancelledInvoicesForDeal
    // re-propaga las MISMAS invoices canceladas en cada corrida; si estos
    // avisos corrieran ahí, spamearían a administración y al espejo UY en cada
    // pasada. Con la llave maestra apagada el intent ya llega forzado a null →
    // con flags off este bloque no corre jamás (neutralidad garantizada).
    // Fire-and-forget: nada de acá bloquea ni rompe la propagación.
    if (cancelIntent === 'cancel' || cancelIntent === 'revert') {
      const motivo = String(tp.motivo_del_ajuste || '').trim() || null;

      // Aviso al deal espejo UY (ambas ramas): verificar el ticket UY a mano.
      if (lineItemId) {
        try {
          notifyMirrorDealOnCancelOrRevert(lineItemId, {
            tipo: cancelIntent,
            invoiceId,
            ticketId,
          }).catch((err) => {
            logger.warn({ module: mod, fn, invoiceId, ticketId, err: err?.message },
              'Aviso a mirror cancel/revert falló (no bloquea)');
          });
        } catch (err) {
          logger.warn({ module: mod, fn, invoiceId, ticketId, err: err?.message },
            'Aviso a mirror cancel/revert falló (no bloquea)');
        }
      } else {
        logger.debug({ module: mod, fn, invoiceId, ticketId },
          'Ticket sin of_line_item_ids: sin lookup de espejo, aviso a mirror omitido');
      }

      // Email a administración: SOLO en la rama REVERTIR (refacturación).
      if (cancelIntent === 'revert') {
        try {
          notifyAdminOnRevert({
            dealId: (tp.of_deal_id || '').trim() || null,
            ticketId,
            invoiceId,
            contador: contadorNuevo,
            cupoResult,
            motivo,
          }).catch((err) => {
            logger.warn({ module: mod, fn, invoiceId, ticketId, err: err?.message },
              'Aviso a administración de reversión falló (no bloquea)');
          });
        } catch (err) {
          logger.warn({ module: mod, fn, invoiceId, ticketId, err: err?.message },
            'Aviso a administración de reversión falló (no bloquea)');
        }
      }
    }
  }

  // 6. Actualizar last_billing_period del line item con fecha REAL de emisión
  // Fecha real → billing_last_billed_date
  //    last_billing_period se mantiene con la fecha plan (seteada al crear invoice)
  if (lineItemId && fechaEmisionYMD && (ETAPAS_CON_FECHA_REAL.includes(etapa) || nodumId)) {
    try {
      const blp = toHubSpotDateOnly(fechaEmisionYMD);
      await hubspotClient.crm.lineItems.basicApi.update(lineItemId, {
        properties: { billing_last_billed_date: blp },
      });
      logger.info({ module: mod, fn, invoiceId, ticketId, lineItemId, fechaEmisionYMD, blp },
       '[BLBD] billing_last_billed_date actualizado con fecha real de emisión');
    } catch (err) {
      logger.warn({ module: mod, fn, invoiceId, ticketId, lineItemId, err },
        '[BLBD] Error actualizando billing_last_billed_date con fecha real (no bloquea)');
    }
  }

// 7. Recalcular facturas_restantes si el ticket llegó a un stage facturado
  const effectiveStage = targetStage || currentStage;
  if (INVOICED_STAGES.has(String(effectiveStage)) && lineItemId) {
    const dealId = tp.of_deal_id || null;
    if (dealId) {
      try {
        const recalcResult = await recalcFacturasRestantes({ hubspotClient, lineItemId, dealId });
        if (recalcResult.cuotasTotales > 0) {
          try {
            const nuevoProgreso = buildPagoDisplay(recalcResult.countTickets, recalcResult.cuotasTotales);
            const liProps = await hubspotClient.crm.lineItems.basicApi.getById(
              lineItemId, ['progreso_pagos']
            );
            const curProgreso = String(liProps.properties?.progreso_pagos ?? '').trim();
            if (curProgreso !== nuevoProgreso) {
              await hubspotClient.crm.lineItems.basicApi.update(lineItemId, {
                properties: { progreso_pagos: nuevoProgreso },
              });
              logger.info({ module: mod, fn, invoiceId, lineItemId, from: curProgreso, to: nuevoProgreso },
                'progreso_pagos actualizado post-propagación');
            }
          } catch (err) {
            logger.warn({ module: mod, fn, invoiceId, lineItemId, err },
              'progreso_pagos falló (no bloquea propagación)');
          }
        }
        logger.info({ module: mod, fn, invoiceId, ticketId, lineItemId, dealId, ...recalcResult },
          'recalcFacturasRestantes ejecutado post-propagación');
      } catch (err) {
        logger.warn({ module: mod, fn, invoiceId, ticketId, lineItemId, dealId, err },
          'recalcFacturasRestantes falló (no bloquea propagación)');
      }
    }
  }

  return {
    status: 'propagated',
    invoiceId,
    ticketId,
    etapa,
    targetStage: targetStage || null,
    updates: ticketUpdate,
  };
}

// ─────────────────────────────────────────────
// Compatibilidad hacia atrás
// ─────────────────────────────────────────────

/**
 * @deprecated Usar propagateInvoiceStateToTicket en su lugar.
 * Mantenido por compatibilidad con llamadas existentes en propagateCancelledInvoicesForDeal.
 */
export async function propagateInvoiceCancellation(invoiceId) {
  const result = await propagateInvoiceStateToTicket(invoiceId);
  return result;
}

/**
 * Para un conjunto de line items de un deal, busca todas las invoices canceladas
 * por LIK y propaga a cada ticket asociado.
 * Diseñado para correr antes de las fases en runPhasesForDeal.
 *
 * @param {Array} lineItems - line items del deal (con properties.line_item_key)
 * @returns {object} resumen { propagated, skipped, errors }
 */
export async function propagateCancelledInvoicesForDeal(lineItems) {
  const mod = 'propagacion/invoice';
  const fn  = 'propagateCancelledInvoicesForDeal';
  const results = { propagated: 0, skipped: 0, errors: 0 };

  if (!Array.isArray(lineItems) || lineItems.length === 0) return results;

  const liks = [...new Set(
    lineItems
      .map(li => (li.properties?.line_item_key || li.line_item_key || '').trim())
      .filter(Boolean)
  )];

  if (liks.length === 0) {
    logger.warn({ module: mod, fn }, 'No se encontraron LIKs en los line items');
    return results;
  }

logger.info({ module: mod, fn, liks }, 'LIKs extraídos para búsqueda');

  const CHUNK_SIZE = 5;
  const allInvoices = [];

  for (let i = 0; i < liks.length; i += CHUNK_SIZE) {
    const chunk = liks.slice(i, i + CHUNK_SIZE);
    try {
      const resp = await hubspotClient.crm.objects.searchApi.doSearch(INVOICE_OBJECT_TYPE, {
        filterGroups: chunk.map(lik => ({
          filters: [{ propertyName: 'line_item_key', operator: 'EQ', value: lik }],
        })),
        properties: ['etapa_de_la_factura', 'line_item_key', 'of_invoice_key'],
        limit: 100,
      });
      allInvoices.push(...(resp?.results ?? []));
    } catch (err) {
      logger.error({ module: mod, fn, chunk, err }, 'Error buscando invoices canceladas (chunk)');
    }
  }

  logger.info({ module: mod, fn, total: allInvoices.length }, 'Resultado búsqueda invoices');

  const cancelledInvoices = allInvoices.filter(
    inv => inv.properties?.etapa_de_la_factura === 'Cancelada'
  );

  for (const inv of cancelledInvoices) {
    try {
      const result = await propagateInvoiceStateToTicket(inv.id);
      if (result.status === 'propagated') results.propagated++;
      else results.skipped++;
    } catch (err) {
      logger.error({ module: mod, fn, invoiceId: inv.id, err }, 'Error propagando cancelación');
      results.errors++;
    }
  }

  
  return results;
}

