// src/services/invoiceService.js
import { hubspotClient } from '../hubspotClient.js';
import { generateInvoiceKey } from '../utils/idempotency.js';
import { parseNumber, safeString } from '../utils/parsers.js';
import { getTodayYMD, toHubSpotDate } from '../utils/dateUtils.js';
import { isDryRun, DEFAULT_CURRENCY } from '../config/constants.js';
import { associateV4 } from '../associations.js';
import { consumeCupoAfterInvoice } from './cupo/consumeCupo.js';
import axios from 'axios';

const HUBSPOT_API_BASE = 'https://api.hubapi.com';
const accessToken = process.env.HUBSPOT_PRIVATE_TOKEN;


// ========= DEBUG HELPERS =========
function statusOf(obj, key) {
  const has = Object.prototype.hasOwnProperty.call(obj || {}, key);
  const val = obj?.[key];
  const empty = val === null || val === "" || typeof val === "undefined";
  const status = !has ? "MISSING" : empty ? "EMPTY" : "OK";
  return { val, status };
}

function showProp(obj, key, label = key) {
  const { val, status } = statusOf(obj, key);
  console.log(`   ${label}: ${val} (${status})`);
}

// Propiedades permitidas en el objeto Invoice de HubSpot
const ALLOWED_INVOICE_PROPS = [
  "cantidad","descripcion","descuento","descuento_por_unidad","etapa_de_la_factura",
  "exonera_irae","fecha_de_caneclacion","fecha_de_emision","fecha_de_envio","fecha_de_pago",
  "frecuencia_de_facturacion","hs_comments","hs_currency","hs_due_date","hs_invoice_date",
  "hs_tax_id","hs_title","hubspot_owner_id","id_factura_nodum","iva",
  "modo_de_generacion_de_factura","monto_a_facturar","motivo_de_pausa","nombre_empresa",
  "nombre_producto","of_invoice_key","pais_operativo","pedido_por","procede_de",
  "responsable_asignado","reventa","servicio","ticket_id","unidad_de_negocio",
  "usuario_disparador_de_factura","vendedor_factura"
];

// Filtra un objeto dejando solo las propiedades permitidas (no null/undefined)
function pickAllowedProps(inputProps) {
  const result = {};
  for (const key of ALLOWED_INVOICE_PROPS) {
    if (inputProps[key] !== undefined && inputProps[key] !== null) {
      result[key] = inputProps[key];
    }
  }
  return result;
}

// Convierte un valor a owner ID numérico o null
function toNumericOwnerOrNull(v) {
  const s = String(v).trim();
  return /^\d+$/.test(s) ? s : null;
}

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
  
  console.log('\n========== CREANDO FACTURA DESDE TICKET ==========');
  console.log('Ticket ID:', ticketId);
  
  // ========== DEBUG: Re-leer ticket con todas las propiedades relevantes ==========
  let ticketFull = ticket;
  try {
    ticketFull = await hubspotClient.crm.tickets.basicApi.getById(ticketId, [
      // Idempotencia y referencias
      'of_ticket_key',
      'of_deal_id',
      'of_line_item_ids',
      'of_invoice_id',
      'of_invoice_key',
      
      // Fechas
      'of_fecha_de_facturacion',
      'fecha_real_de_facturacion',
      'hs_resolution_due_date',
      
      // Montos y cantidades
      'monto_real_a_facturar',
      'of_monto_total',
      'of_cantidad',
      'of_monto_unitario',
      'total_de_horas_consumidas',
      
      // Producto
      'subject',
      'of_producto_nombres',
      'of_descripcion_producto',
      'of_rubro',
      
      // Tax & Discount
      'of_descuento',
      'of_descuento_monto',
      'iva',
      'of_exonera_irae',
      
      // Cupo - Alerta preventiva
      'of_aplica_para_cupo',
      'of_cupo_alerta_preventiva_emitida',
      'of_cupo_alerta_preventiva_fecha',
      'of_cupo_restante_proyectado',
      'of_cupo_consumo_estimado',
      
      // Cupo - Consumo real
      'of_cupo_consumido',
      'of_cupo_consumido_fecha',
      'of_cupo_consumo_valor',
      
      // Contexto
      'of_moneda',
      'of_pais_operativo',
      'of_frecuencia_de_facturacion',
      'of_propietario_secundario',
      'hubspot_owner_id',
      
      // Flags
      'facturar_ahora',
      'repetitivo',
    ]);
    console.log('✓ Ticket re-leído con propiedades completas');
  } catch (err) {
    console.warn('⚠️ No se pudo re-leer ticket completo, usando datos originales:', err?.message);
  }
  
  const tp = ticketFull.properties || {};
  console.log('\n==================== [DEBUG][CUPO] TICKET (ALL props) ====================');
try {
  console.log(JSON.stringify(tp, null, 2));
} catch {
  console.log(tp);
}

console.log('\n-------------------- [DEBUG][CUPO] Keys específicas --------------------');
console.log('[DEBUG][CUPO] of_aplica_para_cupo:', tp.of_aplica_para_cupo);
console.log('[DEBUG][CUPO] tipo_de_cupo (no va en ticket normalmente):', tp.tipo_de_cupo);

console.log('[DEBUG][CUPO] monto_real_a_facturar:', tp.monto_real_a_facturar);
console.log('[DEBUG][CUPO] total_de_horas_consumidas:', tp.total_de_horas_consumidas);
console.log('[DEBUG][CUPO] of_cantidad:', tp.of_cantidad);

console.log('[DEBUG][CUPO] of_deal_id:', tp.of_deal_id);
console.log('[DEBUG][CUPO] of_line_item_ids:', tp.of_line_item_ids);

console.log('[DEBUG][CUPO] of_cupo_consumido:', tp.of_cupo_consumido);
console.log('==========================================================================\n');

console.log('\n-------------------- [DEBUG][CUPO] Props que contienen "cupo" --------------------');
Object.entries(tp)
  .filter(([k]) => k.toLowerCase().includes('cupo'))
  .forEach(([k, v]) => console.log(`[DEBUG][CUPO] ${k}:`, v));
console.log('------------------------------------------------------------------------------\n');

  
  console.log('\n╔════════════════════════════════════════════════════════╗');
  console.log('║         DEBUG: PROPIEDADES DEL TICKET                 ║');
  console.log('╚════════════════════════════════════════════════════════╝');
  
  console.log('\n🔑 IDEMPOTENCIA Y REFERENCIAS');
  showProp(tp, 'of_ticket_key');
  showProp(tp, 'of_deal_id');
  showProp(tp, 'of_line_item_ids');
  showProp(tp, 'of_invoice_id');
  showProp(tp, 'of_invoice_key');
  
  console.log('\n📅 FECHAS');
  showProp(tp, 'of_fecha_de_facturacion');
  showProp(tp, 'fecha_real_de_facturacion');
  showProp(tp, 'hs_resolution_due_date');
  
  console.log('\n💰 MONTOS Y CANTIDADES');
  showProp(tp, 'monto_real_a_facturar');
  showProp(tp, 'of_monto_total');
  showProp(tp, 'of_cantidad');
  showProp(tp, 'of_monto_unitario');
  
  console.log('\n🧾 TAX & DISCOUNT');
  showProp(tp, 'of_descuento');
  showProp(tp, 'of_descuento_monto');
  showProp(tp, 'iva');
  showProp(tp, 'of_exonera_irae');
  
  console.log('\n💳 CUPO - ALERTA PREVENTIVA');
  showProp(tp, 'of_aplica_para_cupo');
  showProp(tp, 'of_cupo_alerta_preventiva_emitida');
  showProp(tp, 'of_cupo_alerta_preventiva_fecha');
  showProp(tp, 'of_cupo_restante_proyectado');
  showProp(tp, 'of_cupo_consumo_estimado');
  
  console.log('\n💳 CUPO - CONSUMO REAL');
  showProp(tp, 'of_cupo_consumido');
  showProp(tp, 'of_cupo_consumido_fecha');
  showProp(tp, 'of_cupo_consumo_valor');
  showProp(tp, 'of_cupo_consumo_invoice_id');
  
  console.log('\n🎯 CONTEXTO');
  showProp(tp, 'of_producto_nombres');
  showProp(tp, 'of_rubro');
  showProp(tp, 'of_moneda');
  showProp(tp, 'of_pais_operativo');
  showProp(tp, 'of_frecuencia_de_facturacion');
  showProp(tp, 'of_propietario_secundario');
  showProp(tp, 'hubspot_owner_id');
  
  console.log('\n🚩 FLAGS');
  showProp(tp, 'facturar_ahora');
  showProp(tp, 'repetitivo');
  
  console.log('\n═══════════════════════════════════════════════════════════\n');
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
  const responsableAsignadoRaw = process.env.USER_BILLING || '83169424';
  const responsableAsignado = toNumericOwnerOrNull(responsableAsignadoRaw);
  
  // 5) Fecha real de facturación (momento de crear la factura)
  const fechaRealFacturacion = getTodayYMD();
  
  // 6) Preparar propiedades de la factura (mapeo Ticket → Factura)
  const invoicePropsRaw = {
    // Título: usar el subject del ticket
    hs_title: tp.subject || `Factura - Ticket ${ticketId}`,
    
    // 💰 Moneda (del ticket)
    hs_currency: tp.of_moneda || DEFAULT_CURRENCY,
    
    // 📅 Fecha de facturación (fecha real, no planificada)
    hs_invoice_date: toHubSpotDate(fechaRealFacturacion),
    hs_due_date: toHubSpotDate(fechaRealFacturacion),
    
    // 🔑 Idempotencia y tracking
    of_invoice_key: invoiceKey,
    ticket_id: String(ticketId),
    
    // 🎯 Identidad del producto (del ticket)
    nombre_producto: tp.of_producto_nombres,
descripcion: tp.of_descripcion_producto,
    servicio: tp.of_rubro,
    
    // 💵 Montos (del ticket - VALORES AJUSTADOS POR EL RESPONSABLE)
    cantidad: parseNumber(tp.of_cantidad, 0),
    monto_a_facturar: parseNumber(tp.monto_real_a_facturar ?? tp.monto_a_facturar, 0), // ⭐ CLAVE: Monto final ajustado
    descuento: parseNumber(tp.of_descuento, 0), // % descuento
    descuento_por_unidad: parseNumber(tp.of_descuento_monto, 0), // monto descuento por unidad
    
    // 🧾 Impuestos y exoneraciones
iva: String(tp.iva).trim() === 'true' ? 'true' : 'false',
    exonera_irae: tp.of_exonera_irae, // desde ticket (si existe)
    
    // 👥 Responsables
    vendedor_factura: tp.of_propietario_secundario,
    
    // 📊 Frecuencia
    frecuencia_de_facturacion: tp.of_frecuencia_de_facturacion,
    
    // 🏢 Contexto
    pais_operativo: tp.of_pais_operativo,
    
    // 🔑 Etapa inicial
    etapa_de_la_factura: 'Pendiente',
  };

  // 🐛 DEBUG: Log mapeo Ticket → Invoice para tax/discount
  console.log('\n[DBG][INVOICE] Tax/Discount TICKET → INVOICE:');
  console.log('[DBG][INVOICE] SOURCE (ticket):', {
    of_descuento: tp.of_descuento,
    of_descuento_monto: tp.of_descuento_monto,
    iva: tp.iva,
    of_exonera_irae: tp.of_exonera_irae,
  });
  console.log('[DBG][INVOICE] TARGET (invoice):', {
    descuento: invoicePropsRaw.descuento,
    descuento_por_unidad: invoicePropsRaw.descuento_por_unidad,
    iva: invoicePropsRaw.iva,
    exonera_irae: invoicePropsRaw.exonera_irae,
  });

  // Agregar responsable_asignado solo si es numérico válido
  if (responsableAsignado) {
    invoicePropsRaw.responsable_asignado = responsableAsignado;
  }
  
  // Asignar al usuario administrativo si está configurado
  const invoiceOwner = toNumericOwnerOrNull(process.env.INVOICE_OWNER_ID);
  if (invoiceOwner) {
    invoicePropsRaw.hubspot_owner_id = invoiceOwner;
  }
  
  // Filtrar solo propiedades permitidas
  const invoiceProps = pickAllowedProps(invoicePropsRaw);
  
  console.log('\n--- PROPIEDADES DE LA FACTURA A CREAR ---');
  console.log(JSON.stringify(invoiceProps, null, 2));
  console.log('-----------------------------------------\n');
  
  try {
    // 7) Crear la factura usando API directa
    console.log('Creando factura en HubSpot...');
    const createResp = await createInvoiceDirect(invoiceProps);
    const invoiceId = createResp.id;

        
    console.log('✓ Factura creada con ID:', invoiceId);
    
    // ========== DEBUG: Re-leer invoice con todas las propiedades relevantes ==========
    let invoiceFull = null;
    try {
      invoiceFull = await hubspotClient.crm.objects.basicApi.getById('invoices', invoiceId, [
        // Idempotencia
        'of_invoice_key',
        'ticket_id',
        
        // Fechas
        'hs_invoice_date',
        'hs_due_date',
        'fecha_de_emision',
        'fecha_de_envio',
        'fecha_de_pago',
        'fecha_de_caneclacion',
        
        // Montos
        'monto_a_facturar',
        'cantidad',
        'descuento',
        'descuento_por_unidad',
        
        // Tax
        'iva',
        'exonera_irae',
        
        // Producto
        'hs_title',
        'nombre_producto',
        'descripcion',
        'servicio',
        
        // Estado
        'etapa_de_la_factura',
        'id_factura_nodum',
        
        // Contexto
        'hs_currency',
        'pais_operativo',
        'frecuencia_de_facturacion',
        'vendedor_factura',
        'responsable_asignado',
        'hubspot_owner_id',
      ]);
      
      const ip = invoiceFull.properties || {};
      
      console.log('\n╔════════════════════════════════════════════════════════╗');
      console.log('║         DEBUG: PROPIEDADES DE LA INVOICE              ║');
      console.log('╚════════════════════════════════════════════════════════╝');
      
      console.log('\n🔑 IDEMPOTENCIA');
      showProp(ip, 'of_invoice_key');
      showProp(ip, 'ticket_id');
      
      console.log('\n📅 FECHAS');
      showProp(ip, 'hs_invoice_date');
      showProp(ip, 'hs_due_date');
      showProp(ip, 'fecha_de_emision');
      showProp(ip, 'fecha_de_envio');
      showProp(ip, 'fecha_de_pago');
      
      console.log('\n💰 MONTOS');
      showProp(ip, 'monto_a_facturar');
      showProp(ip, 'cantidad');
      showProp(ip, 'descuento');
      showProp(ip, 'descuento_por_unidad');
      
      console.log('\n🧾 TAX');
      showProp(ip, 'iva');
      showProp(ip, 'exonera_irae');
      
      console.log('\n📦 PRODUCTO');
      showProp(ip, 'hs_title');
      showProp(ip, 'nombre_producto');
      showProp(ip, 'descripcion');
      showProp(ip, 'servicio');
      
      console.log('\n🎯 ESTADO Y CONTEXTO');
      showProp(ip, 'etapa_de_la_factura');
      showProp(ip, 'id_factura_nodum');
      showProp(ip, 'hs_currency');
      showProp(ip, 'pais_operativo');
      showProp(ip, 'frecuencia_de_facturacion');
      
      console.log('\n👥 RESPONSABLES');
      showProp(ip, 'vendedor_factura');
      showProp(ip, 'responsable_asignado');
      showProp(ip, 'hubspot_owner_id');
      
      console.log('\n═══════════════════════════════════════════════════════════\n');
      
    } catch (err) {
      console.warn('⚠️ No se pudo re-leer invoice completa:', err?.message);
    }
    
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
          fecha_real_de_facturacion: fechaRealFacturacion,
        },
      });
      console.log(`✓ Ticket actualizado con invoice_id=${invoiceId} y fecha real`);
    } catch (e) {
      console.warn('⚠️ No se pudo actualizar ticket:', e.message);
    }
    
    // 10) Actualizar line item con referencia a la factura
if (lineItemId) {
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
    console.warn('⚠️ No se pudo actualizar line item:', e.message);
  }
}
    
    console.log('\n✅ FACTURA CREADA EXITOSAMENTE DESDE TICKET');
    console.log('Invoice ID:', invoiceId);
    console.log('Invoice Key:', invoiceKey);
    console.log('Responsable:', responsableAsignado || 'no asignado');
    console.log('Modo de generación:', modoGeneracion);
    console.log('================================================\n');

// 12) Consumo de cupo (idempotente, no rompe facturación)
try {
  const dealId = String(tp.of_deal_id || '');
  const lineItemIdRaw = String(tp.of_line_item_ids || '');
  const firstLineItemId = lineItemIdRaw.includes(',')
    ? lineItemIdRaw.split(',')[0].trim()
    : lineItemIdRaw.trim();
 
  if (!dealId) {
    console.log('[invoiceService] ⊘ No se consume cupo: falta of_deal_id en ticket');
  } else if (!invoiceId) {
    console.log('[invoiceService] ⚠️ No se consume cupo: invoiceId undefined (bug interno)');
  } else {
    if (lineItemIdRaw.includes(',')) {
      console.log(`[invoiceService] ⚠️ Ticket tiene múltiples lineItems (${lineItemIdRaw}), usando primero: ${firstLineItemId}`);
    }

    console.log(`[invoiceService] 🔹 Consumiendo cupo: dealId=${dealId}, ticketId=${ticketId}, lineItemId=${firstLineItemId}, invoiceId=${invoiceId}`);

    await consumeCupoAfterInvoice({
      dealId,
      ticketId,
      lineItemId: firstLineItemId,
      invoiceId,
    });
  }
} catch (err) {
  console.error('[invoiceService] ❌ Error en consumo de cupo:', err?.message);
  // NO lanzar error: consumo de cupo es complementario, no debe romper facturación
}

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
/**
 * ✅ UPDATED: Acepta billingPeriodDate para invoiceKey y invoiceDate para hs_invoice_date
 * 
 * @param {Object} deal - Deal de HubSpot
 * @param {Object} lineItem - Line Item de HubSpot
 * @param {string} billingPeriodDate - Fecha del período de facturación (YYYY-MM-DD) - para invoiceKey
 * @param {string} invoiceDate - Fecha de emisión de la factura (YYYY-MM-DD) - para hs_invoice_date (default: billingPeriodDate)
 */
export async function createAutoInvoiceFromLineItem(deal, lineItem, billingPeriodDate, invoiceDate = null) {
  const dealId = String(deal.id || deal.properties?.hs_object_id);
  const lineItemId = String(lineItem.id || lineItem.properties?.hs_object_id);
  const lp = lineItem.properties || {};
  const dp = deal.properties || {};
  
  // ✅ invoiceDate defaults to billingPeriodDate if not provided
  const actualInvoiceDate = invoiceDate || billingPeriodDate;
  
  console.log('\n========== CREANDO FACTURA AUTOMÁTICA ==========');
  console.log('Deal ID:', dealId);
  console.log('Deal Name:', dp.dealname);
  console.log('Line Item ID:', lineItemId);
  console.log('Line Item Name:', lp.name);
  console.log('\n🔑 === KEY DATES ===');
  console.log(`   billingPeriodDate: ${billingPeriodDate} (for invoiceKey)`);
  console.log(`   invoiceDate: ${actualInvoiceDate} (for hs_invoice_date)`);
  
  // ✅ CRITICAL: invoiceKey usa billingPeriodDate (NO today)
  const invoiceKey = generateInvoiceKey(dealId, lineItemId, billingPeriodDate);
  console.log(`   invoiceKey: ${invoiceKey}`);
  
  // 2) Verificar si ya tiene factura asociada en el line item
  if (lp.invoice_id) {
    if (safeString(lp.invoice_key) === invoiceKey) {
      console.log(`✓ Line Item ${lineItemId} ya tiene factura ${lp.invoice_id} (invoice_key OK)`);
      return { invoiceId: lp.invoice_id, created: false };
    }

    console.warn(`⚠️ Line Item ${lineItemId} tiene invoice_id=${lp.invoice_id} pero invoice_key mismatch. IGNORANDO (posible clon sucio).`);
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
    hs_invoice_date: toHubSpotDate(actualInvoiceDate),  // ✅ Uses invoiceDate
    hs_due_date: toHubSpotDate(actualInvoiceDate),
    hs_invoice_billable: false,
    
    // 👤 Destinatario externo
    hs_external_recipient: process.env.INVOICE_RECIPIENT_ID || '85894063',
    
    // ✅ CRITICAL: of_invoice_key usa billingPeriodDate
    of_invoice_key: invoiceKey,
    
    // Propiedad custom para gestión del flujo
    etapa_de_la_factura: 'Pendiente',
    
    // 📦 Producto (del line item)
    ...(lp.name ? { nombre_producto: lp.name } : {}),
    ...(lp.description ? { descripcion: lp.description } : {}),
    ...(lp.servicio ? { servicio: lp.servicio } : {}),
    ...(dp.dealname ? { nombre_empresa: dp.dealname } : {}),
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
    
    // 7) Asociar factura a Deal
    console.log(`\n--- CREANDO ASOCIACIONES ---`);
    
    const assocCalls = [];
    
    // Asociación Invoice → Deal
    assocCalls.push(
      associateV4('invoices', invoiceId, 'deals', dealId)
        .then(() => {
          console.log(`✓ Asociación invoice→deal creada`);
        }).catch(e => {
          console.error(`✗ Error asociando invoice→deal:`, e.message);
        })
    );
    
    // ... (rest of associations remain the same)

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
       'fecha_de_emision', 'fecha_de_envio', 'fecha_de_pago', 'fecha_de_caneclacion',
       'id_factura_nodum', 'hs_invoice_date', 'hs_currency']
    );
    return invoice;
  } catch (err) {
    console.error(`[invoiceService] Error obteniendo factura ${invoiceId}:`, err?.message);
    throw err;
  }
}