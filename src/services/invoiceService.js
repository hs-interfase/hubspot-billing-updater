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
 */
function getTodayISO() {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padSta
  const day = String(today.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
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
  
  console.log('\n========== CREANDO FACTURA AUTOMÁTICA ==========');
  console.log('Deal ID:', dealId);
  console.log('Deal Name:', dp.dealname);
  console.log('Line Item ID:', lineItemId);
  console.log('Line Item Name:', lp.name);
  console.log('Billing Date:', billingDate);
  console.log('Propiedades del Line Item:', JSON.stringify(lp, null, 2));
  
  // 1) Verificar si ya tiene factura asociada en el line item
  if (lp.invoice_id) {
    console.log(`✓ Line Item ${lineItemId} ya tiene factura ${lp.invoice_id}`);
    console.log('================================================\n');
    return { invoiceId: lp.invoice_id, created: false };
  }
  
  // 2) Generar clave única
  const invoiceKey = generateInvoiceKey(dealId, lineItemId, billingDate);
  console.log('Invoice Key generada:', invoiceKey);
  
  // 3) DRY RUN check
  if (isDryRun()) {
    console.log(`DRY_RUN: no se crea factura para line item ${lineItemId}`);
    console.log('================================================\n');
    return { invoiceId: null, created: false };
  }
  
  // 4) Calcular monto total
  const quantity = parseNumber(lp.quantity);
  const price = parseNumber(lp.price);
  const total = quantity * price;
  
  console.log('Cantidad:', quantity);
  console.log('Precio unitario:', price);
  console.log('Total calculado:', total);
  console.log('Moneda del deal:', dp.deal_currency_code || DEFAULT_CURRENCY);
  
  // 5) Preparar propiedades de la factura
  const dealName = dp.dealname || 'Deal';
  const lineItemName = lp.name || 'Line Item';
  const invoiceProps = {
    // Propiedades estándar HubSpot
    hs_title: `${dealName} - ${lineItemName}`, // 🔑 TÍTULO: Deal + Line Item
    hs_currency: dp.deal_currency_code || DEFAULT_CURRENCY,
    hs_invoice_date: billingDate,
    hs_due_date: billingDate,
    hs_invoice_billable: false, // 🔑 CLAVE: Desactiva validaciones, PDFs, emails
    
    // 👤 Destinatario externo (usuario HubSpot)
    hs_external_recipient: process.env.INVOICE_RECIPIENT_ID || '85894063',
    
    // Propiedad custom para idempotencia
    of_invoice_key: invoiceKey,
    
    // 🔑 Propiedad custom para gestión del flujo
    etapa_de_la_factura: 'Pendiente',
    
    // 📦 Producto (del line item)
    ...(lp.name ? { nombre_producto: lp.name } : {}),
    
    // 📝 Descripción (del line item)
    ...(lp.description ? { descripcion: lp.description } : {}),
    
    // 💼 Servicio/Rubro (del line item)
    ...(lp.servicio ? { servicio: lp.servicio } : {}),
    
    // 🏢 Empresa beneficiaria (del deal - solo referencia)
    ...(dp.dealname ? { nombre_empresa: dp.dealname } : {}),
    
    // 🎯 Unidad de negocio (del line item)
    ...(lp.unidad_de_negocio ? { unidad_de_negocio: lp.unidad_de_negocio } : {}),
  };
  
  // Asignar al usuario administrativo si está configurado
  if (process.env.INVOICE_OWNER_ID) {
    invoiceProps.hubspot_owner_id = process.env.INVOICE_OWNER_ID;
  }
  
  console.log('\n--- PROPIEDADES DE LA FACTURA A CREAR ---');
  console.log(JSON.stringify(invoiceProps, null, 2));
  console.log('-----------------------------------------\n');
  
  try {
    // 6) Crear la factura usando API directa
    console.log('Creando factura en HubSpot...');
    const createResp = await createInvoiceDirect(invoiceProps);
    const invoiceId = createResp.id;
    
    console.log('✓ Factura creada con ID:', invoiceId);
    console.log('Respuesta de HubSpot:', JSON.stringify(createResp, null, 2));
    
// 7) Asociar factura a Deal y Contact (NO a Line Item para evitar que HubSpot los borre)
console.log(`\n--- CREANDO ASOCIACIONES ---`);

const assocCalls = [];

// Asociación Invoice → Deal (typeId: 175)
assocCalls.push(
  associateV4('invoices', invoiceId, 'deals', dealId)
    .then(() => {
      console.log(`✓ Asociación invoice→deal creada`);
    }).catch(e => {
      console.error(`✗ Error asociación invoice→deal:`, e.message);
      throw e;
    })
);

// ⚠️ NO asociamos Invoice → Line Item para evitar que HubSpot borre los line items
// La referencia se mantiene solo a través de invoice_id en las propiedades del line item
console.log('⚠️ Saltando asociación invoice→line_item (evita borrado automático)');

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
    console.log('Contacto encontrado:', contactId);
    assocCalls.push(
      associateV4('invoices', invoiceId, 'contacts', contactId)
        .then(() => {
          console.log(`✓ Asociación invoice→contact creada`);
        }).catch(e => {
          console.warn('⚠️ No se pudo asociar contacto (no crítico)');
        })
    );
  } else {
    console.log('No hay contacto asociado al deal');
  }
} catch (e) {
  console.warn('No se pudo obtener contacto del deal');
}

// Esperar TODAS las asociaciones
await Promise.all(assocCalls);
console.log('✓ Todas las asociaciones creadas');
    
    // 9) Actualizar line item con referencia a la factura
    console.log('\n--- ACTUALIZANDO LINE ITEM ---');
    try {
      await hubspotClient.crm.lineItems.basicApi.update(lineItemId, {
        properties: {
          invoice_id: invoiceId,
          invoice_key: invoiceKey,
        },
      });
      console.log(`✓ Line item actualizado con invoice_id=${invoiceId}`);
    } catch (e) {
      console.warn('⚠ No se pudo actualizar line item con invoice_id:', e.message);
    }
    
    console.log('\n✅ FACTURA CREADA EXITOSAMENTE');
    console.log('Invoice ID:', invoiceId);
    console.log('Invoice Key:', invoiceKey);
    console.log('Etapa:', 'Pendiente');
    console.log('================================================\n');
    
    return { invoiceId, created: true };
  } catch (err) {
    console.error('\n❌ ERROR CREANDO FACTURA:');
    console.error('Mensaje:', err?.message);
    console.error('Response data:', JSON.stringify(err?.response?.data, null, 2));
    console.error('Stack:', err?.stack);
    console.error('================================================\n');
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
      ['etapa_de_la_factura', 'of_invoice_key',
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
    // Título: Deal + Line Item (o nombre del ticket si no hay)
    hs_title: props.subject || `Ticket ${ticketId}`,
    hs_currency: props.of_moneda || DEFAULT_CURRENCY,
    hs_invoice_date: props.of_fecha_de_facturacion || getTodayISO(), // Fecha de facturación
    hs_due_date: props.of_fecha_de_facturacion || getTodayISO(),
    hs_invoice_billable: false, // Desactiva validaciones
    of_invoice_key: invoiceKey,
    etapa_de_la_factura: 'Pendiente',
  };  // Asignar al usuario administrativo si está configurado
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