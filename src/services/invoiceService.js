// src/services/invoiceService.js
import { hubspotClient } from '../hubspotClient.js';
import { generateInvoiceKey } from '../utils/idempotency.js';
import { parseNumber, safeString } from '../utils/parsers.js';
import { isDryRun, DEFAULT_CURRENCY } from '../config/constants.js';
import { associateV4 } from '../associations.js';
import axios from 'axios';

const HUBSPOT_API_BASE = 'https://api.hubapi.com';
const accessToken = process.env.HUBSPOT_PRIVATE_TOKEN;

// Crear factura usando API REST directa
async function createInvoiceDirect(properties) {
  const response = await axios.post(
    `${HUBSPOT_API_BASE}/crm/v3/objects/invoices`,
    { properties },
    {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    }
  );
  return response.data;
}

// Actualizar factura usando API REST directa
async function updateInvoiceDirect(invoiceId, properties) {
  const response = await axios.patch(
    `${HUBSPOT_API_BASE}/crm/v3/objects/invoices/${invoiceId}`,
    { properties },
    {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    }
  );
  return response.data;
}

/**
 * Obtiene la fecha actual en formato YYYY-MM-DD para HubSpot.
 * HubSpot espera fechas en formato ISO (YYYY-MM-DD) para propiedades de tipo Date.
 */
function getTodayISO() {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, '0');
  const day = String(today.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Actualiza la etapa de una factura y completa automáticamente las fechas correspondientes.
 * 
 * @param {string} invoiceId - ID de la factura en HubSpot
 * @param {string} newStage - Nueva etapa: 'pendiente', 'generada', 'emitida', 'paga', 'cancelada'
 * @returns {Promise<Object>} Factura actualizada
 */
export async function updateInvoiceStage(invoiceId, newStage) {
  const today = getTodayISO();
  const updates = {
    etapa_de_la_factura: newStage,
  };
  
  // Completar fechas según la etapa
  switch (newStage) {
    case 'emitida':
      updates.fecha_de_emision = today;
      updates.fecha_de_envio = today;
      console.log(`[invoiceService] Factura ${invoiceId} → EMITIDA (${today})`);
      break;
    
    case 'paga':
      updates.fecha_de_pago = today;
      console.log(`[invoiceService] Factura ${invoiceId} → PAGA (${today})`);
      break;
    
    case 'cancelada':
      updates.fecha_de_cancelacion = today;
      console.log(`[invoiceService] Factura ${invoiceId} → CANCELADA (${today})`);
      break;
    
    case 'generada':
      console.log(`[invoiceService] Factura ${invoiceId} → GENERADA`);
      break;
    
    case 'pendiente':
      console.log(`[invoiceService] Factura ${invoiceId} → PENDIENTE`);
      break;
    
    default:
      console.warn(`[invoiceService] Etapa desconocida: ${newStage}`);
  }
  
  try {
    await updateInvoiceDirect(invoiceId, updates);
    console.log(`[invoiceService] ✅ Factura ${invoiceId} actualizada:`, updates);
    return updates;
  } catch (err) {
    console.error(`[invoiceService] Error actualizando factura ${invoiceId}:`, err?.response?.data || err?.message);
    throw err;
  }
}

/**
 * Obtiene una factura por ID.
 * 
 * @param {string} invoiceId - ID de la factura
 * @returns {Promise<Object>} Factura de HubSpot
 */
export async function getInvoice(invoiceId) {
  try {
    const invoice = await hubspotClient.crm.objects.basicApi.getById(
      'invoices',
      invoiceId,
      ['etapa_de_la_factura', 'of_invoice_key', 'of_line_item_id', 'of_deal_id', 
       'fecha_de_emision', 'fecha_de_envio', 'fecha_de_pago', 'fecha_de_cancelacion',
       'id_factura_nodum', 'hs_invoice_date', 'hs_currency']
    );
    return invoice;
  } catch (err) {
    console.error(`[invoiceService] Error obteniendo factura ${invoiceId}:`, err?.message);
    throw err;
  }
}

/**
 * Crea una factura automática desde un Line Item.
 * 
 * ESTRATEGIA:
 * - hs_invoice_billable = false: Desactiva validaciones de HubSpot (permite line items recurrentes)
 * - hs_invoice_status = 'draft': Estado técnico de HubSpot (siempre draft)
 * - etapa_de_la_factura: Propiedad custom para gestión del flujo real
 *   Estados: 'pendiente', 'generada', 'emitida', 'paga', 'cancelada'
 * - Fechas automáticas según etapa (vía updateInvoiceStage):
 *   - fecha_de_emision: cuando pasa a 'emitida'
 *   - fecha_de_envio: cuando pasa a 'emitida'
 *   - fecha_de_pago: cuando pasa a 'paga'
 *   - fecha_de_cancelacion: cuando pasa a 'cancelada'
 * 
 * @param {Object} deal - Deal de HubSpot
 * @param {Object} lineItem - Line Item de HubSpot (puede ser recurrente)
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
  
  // 3) DRY RUN check
  if (isDryRun()) {
    console.log(`[invoiceService] DRY_RUN: no se crea factura para line item ${lineItemId}`);
    return { invoiceId: null, created: false };
  }
  
  // 4) Calcular monto total
  const quantity = parseNumber(lp.quantity);
  const price = parseNumber(lp.price);
  const total = quantity * price;
  
  // 5) Preparar propiedades de la factura
  const invoiceProps = {
    // Propiedades estándar HubSpot
    hs_currency: dp.deal_currency_code || DEFAULT_CURRENCY,
    hs_invoice_date: billingDate,
    hs_due_date: billingDate,
    hs_invoice_billable: false, // 🔑 CLAVE: Desactiva validaciones, PDFs, emails
    // hs_invoice_status queda en 'draft' por defecto (no cambiar)
    
    // Propiedades custom para tracking y trazabilidad
    of_invoice_key: invoiceKey,
    of_line_item_id: lineItemId,
    of_deal_id: dealId,
    
    // 🔑 Propiedad custom para gestión del flujo
    etapa_de_la_factura: 'pendiente', // pendiente → generada → emitida → paga / cancelada
    
    // Fechas del ciclo de vida (se completan con updateInvoiceStage)
    // fecha_de_emision: se completa cuando etapa → 'emitida'
    // fecha_de_envio: se completa cuando etapa → 'emitida'
    // fecha_de_pago: se completa cuando etapa → 'paga'
    // fecha_de_cancelacion: se completa cuando etapa → 'cancelada'
  };
  
  // Asignar al usuario administrativo si está configurado
  if (process.env.INVOICE_OWNER_ID) {
    invoiceProps.hubspot_owner_id = process.env.INVOICE_OWNER_ID;
  }
  
  try {
    // 6) Crear la factura usando API directa
    const createResp = await createInvoiceDirect(invoiceProps);
    const invoiceId = createResp.id;
    
    console.log(`[invoiceService] Factura creada: ${invoiceId} (billable=false, etapa=pendiente)`);
    
    // 7) Asociar factura a Deal, Line Item y Contact usando associateV4
    console.log(`[invoiceService] Creando asociaciones para factura ${invoiceId}...`);
    
    const assocCalls = [];
    
    // Asociación Invoice → Deal (typeId: 175)
    assocCalls.push(
      associateV4('invoices', invoiceId, 'deals', dealId)
        .then(() => {
          console.log(`[invoiceService] ✅ Asociación invoice→deal creada`);
        }).catch(e => {
          console.error(`[invoiceService] ❌ Error asociación invoice→deal:`, e.message);
          throw e;
        })
    );
    
    // Asociación Invoice → Line Item (typeId: 409)
    // Ahora funciona sin validaciones porque hs_invoice_billable=false
    assocCalls.push(
      associateV4('invoices', invoiceId, 'line_items', lineItemId)
        .then(() => {
          console.log(`[invoiceService] ✅ Asociación invoice→line_item creada`);
        }).catch(e => {
          console.error(`[invoiceService] ❌ Error asociación invoice→line_item:`, e.message);
          throw e;
        })
    );
    
    // Intentar asociar contacto principal del deal (typeId: 177)
    try {
      const contacts = await hubspotClient.crm.associations.v4.basicApi.getPage(
        'deals',
        dealId,
        'contacts',
        10
      );
      const contactId = contacts.results?.[0]?.toObjectId || null;
      if (contactId) {
        assocCalls.push(
          associateV4('invoices', invoiceId, 'contacts', contactId)
            .then(() => {
              console.log(`[invoiceService] ✅ Asociación invoice→contact creada`);
            }).catch(e => {
              console.warn('[invoiceService] ⚠️ No se pudo asociar contacto (no crítico)');
            })
        );
      }
    } catch (e) {
      console.warn('[invoiceService] No se pudo obtener contacto del deal');
    }
    
    // Esperar TODAS las asociaciones
    await Promise.all(assocCalls);
    console.log(`[invoiceService] ✅ Todas las asociaciones creadas`);
    
    // 8) NO cambiamos hs_invoice_status - queda en 'draft'
    //    El flujo se gestiona con etapa_de_la_factura
    console.log(`[invoiceService] ℹ️ Factura en etapa 'pendiente' - gestión manual del flujo`);
    
    // 9) Actualizar line item con referencia a la factura
    // NOTA: Line items NO tienen 'etapa_de_la_factura', solo la referencia
    try {
      await hubspotClient.crm.lineItems.basicApi.update(lineItemId, {
        properties: {
          of_invoice_id: invoiceId,
          of_invoice_key: invoiceKey,
        },
      });
      console.log(`[invoiceService] ✅ Line item actualizado con referencia a factura`);
    } catch (e) {
      console.warn('[invoiceService] No se pudo actualizar line item con invoice_id');
    }
    
    console.log(`[invoiceService] ✅ Factura ${invoiceId} creada para line item ${lineItemId}`);
    return { invoiceId, created: true };
  } catch (err) {
    console.error('[invoiceService] Error creando factura automática:', err?.response?.data || err?.message || err);
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
    hs_invoice_billable: false, // Desactiva validaciones
    of_invoice_key: invoiceKey,
    of_deal_id: props.of_deal_id,
    of_line_item_id: props.of_line_item_ids,
    etapa_de_la_factura: 'pendiente',
  };
  
  // Asignar al usuario administrativo si está configurado
  if (process.env.INVOICE_OWNER_ID) {
    invoiceProps.hubspot_owner_id = process.env.INVOICE_OWNER_ID;
  }
  
  try {
    // Crear factura usando API directa
    const createResp = await createInvoiceDirect(invoiceProps);
    const invoiceId = createResp.id;
    
    // Asociar a ticket y deal usando associateV4
    const assocCalls = [];
    if (ticketId) {
      assocCalls.push(associateV4('invoices', invoiceId, 'tickets', ticketId));
    }
    if (props.of_deal_id) {
      assocCalls.push(associateV4('invoices', invoiceId, 'deals', props.of_deal_id));
    }
    if (props.of_line_item_ids) {
      assocCalls.push(associateV4('invoices', invoiceId, 'line_items', props.of_line_item_ids));
    }
    
    await Promise.all(assocCalls);
    
    // Actualizar ticket
    await hubspotClient.crm.tickets.basicApi.update(ticketId, {
      properties: {
        of_invoice_id: invoiceId,
        of_invoice_key: invoiceKey,
      },
    });
    
    console.log(`[invoiceService] Factura ${invoiceId} creada desde ticket ${ticketId}`);
    return { invoiceId, created: true };
  } catch (err) {
    console.error('[invoiceService] Error creando factura desde ticket:', err?.response?.data || err?.message || err);
    throw err;
  }
}