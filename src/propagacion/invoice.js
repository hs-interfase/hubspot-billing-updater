/**
 * src/propagacion/invoice.js
 *
 * Propagación de cambios de estado de Invoice → Ticket asociado.
 *
 * Cuando una invoice pasa a etapa_de_la_factura = 'Cancelada':
 *   1. Busca el ticket asociado vía Associations API
 *   2. Escribe of_invoice_status = 'Cancelada' en el ticket
 *
 * of_invoice_id y of_invoice_key se conservan intencionalmente para
 * trazabilidad. Los guards leen of_invoice_status para permitir re-facturación.
 */

import { hubspotClient } from '../hubspotClient.js';
import logger from '../../lib/logger.js';

const INVOICE_OBJECT_TYPE = 'invoices';
const TICKET_OBJECT_TYPE = 'tickets';
const CANCELLED_STAGE = 'Cancelada';

/**
 * Propaga la cancelación de UNA invoice al ticket asociado.
 *
 * @param {string} invoiceId
 * @returns {object} { status, invoiceId, ticketId? }
 */
export async function propagateInvoiceCancellation(invoiceId) {
  // 1. Verificar que la invoice efectivamente está Cancelada
  let invoice;
  try {
    invoice = await hubspotClient.crm.objects.basicApi.getById(
      INVOICE_OBJECT_TYPE,
      invoiceId,
      ['etapa_de_la_factura']
    );
  } catch (err) {
    logger.error({ module: 'propagacion/invoice', fn: 'propagateInvoiceCancellation', invoiceId, err }, 'Error al obtener invoice');
    throw err;
  }

  const stage = invoice.properties.etapa_de_la_factura;
  if (stage !== CANCELLED_STAGE) {
    logger.info({ module: 'propagacion/invoice', fn: 'propagateInvoiceCancellation', invoiceId, stage }, 'No es Cancelada, skip');
    return { status: 'skipped', reason: 'not_cancelled', invoiceId };
  }

  // 2. Buscar ticket asociado vía Associations API
  let ticketId;
  try {
    const associations = await hubspotClient.crm.objects.associationsApi.getAll(
      INVOICE_OBJECT_TYPE,
      invoiceId,
      TICKET_OBJECT_TYPE
    );

    const results = associations?.results ?? [];
    if (results.length === 0) {
      logger.warn({ module: 'propagacion/invoice', fn: 'propagateInvoiceCancellation', invoiceId }, 'No hay ticket asociado');
      return { status: 'skipped', reason: 'no_associated_ticket', invoiceId };
    }

    ticketId = results[0].id;
  } catch (err) {
    logger.error({ module: 'propagacion/invoice', fn: 'propagateInvoiceCancellation', invoiceId, err }, 'Error al obtener asociaciones');
    throw err;
  }

  // 3. Verificar si el ticket ya tiene of_invoice_status = Cancelada (evitar update innecesario)
  try {
    const ticket = await hubspotClient.crm.tickets.basicApi.getById(String(ticketId), ['of_invoice_status']);
    if (ticket.properties.of_invoice_status === CANCELLED_STAGE) {
      logger.info({ module: 'propagacion/invoice', fn: 'propagateInvoiceCancellation', invoiceId, ticketId }, 'Ticket ya tiene status Cancelada, skip');
      return { status: 'skipped', reason: 'already_propagated', invoiceId, ticketId };
    }
  } catch (err) {
    // fail open: si no podemos leer el ticket, igual intentamos actualizar
    logger.warn({ module: 'propagacion/invoice', fn: 'propagateInvoiceCancellation', invoiceId, ticketId, err }, 'Error leyendo ticket, continuando igual');
  }

  // 4. Marcar of_invoice_status en el ticket
  try {
    await hubspotClient.crm.tickets.basicApi.update(String(ticketId), {
      properties: { of_invoice_status: CANCELLED_STAGE },
    });
    logger.info({ module: 'propagacion/invoice', fn: 'propagateInvoiceCancellation', invoiceId, ticketId }, 'Ticket actualizado: of_invoice_status=Cancelada');
  } catch (err) {
    logger.error({ module: 'propagacion/invoice', fn: 'propagateInvoiceCancellation', invoiceId, ticketId, err }, 'Error actualizando ticket');
    throw err;
  }

  return { status: 'propagated', invoiceId, ticketId };
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
  const results = { propagated: 0, skipped: 0, errors: 0 };

  if (!Array.isArray(lineItems) || lineItems.length === 0) return results;

  // Extraer LIKs únicos
  const liks = [...new Set(
    lineItems
      .map(li => (li.properties?.line_item_key || li.line_item_key || '').trim())
      .filter(Boolean)
  )];

  if (liks.length === 0) {
    logger.warn({ module: 'propagacion/invoice', fn: 'propagateCancelledInvoicesForDeal' }, 'No se encontraron LIKs en los line items');
    return results;
  }

  // Buscar invoices canceladas para estos LIKs
  // Cada LIK es un filterGroup separado (OR entre LIKs, AND dentro de cada grupo)
  let cancelledInvoices = [];
  try {
    const resp = await hubspotClient.crm.objects.searchApi.doSearch(INVOICE_OBJECT_TYPE, {
      filterGroups: liks.map(lik => ({
        filters: [
          { propertyName: 'line_item_key', operator: 'EQ', value: lik },
          { propertyName: 'etapa_de_la_factura', operator: 'EQ', value: CANCELLED_STAGE },
        ],
      })),
      properties: ['etapa_de_la_factura', 'line_item_key'],
      limit: 100,
    });
    cancelledInvoices = resp?.results ?? [];
  } catch (err) {
    // fail open: no bloqueamos las fases si falla esta búsqueda
    logger.error({ module: 'propagacion/invoice', fn: 'propagateCancelledInvoicesForDeal', liks, err }, 'Error buscando invoices canceladas, fail open');
    return results;
  }

  if (cancelledInvoices.length === 0) return results;

  logger.info(
    { module: 'propagacion/invoice', fn: 'propagateCancelledInvoicesForDeal', count: cancelledInvoices.length },
    'Invoices canceladas encontradas, propagando'
  );

  for (const invoice of cancelledInvoices) {
    try {
      const result = await propagateInvoiceCancellation(invoice.id);
      if (result.status === 'propagated') results.propagated++;
      else results.skipped++;
    } catch (err) {
      logger.error({ module: 'propagacion/invoice', fn: 'propagateCancelledInvoicesForDeal', invoiceId: invoice.id, err }, 'Error propagando cancelación, continuando');
      results.errors++;
    }
  }

  logger.info(
    { module: 'propagacion/invoice', fn: 'propagateCancelledInvoicesForDeal', ...results },
    'Propagación de facturas canceladas completada'
  );

  return results;
}