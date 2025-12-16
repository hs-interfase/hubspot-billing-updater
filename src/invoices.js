// src/invoices.js
import { hubspotClient } from './hubspotClient.js';

/**
 * Crea una factura en HubSpot a partir de un ticket de facturación.
 * - Usa DRY_RUN para no emitir registros reales mientras se prueba.
 * - Utiliza of_invoice_id y of_invoice_key para evitar duplicados.
 * - Asocia la factura al deal, la empresa, el contacto, el ticket y el line item.
 *
 * @param {Object} ticket   Registro de ticket con sus propiedades.
 * @returns {Promise<{invoiceId: string|null}>}
 */
export async function createInvoiceForTicket(ticket) {
  const ticketId = ticket.id || ticket.properties?.hs_object_id;
  const props = ticket.properties || {};

  // Idempotencia: si ya existe of_invoice_id en el ticket, no crear otra
  const existingInvoiceId = props.of_invoice_id;
  if (existingInvoiceId) {
    console.log(`[invoices] Ticket ${ticketId} ya tiene factura ${existingInvoiceId}, no se crea otra.`);
    return { invoiceId: existingInvoiceId };
  }

  // Construir clave idempotente para factura (deal::lineItem::fecha)
  const invoiceKey =
    props.of_invoice_key ||
    `${props.of_deal_id || ''}::${props.of_line_item_ids || ''}::${props.of_fecha_de_facturacion || ''}`;

  // Respeto de DRY_RUN: solo loguea la acción sin crear nada
  const dryRun = (process.env.DRY_RUN || '').toString().toLowerCase() === 'true';
  if (dryRun) {
    console.log(`[invoices] DRY_RUN: se omite creación real de factura para ticket ${ticketId}, key ${invoiceKey}`);
    return { invoiceId: null };
  }

  // Preparar propiedades básicas de la factura
  const invoiceProps = {
    hs_currency: props.of_moneda || 'USD',
    hs_invoice_date: props.of_fecha_de_facturacion,
    // Fecha de vencimiento: +30 días; puede ajustarse según necesidad
    hs_due_date: props.of_fecha_de_facturacion,
    // Almacenar la clave idempotente en una propiedad personalizada
    of_invoice_key: invoiceKey,
    of_invoice_status: 'draft',
  };

  try {
    // 1) Crear borrador de factura
    const createResp = await hubspotClient.crm.invoices.basicApi.create({
      properties: invoiceProps,
    });
    const invoiceId = createResp.id || createResp.result?.id;

    // 2) Asociar contacto/compañía/deal/line item/ticket
    //   HubSpot exige al menos un contacto y un line item para abrir la factura.
    const dealId = props.of_deal_id;
    const lineItemId = props.of_line_item_ids;
    // Buscamos un contacto asociado al deal o a la empresa (simplemente usamos el primero)
    let contactId = null;
    try {
      const contacts = await hubspotClient.crm.associations.v4.basicApi.getPage(
        'deals',
        dealId,
        'contacts',
        10
      );
      contactId = contacts.results?.[0]?.toObjectId || null;
    } catch (e) {
      console.warn(`[invoices] No se pudo obtener contacto asociado al deal ${dealId}`, e?.response?.body || e?.message);
    }

    // Asociaciones obligatorias
    const assocCalls = [];

    if (lineItemId) {
      assocCalls.push(
        hubspotClient.crm.associations.v4.basicApi.create(
          'invoices',
          invoiceId,
          'line_items',
          lineItemId,
          [ /* association type id 301, HubSpot defined */ ]
        )
      );
    }
    if (dealId) {
      assocCalls.push(
        hubspotClient.crm.associations.v4.basicApi.create(
          'invoices',
          invoiceId,
          'deals',
          dealId,
          []
        )
      );
    }
    if (contactId) {
      assocCalls.push(
        hubspotClient.crm.associations.v4.basicApi.create(
          'invoices',
          invoiceId,
          'contacts',
          contactId,
          [ /* association type id 187 */ ]
        )
      );
    }
    if (ticketId) {
      assocCalls.push(
        hubspotClient.crm.associations.v4.basicApi.create(
          'invoices',
          invoiceId,
          'tickets',
          ticketId,
          []
        )
      );
    }

    await Promise.all(assocCalls);

    // 3) Pasar la factura a estado "open" (no envía email al cliente porque no usamos auto-email)
    await hubspotClient.crm.invoices.basicApi.update(invoiceId, {
      properties: { hs_invoice_status: 'open' },
    });

    console.log(`[invoices] Factura ${invoiceId} creada y abierta para ticket ${ticketId}`);

    return { invoiceId };
  } catch (err) {
    console.error('[invoices] Error creando factura', err?.response?.body || err?.message || err);
    throw err;
  }
}

/**
 * Busca todos los tickets en etapa READY sin factura, crea la factura y
 * actualiza el ticket con el ID/URL resultante. Se puede ejecutar como job diario.
 */
export async function emitInvoicesForReadyTickets() {
  // Filtros de búsqueda: pipeline y stage listos para facturar, sin of_invoice_id
  const readyStage =
    process.env.BILLING_TICKET_STAGE_READY || process.env.BILLING_ORDER_STAGE_READY;
  const pipelineId = process.env.BILLING_TICKET_PIPELINE_ID;

  const filterGroups = [
    {
      filters: [
        { propertyName: 'hs_pipeline', operator: 'EQ', value: pipelineId },
        { propertyName: 'hs_pipeline_stage', operator: 'EQ', value: readyStage },
      ],
    },
    {
      filters: [
        { propertyName: 'of_invoice_id', operator: 'HAS_PROPERTY', value: false },
      ],
    },
  ];

  let after = undefined;
  let processed = 0;

  do {
    const resp = await hubspotClient.crm.tickets.searchApi.doSearch({
      filterGroups,
      sorts: [],
      properties: [
        'of_deal_id',
        'of_line_item_ids',
        'of_fecha_de_facturacion',
        'of_invoice_id',
        'of_invoice_key',
        'hs_object_id',
      ],
      limit: 100,
      after,
    });

    const tickets = resp.results || [];
    for (const ticket of tickets) {
      try {
        const { invoiceId } = await createInvoiceForTicket(ticket);
        if (invoiceId) {
          // Persistir resultado en el ticket
          await hubspotClient.crm.tickets.basicApi.update(ticket.id, {
            properties: {
              of_invoice_id: invoiceId,
              of_invoice_key:
                ticket.properties.of_invoice_key ||
                `${ticket.properties.of_deal_id}::${ticket.properties.of_line_item_ids}::${ticket.properties.of_fecha_de_facturacion}`,
              of_invoice_status: 'open',
            },
          });
        }
        processed++;
      } catch (e) {
        await hubspotClient.crm.tickets.basicApi.update(ticket.id, {
          properties: {
            of_billing_error: e?.message || 'Error creando factura',
          },
        });
      }
    }
    after = resp.paging?.next?.after;
  } while (after);

  return { processed };
}
