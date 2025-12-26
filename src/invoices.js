import { hubspotClient } from './hubspotClient.js';

/*
 * Módulo para crear facturas. Incluye funciones para facturar tickets (manual)
 * y facturar line items (automático). Usa DRY_RUN para evitar ejecuciones
 * en entornos de prueba.
 */

export async function createInvoiceForTicket(ticket) {
  const ticketId = ticket.id || ticket.properties?.hs_object_id;
  const props = ticket.properties || {};

  const existingInvoiceId = props.of_invoice_id;
  if (existingInvoiceId) {
    console.log(`[invoices] Ticket ${ticketId} ya tiene factura ${existingInvoiceId}, no se crea otra.`);
    return { invoiceId: existingInvoiceId };
  }

  const invoiceKey =
    props.of_invoice_key ||
    `${props.of_deal_id || ''}::${props.of_line_item_ids || ''}::${props.of_fecha_de_facturacion || ''}`;

  const dryRun = (process.env.DRY_RUN || '').toString().toLowerCase() === 'true';
  if (dryRun) {
    console.log(`[invoices] DRY_RUN: se omite creación real de factura para ticket ${ticketId}, key ${invoiceKey}`);
    return { invoiceId: null };
  }

  const invoiceProps = {
    hs_currency: props.of_moneda || 'USD',
    hs_invoice_date: props.of_fecha_de_facturacion,
    hs_due_date: props.of_fecha_de_facturacion,
    of_invoice_key: invoiceKey,
    of_invoice_status: 'draft',
  };

  try {
    const createResp = await hubspotClient.crm.invoices.basicApi.create({
      properties: invoiceProps,
    });
    const invoiceId = createResp.id || createResp.result?.id;

    const dealId = props.of_deal_id;
    const lineItemId = props.of_line_item_ids;
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
    const assocCalls = [];
    if (lineItemId) {
      assocCalls.push(
        hubspotClient.crm.associations.v4.basicApi.create(
          'invoices',
          invoiceId,
          'line_items',
          lineItemId,
          []
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
          []
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
 * Crea una factura automática a partir de un line item. Calcula el total como
 * cantidad × precio y asocia la factura al negocio y al line item.
 */
export async function createInvoiceForLineItem(deal, lineItem, invoiceDate) {
  if (!deal || !lineItem) return { invoiceId: null };
  const dealId = String(deal.id || deal.properties?.hs_object_id);
  const lineItemId = String(lineItem.id || lineItem.properties?.hs_object_id);
  const lp = lineItem.properties || {};
  const dp = deal.properties || {};

  const invoiceKey = `${dealId}::${lineItemId}::${invoiceDate || ''}`;

  if (lp.of_invoice_id) {
    return { invoiceId: lp.of_invoice_id };
  }
  const dryRun = (process.env.DRY_RUN || '').toString().toLowerCase() === 'true';
  if (dryRun) {
    console.log(`[invoices] DRY_RUN: no se crea factura real para line item ${lineItemId}`);
    return { invoiceId: null };
  }
  const quantity = parseFloat(lp.quantity) || 0;
  const price = parseFloat(lp.price) || 0;
  const total = quantity * price;
  const invoiceProps = {
    hs_currency: dp.deal_currency_code || 'USD',
    hs_invoice_date: invoiceDate,
    hs_due_date: invoiceDate,
    of_invoice_key: invoiceKey,
    of_invoice_status: 'draft',
    amount: total.toString(),
    subject: lp.name || 'Factura automática',
  };
  try {
    const createResp = await hubspotClient.crm.invoices.basicApi.create({
      properties: invoiceProps,
    });
    const invoiceId = createResp.id || createResp.result?.id;
    const assocCalls = [];
    assocCalls.push(
      hubspotClient.crm.associations.v4.basicApi.create(
        'invoices',
        invoiceId,
        'deals',
        dealId,
        []
      )
    );
    assocCalls.push(
      hubspotClient.crm.associations.v4.basicApi.create(
        'invoices',
        invoiceId,
        'line_items',
        lineItemId,
        []
      )
    );
    await Promise.all(assocCalls);
    await hubspotClient.crm.invoices.basicApi.update(invoiceId, {
      properties: { hs_invoice_status: 'open' },
    });
    try {
      await hubspotClient.crm.lineItems.basicApi.update(lineItemId, {
        properties: {
          of_invoice_id: invoiceId,
          of_invoice_key: invoiceKey,
          of_invoice_status: 'open',
        },
      });
    } catch (e) {
      console.warn('[invoices] No se pudo actualizar line item con invoice', e?.response?.body || e?.message);
    }
    console.log(`[invoices] Factura ${invoiceId} creada y abierta para line item ${lineItemId}`);
    return { invoiceId };
  } catch (err) {
    console.error('[invoices] Error creando factura automática', err?.response?.body || err?.message || err);
    throw err;
  }
}

/**
 * Procesa tickets listos para facturar. Busca tickets en etapa READY sin factura,
 * crea la factura y actualiza el ticket. Se puede ejecutar periódicamente.
 */
export async function emitInvoicesForReadyTickets() {
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
  let after;
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
