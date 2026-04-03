/**
 * src/propagacion/invoice.js
 *
 * Propagación de cambios de estado de Invoice (real/Nodum) → Ticket asociado.
 *
 * Responsabilidades:
 *   1. Mapear etapa_de_la_factura → stage del ticket (manual o automático)
 *   2. Sincronizar of_invoice_status en el ticket
 *   3. Escribir fecha_real_de_facturacion en el ticket (desde fecha_de_emision)
 *   4. Actualizar last_billing_period en el line item con la fecha REAL de emisión
 *   5. Mover ticket a CREATED cuando se setea id_factura_nodum (si no hay etapa posterior)
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
} from '../config/constants.js';

const INVOICE_OBJECT_TYPE = 'invoices';

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

// ─────────────────────────────────────────────
// Función principal
// ─────────────────────────────────────────────

/**
 * Propaga el estado de una invoice al ticket asociado.
 *
 * Actualiza en el ticket:
 *   - hs_pipeline_stage      → según mapeo de etapa y nodum_id
 *   - of_invoice_status      → espejo de etapa_de_la_factura
 *   - fecha_real_de_facturacion → desde fecha_de_emision (si aplica)
 *
 * Actualiza en el line item:
 *   - last_billing_period    → fecha real de emisión (si aplica)
 *
 * @param {string} invoiceId
 * @returns {object} { status, invoiceId, ticketId?, updates? }
 */
export async function propagateInvoiceStateToTicket(invoiceId) {
  const mod = 'propagacion/invoice';
  const fn  = 'propagateInvoiceStateToTicket';

  // 1. Leer invoice
  let invoice;
  try {
    invoice = await hubspotClient.crm.objects.basicApi.getById(
      INVOICE_OBJECT_TYPE,
      invoiceId,
      ['etapa_de_la_factura', 'of_invoice_key', 'ticket_id', 'id_factura_nodum', 'fecha_de_emision']
    );
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

  logger.info({ module: mod, fn, invoiceId, etapa, nodumId, invoiceKey, fechaEmisionYMD }, 'Iniciando propagación');

  // 2. Buscar ticket — primero por of_invoice_key, fallback a ticket_id en invoice
  let ticket = null;

  if (invoiceKey) {
    try {
      const resp = await hubspotClient.crm.tickets.searchApi.doSearch({
        filterGroups: [{ filters: [{ propertyName: 'of_invoice_key', operator: 'EQ', value: invoiceKey }] }],
        properties: ['of_invoice_status', 'hs_pipeline', 'hs_pipeline_stage', 'of_line_item_ids', 'fecha_real_de_facturacion'],
        limit: 1,
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
        ['of_invoice_status', 'hs_pipeline', 'hs_pipeline_stage', 'of_line_item_ids', 'fecha_real_de_facturacion']
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

  // fecha_real_de_facturacion: solo cuando hay fecha de emisión real y la etapa es post-pendiente
  const etapasConFechaReal = ['Emitida', 'Enviada', 'Paga', 'Atrasada'];
  if (fechaEmisionYMD && etapasConFechaReal.includes(etapa)) {
    const fechaHubSpot = toHubSpotDateOnly(fechaEmisionYMD);
    if (tp.fecha_real_de_facturacion !== fechaHubSpot) {
      ticketUpdate.fecha_real_de_facturacion = fechaHubSpot;
    }
  }
  // También si tenemos nodumId pero etapa es Pendiente, igual tomamos la fecha si existe
  if (nodumId && fechaEmisionYMD && !etapasConFechaReal.includes(etapa)) {
    const fechaHubSpot = toHubSpotDateOnly(fechaEmisionYMD);
    if (tp.fecha_real_de_facturacion !== fechaHubSpot) {
      ticketUpdate.fecha_real_de_facturacion = fechaHubSpot;
    }
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

  // 6. Actualizar last_billing_period del line item con fecha REAL de emisión
  //    (solo cuando la factura está efectivamente emitida y tenemos la fecha)
  const etapasParaBLP = ['Emitida', 'Enviada', 'Paga'];
  if (lineItemId && fechaEmisionYMD && (etapasParaBLP.includes(etapa) || nodumId)) {
    try {
      const blp = toHubSpotDateOnly(fechaEmisionYMD);
      await hubspotClient.crm.lineItems.basicApi.update(lineItemId, {
        properties: { last_billing_period: blp },
      });
      logger.info({ module: mod, fn, invoiceId, ticketId, lineItemId, fechaEmisionYMD, blp },
        '[BLP] last_billing_period actualizado con fecha real de emisión');
    } catch (err) {
      logger.warn({ module: mod, fn, invoiceId, ticketId, lineItemId, err },
        '[BLP] Error actualizando last_billing_period con fecha real (no bloquea)');
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