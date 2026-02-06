
// src/services/invoiceService.js
import { hubspotClient } from '../hubspotClient.js';
import { buildInvoiceKey } from '../utils/invoiceKey.js';
import { parseNumber, safeString, parseBool } from '../utils/parsers.js';
import { getTodayYMD, toYMDInBillingTZ, toHubSpotDateOnly } from '../utils/dateUtils.js';
import { isDryRun, DEFAULT_CURRENCY } from '../config/constants.js';
import { associateV4 } from '../associations.js';
import { consumeCupoAfterInvoice } from './cupo/consumeCupo.js';
import { buildValidatedUpdateProps } from '../utils/propertyHelpers.js';
import axios from 'axios';

const HUBSPOT_API_BASE = 'https://api.hubapi.com';
const accessToken = process.env.HUBSPOT_PRIVATE_TOKEN;

// Extrae la fecha YYYY-MM-DD del ticketKey (último segmento si matchea formato)
function extractBillDateFromTicketKey(ticketKey) {
  if (!ticketKey) return null;
  const parts = String(ticketKey).split('::');
  const last = parts[parts.length - 1];
  return /^\d{4}-\d{2}-\d{2}$/.test(last) ? last : null;
}  


// Sincroniza billing_last_billed_date en el line item a partir del ticket (fecha esperada)
async function syncBillingLastBilledDateFromTicket(ticketObj) {
  try {
    const tp = ticketObj?.properties || {};
    const ticketId = String(ticketObj?.id || ticketObj?.properties?.hs_object_id || '');

    // SOLO fecha esperada (plan). NO usar of_fecha_de_facturacion.
   const expectedYMD =
  toYMDInBillingTZ(tp.fecha_resolucion_esperada) ||
  extractBillDateFromTicketKey(tp.of_ticket_key);

if (!expectedYMD) return;

    // asumimos 1 solo line item id numérico en of_line_item_ids
    const lineItemId = String(tp.of_line_item_ids || '').split(',')[0].trim();
    if (!lineItemId) return;

    const billingLastBilledMs = String(toHubSpotDateOnly(expectedYMD));

    await hubspotClient.crm.lineItems.basicApi.update(String(lineItemId), {
      properties: { billing_last_billed_date: billingLastBilledMs },
    });

  if (process.env.DBG_PHASE1 === 'true') {
    console.log('[syncBillingLastBilledDateFromTicket] set billing_last_billed_date', {
      ticketId,
      lineItemId,
      expectedYMD,
      billing_last_billed_date_ms: billingLastBilledMs,
    });
  }
} catch (e) {
    console.warn('[syncBillingLastBilledDateFromTicket] error:', e?.message || e);
  }
}

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
  "cantidad","createdate","descripcion","descuento","descuento_por_unidad","etapa_de_la_factura",
  "exonera_irae","fecha_de_caneclacion","fecha_de_emision","fecha_de_envio","fecha_de_facturacion",
  "fecha_de_pago","frecuencia_de_facturacion","hs_amount_billed","hs_comments","hs_currency","hs_due_date",
  "hs_invoice_billable","hs_invoice_date","hs_tax_id","hs_title","hubspot_owner_id",
  "id_factura_nodum","impacto_facturado","impacto_forecast","impacto_historico","iva",
  "mensual","modo_de_generacion_de_factura","monto_a_facturar","motivo_de_pausa","nombre_empresa",
  "nombre_producto","of_invoice_key","of_monto_total_facturado","pais_operativo","pedido_por",
  "periodo_a_facturar","procede_de","responsable_asignado","reventa","servicio","ticket_id",
  "unidad_de_negocio","usuario_disparador_de_factura","vendedor_factura"
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

// ═══════════════════════════════════════════════════════════════════════════════
// ⚠️ REGLA NO NEGOCIABLE - FREEZE RULE ⚠️
// ═══════════════════════════════════════════════════════════════════════════════
// - Backend NO calcula montos: NO qty*price, NO descuentos, NO IVA.
// - Solo copia RAW + usa propiedades CALCULADAS por HubSpot en el Ticket (total_real_a_facturar, etc.).
// - IVA/descuento se copian solo como flags informativos.
// ═══════════════════════════════════════════════════════════════════════════════

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
      'fecha_resolucion_esperada',
      
      // Montos y cantidades
      'total_real_a_facturar',         // ← Monto total calculado por HubSpot
      'cantidad_real',               
      'monto_unitario_real',         

      // Producto
      'subject',
      'of_producto_nombres',
      'of_descripcion_producto',
      'of_rubro',
      
      // Tax & Discount
      'descuento_en_porcentaje',    
      'descuento_por_unidad_real', 
      'of_iva',
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
      'of_cupo_consumo_invoice_id',
      
      // Contexto
      'of_moneda',
      'of_pais_operativo',
      'of_frecuencia_de_facturacion',
      'of_propietario_secundario',
      'hubspot_owner_id',
      'of_cliente',
      'unidad_de_negocio',
      
      // Otros campos
      'descripcion',
      'comments',
      'createdate',
      'motivo_pausa',
      'id_factura_nodum',
      'etapa_factura',
      
      // Flags
      'facturar_ahora',
      'repetitivo',
    ]);
    console.log('✓ Ticket re-leído con propiedades completas');
  } catch (err) {
    console.warn('⚠️ No se pudo re-leer ticket completo, usando datos originales:', err?.message);
  }
  
  const tp = ticketFull.properties || {};

  function extractBillDateFromTicketKey(ticketKey) {
    const parts = String(ticketKey || '').split('::');
    const last = parts[parts.length - 1];
    return /^\d{4}-\d{2}-\d{2}$/.test(last) ? last : null;
  }

  if (process.env.DBG_TICKET_KEY === 'true') {
    console.log('[DBG_TICKET_KEY][invoiceService] ticket', {
      ticketId,
      of_ticket_key: tp.of_ticket_key,
      fecha_resolucion_esperada: tp.fecha_resolucion_esperada,
      date_from_key: extractBillDateFromTicketKey(tp.of_ticket_key),
      of_line_item_ids: tp.of_line_item_ids,
    });
  }
  
  // ⚡ Guard verbose JSON dump behind env flag (reduce noise)
  if (process.env.DBG_TICKET_FULL === 'true') {
    console.log('\n==================== [DEBUG][CUPO] TICKET (ALL props) ====================');
    try {
      console.log(JSON.stringify(tp, null, 2));
    } catch {
      console.log(tp);
    }
    console.log('==========================================================================\n');
  }

  // ⚡ RESOLVED VARIABLES (early creation for debug logs AND later usage)
  // These prove NO backend calculations - we only extract RAW values from HubSpot
  const cantidadResolved = parseNumber(tp.cantidad_real ?? null, 0);
  const montoUnitarioResolved = parseNumber(tp.monto_unitario_real ?? null, 0);
  const descuentoPctResolved = parseNumber(tp.descuento_en_porcentaje ?? null, 0);
  const descuentoUnitResolved = parseNumber(tp.descuento_por_unidad_real ?? null, 0);
  const totalFinalResolved = parseNumber(tp.total_real_a_facturar ?? null, 0);
  const hasIVAResolved = parseBool(tp.of_iva);

console.log('\n-------------------- [DEBUG][CUPO] Keys específicas --------------------');
console.log('[DEBUG][CUPO] of_aplica_para_cupo:', tp.of_aplica_para_cupo);

console.log('[DEBUG][CUPO] total_real_a_facturar:', tp.total_real_a_facturar);
console.log('[DEBUG][CUPO] cantidad:', tp.cantidad_real);

console.log('[DEBUG][CUPO] of_deal_id:', tp.of_deal_id);
console.log('[DEBUG][CUPO] of_line_item_ids:', tp.of_line_item_ids);

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
  showProp(tp, 'fecha_resolucion_esperada');
  
  console.log('\n💰 MONTOS Y CANTIDADES (valores RESUELTOS desde Ticket, NO backend calculations)');
  console.log(`   cantidad: ${cantidadResolved} (source: cantidad_real`);
  console.log(`   montoUnitario: ${montoUnitarioResolved} (info only, NO multiply) (source: monto_unitario_real`);
  console.log(`   totalFinal: ${totalFinalResolved} (HubSpot-CALCULATED source of truth) (source: total_real_a_facturar`);
  
  console.log('\n🧾 TAX & DISCOUNT (valores RESUELTOS, NO backend calculations)');
  console.log(`   descuentoPct: ${descuentoPctResolved}% (source: descuento_en_porcentaje)`);
  console.log(`   descuentoUnit: ${descuentoUnitResolved} (source: descuento_por_unidad_real ?? of_descuento_monto)`);
  console.log(`   hasIVA: ${hasIVAResolved} (source: of_iva)`);
  
  console.log('\n⚠️  NO backend calculations: baseTotal, totalAfterDiscount, totalWithTax, IVA $ - REMOVED');
  
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

const rawLineItemIds = safeString(tp.of_line_item_ids);
const lineItemId = rawLineItemIds?.includes(',')
  ? rawLineItemIds.split(',')[0].trim()
  : rawLineItemIds;

const fechaPlan =
  extractBillDateFromTicketKey(tp.of_ticket_key) ||
  toYMDInBillingTZ(tp.fecha_resolucion_esperada) ||
  null;
console.log('Line Item ID (para invoiceKey):', lineItemId);
console.log('Fecha plan (para invoiceKey):', fechaPlan);
const invoiceKeyStrict =
  (dealId && lineItemId && fechaPlan)
    ? buildInvoiceKey(dealId, lineItemId, fechaPlan)
    : null;


// fallback SOLO si no hay strict (menos ideal)
const invoiceKey = invoiceKeyStrict || safeString(tp.of_ticket_key) || `ticket::${ticketId}`;
console.log('Invoice Key:', invoiceKey);

// 2) Verificar si ya tiene factura (REGLA estricta)
if (tp.of_invoice_id) {
  const ticketKey = safeString(tp.of_invoice_key); // guardada en ticket (recomendado)
  const expected = invoiceKey;

  if (ticketKey && ticketKey === expected) {
    // ✅ Ultra conservador: solo si lineItemId y fechaPlan existen
    if (lineItemId && fechaPlan) {
      await hubspotClient.crm.lineItems.basicApi.update(lineItemId, {
        properties: {
        ...(fechaPlan ? { billing_last_billed_date: String(toHubSpotDateOnly(fechaPlan)) } : {}),
        },
      });
      if (process.env.DBG_PHASE1 === 'true') {
        console.log(`[billing_last_billed_date] LI ${lineItemId} => ${fechaPlan}`);
      }
    }
    // NUEVO: sincronizar siempre, por robustez
    await syncBillingLastBilledDateFromTicket(ticketFull);
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
  
// 5) Fechas (igual que AUTO): invoice_date = hoy, due_date = hoy + 10 días
const invoiceDateYMD = getTodayYMD(); // 'YYYY-MM-DD' en BILLING_TZ

// sumar 10 días sin romper por timezone
const baseDate = new Date(invoiceDateYMD + 'T12:00:00Z');
baseDate.setUTCDate(baseDate.getUTCDate() + 10);
const dueDateYMD = baseDate.toISOString().slice(0, 10);

const invoiceDateMs = toHubSpotDateOnly(invoiceDateYMD);
const dueDateMs = toHubSpotDateOnly(dueDateYMD);


  // 5.5) Use resolved variables (already created early for debug logs)
  const cantidad = cantidadResolved;
  const montoUnitario = montoUnitarioResolved; // Info only, NO multiply
  const descuentoPct = descuentoPctResolved;
  const descuentoUnit = descuentoUnitResolved;
  const totalFinal = totalFinalResolved; // Source of truth for final amount
  const hasIVA = hasIVAResolved;
  
  // 6) Preparar propiedades de la factura (mapeo Ticket → Factura)
  const invoicePropsRaw = {
  
    // 💰 Moneda (del ticket)
    hs_currency: tp.of_moneda || DEFAULT_CURRENCY,
    
    // ✅ C.4) Fechas: invoice_date y due_date calculados con dateUtils
    hs_invoice_date: invoiceDateMs,
    hs_due_date: dueDateMs,
    
    // ✅ Desactiva validaciones de HubSpot
    hs_invoice_billable: false,
    
    // 🔑 Idempotencia y tracking
    of_invoice_key: invoiceKey,
    ticket_id: String(ticketId),
    
    // 🎯 Identidad del producto (del ticket)
    nombre_producto: tp.of_producto_nombres,
    descripcion: tp.of_descripcion_producto || tp.descripcion,
    servicio: tp.of_rubro,
    
// 💵 Montos y cantidades (inputs RAW del Ticket, usados por HubSpot para calcular):
// - cantidad: RAW input desde 'cantidad_real' (cantidad ajustada, NO snapshot)
// - monto_a_facturar: HubSpot-CALCULATED desde 'total_real_a_facturar' (source of truth, NO backend calculation)
// - hs_amount_billed: mismo que monto_a_facturar
    cantidad: cantidad,
    monto_a_facturar: totalFinal,
    hs_amount_billed: totalFinal,

// 💵 Descuentos e impuestos (RAW inputs informativos del Ticket, NO backend calculations):
// - descuento: RAW input desde 'descuento_en_porcentaje' (% descuento configurado)
// - descuento_por_unidad: RAW input desde 'descuento_por_unidad_real' (descuento unitario configurado)
// - iva: boolean flag desde 'of_iva' (indica si aplica IVA, NO calcula IVA)
descuento: descuentoPct,
descuento_por_unidad: descuentoUnit,
iva: hasIVA ? 'true' : 'false',
exonera_irae: tp.of_exonera_irae,

    
    // 👥 Responsables
    responsable_asignado: toNumericOwnerOrNull(tp.hubspot_owner_id || tp.responsable_asignado),
    vendedor_factura: tp.of_propietario_secundario,
    
    // 📊 Frecuencia
    frecuencia_de_facturacion: tp.of_frecuencia_de_facturacion || (tp.repetitivo ? 'Mensual' : undefined),
    
    // 🏢 Contexto del negocio
    nombre_empresa: tp.of_cliente,
    pais_operativo: tp.of_pais_operativo,
    unidad_de_negocio: tp.unidad_de_negocio,
    
    // 📅 Fechas adicionales
    fecha_de_facturacion: tp.of_fecha_de_facturacion,
  
    // 📆 Periodos
    periodo_a_facturar: tp.of_periodo_a_facturar,
    mensual: tp.of_periodo_de_facturacion,
    
    // 📝 Comentarios y metadata
    hs_comments: tp.comments,
    motivo_de_pausa: tp.motivo_pausa,
    
    // 🔢 IDs externos
    id_factura_nodum: tp.id_factura_nodum,
    
    // 🔑 Etapa inicial
    etapa_de_la_factura: tp.etapa_factura || 'Pendiente',
    
    // 🚀 Modo de generación
    modo_de_generacion_de_factura: modoGeneracion,
  };

  // 🐛 DEBUG: RAW values from Ticket (NO backend calculations)
  console.log('\n[DBG][INVOICE] RAW Values TICKET → INVOICE (NO calculations):');
  console.log('[DBG][INVOICE] SOURCE (ticket RAW props):');
  console.log('PRIMARY:');
  console.log('cantidad_real:', tp.cantidad_real);
  console.log('monto_unitario_real:', tp.monto_unitario_real, '(info only, NO multiply)');
  console.log('descuento_en_porcentaje:', tp.descuento_en_porcentaje);
  console.log('descuento_por_unidad_real:', tp.descuento_por_unidad_real);
  console.log('total_real_a_facturar:', tp.total_real_a_facturar, '(HubSpot-CALCULATED)');
  console.log('of_iva:', tp.of_iva);
  console.log('FALLBACKS (legacy):');
  
  console.log('[DBG][INVOICE] RESOLVED (used for payload):', {
    cantidadResolved,
    montoUnitarioResolved, // info only
    descuentoPctResolved,
    descuentoUnitResolved,
    hasIVAResolved,
    totalFinalResolved,
  });
  
  console.log('[DBG][INVOICE] TARGET (invoice props):');
  console.log('  cantidad:', invoicePropsRaw.cantidad);
  console.log('  monto_a_facturar:', invoicePropsRaw.monto_a_facturar);
  console.log('  descuento:', invoicePropsRaw.descuento);
  console.log('  descuento_por_unidad:', invoicePropsRaw.descuento_por_unidad);
  console.log('  iva:', invoicePropsRaw.iva);

  // Agregar usuario disparador si es manual
  if (usuarioDisparador) {
    invoicePropsRaw.usuario_disparador_de_factura = usuarioDisparador;
  }
  
  // Asignar al usuario administrativo si está configurado
  const invoiceOwner = toNumericOwnerOrNull(process.env.INVOICE_OWNER_ID);
  if (invoiceOwner) {
    invoicePropsRaw.hubspot_owner_id = invoiceOwner;
  }
  
  // ✅ D) Validar propiedades contra schema
  const validatedProps = await buildValidatedUpdateProps('invoices', invoicePropsRaw, {
    logPrefix: '[createInvoiceFromTicket]'
  });
  
  if (Object.keys(validatedProps).length === 0) {
    console.error('❌ SKIP_EMPTY_UPDATE: No hay propiedades válidas para crear invoice');
    return { invoiceId: null, created: false };
  }
  
  console.log('\n╔════════════════════════════════════════════════════════════════╗');
  console.log('║         📄 CREACIÓN DE FACTURA - PROPIEDADES COMPLETAS        ║');
  console.log('╚════════════════════════════════════════════════════════════════╝');
  
  console.log('\n🔑 IDEMPOTENCIA Y REFERENCIAS');
  console.log('   of_invoice_key:', validatedProps.of_invoice_key);
  console.log('   ticket_id:', validatedProps.ticket_id);
  
  console.log('\n📋 TÍTULO Y DESCRIPCIÓN');
  console.log('   hs_title:', validatedProps.hs_title);
  console.log('   descripcion:', validatedProps.descripcion);
  console.log('   nombre_producto:', validatedProps.nombre_producto);
  console.log('   servicio:', validatedProps.servicio);
  
  console.log('\n💰 MONTOS Y CANTIDADES');
  console.log('   cantidad:', validatedProps.cantidad);
  console.log('   monto_a_facturar:', validatedProps.monto_a_facturar);
  if (validatedProps.of_monto_total_facturado) {
    console.log('   of_monto_total_facturado:', validatedProps.of_monto_total_facturado);
  }
  console.log('   hs_currency:', validatedProps.hs_currency);
  
  console.log('\n💵 DESCUENTOS E IMPUESTOS');
  console.log('   descuento (%):', validatedProps.descuento);
  console.log('   descuento_por_unidad ($):', validatedProps.descuento_por_unidad);
  console.log('   iva:', validatedProps.iva);
  console.log('   exonera_irae:', validatedProps.exonera_irae);
  
  console.log('\n📅 FECHAS');
  console.log('   hs_invoice_date:', validatedProps.hs_invoice_date);
  console.log('   hs_due_date:', validatedProps.hs_due_date);
  console.log('   fecha_de_facturacion:', validatedProps.fecha_de_facturacion);
  if (validatedProps.createdate) {
    console.log('   createdate:', validatedProps.createdate);
  }
  
  console.log('\n👥 RESPONSABLES');
  console.log('   responsable_asignado:', validatedProps.responsable_asignado);
  console.log('   vendedor_factura:', validatedProps.vendedor_factura);
  console.log('   hubspot_owner_id:', validatedProps.hubspot_owner_id);
  console.log('   usuario_disparador_de_factura:', validatedProps.usuario_disparador_de_factura);
  
  console.log('\n🏢 CONTEXTO DEL NEGOCIO');
  console.log('   nombre_empresa:', validatedProps.nombre_empresa);
  console.log('   pais_operativo:', validatedProps.pais_operativo);
  console.log('   unidad_de_negocio:', validatedProps.unidad_de_negocio);
  console.log('   frecuencia_de_facturacion:', validatedProps.frecuencia_de_facturacion);
  
  console.log('\n📊 IMPACTOS Y PERIODOS');
  console.log('   impacto_historico:', validatedProps.impacto_historico);
  console.log('   impacto_facturado:', validatedProps.impacto_facturado);
  console.log('   impacto_forecast:', validatedProps.impacto_forecast);
  console.log('   periodo_a_facturar:', validatedProps.periodo_a_facturar);
  console.log('   mensual:', validatedProps.mensual);
  
  console.log('\n📝 OTROS DATOS');
  console.log('   etapa_de_la_factura:', validatedProps.etapa_de_la_factura);
  console.log('   modo_de_generacion_de_factura:', validatedProps.modo_de_generacion_de_factura);
  console.log('   hs_invoice_billable:', validatedProps.hs_invoice_billable);
  console.log('   hs_comments:', validatedProps.hs_comments);
  console.log('   motivo_de_pausa:', validatedProps.motivo_de_pausa);
  console.log('   id_factura_nodum:', validatedProps.id_factura_nodum);
  
  console.log('\n📦 PROPIEDADES COMPLETAS (JSON):');
  console.log(JSON.stringify(validatedProps, null, 2));
  console.log('\n════════════════════════════════════════════════════════════════\n');
  
  try {
    // 7) Crear la factura usando API directa
    console.log('Creando factura en HubSpot...');
    const createResp = await createInvoiceDirect(validatedProps);
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
fecha_real_de_facturacion: invoiceDateYMD,
        },
      });
      console.log(`✓ Ticket actualizado con invoice_id=${invoiceId} y fecha real`);
    } catch (e) {
      console.warn('⚠️ No se pudo actualizar ticket:', e.message);
    }
    

    // 10) Actualizar line item con referencia a la factura (bloque sugerido)
    if (lineItemId) {
      try {
        await hubspotClient.crm.lineItems.basicApi.update(lineItemId, {
          properties: {
            ...(fechaPlan ? { billing_last_billed_date: String(toHubSpotDateOnly(fechaPlan)) } : {}),
            ...(invoiceId ? { invoice_id: invoiceId } : {}),
            ...(invoiceKey ? { invoice_key: invoiceKey } : {}),
          }
        });
        if (process.env.DBG_PHASE1 === 'true') {
          console.log(`[billing_last_billed_date] LI ${lineItemId} => ${fechaPlan}`);
        }
        console.log(`✓ Line item actualizado con invoice_id=${invoiceId}`);
      } catch (e) {
        console.warn('⚠️ No se pudo actualizar line item:', e.message);
      }
    }
    
    console.log('\n✅ FACTURA CREADA EXITOSAMENTE DESDE TICKET');
    console.log('Invoice ID:', invoiceId);
    console.log('Invoice Key:', invoiceKey);
    console.log('Responsable:', invoicePropsRaw.responsable_asignado || tp.hubspot_owner_id || 'no asignado');
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

    // NUEVO: sincronizar siempre después de crear y actualizar ticket/line item
    await syncBillingLastBilledDateFromTicket(ticketFull);
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
  const invoiceKey = buildInvoiceKey(dealId, lineItemId, billingPeriodDate);
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
  
  // 4) Construir nombre de Invoice: "<DealName> - <li_short> - <billDateYMD>"
  const dealName = dp.dealname || 'Deal';
  let liShort = lp.name || null;
  
  // Si no hay nombre, generar "Flota 1", "Flota 2", etc.
  if (!liShort) {
    // TODO: Para generar "Flota N" necesitamos el índice del LI en el deal
    // Por ahora usar fallback simple
    liShort = `Line Item ${lineItemId}`;
    console.warn('⚠️ Line item sin nombre, usando fallback:', liShort);
  }
  
  const invoiceTitle = `${dealName} - ${liShort} - ${billingPeriodDate}`;
  
  // ✅ C) Calcular fecha de vencimiento: billDate + 10 días
  const billDate = new Date(billingPeriodDate);
  billDate.setDate(billDate.getDate() + 10);
  const dueDateYMD = billDate.toISOString().split('T')[0];
  
  console.log('📋 Invoice metadata:');
  console.log('   hs_title:', invoiceTitle);
  console.log('   hs_invoice_date:', actualInvoiceDate);
  console.log('   hs_due_date:', dueDateYMD, '(+10 días)');
  
  // 5) Preparar propiedades de la factura
  const invoiceProps = {
    // ✅ C.1) Nombre de Invoice
    hs_title: invoiceTitle,
    hs_currency: dp.deal_currency_code || DEFAULT_CURRENCY,
    hs_invoice_date: toHubSpotDateOnly(actualInvoiceDate),  // ✅ timestamp ms
    hs_due_date: toHubSpotDateOnly(dueDateYMD),              // ✅ C.4) +10 días
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
  
  // ✅ D) Usar buildValidatedUpdateProps para validar propiedades
  const validatedProps = await buildValidatedUpdateProps('invoices', invoiceProps, {
    logPrefix: '[createAutoInvoice]'
  });
  
  if (Object.keys(validatedProps).length === 0) {
    console.error('❌ SKIP_EMPTY_UPDATE: No hay propiedades válidas para crear invoice');
    console.log('================================================\n');
    return { invoiceId: null, created: false };
  }
  
  console.log('\n╔════════════════════════════════════════════════════════════════╗');
  console.log('║   📄 CREACIÓN AUTOMÁTICA DE FACTURA - PROPIEDADES COMPLETAS   ║');
  console.log('╚════════════════════════════════════════════════════════════════╝');
  
  console.log('\n🔑 IDEMPOTENCIA Y REFERENCIAS');
  console.log('   of_invoice_key:', validatedProps.of_invoice_key);
  console.log('   Deal ID:', dealId);
  console.log('   Line Item ID:', lineItemId);
  
  console.log('\n📋 TÍTULO Y DESCRIPCIÓN');
  console.log('   hs_title:', validatedProps.hs_title);
  console.log('   descripcion:', validatedProps.descripcion);
  console.log('   nombre_producto:', validatedProps.nombre_producto);
  console.log('   servicio:', validatedProps.servicio);
  
  console.log('\n💰 MONTOS Y CANTIDADES');
  console.log('   of_monto_total_facturado:', validatedProps.of_monto_total_facturado);
  console.log('   hs_currency:', validatedProps.hs_currency);
  
  console.log('\n📅 FECHAS');
  console.log('   hs_invoice_date:', validatedProps.hs_invoice_date);
  console.log('   hs_due_date:', validatedProps.hs_due_date);
  console.log('   billingPeriodDate:', billingPeriodDate);
  
  console.log('\n👥 RESPONSABLES');
  console.log('   hubspot_owner_id:', validatedProps.hubspot_owner_id);
  console.log('   hs_external_recipient:', validatedProps.hs_external_recipient);
  
  console.log('\n🏢 CONTEXTO DEL NEGOCIO');
  console.log('   nombre_empresa:', validatedProps.nombre_empresa);
  console.log('   unidad_de_negocio:', validatedProps.unidad_de_negocio);
  
  console.log('\n📝 OTROS DATOS');
  console.log('   etapa_de_la_factura:', validatedProps.etapa_de_la_factura);
  console.log('   hs_invoice_billable:', validatedProps.hs_invoice_billable);
  
  console.log('\n📦 PROPIEDADES COMPLETAS (JSON):');
  console.log(JSON.stringify(validatedProps, null, 2));
  console.log('\n════════════════════════════════════════════════════════════════\n');
  
  try {
    // 6) Crear la factura usando API directa
    console.log('Creando factura en HubSpot...');
    const createResp = await createInvoiceDirect(validatedProps);
    const invoiceId = createResp.id;
    
    console.log('✓ Factura creada con ID:', invoiceId);
    
    // 7) Asociar factura a Deal
    console.log(`\n--- CREANDO ASOCIACIONES ---`);
    
    const assocCalls = [];
    
    // Asociación Invoice → Deal
    assocCalls.push(
      associateV4('invoices', invoiceId, 'deals', dealId)
        .then(() => console.log(`✓ Asociación invoice→deal creada`))
        .catch(e => console.error(`✗ Error asociando invoice→deal:`, e.message))
    );
    
    // Intentar asociar contacto principal del deal
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
            .then(() => console.log(`✓ Asociación invoice→contact creada`))
            .catch(e => console.warn('⚠️ No se pudo asociar contacto'))
        );
      }
    } catch (e) {
      console.warn('⚠️ No se pudo obtener contacto del deal');
    }
    
    await Promise.all(assocCalls);
        console.log('--- ASOCIACIONES COMPLETADAS ---\n');
        
        // 8) Actualizar line item con invoice_id e invoice_key
        await hubspotClient.crm.lineItems.basicApi.update(lineItemId, {
          properties: {
            invoice_id: invoiceId,
            invoice_key: invoiceKey,
          },
        });
        
        console.log(`✓ Line Item ${lineItemId} actualizado con invoice_id: ${invoiceId}`);
        console.log('================================================\n');
        
        return { invoiceId, created: true };
        
      } catch (error) {
        console.error('\n❌ Error creando factura:', error.response?.body || error.message);
        console.error(error.stack);
        throw error;
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
       'fecha_de_emision', 'fecha_de_envio', 'fecha_de_pago', 'fecha_de_caneclacion',
       'id_factura_nodum', 'hs_invoice_date', 'hs_currency']
    );
    return invoice;
  } catch (err) {
    console.error(`[invoiceService] Error obteniendo factura ${invoiceId}:`, err?.message);
    throw err;
  }
}