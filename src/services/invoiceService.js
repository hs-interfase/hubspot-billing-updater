// src/services/invoiceService.js

import { hubspotClient } from '../hubspotClient.js';
import { generateInvoiceKey } from '../utils/idempotency.js';
import { parseNumber, safeString } from '../utils/parsers.js';
import { isDryRun, DEFAULT_CURRENCY } from '../config/constants.js';

/**
 * Servicio para crear facturas automáticas o manuales.
 * Implementa idempotencia mediante of_invoice_key.
 */

/**
 * Busca una factura existente por clave única (of_invoice_key).
 */
async function findInvoiceByKey(invoiceKey) {
  try {
    const searchResp = await hubspotClient.crm.invoices.searchApi.doSearch({
      filterGroups: [
        {
          filters: [
            {
              propertyName: 'of_invoice_key',
              operator: 'EQ',
              value: invoiceKey,
            },
          ],
        },
      ],
      properties: ['of_invoice_id', 'of_invoice_status'],
      limit: 1,
    });

    return searchResp.results?.[0] || null;
  } catch (err) {
    console.warn('[invoiceService] Error buscando factura por key:', invoiceKey, err?.message);
    return null;
  }
}

/**
 * Crea una factura automática desde un Line Item.
 * 
 * @param {Object} deal - Deal de HubSpot
 * @param {Object} lineItem - Line Item de HubSpot
 * @param {string} billingDate - Fecha de facturación (YYYY-MM-DD)
 * @returns {Object} { invoiceId, created }
 */
export async function createAutoInvoiceFromLineItem(deal, lineItem, billingDate) {
  const dealId = String(deal.id || deal.properties?.hs_object_id);
  const lineItemId = String(lineItem.id || lineItem.properties?.hs_object_id);
  const lp = lineItem.properties || {};
  const dp = deal.properties || {};
  
  // 1) Verificar si ya tiene factura asociada en el line item
  if (lp.of_invoice_id) {
    console.log(`[invoiceService] Line Item ${lineItemId} ya tiene factura ${lp.of_invoice_id}`);
    return { invoiceId: lp.of_invoice_id, created: false };
  }
  
  // 2) Generar clave única
  const invoiceKey = generateInvoiceKey(dealId, lineItemId, billingDate);
  
  // 3) Verificar si ya existe factura con esa clave
  const existing = await findInvoiceByKey(invoiceKey);
  if (existing) {
    console.log(`[invoiceService] Factura ya existe con key ${invoiceKey}, id=${existing.id}`);
    // Actualizar line item con la factura existente
    try {
      await hubspotClient.crm.lineItems.basicApi.update(lineItemId, {
        properties: {
          of_invoice_id: existing.id,
          of_invoice_key: invoiceKey,
          of_invoice_status: existing.properties?.of_invoice_status || 'open',
        },
      });
    } catch (e) {
      console.warn('[invoiceService] No se pudo actualizar line item con factura existente');
    }
    return { invoiceId: existing.id, created: false };
  }
  
  // 4) DRY RUN check
  if (isDryRun()) {
    console.log(`[invoiceService] DRY_RUN: no se crea factura real para ${invoiceKey}`);
    return { invoiceId: null, created: false };
  }
  
  // 5) Calcular monto total
  const quantity = parseNumber(lp.quantity, 0);
  const price = parseNumber(lp.price, 0);
  const total = quantity * price;
  
  // 6) Crear factura
  const invoiceProps = {
    hs_currency: safeString(dp.deal_currency_code || DEFAULT_CURRENCY),
    hs_invoice_date: billingDate,
    hs_due_date: billingDate,
    of_invoice_key: invoiceKey,
    of_invoice_status: 'draft',
    amount: total.toString(),
    subject: safeString(lp.name || `Factura automática - ${dp.dealname}`),
  };
  
  try {
    const createResp = await hubspotClient.crm.invoices.basicApi.create({
      properties: invoiceProps,
    });
    const invoiceId = createResp.id || createResp.result?.id;
    
    // 7) Asociar factura a Deal y Line Item
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
    
    // Intentar asociar a contacto principal del deal
    try {
      const contacts = await hubspotClient.crm.associations.v4.basicApi.getPage(
        'deals',
        dealId,
        'contacts',
        10
      );
      const contactId = contacts.results?.[0]?.toObjectId;
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
    } catch (e) {
      console.warn('[invoiceService] No se pudo asociar contacto a factura');
    }
    
    await Promise.all(assocCalls);
    
    // 8) Cambiar estado a "open"
    await hubspotClient.crm.invoices.basicApi.update(invoiceId, {
      properties: { of_invoice_status: 'open' },
    });
    
    // 9) Actualizar line item con referencia a la factura
    try {
      await hubspotClient.crm.lineItems.basicApi.update(lineItemId, {
        properties: {
          of_invoice_id: invoiceId,
          of_invoice_key: invoiceKey,
          of_invoice_status: 'open',
        },
      });
    } catch (e) {
      console.warn('[invoiceService] No se pudo actualizar line item con invoice_id');
    }
    
    console.log(`[invoiceService] Factura ${invoiceId} creada y abierta para line item ${lineItemId}`);
    return { invoiceId, created: true };
  } catch (err) {
    console.error('[invoiceService] Error creando factura automática:', err?.response?.body || err?.message || err);
    throw err;
  }
}

/**
 * Crea una factura desde un ticket manual (legacy/opcional).
 * 
 * @param {Object} ticket - Ticket de HubSpot
 * @returns {Object} { invoiceId, created }
 */
export async function createInvoiceFromTicket(ticket) {
  const ticketId = ticket.id || ticket.properties?.hs_object_id;
  const props = ticket.properties || {};
  
  // Verificar si ya tiene factura
  if (props.of_invoice_id) {
    console.log(`[invoiceService] Ticket ${ticketId} ya tiene factura ${props.of_invoice_id}`);
    return { invoiceId: props.of_invoice_id, created: false };
  }
  
  const invoiceKey = props.of_ticket_key || `ticket::${ticketId}::${props.of_fecha_de_facturacion}`;
  
  // DRY RUN check
  if (isDryRun()) {
    console.log(`[invoiceService] DRY_RUN: no se crea factura desde ticket ${ticketId}`);
    return { invoiceId: null, created: false };
  }
  
  const invoiceProps = {
    hs_currency: props.of_moneda || DEFAULT_CURRENCY,
    hs_invoice_date: props.of_fecha_de_facturacion,
    hs_due_date: props.of_fecha_de_facturacion,
    of_invoice_key: invoiceKey,
    of_invoice_status: 'draft',
    amount: props.monto_real_a_facturar || '0',
    subject: props.subject || 'Factura desde ticket',
  };
  
  try {
    const createResp = await hubspotClient.crm.invoices.basicApi.create({
      properties: invoiceProps,
    });
    const invoiceId = createResp.id || createResp.result?.id;
    
    // Asociar a ticket, deal, line item
    const assocCalls = [];
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
    if (props.of_deal_id) {
      assocCalls.push(
        hubspotClient.crm.associations.v4.basicApi.create(
          'invoices',
          invoiceId,
          'deals',
          props.of_deal_id,
          []
        )
      );
    }
    if (props.of_line_item_ids) {
      assocCalls.push(
        hubspotClient.crm.associations.v4.basicApi.create(
          'invoices',
          invoiceId,
          'line_items',
          props.of_line_item_ids,
          []
        )
      );
    }
    
    await Promise.all(assocCalls);
    
    // Cambiar a "open"
    await hubspotClient.crm.invoices.basicApi.update(invoiceId, {
      properties: { of_invoice_status: 'open' },
    });
    
    // Actualizar ticket
    await hubspotClient.crm.tickets.basicApi.update(ticketId, {
      properties: {
        of_invoice_id: invoiceId,
        of_invoice_key: invoiceKey,
        of_invoice_status: 'open',
      },
    });
    
    console.log(`[invoiceService] Factura ${invoiceId} creada desde ticket ${ticketId}`);
    return { invoiceId, created: true };
  } catch (err) {
    console.error('[invoiceService] Error creando factura desde ticket:', err?.response?.body || err?.message || err);
    throw err;
  }
}
