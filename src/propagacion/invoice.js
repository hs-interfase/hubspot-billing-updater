/**
 * src/propagacion/invoice.js
 *
 * Propagación de cambios de estado de Invoice → Ticket asociado.
 *
 * Cuando una invoice pasa a etapa_de_la_factura = 'Cancelada':
 *   1. Verifica que la invoice esté efectivamente cancelada
 *   2. Busca el ticket asociado vía Associations API
 *   3. Escribe of_invoice_status = 'Cancelada' en el ticket
 *
 * of_invoice_id y of_invoice_key se conservan intencionalmente para
 * mantener trazabilidad. Los guards de facturación leen of_invoice_status
 * para decidir si el ticket puede re-facturarse.
 */

const hubspotClient = require('../lib/hubspotClient'); // ajusta al path real

const INVOICE_OBJECT_TYPE = 'invoices';
const TICKET_OBJECT_TYPE = 'tickets';
const CANCELLED_STAGE = 'Cancelada';

/**
 * Propaga la cancelación de una invoice al ticket asociado.
 *
 * @param {string} invoiceId - HubSpot object ID de la invoice cancelada
 * @returns {object} resultado con ticketId afectado o motivo de skip
 */
async function propagateInvoiceCancellation(invoiceId) {
  const logPrefix = `[propagacion/invoice][invoiceId=${invoiceId}]`;

  // 1. Verificar que la invoice efectivamente está Cancelada
  let invoice;
  try {
    invoice = await hubspotClient.crm.objects.basicApi.getById(
      INVOICE_OBJECT_TYPE,
      invoiceId,
      ['etapa_de_la_factura']
    );
  } catch (err) {
    console.error(`${logPrefix} Error al obtener invoice:`, err.message);
    throw err;
  }

  const stage = invoice.properties.etapa_de_la_factura;
  if (stage !== CANCELLED_STAGE) {
    console.log(`${logPrefix} Stage es "${stage}", no es Cancelada. Skip.`);
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
      console.warn(`${logPrefix} No hay ticket asociado a esta invoice.`);
      return { status: 'skipped', reason: 'no_associated_ticket', invoiceId };
    }

    ticketId = results[0].id;
  } catch (err) {
    console.error(`${logPrefix} Error al obtener asociaciones:`, err.message);
    throw err;
  }

  console.log(`${logPrefix} Ticket asociado: ${ticketId}`);

  // 3. Marcar of_invoice_status en el ticket.
  //    of_invoice_id y of_invoice_key se conservan para trazabilidad.
  //    Los guards leen of_invoice_status para permitir re-facturación.
  try {
    await hubspotClient.crm.tickets.basicApi.update(ticketId, {
      properties: {
        of_invoice_status: CANCELLED_STAGE,
      },
    });

    console.log(`${logPrefix} Ticket ${ticketId} actualizado: of_invoice_status=Cancelada.`);
  } catch (err) {
    console.error(`${logPrefix} Error al actualizando ticket ${ticketId}:`, err.message);
    throw err;
  }

  return {
    status: 'propagated',
    invoiceId,
    ticketId,
  };
}

module.exports = { propagateInvoiceCancellation };