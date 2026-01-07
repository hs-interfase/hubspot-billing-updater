// src/services/invoiceService.js
import { hubspotClient } from '../hubspotClient.js';
import { generateInvoiceKey } from '../utils/idempotency.js';
import { parseNumber, safeString } from '../utils/parsers.js';
import { getTodayYMD, toHubSpotDate } from '../utils/dateUtils.js';
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
 * Crea una factura desde un ticket de orden de facturación.
 * La factura SIEMPRE toma datos del ticket (no del line item directamente).
 * 
 * @param {Object} ticket - Ticket de HubSpot
 * @param {string} modoGeneracion - Modo de generación: 'AUTO_LINEITEM', 'MANUAL_TICKET', 'MANUAL_LINEITEM'
 * @param {string} usuarioDisparador - ID del usuario que disparó la facturación (opcional, si es manual)
 * @returns {Object} { invoiceId, created }
 */
export async function createInvoiceFromTicket(ticket, modoGeneracion = 'AUTO_LINEITEM', usuarioDisparador = null) {
  const ticketId = ticket.id || ticket.properties?.hs_object_id;
  const tp = ticket.properties || {};
  
  console.log('\n========== CREANDO FACTURA DESDE TICKET ==========');
  console.log('Ticket ID:', ticketId);
  console.log('Ticket Key:', tp.of_ticket_key);
  console.log('Modo de generación:', modoGeneracion);
  
// 1) Calcular invoiceKey estricta (si hay data suficiente)
const dealId = safeString(tp.of_deal_id);

// OJO: si of_line_item_ids puede venir CSV, tomar el primero
const rawLineItemIds = safeString(tp.of_line_item_ids);
const lineItemId = rawLineItemIds?.includes(',')
  ? rawLineItemIds.split(',')[0].trim()
  : rawLineItemIds;

const fechaPlan = safeString(tp.of_fecha_de_facturacion); // YYYY-MM-DD

const invoiceKeyStrict =
  (dealId && lineItemId && fechaPlan)
    ? generateInvoiceKey(dealId, lineItemId, fechaPlan)
    : null;

// fallback SOLO si no hay strict (menos ideal)
const invoiceKey = invoiceKeyStrict || safeString(tp.of_ticket_key) || `ticket::${ticketId}`;
console.log('Invoice Key:', invoiceKey);

// 2) Verificar si ya tiene factura (REGLA estricta)
if (tp.of_invoice_id) {
  const ticketKey = safeString(tp.of_invoice_key); // guardada en ticket (recomendado)
  const expected = invoiceKey;

  if (ticketKey && ticketKey === expected) {
    console.log(`✓ Ticket ${ticketId} ya tiene factura ${tp.of_invoice_id} (invoice_key OK)`);
    return { invoiceId: tp.of_invoice_id, created: false };
  }

  console.warn(
    `⚠️ Ticket ${ticketId} tiene of_invoice_id=${tp.of_invoice_id} pero invoice_key no valida. IGNORANDO para evitar clon sucio.`
  );
}
  
  // 3) DRY RUN check
  if (isDryRun()) {
    console.log(`DRY_RUN: no se crea factura desde ticket ${ticketId}`);
    console.log('================================================\n');
    return { invoiceId: null, created: false };
  }
  
  // 4) Determinar responsable asignado
  const responsableAsignado = modoGeneracion === 'AUTO_LINEITEM' 
    ? 'AUTO' 
    : (tp.responsable_asignado || 'Sin asignar');
  
  // 5) Fecha real de facturación (momento de crear la factura)
  const fechaRealFacturacion = getTodayYMD();
  
  // 6) Preparar propiedades de la factura (mapeo Ticket → Factura)
  const invoiceProps = {
    // Título: usar el subject del ticket
    hs_title: tp.subject || `Factura - Ticket ${ticketId}`,
    
    // 💰 Moneda (del ticket)
    hs_currency: tp.of_moneda || DEFAULT_CURRENCY,
    
    // 📅 Fecha de facturación (fecha real, no planificada)
    hs_invoice_date: toHubSpotDate(fechaRealFacturacion),
    hs_due_date: toHubSpotDate(fechaRealFacturacion),
    
    // 🔑 Configuración HubSpot
    hs_invoice_billable: false, // Desactiva validaciones, PDFs, emails
    
    // 👤 Destinatario externo (usuario HubSpot)
    hs_external_recipient: process.env.INVOICE_RECIPIENT_ID || '85894063',
    
    // 🔑 Idempotencia y tracking
    of_invoice_key: invoiceKey,
    of_ticket_id: ticketId,
    
    // 🎯 Identidad del producto (del ticket)
    nombre_producto: tp.of_producto_nombres,
    descripcion: tp.descripcion_producto,
    servicio: tp.of_rubro,
    
    // 💵 Montos (del ticket - VALORES AJUSTADOS POR EL RESPONSABLE)
    monto_unitario: parseNumber(tp.of_monto_unitario, 0),
    cantidad: parseNumber(tp.of_cantidad, 0),
    monto_total: parseNumber(tp.of_monto_total, 0),
    monto_real_a_facturar: parseNumber(tp.monto_real_a_facturar, 0), // ⭐ CLAVE: Monto final ajustado
    descuento: parseNumber(tp.of_descuento, 0),
    iva: tp.iva,
    
    // 👥 Responsables
    responsable_asignado: responsableAsignado,
    vendedor_factura: tp.of_propietario_secundario,
    
    // 📊 Frecuencia
    frecuencia_de_facturacion: tp.of_frecuencia_de_facturacion,
    
    // 🏢 Contexto
    of_pais_operativo: tp.of_pais_operativo,
    
    // 🔑 Etapa inicial
    etapa_de_la_factura: 'Pendiente',
  };
  
  // Asignar al usuario administrativo si está configurado
  if (process.env.INVOICE_OWNER_ID) {
    invoiceProps.hubspot_owner_id = process.env.INVOICE_OWNER_ID;
  }
  
  console.log('\n--- PROPIEDADES DE LA FACTURA A CREAR ---');
  console.log(JSON.stringify(invoiceProps, null, 2));
  console.log('-----------------------------------------\n');
  
  try {
    // 7) Crear la factura usando API directa
    console.log('Creando factura en HubSpot...');
    const createResp = await createInvoiceDirect(invoiceProps);
    const invoiceId = createResp.id;
    
    console.log('✓ Factura creada con ID:', invoiceId);
    
    // 8) Asociar factura a Deal, Ticket y Contact
    console.log('\n--- CREANDO ASOCIACIONES ---');
    const assocCalls = [];
    
    // Asociación Invoice → Deal
    if (tp.of_deal_id) {
      assocCalls.push(
        associateV4('invoices', invoiceId, 'deals', tp.of_deal_id)
          .then(() => console.log(`✓ Asociación invoice→deal creada`))
          .catch(e => console.warn(`⚠️ Error asociación invoice→deal:`, e.message))
      );
    }
    
    // Asociación Invoice → Ticket
    assocCalls.push(
      associateV4('invoices', invoiceId, 'tickets', ticketId)
        .then(() => console.log(`✓ Asociación invoice→ticket creada`))
        .catch(e => console.warn(`⚠️ Error asociación invoice→ticket:`, e.message))
    );
    
    // ⚠️ NO asociamos Invoice → Line Item para evitar que HubSpot borre los line items
    console.log('⚠️ Saltando asociación invoice→line_item (evita borrado automático)');
    
    // Intentar asociar contacto principal del deal
    if (tp.of_deal_id) {
      try {
        const contacts = await hubspotClient.crm.associations.v4.basicApi.getPage(
          'deals',
          tp.of_deal_id,
          'contacts',
          10
        );
        const contactId = contacts.results?.[0]?.toObjectId || null;
        if (contactId) {
          assocCalls.push(
            associateV4('invoices', invoiceId, 'contacts', contactId)
              .then(() => console.log(`✓ Asociación invoice→contact creada`))
              .catch(e => console.warn('⚠️ No se pudo asociar contacto'))
          );
        }
      } catch (e) {
        console.warn('No se pudo obtener contacto del deal');
      }
    }
    
    await Promise.all(assocCalls);
    console.log('✓ Todas las asociaciones creadas');
    
    // 9) Actualizar ticket con fecha real de facturación y referencia a la factura
    console.log('\n--- ACTUALIZANDO TICKET ---');
    try {
      await hubspotClient.crm.tickets.basicApi.update(ticketId, {
        properties: {
          of_invoice_id: invoiceId,
          of_invoice_key: invoiceKey,
          of_fecha_real_de_facturacion: fechaRealFacturacion, // 📅 Fecha REAL (momento de emisión)
        },
      });
      console.log(`✓ Ticket actualizado con invoice_id=${invoiceId} y fecha real`);
    } catch (e) {
      console.warn('⚠️ No se pudo actualizar ticket:', e.message);
    }
    
    // 10) Actualizar line item con referencia a la factura
    if (tp.of_line_item_ids) {
      console.log('\n--- ACTUALIZANDO LINE ITEM ---');
      try {
        await hubspotClient.crm.lineItems.basicApi.update(tp.of_line_item_ids, {
          properties: {
            invoice_id: invoiceId,
            invoice_key: invoiceKey,
          },
        });
        console.log(`✓ Line item actualizado con invoice_id=${invoiceId}`);
      } catch (e) {
        console.warn('⚠️ No se pudo actualizar line item:', e.message);
      }
    }
    
    console.log('\n✅ FACTURA CREADA EXITOSAMENTE DESDE TICKET');
    console.log('Invoice ID:', invoiceId);
    console.log('Invoice Key:', invoiceKey);
    console.log('Responsable:', responsableAsignado);
    console.log('Modo de generación:', modoGeneracion);
    console.log('================================================\n');
    
    return { invoiceId, created: true };
  } catch (err) {
    console.error('\n❌ ERROR CREANDO FACTURA DESDE TICKET:');
    console.error('Mensaje:', err?.message);
    console.error('Status:', err?.response?.status);
    console.error('Response data:', JSON.stringify(err?.response?.data, null, 2));
    console.error('URL:', err?.config?.url);
    console.error('================================================\n');
    throw err;
  }
}

/**
 * Crea una factura automática desde un Line Item (LEGACY - mantener por compatibilidad).
 * 
 * ⚠️ NOTA: Idealmente deberías usar createInvoiceFromTicket en su lugar.
 * Esta función se mantiene solo para compatibilidad con código existente.
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
  
  console.log('\n========== CREANDO FACTURA AUTOMÁTICA (LEGACY) ==========');
  console.log('Deal ID:', dealId);
  console.log('Deal Name:', dp.dealname);
  console.log('Line Item ID:', lineItemId);
  console.log('Line Item Name:', lp.name);
  console.log('Billing Date:', billingDate);
  console.log('Propiedades del Line Item:', JSON.stringify(lp, null, 2));
  
  
   // 2) Generar clave única
   const invoiceKey = generateInvoiceKey(dealId, lineItemId, billingDate);
  console.log('Invoice Key generada:', invoiceKey);
  
  // 2) Verificar si ya tiene factura asociada en el line item
if (lp.invoice_id) {
  if (safeString(lp.invoice_key) === invoiceKey) {
    console.log(`✓ Line Item ${lineItemId} ya tiene factura ${lp.invoice_id} (invoice_key OK)`);
    return { invoiceId: lp.invoice_id, created: false };
  }

  console.warn(`⚠️ Line Item ${lineItemId} tiene invoice_id=${lp.invoice_id} pero invoice_key mismatch. IGNORANDO (posible clon sucio).`);
  // seguir y crear
}

  
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
  hs_title: `${dealName} - ${lineItemName}`,
  hs_currency: dp.deal_currency_code || DEFAULT_CURRENCY,
  hs_invoice_date: toHubSpotDate(billingDate),
  hs_due_date: toHubSpotDate(billingDate),
  hs_invoice_billable: false,
  
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
  
  // ❌ ELIMINADAS: modo_de_generacion_factura y usuario_disparador_factura
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
    
    // 8) Actualizar line item con referencia a la factura
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
      console.warn('⚠️ No se pudo actualizar line item con invoice_id:', e.message);
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
    console.error('Status:', err?.response?.status);
    console.error('Response data:', JSON.stringify(err?.response?.data, null, 2));
    console.error('URL:', err?.config?.url);
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