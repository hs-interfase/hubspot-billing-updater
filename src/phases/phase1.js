// src/phases/phase1.js
import { hubspotClient, getDealWithLineItems } from '../hubspotClient.js';
import { mirrorDealToUruguay } from '../dealMirroring.js';
import {
  updateLineItemSchedule,
  computeNextBillingDateFromLineItems,
  computeLastBillingDateFromLineItems,
  computeBillingCountersForLineItem,
} from '../billingEngine.js';
import { updateDealCupo } from '../cupo.js';
import { normalizeBillingStartDelay } from '../normalizeBillingStartDelay.js';
import { logDateEnvOnce } from "../utils/dateDebugs.js";
import { getTodayYMD } from "../utils/dateUtils.js";
import { parseBool, parseNumber, safeString } from "../utils/parsers.js";

logDateEnvOnce();

/**
 * Inicializa cupo en Deal si cupo_activo=true y tipo_de_cupo tiene valor.
 * Establece cupo_consumido, cupo_restante, cupo_ultima_actualizacion si están vacíos.
 * Solo actualiza HubSpot si al menos una propiedad cambió.
 */
async function initCupoIfNeeded(dealId, dp) {
  const cupoActivo = parseBool(dp.cupo_activo);
  const tipoCupo = safeString(dp.tipo_de_cupo);

  if (!cupoActivo || !tipoCupo) {
    return; // No aplica cupo
  }

  // Calcular total según tipo
  let total = 0;
  if (tipoCupo === "Por Horas") {
    total = parseNumber(dp.cupo_total, 0);
  } else if (tipoCupo === "Por Monto") {
    total = parseNumber(dp.cupo_total_monto ?? dp.cupo_total, 0);
  }

  
  // Warning si cupo está activo pero total es 0 o negativo
  if (total <= 0) {
    console.warn(`[cupo:init] ⚠️ dealId=${dealId} tiene cupo_activo=true y tipo_de_cupo="${tipoCupo}" pero total calculado es ${total}`);
    return;
  }

  // Verificar qué propiedades necesitan inicialización
    const currentConsumido = dp.cupo_consumido;
  const currentRestante = dp.cupo_restante;
  const currentUltimaActualizacion = dp.cupo_ultima_actualizacion;

    const needsConsumido = currentConsumido == null || currentConsumido === "";
  const needsRestante = currentRestante == null || currentRestante === "";
  const needsUltimaActualizacion = currentUltimaActualizacion == null || currentUltimaActualizacion === "";

  const needsUpdate = needsConsumido || needsRestante || needsUltimaActualizacion;

  if (!needsUpdate) {
    return; // Todas las propiedades ya tienen valores
  }

  // Preparar valores nuevos
  const updateProps = {};
  if (needsConsumido) updateProps.cupo_consumido = "0";
  if (needsRestante) updateProps.cupo_restante = String(total);
  if (needsUltimaActualizacion) updateProps.cupo_ultima_actualizacion = getTodayYMD();

  // Actualizar HubSpot
  try {
    await hubspotClient.crm.deals.basicApi.update(String(dealId), { properties: updateProps });
    console.log(`[cupo:init] updated=true dealId=${dealId} values=${JSON.stringify(updateProps)}`);
  } catch (err) {
    console.error(`[cupo:init] Error actualizando deal ${dealId}:`, err?.message);
  }
}

function classifyLineItemFlow(li) {
  const p = li?.properties || {};

  // Irregular tiene prioridad
const irregular = (p.irregular ?? '').toString().toLowerCase();
  if (irregular === 'true' || irregular === '1' || irregular === 'si' || irregular === 'sí') {
    return 'Irregular';
  }

  // Recurrente si tiene frecuencia
  const freq = (p.recurringbillingfrequency ?? p.hs_recurring_billing_frequency ?? '')
    .toString()
    .toLowerCase()
    .trim();
  if (freq) return 'Recurrente';

  // Pago único si tiene 1 pago
  const num = (p.hs_recurring_billing_number_of_payments ?? '').toString().trim();
  if (num === '1') return 'Pago Único';

  return null;
}

// Tipo del negocio = tipo del PRÓXIMO evento (no mezcla).
// Usa las line items que tienen como "start" la próxima fecha.
// Si vos tenés otra property "proxima_fecha_line_item", la cambiamos acá.
function pickDealFlowTypeForNextEvent(lineItems, nextDateStr) {
  if (!nextDateStr) return null;

  const matches = (lineItems || []).filter((li) => {
    const p = li?.properties || {};
    const liDate = (p.hs_recurring_billing_start_date ?? '').toString().slice(0, 10);
    return liDate === nextDateStr;
  });

  if (matches.length === 0) return null;

  const types = matches.map(classifyLineItemFlow).filter(Boolean);
  if (types.includes('Irregular')) return 'Irregular';
  if (types.includes('Recurrente')) return 'Recurrente';
  if (types.includes('Pago Único')) return 'Pago Único';
  return null;
}


function parseBoolFromHubspot(raw) {
  const v = (raw ?? '').toString().toLowerCase();
  return v === 'true' || v === '1' || v === 'sí' || v === 'si' || v === 'yes';
}

function fmtYMD(date) {
  if (!date) return null;
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Mensaje simple (evita crash). Si querés un mensaje más rico, lo refinamos luego,
 * pero este garantiza que fase 1 no se caiga.
 */
function buildNextBillingMessage({ deal, nextDate, lineItems }) {
  const dealName = deal?.properties?.dealname || '';
  const count = Array.isArray(lineItems) ? lineItems.length : 0;
  return `Próxima facturación ${fmtYMD(nextDate)} · ${dealName} · ${count} line items`;
}

/**
 * Deriva frecuencia del deal:
 * - si hay al menos un monthly => monthly
 * - si hay al menos un yearly => yearly
 * - si hay mezcla => mixed
 * - si no hay recurring => one_time
 */
function deriveDealBillingFrequency(lineItems) {
  const freqs = new Set();

  for (const li of lineItems || []) {
    const p = li?.properties || {};
    const f =
      (p.hs_recurring_billing_frequency ?? p.recurringbillingfrequency ?? '')
        .toString()
        .toLowerCase()
        .trim();

    // HubSpot suele usar monthly, annually, yearly, etc.
    if (f) freqs.add(f);
    else {
      // si tiene number_of_payments=1 y no tiene frecuencia, lo tratamos como one-time
      const n = (p.hs_recurring_billing_number_of_payments ?? '').toString();
      if (n === '1') freqs.add('one_time');
    }
  }

  if (freqs.size === 0) return null;
  if (freqs.size === 1) return [...freqs][0];

  // si hay mezcla
  return 'mixed';
}

async function processLineItemsForPhase1(lineItems, today, { alsoInitCupo = true } = {}) {
  if (!Array.isArray(lineItems) || lineItems.length === 0) return;

  // 1) calendario
  for (const li of lineItems) {
    try {
      await updateLineItemSchedule(li);
    } catch (err) {
      console.error('[phase1] Error en updateLineItemSchedule para line item', li.id, err);
    }
  }

  // 2) contadores + persistencia
  for (const li of lineItems) {
    try {
      const counters = computeBillingCountersForLineItem(li, today);
      const updateProps = {
        facturacion_total_avisos: String(counters.facturacion_total_avisos ?? 0),
        avisos_emitidos_facturacion: String(counters.avisos_emitidos_facturacion ?? 0),
        avisos_restantes_facturacion: String(counters.avisos_restantes_facturacion ?? 0),
      };

      li.properties = { ...(li.properties || {}), ...updateProps };
      await hubspotClient.crm.lineItems.basicApi.update(String(li.id), { properties: updateProps });
    } catch (err) {
      console.error('[phase1] Error guardando contadores en line item', li.id, err);
    }
  }
}

export async function runPhase1(dealId) {

  if (!dealId) throw new Error('runPhase1 requiere un dealId');

  // Obtener negocio y line items
  const { deal, lineItems } = await getDealWithLineItems(dealId);
  const dealProps = deal.properties || {};




// ========= DEBUG HELPERS =========
const DBG_PHASE1 = process.env.DBG_PHASE1 === "true";

function statusOf(obj, key) {
  const has = Object.prototype.hasOwnProperty.call(obj || {}, key);
  const val = obj?.[key];
  const empty = val === null || val === "" || typeof val === "undefined";
  const status = !has ? "MISSING" : empty ? "EMPTY" : "OK";
  return { val, status };
}

function showProp(obj, key, label = key) {
  const { val, status } = statusOf(obj, key);
  console.log(`   ${label}:`, val, `(${status})`);
}

// ========== DEBUG LOGS - DEAL + LINE ITEMS (PHASE 1) ==========
if (DBG_PHASE1) {
  const dp = deal?.properties || {};

  console.log("\n╔════════════════════════════════════════════════════════╗");
  console.log("║              PHASE 1 - DEAL CARGADO                   ║");
  console.log("╚════════════════════════════════════════════════════════╝");

  // 🔎 Ver si realmente vinieron las props
  console.log("\n🔎 DEAL PROP KEYS:", Object.keys(dp).sort());

  console.log("\n📊 INFORMACIÓN GENERAL");
  showProp({ dealId }, "dealId", "Deal ID");
  showProp(dp, "dealname", "Deal Name");
  showProp(dp, "dealstage", "Deal Stage");
  showProp(dp, "deal_currency_code", "Moneda");
  showProp(dp, "pais_operativo", "País");
  showProp(dp, "unidad_de_negocio", "Unidad de Negocio");

  console.log("\n💰 CUPO");
  showProp(dp, "tipo_de_cupo");
  showProp(dp, "cupo_activo");
  showProp(dp, "cupo_total");
  showProp(dp, "cupo_total_monto");
  showProp(dp, "cupo_consumido");
  showProp(dp, "cupo_restante");
  showProp(dp, "cupo_umbral");
  showProp(dp, "cupo_ultima_actualizacion");

  console.log("\n📅 FACTURACIÓN");
  showProp(dp, "facturacion_activa");
  showProp(dp, "facturacion_proxima_fecha");
  showProp(dp, "facturacion_ultima_fecha");
  showProp(dp, "facturacion_frecuencia_de_facturacion");
  showProp(dp, "facturacion_mensaje_proximo_aviso");

  console.log("\n🔗 MIRRORS");
  showProp(dp, "deal_py_origen_id");
  showProp(dp, "deal_uy_mirror_id");
  showProp(dp, "es_mirror_de_py");

  console.log("\n╔════════════════════════════════════════════════════════╗");
  console.log(`║           LINE ITEMS CARGADOS (${lineItems.length})                   ║`);
  console.log("╚════════════════════════════════════════════════════════╝");

  for (const li of lineItems) {
    const lp = li?.properties || {};

    console.log("\n────────────────────────────────────────────────────────");
    console.log("📦 LINE ITEM ID:", li?.id);

    // 🔎 Ver si realmente vinieron las props
    console.log("🔎 LI PROP KEYS:", Object.keys(lp).sort());

    console.log("   Nombre:", lp.name);

    console.log("\n   💵 PRICING");
    showProp(lp, "price");
    showProp(lp, "quantity");
    showProp(lp, "amount");
    showProp(lp, "discount", "discount (monto/unidad)");
    showProp(lp, "hs_discount_percentage", "hs_discount_percentage (%)");

    console.log("\n   🧾 TAX");
    showProp(lp, "hs_tax_rate_group_id");
    showProp(lp, "hs_post_tax_amount");

    console.log("\n   🔄 RECURRING");
    showProp(lp, "recurringbillingfrequency");
    showProp(lp, "hs_recurring_billing_start_date");
    // compat: a veces viene en una u otra
    const nop = lp.number_of_payments ?? lp.hs_recurring_billing_number_of_payments;
    console.log("   number_of_payments:", nop, `(OK)`);

    console.log("\n   ⏰ BILLING DELAY");
    showProp(lp, "hs_billing_start_delay_type");
    showProp(lp, "hs_billing_start_delay_days");
    showProp(lp, "hs_billing_start_delay_months");

    console.log("\n   📅 FACTURACIÓN");
    showProp(lp, "facturacion_activa");
    showProp(lp, "facturacion_automatica");
    showProp(lp, "facturar_ahora");
    showProp(lp, "irregular");
    showProp(lp, "pausa");
    showProp(lp, "motivo_de_pausa");

    console.log("\n   💰 CUPO");
    showProp(lp, "parte_del_cupo");

    console.log("\n   🔗 REFERENCIAS");
    showProp(lp, "invoice_id");
    showProp(lp, "invoice_key");
    showProp(lp, "pais_operativo");
    showProp(lp, "uy");
  }

  console.log("\n═══════════════════════════════════════════════════════════\n");
}




// -- Convertir retrasos en fecha de inicio concreta --
  // Esto modifica los line items en HubSpot y los actualiza en memoria.
  try {
    await normalizeBillingStartDelay(lineItems, deal);
  } catch (err) {
    console.error('[phase1] Error normalizando retrasos de facturación', err);
  }
  
    
  // ========== DEBUG POST-NORMALIZE (FECHAS FINALES) ==========
  if (DBG_PHASE1) {
    console.log("\n╔════════════════════════════════════════════════════════╗");
    console.log("║       POST-NORMALIZE - FECHAS FINALES LINE ITEMS      ║");
    console.log("╚════════════════════════════════════════════════════════╝");
  
    for (const li of lineItems) {
      const lp = li?.properties || {};
      console.log(`\n📦 Line Item ${li.id} - ${lp.name}`);
      console.log(`   hs_recurring_billing_start_date: ${lp.hs_recurring_billing_start_date}`);
      console.log(`   hs_billing_start_delay_type: ${lp.hs_billing_start_delay_type || '(vacío)'}`);
      console.log(`   hs_billing_start_delay_days: ${lp.hs_billing_start_delay_days || '(vacío)'}`);
      console.log(`   hs_billing_start_delay_months: ${lp.hs_billing_start_delay_months || '(vacío)'}`);
    }
  
    console.log("\n═══════════════════════════════════════════════════════════\n");
  }

  // 1) Mirroring (si corresponde)
  let mirrorResult = null;
  try {
    mirrorResult = await mirrorDealToUruguay(dealId);
  } catch (err) {
    console.error('[phase1] Error en mirrorDealToUruguay:', err?.response?.body || err);
  }

  // Si no hay line items en el negocio original, terminamos
  if (!lineItems || !lineItems.length) {
    return {
      dealId,
      dealName: dealProps.dealname,
      skipped: true,
      reason: 'sin line items',
    };
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);

    // 1.5) Inicializar cupo si es necesario (antes de procesar line items)
  try {
    await initCupoIfNeeded(dealId, dealProps);
  } catch (err) {
    console.error('[phase1] Error en initCupoIfNeeded:', err);
  }

  // 2) Procesar negocio original: calendario + contadores + cupo por línea
  await processLineItemsForPhase1(lineItems, today, { alsoInitCupo: true });

// 2.1) Procesar espejo UY (si existe): calendario + contadores + cupo por línea
if (mirrorResult?.mirrored && mirrorResult?.targetDealId) {
  try {
    const { deal: mirrorDeal, lineItems: mirrorLineItems } =
      await getDealWithLineItems(mirrorResult.targetDealId);
      
    console.log(`[phase1] Procesando ESPEJO deal=${mirrorResult.targetDealId} lineItems=${mirrorLineItems.map(x=>x.id).join(",")}`);
   
     // Inicializar cupo del espejo también
  try {
    await initCupoIfNeeded(mirrorResult.targetDealId, mirrorDeal.properties);
  } catch (err) {
    console.error('[phase1] Error initCupoIfNeeded en espejo UY', mirrorResult.targetDealId, err);
  }

    await processLineItemsForPhase1(mirrorLineItems, today, { alsoInitCupo: true });

    // actualizar cupo a nivel deal espejo usando sus props (no pisar inputs)
    try {
      await updateDealCupo(mirrorResult.targetDealId, mirrorLineItems, mirrorDeal);
    } catch (err) {
      console.error('[phase1] Error updateDealCupo en espejo UY', mirrorResult.targetDealId, err);
    }
  } catch (err) {
    console.error('[phase1] No se pudo obtener o procesar el deal espejo', mirrorResult.targetDealId, err);
  }
}

  // 3) Calcular próxima y última fecha de facturación (negocio original)
  const nextBillingDate = computeNextBillingDateFromLineItems(lineItems, today);
  const lastBillingDate = computeLastBillingDateFromLineItems(lineItems, today);

  let effectiveNext = nextBillingDate;
  let effectiveLast = lastBillingDate;
  if (nextBillingDate && nextBillingDate.getTime() < today.getTime()) {
    effectiveLast = nextBillingDate;
    effectiveNext = null;
  }

  // 4) Calcular strings de fechas ANTES de usarlas
  const nextDateStr = fmtYMD(effectiveNext);
  const lastDateStr = fmtYMD(effectiveLast);

  // 4b) Tipo del negocio = tipo del PRÓXIMO evento (no mezcla)
  const dealBillingFrequency = pickDealFlowTypeForNextEvent(lineItems, nextDateStr);

   // 5) Actualizar cupo a nivel negocio pasando también el negocio completo
   try {
     await updateDealCupo(dealId, lineItems, deal);
   } catch (err) {
     console.error('[phase1] Error updateDealCupo deal', dealId, err);
   }

  // 6) Construir mensaje
  const message = effectiveNext
    ? buildNextBillingMessage({ deal, nextDate: effectiveNext, lineItems })
    : '';


  // 7) Actualizar SIEMPRE propiedades del deal (aunque facturacion_activa=false)
  const updateBody = {
    properties: {
      facturacion_proxima_fecha: nextDateStr || null,
      facturacion_ultima_fecha: lastDateStr || null,
      facturacion_mensaje_proximo_aviso: message || '',
      // ⚠️ SOLO PARA REPORTING: esta propiedad NO se usa en lógica de facturación
      // La fuente de verdad SIEMPRE es el Line Item
      facturacion_frecuencia_de_facturacion: dealBillingFrequency || null,
    },
  };

  await hubspotClient.crm.deals.basicApi.update(String(dealId), updateBody);

  // 8) “Skip” solo como semántica (ya actualizamos TODO lo que es fase 1)
  const active = parseBoolFromHubspot(dealProps.facturacion_activa);
  if (!active) {
    return {
      dealId,
      dealName: dealProps.dealname,
      skipped: true,
      reason: 'facturacion_activa es false; se recalcularon calendarios, contadores, cupo y propiedades del deal',
      nextBillingDate: nextDateStr,
      lastBillingDate: lastDateStr,
    };
  }

  // Si no hay fechas ni futuras ni pasadas
  if (!nextBillingDate && !lastBillingDate) {
    return {
      dealId,
      dealName: dealProps.dealname,
      skipped: true,
      reason: 'sin fechas útiles (contrato completado o mal configurado)',
    };
  }

  return {
    dealId,
    dealName: dealProps.dealname,
    nextBillingDate: nextDateStr || null,
    lastBillingDate: lastDateStr || null,
    lineItemsCount: lineItems.length,
    facturacion_frecuencia_de_facturacion: dealBillingFrequency,
  };
}
