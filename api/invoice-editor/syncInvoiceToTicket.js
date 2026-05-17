// api/invoice-editor/syncInvoiceToTicket.js
//
// Propaga cambios de factura → ticket.
// Solo mapea los campos que vienen en el update (no sobreescribe con null).
// La etapa (of_invoice_status) tiene su propia función en invoices.js y NO se toca acá.

import logger from '../../lib/logger.js'

const MOD = 'invoice-editor/syncInvoiceToTicket'

// Mapeo invoice → ticket
// Clave: nombre del campo en la factura
// Valor: nombre del campo en el ticket
const INVOICE_TO_TICKET_MAP = {
  id_factura_nodum:    'numero_de_factura',
  fecha_de_emision:    'fecha_real_de_facturacion',
  monto_a_facturar:    'total_real_a_facturar',
  cantidad:            'cantidad_real',
  monto_unitario:      'monto_unitario_real',
  descuento:           'descuento_en_porcentaje',
  descuento_por_unidad:'descuento_por_unidad_real',
  descripcion:         'of_descripcion_producto',
  nombre_producto:     'of_producto_nombres',
  servicio:            'of_rubro',
  unidad_de_negocio:   'unidad_de_negocio',
  iva:                 'of_iva',
  dolar:               'dolar',
}

/**
 * Construye el objeto de propiedades del ticket a partir de los campos
 * que se están actualizando en la factura. Solo incluye los campos
 * que efectivamente están en el update.
 *
 * @param {Object} invoiceProps - campos del PATCH de la factura (ya filtrados/validados)
 * @returns {Object} propiedades para el ticket, o {} si no hay nada que propagar
 */
export function buildTicketPropsFromInvoice(invoiceProps) {
  const ticketProps = {}

  for (const [invoiceField, ticketField] of Object.entries(INVOICE_TO_TICKET_MAP)) {
    if (invoiceField in invoiceProps && invoiceProps[invoiceField] !== null) {
      ticketProps[ticketField] = invoiceProps[invoiceField]
    }
  }

  return ticketProps
}

/**
 * Propaga los campos relevantes de una factura al ticket asociado.
 * Llama a HubSpot solo si hay algo que actualizar.
 *
 * @param {string} ticketId
 * @param {Object} invoiceProps - campos del PATCH de la factura
 * @param {string} invoiceId    - solo para logging
 * @param {Function} hsClient   - función que devuelve el cliente axios de HubSpot
 */
export async function syncInvoiceToTicket(ticketId, invoiceProps, invoiceId, hsClient) {
  const fn = 'syncInvoiceToTicket'

  if (!ticketId) {
    logger.warn({ module: MOD, fn, invoiceId }, 'ticketId vacío, skip')
    return
  }

  const ticketProps = buildTicketPropsFromInvoice(invoiceProps)

  if (Object.keys(ticketProps).length === 0) {
    logger.debug({ module: MOD, fn, invoiceId }, 'Ningún campo mapeable en el update, skip')
    return
  }

  logger.info({ module: MOD, fn, invoiceId, ticketId, fields: Object.keys(ticketProps) },
    'Propagando campos de factura a ticket')

  try {
    await hsClient().patch(`/crm/v3/objects/tickets/${ticketId}`, {
      properties: ticketProps,
    })
    logger.info({ module: MOD, fn, invoiceId, ticketId },
      '✅ Ticket actualizado desde factura')
  } catch (err) {
    logger.error({ module: MOD, fn, invoiceId, ticketId, err: err.response?.data || err.message },
      '❌ Error actualizando ticket desde factura')
  }
}