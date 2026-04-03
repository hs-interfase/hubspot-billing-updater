// src/phases/phase1.js
<<<<<<< HEAD
import { hubspotClient, getDealWithLineItems } from "../hubspotClient.js";
import { mirrorDealToUruguay } from "../dealMirroring.js";
=======
import { hubspotClient, getDealWithLineItems } from '../hubspotClient.js';
import { syncBillingState } from '../services/billing/syncBillingState.js';
import { DEAL_STAGE_LOST } from '../config/constants.js';
import { mirrorDealToUruguay } from '../dealMirroring.js';
>>>>>>> pruebas
import {
  updateLineItemSchedule,
  computeNextBillingDateFromLineItems,
  computeLastBillingDateFromLineItems,
<<<<<<< HEAD
  computeBillingCountersForLineItem,
} from "../billingEngine.js";
import { updateDealCupo } from "../utils/propertyHelpers.js";
import { normalizeBillingStartDelay } from "../normalizeBillingStartDelay.js";
=======
} from '../billingEngine.js';
import { updateDealCupo } from '../utils/propertyHelpers.js';
import { normalizeBillingStartDelay } from '../normalizeBillingStartDelay.js';
>>>>>>> pruebas
import { logDateEnvOnce } from "../utils/dateDebugs.js";
import { parseBool, parseNumber, safeString } from "../utils/parsers.js";
import { computeCupoEstadoFrom } from "../utils/calculateCupoEstado.js";
import { ensureLineItemKey } from '../utils/lineItemKey.js';
import { sanitizeClonedLineItem } from '../services/lineItems/cloneSanitizerService.js';
import { ensureForecastMetaOnLineItem } from '../services/forecast/forecastMetaService.js';
import logger from '../../lib/logger.js';
import { recalcFromTickets } from '../services/lineItems/recalcFromTickets.js';
import { reportHubSpotError } from '../utils/hubspotErrorCollector.js';

const CANCELLED_STAGE_ID = process.env.CANCELLED_STAGE_ID || "";

logDateEnvOnce();

/**
 * Helper anti-spam: reporta a HubSpot solo errores 4xx accionables (≠ 429).
 * 429 y 5xx son transitorios → solo logger.error, sin reporte.
 */
function reportIfActionable({ objectType, objectId, message, err }) {
  const status = err?.response?.status ?? err?.statusCode ?? null;
  if (status === null) {
    reportHubSpotError({ objectType, objectId, message });
    return;
  }
  if (status === 429 || status >= 500) return;
  if (status >= 400 && status < 500) {
    reportHubSpotError({ objectType, objectId, message });
  }
}

/**
 * Activa o desactiva cupo según reglas simplificadas.
 */
async function activateCupoIfNeeded(dealId, dealProps, lineItems) {
  const facturacionActiva = parseBool(dealProps.facturacion_activa);
  const tipoRaw = safeString(dealProps.tipo_de_cupo).trim();
  const tipo = tipoRaw.toLowerCase();

  const shouldActivate = facturacionActiva && tipoRaw !== "";

  const cupoConsumido = dealProps.cupo_consumido;
  const cupoRestante = dealProps.cupo_restante;

  const isConsumidoNull =
    cupoConsumido === null || cupoConsumido === undefined || cupoConsumido === "";
  const isRestanteNull =
    cupoRestante === null || cupoRestante === undefined || cupoRestante === "";

  let cupoTotal = 0;
  if (tipo === "por horas" || tipo === "por_horas") {
    cupoTotal = parseNumber(dealProps.cupo_total, 0);
  } else if (tipo === "por monto" || tipo === "por_monto") {
    cupoTotal = parseNumber(dealProps.cupo_total_monto ?? dealProps.cupo_total, 0);
  }

  const updateProps = {};

  const currentCupoActivo = parseBool(dealProps.cupo_activo);
  if (currentCupoActivo !== shouldActivate) {
    updateProps.cupo_activo = String(shouldActivate);
  }

  if (shouldActivate && isConsumidoNull) {
    updateProps.cupo_consumido = "0";
  }
  if (shouldActivate && isRestanteNull) {
    updateProps.cupo_restante = String(cupoTotal);
  }

<<<<<<< HEAD
  /*  // ✅ A) Actualizar cupo_estado según reglas
  const { calculateCupoEstado } = await import('../utils/propertyHelpers.js');
  const newCupoEstado = calculateCupoEstado({
    cupo_activo: updateProps.cupo_activo ?? dealProps.cupo_activo,
    cupo_restante: updateProps.cupo_restante ?? dealProps.cupo_restante,
    cupo_umbral: dealProps.cupo_umbral,
=======
  const newCupoEstado = computeCupoEstadoFrom(dealProps, {
    cupo_activo: updateProps.cupo_activo,
    cupo_consumido: updateProps.cupo_consumido,
    cupo_restante: updateProps.cupo_restante,
    tipo_de_cupo: updateProps.tipo_de_cupo,
    cupo_total: updateProps.cupo_total,
    cupo_total_monto: updateProps.cupo_total_monto,
>>>>>>> pruebas
  });

  const currentCupoEstado = dealProps.cupo_estado;

  if (newCupoEstado !== 'Inconsistente' && newCupoEstado && newCupoEstado !== currentCupoEstado) {
    updateProps.cupo_estado = newCupoEstado;
<<<<<<< HEAD
    console.log([cupo:activate] cupo_estado: ${currentCupoEstado || '(null)'} → ${newCupoEstado});
  }
*/

  const newCupoEstado = computeCupoEstadoFrom(dealProps, {
    cupo_activo: updateProps.cupo_activo,
    cupo_consumido: updateProps.cupo_consumido,
    cupo_restante: updateProps.cupo_restante,
    // si en Phase 1 también se puede modificar tipo/total, incluilo acá
    tipo_de_cupo: updateProps.tipo_de_cupo,
    cupo_total: updateProps.cupo_total,
    cupo_total_monto: updateProps.cupo_total_monto,
  });

  const currentCupoEstado = dealProps.cupo_estado;

  if (newCupoEstado === "Inconsistente") {
    // tu diag puede quedarse, pero calculalo desde merged también para que no mienta
  } else if (newCupoEstado && newCupoEstado !== currentCupoEstado) {
    updateProps.cupo_estado = newCupoEstado;
    console.log(
      `[cupo:activate] cupo_estado: ${currentCupoEstado || "(null)"} → ${newCupoEstado}`
    );
  }
=======
    logger.info({ module: 'phase1', fn: 'activateCupoIfNeeded', dealId, from: currentCupoEstado || '(null)', to: newCupoEstado }, `[cupo:activate] cupo_estado: ${currentCupoEstado || '(null)'} → ${newCupoEstado}`);
  }
>>>>>>> pruebas

  if (Object.keys(updateProps).length === 0) {
    logger.info({ module: 'phase1', fn: 'activateCupoIfNeeded', dealId, cupo_activo: shouldActivate }, '[cupo:activate] sin cambios');
    return;
  }

<<<<<<< HEAD
  console.log(
    `[cupo:activate] Updating deal ${dealId} with:`,
    Object.keys(updateProps).join(", ")
  );
  await hubspotClient.crm.deals.basicApi.update(String(dealId), {
    properties: updateProps,
  });
  console.log(`[cupo:activate] ✅ Deal ${dealId} actualizado:`, updateProps);
=======
  logger.info({ module: 'phase1', fn: 'activateCupoIfNeeded', dealId, keys: Object.keys(updateProps) }, `[cupo:activate] Updating deal ${dealId}`);

  try {
    await hubspotClient.crm.deals.basicApi.update(String(dealId), { properties: updateProps });
  } catch (err) {
    logger.error({ module: 'phase1', fn: 'activateCupoIfNeeded', dealId, err }, 'deal_update_failed: activateCupoIfNeeded');
    // deals fuera del criterio ticket/line_item → no reportIfActionable
    return;
  }

  logger.info({ module: 'phase1', fn: 'activateCupoIfNeeded', dealId, updateProps }, '[cupo:activate] ✅ Deal actualizado');

  // Hook: Centraliza estado billing si se cancela el deal
  if (updateProps.dealstage && (
    updateProps.dealstage === DEAL_STAGE_LOST ||
    updateProps.dealstage === CANCELLED_STAGE_ID
  )) {
    try {
      await syncBillingState({ hubspotClient, dealId, dealIsCanceled: true });
    } catch (err) {
      logger.warn({ module: 'phase1', fn: 'activateCupoIfNeeded', dealId, err }, '[activateCupoIfNeeded] syncBillingState failed');
    }
  }
>>>>>>> pruebas
}

function classifyLineItemFlow(li) {
  const p = li?.properties || {};

<<<<<<< HEAD
  // Irregular tiene prioridad
  const irregular = (p.irregular ?? "").toString().toLowerCase();
  if (irregular === "true" || irregular === "1" || irregular === "si" || irregular === "sí") {
    return "Irregular";
  }

  // Recurrente si tiene frecuencia
  const freq = (p.recurringbillingfrequency ?? p.hs_recurring_billing_frequency ?? "")
=======
  const irregular = (p.irregular ?? '').toString().toLowerCase();
  if (irregular === 'true' || irregular === '1' || irregular === 'si' || irregular === 'sí') {
    return 'Irregular';
  }

  const freq = (p.recurringbillingfrequency ?? p.hs_recurring_billing_frequency ?? '')
>>>>>>> pruebas
    .toString()
    .toLowerCase()
    .trim();
  if (freq) return "Recurrente";

<<<<<<< HEAD
  // Pago único si tiene 1 pago
  const num = (p.hs_recurring_billing_number_of_payments ?? "").toString().trim();
  if (num === "1") return "Pago Único";
=======
  const num = (p.hs_recurring_billing_number_of_payments ?? '').toString().trim();
  if (num === '1') return 'Pago Único';
>>>>>>> pruebas

  return null;
}

function pickDealFlowTypeForNextEvent(lineItems, nextDateStr) {
  if (!nextDateStr) return null;

  const matches = (lineItems || []).filter((li) => {
    const p = li?.properties || {};
    const liDate = (p.hs_recurring_billing_start_date ?? "").toString().slice(0, 10);
    return liDate === nextDateStr;
  });

  if (matches.length === 0) return null;

  const types = matches.map(classifyLineItemFlow).filter(Boolean);
  if (types.includes("Irregular")) return "Irregular";
  if (types.includes("Recurrente")) return "Recurrente";
  if (types.includes("Pago Único")) return "Pago Único";
  return null;
}

function parseBoolFromHubspot(raw) {
  const v = (raw ?? "").toString().toLowerCase();
  return v === "true" || v === "1" || v === "sí" || v === "si" || v === "yes";
}

function fmtYMD(date) {
  if (!date) return null;
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function buildNextBillingMessage({ deal, nextDate, lineItems }) {
  const dealName = deal?.properties?.dealname || "";
  const count = Array.isArray(lineItems) ? lineItems.length : 0;
  return `Próxima facturación ${fmtYMD(nextDate)} · ${dealName} · ${count} line items`;
}

<<<<<<< HEAD
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
    const f = (p.hs_recurring_billing_frequency ?? p.recurringbillingfrequency ?? "")
      .toString()
      .toLowerCase()
      .trim();

    // HubSpot suele usar monthly, annually, yearly, etc.
    if (f) freqs.add(f);
    else {
      // si tiene number_of_payments=1 y no tiene frecuencia, lo tratamos como one-time
      const n = (p.hs_recurring_billing_number_of_payments ?? "").toString();
      if (n === "1") freqs.add("one_time");
    }
  }

  if (freqs.size === 0) return null;
  if (freqs.size === 1) return [...freqs][0];

  // si hay mezcla
  return "mixed";
}

async function processLineItemsForPhase1(lineItems, today, { alsoInitCupo = true } = {}) {
  if (!Array.isArray(lineItems) || lineItems.length === 0) return;

  // 1) calendario
  for (const li of lineItems) {
    try {
      await updateLineItemSchedule(li);
    } catch (err) {
      console.error("[phase1] Error en updateLineItemSchedule para line item", li.id, err);
    }
=======
async function processLineItemsForPhase1(dealId, lineItems, today, { alsoInitCupo = true, dealProps = {} } = {}) {
  if (!Array.isArray(lineItems) || lineItems.length === 0) return;

  const debug = process.env.DBG_PHASE1 === 'true';

  function parseLineItemKey(lineItemKey) {
    if (!lineItemKey) return null;
    const parts = String(lineItemKey).split(':');
    if (parts.length < 2) return null;
    return { dealId: parts[0], lineItemId: parts[1] };
>>>>>>> pruebas
  }

  for (const li of lineItems) {
    try {
      const existingKey = String(li.properties?.line_item_key || '').trim();
      const parsed = parseLineItemKey(existingKey);

<<<<<<< HEAD
      li.properties = { ...(li.properties || {}), ...updateProps };
      await hubspotClient.crm.lineItems.basicApi.update(String(li.id), {
        properties: updateProps,
      });
    } catch (err) {
      console.error("[phase1] Error guardando contadores en line item", li.id, err);
=======
      const keyMatches =
        !!parsed &&
        String(parsed.dealId) === String(dealId) &&
        String(parsed.lineItemId) === String(li.id);

      if (debug) {
        logger.debug({
          module: 'phase1',
          fn: 'processLineItemsForPhase1',
          lineItemId: li.id,
          existingKey: existingKey || null,
          parsedKey: parsed || null,
          keyMatches,
        }, '[phase1][line_item_key][pre]');
      }

      // 1) Si hay key pero NO matchea => limpiar + rekey forzado
      if (existingKey && !keyMatches) {
        const updates = sanitizeClonedLineItem(li, dealId, { debug });
        if (updates && Object.keys(updates).length) {
          try {
            await hubspotClient.crm.lineItems.basicApi.update(String(li.id), { properties: updates });
          } catch (err) {
            logger.error({ module: 'phase1', fn: 'processLineItemsForPhase1', lineItemId: li.id, err }, 'line_item_update_failed: sanitizeClonedLineItem');
            reportIfActionable({
              objectType: 'line_item',
              objectId: li.id,
              message: `line_item_update_failed (sanitizeClonedLineItem): ${err?.message || err}`,
              err,
            });
            continue;
          }
          li.properties = { ...(li.properties || {}), ...updates };
        }

        const { key: newKey } = ensureLineItemKey({ dealId, lineItem: li, forceNew: true });

        try {
          await hubspotClient.crm.lineItems.basicApi.update(String(li.id), {
            properties: { line_item_key: newKey },
          });
        } catch (err) {
          logger.error({ module: 'phase1', fn: 'processLineItemsForPhase1', lineItemId: li.id, newKey, err }, 'line_item_update_failed: rekey forzado');
          reportIfActionable({
            objectType: 'line_item',
            objectId: li.id,
            message: `line_item_update_failed (rekey forzado): ${err?.message || err}`,
            err,
          });
          continue;
        }
        li.properties = { ...(li.properties || {}), line_item_key: newKey };

        logger.info({
          module: 'phase1',
          fn: 'processLineItemsForPhase1',
          dealId,
          lineItemId: li.id,
          oldKey: existingKey,
          newKey,
        }, '[phase1][line_item_key] replaced (mismatch)');
      }

      // 2) Si NO hay key => crear
      if (!existingKey) {
        const { key: lineItemKey } = ensureLineItemKey({ dealId, lineItem: li });

        try {
          await hubspotClient.crm.lineItems.basicApi.update(String(li.id), {
            properties: { line_item_key: lineItemKey },
          });
        } catch (err) {
          logger.error({ module: 'phase1', fn: 'processLineItemsForPhase1', lineItemId: li.id, lineItemKey, err }, 'line_item_update_failed: crear line_item_key');
          reportIfActionable({
            objectType: 'line_item',
            objectId: li.id,
            message: `line_item_update_failed (crear line_item_key): ${err?.message || err}`,
            err,
          });
          continue;
        }
        li.properties = { ...(li.properties || {}), line_item_key: lineItemKey };

        logger.info({ module: 'phase1', fn: 'processLineItemsForPhase1', dealId, lineItemId: li.id, line_item_key: lineItemKey }, '[phase1][line_item_key] created');
      }

      // 0.5) HARD STOP POR PROPERTY: si fechas_completas=true, no recalcular schedule
      const fechasCompletas =
        String(li.properties?.fechas_completas || '').toLowerCase() === 'true';

      if (fechasCompletas) {
        if ((li.properties?.billing_next_date ?? '') !== '') {
          try {
            await hubspotClient.crm.lineItems.basicApi.update(String(li.id), {
              properties: { billing_next_date: '' },
            });
          } catch (err) {
            logger.error({ module: 'phase1', fn: 'processLineItemsForPhase1', lineItemId: li.id, err }, 'line_item_update_failed: limpiar billing_next_date (fechas_completas)');
            reportIfActionable({
              objectType: 'line_item',
              objectId: li.id,
              message: `line_item_update_failed (fechas_completas clear): ${err?.message || err}`,
              err,
            });
          }
          li.properties = { ...(li.properties || {}), billing_next_date: '' };
        }

        logger.debug({ module: 'phase1', fn: 'processLineItemsForPhase1', lineItemId: li.id }, '[phase1] fechas_completas=true -> skip schedule');
      } else {
        await updateLineItemSchedule(li, {
          dealId,
          dealName: dealProps.dealname,
          ownerId:  dealProps.hubspot_owner_id || null,
        });
      }

      await ensureForecastMetaOnLineItem(li);

      if (debug) {
        logger.debug({
          module: 'phase1',
          fn: 'processLineItemsForPhase1',
          lineItemId: li.id,
          billing_next_date: li.properties?.billing_next_date,
          last_ticketed_date: li.properties?.last_ticketed_date,
          last_billing_period: li.properties?.last_billing_period,
          fechas_completas: li.properties?.fechas_completas,
        }, '[phase1][post-updateLineItemSchedule]');
      }
    } catch (err) {
      logger.error({ module: 'phase1', fn: 'processLineItemsForPhase1', lineItemId: li.id, err }, '[phase1] Error en updateLineItemSchedule para line item');
>>>>>>> pruebas
    }
  }
}

<<<<<<< HEAD
export async function runPhase1(dealId, {
   mode,
   sourceLineItemId
  } = {}) {
  if (!dealId) throw new Error("runPhase1 requiere un dealId");
=======
export async function runPhase1(dealId) {
  if (!dealId) throw new Error('runPhase1 requiere un dealId');
>>>>>>> pruebas

  const { deal, lineItems } = await getDealWithLineItems(dealId);
  const dealProps = deal.properties || {};

<<<<<<< HEAD
  // Sanear identidad de line items clonados por UI (solo si no es espejo)
  await sanitizeClonedLineItemIdentity(deal, lineItems);

  // Derivar intención de facturación urgente
  const shouldPropagateUrgentBilling = mode === "line_item.facturar_ahora" && sourceLineItemId;

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
    console.log(
      `║           LINE ITEMS CARGADOS (${lineItems.length})                   ║`
    );
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
      console.log("   number_of_payments:", nop, "(OK)");

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
    console.error("[phase1] Error normalizando retrasos de facturación", err);
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
      console.log(
        `   hs_billing_start_delay_type: ${lp.hs_billing_start_delay_type || "(vacío)"}`
      );
      console.log(
        `   hs_billing_start_delay_days: ${lp.hs_billing_start_delay_days || "(vacío)"}`
      );
      console.log(
        `   hs_billing_start_delay_months: ${lp.hs_billing_start_delay_months || "(vacío)"}`
      );
    }

    console.log("\n═══════════════════════════════════════════════════════════\n");
=======
  const DBG_PHASE1 = process.env.DBG_PHASE1 === 'true';

  // ===== DEBUG: dump de deal + line items en un solo log =====
  if (DBG_PHASE1) {
    const dp = deal?.properties || {};
    logger.debug({
      module: 'phase1',
      fn: 'runPhase1',
      dealId,
      dealPropKeys: Object.keys(dp).sort(),
      deal: {
        dealname: dp.dealname,
        dealstage: dp.dealstage,
        deal_currency_code: dp.deal_currency_code,
        pais_operativo: dp.pais_operativo,
        unidad_de_negocio: dp.unidad_de_negocio,
        facturacion_activa: dp.facturacion_activa,
        facturacion_proxima_fecha: dp.facturacion_proxima_fecha,
        facturacion_ultima_fecha: dp.facturacion_ultima_fecha,
        cupo_activo: dp.cupo_activo,
        cupo_total: dp.cupo_total,
        cupo_total_monto: dp.cupo_total_monto,
        cupo_consumido: dp.cupo_consumido,
        cupo_restante: dp.cupo_restante,
        cupo_umbral: dp.cupo_umbral,
        tipo_de_cupo: dp.tipo_de_cupo,
        deal_py_origen_id: dp.deal_py_origen_id,
        deal_uy_mirror_id: dp.deal_uy_mirror_id,
        es_mirror_de_py: dp.es_mirror_de_py,
      },
      lineItems: lineItems.map(li => {
        const lp = li?.properties || {};
        return {
          id: li.id,
          name: lp.name,
          price: lp.price,
          quantity: lp.quantity,
          amount: lp.amount,
          discount: lp.discount,
          hs_discount_percentage: lp.hs_discount_percentage,
          hs_tax_rate_group_id: lp.hs_tax_rate_group_id,
          recurringbillingfrequency: lp.recurringbillingfrequency,
          hs_recurring_billing_start_date: lp.hs_recurring_billing_start_date,
          number_of_payments: lp.number_of_payments ?? lp.hs_recurring_billing_number_of_payments,
          hs_billing_start_delay_days: lp.hs_billing_start_delay_days,
          hs_billing_start_delay_months: lp.hs_billing_start_delay_months,
          facturacion_activa: lp.facturacion_activa,
          facturacion_automatica: lp.facturacion_automatica,
          facturar_ahora: lp.facturar_ahora,
          irregular: lp.irregular,
          parte_del_cupo: lp.parte_del_cupo,
          pais_operativo: lp.pais_operativo,
        };
      }),
    }, '[phase1] DEAL + LINE ITEMS cargados');
  }

  // -- Convertir retrasos en fecha de inicio concreta --
  try {
    await normalizeBillingStartDelay(lineItems, deal);
  } catch (err) {
    logger.error({ module: 'phase1', fn: 'runPhase1', dealId, err }, '[phase1] Error normalizando retrasos de facturación');
  }

  // ===== DEBUG POST-NORMALIZE =====
  if (DBG_PHASE1) {
    logger.debug({
      module: 'phase1',
      fn: 'runPhase1',
      dealId,
      lineItems: lineItems.map(li => ({
        id: li.id,
        name: li.properties?.name,
        hs_recurring_billing_start_date: li.properties?.hs_recurring_billing_start_date,
        hs_billing_start_delay_type: li.properties?.hs_billing_start_delay_type,
        hs_billing_start_delay_days: li.properties?.hs_billing_start_delay_days,
        hs_billing_start_delay_months: li.properties?.hs_billing_start_delay_months,
      })),
    }, '[phase1] POST-NORMALIZE fechas finales line items');
>>>>>>> pruebas
  }

  async function sanitizeClonedLineItemIdentity(deal, lineItems) {
  const isMirror = parseBool(deal.properties.es_mirror_de_py);

  if (isMirror) return;

  for (const li of lineItems) {
    const p = li.properties || {};

    if (p.of_line_item_py_origen_id) {
      await hubspotClient.crm.lineItems.basicApi.update(String(li.id), {
        properties: {
          of_line_item_py_origen_id: null,
        },
      });

      li.properties.of_line_item_py_origen_id = null;
    }
  }
}

  // 1) Mirroring (si corresponde)
  let mirrorResult = null;
  try {
    mirrorResult = await mirrorDealToUruguay(dealId, {
      mode,
      sourceLineItemId,
    });
  } catch (err) {
<<<<<<< HEAD
    console.error("[phase1] Error en mirrorDealToUruguay:", err?.response?.body || err);
  }

  // Propagar facturar_ahora al line item espejo si corresponde
  if (
    shouldPropagateUrgentBilling &&
    mirrorResult?.mirrored &&
    mirrorResult?.mirrorLineItemId
  ) {
    try {
      await hubspotClient.crm.lineItems.basicApi.update(
        String(mirrorResult.mirrorLineItemId),
        {
          properties: { facturar_ahora: "true" },
        }
      );
      console.log(`[phase1] Propagado facturar_ahora al mirror LI ${mirrorResult.mirrorLineItemId}`);
    } catch (err) {
      console.warn(`[phase1] Error propagando facturar_ahora al mirror LI`, mirrorResult.mirrorLineItemId, err?.message);
    }
=======
    logger.error({ module: 'phase1', fn: 'runPhase1', dealId, err }, '[phase1] Error en mirrorDealToUruguay');
>>>>>>> pruebas
  }

  // Si no hay line items en el negocio original, terminamos
  if (!lineItems || !lineItems.length) {
    return {
      dealId,
      dealName: dealProps.dealname,
      skipped: true,
      reason: "sin line items",
    };
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // 1.5) Inicializar cupo si es necesario (antes de procesar line items)
  try {
    await activateCupoIfNeeded(dealId, dealProps, lineItems);
  } catch (err) {
<<<<<<< HEAD
    console.error("[phase1] Error en activateCupoIfNeeded:", err);
=======
    logger.error({ module: 'phase1', fn: 'runPhase1', dealId, err }, '[phase1] Error en activateCupoIfNeeded');
>>>>>>> pruebas
  }

  // 2) Procesar negocio original: calendario + contadores + cupo por línea
await processLineItemsForPhase1(dealId, lineItems, today, { alsoInitCupo: true, dealProps });

<<<<<<< HEAD
  // 2.1) Procesar espejo UY (si existe): calendario + contadores + cupo por línea
  if (mirrorResult?.mirrored && mirrorResult?.targetDealId) {
    try {
      const { deal: mirrorDeal, lineItems: mirrorLineItems } = await getDealWithLineItems(
        mirrorResult.targetDealId
      );

      console.log(
        `[phase1] Procesando ESPEJO deal=${mirrorResult.targetDealId} lineItems=${mirrorLineItems
          .map((x) => x.id)
          .join(",")}`
      );

      // Inicializar cupo del espejo también
      try {
        await activateCupoIfNeeded(
          mirrorResult.targetDealId,
          mirrorDeal.properties,
          mirrorLineItems
        );
      } catch (err) {
        console.error(
          "[phase1] Error activateCupoIfNeeded en espejo UY",
          mirrorResult.targetDealId,
          err
        );
      }

      await processLineItemsForPhase1(mirrorLineItems, today, { alsoInitCupo: true });

      // actualizar cupo a nivel deal espejo usando sus props (no pisar inputs)
      try {
        await updateDealCupo(mirrorDeal, mirrorLineItems);
      } catch (err) {
        console.error("[phase1] Error updateDealCupo en espejo UY", mirrorResult.targetDealId, err);
      }
    } catch (err) {
      console.error(
        "[phase1] No se pudo obtener o procesar el deal espejo",
        mirrorResult.targetDealId,
        err
      );
=======
  // 2.1) Procesar espejo UY (si existe)
  if (mirrorResult?.mirrored && mirrorResult?.targetDealId) {
    try {
      const { deal: mirrorDeal, lineItems: mirrorLineItems } =
        await getDealWithLineItems(mirrorResult.targetDealId);

      logger.info({
        module: 'phase1',
        fn: 'runPhase1',
        mirrorDealId: mirrorResult.targetDealId,
        mirrorLineItemIds: mirrorLineItems.map(x => x.id),
      }, '[phase1] Procesando ESPEJO UY');

      try {
        await activateCupoIfNeeded(mirrorResult.targetDealId, mirrorDeal.properties, mirrorLineItems);
      } catch (err) {
        logger.error({ module: 'phase1', fn: 'runPhase1', mirrorDealId: mirrorResult.targetDealId, err }, '[phase1] Error activateCupoIfNeeded en espejo UY');
      }

// CORRECTO
await processLineItemsForPhase1(mirrorResult.targetDealId, mirrorLineItems, today, { alsoInitCupo: true, dealProps: mirrorDeal.properties || {} });
      try {
        await updateDealCupo(mirrorDeal, mirrorLineItems);
      } catch (err) {
        logger.error({ module: 'phase1', fn: 'runPhase1', mirrorDealId: mirrorResult.targetDealId, err }, '[phase1] Error updateDealCupo en espejo UY');
      }
    } catch (err) {
      logger.error({ module: 'phase1', fn: 'runPhase1', mirrorDealId: mirrorResult.targetDealId, err }, '[phase1] No se pudo obtener o procesar el deal espejo');
>>>>>>> pruebas
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

  // 4) Calcular strings de fechas
  const nextDateStr = fmtYMD(effectiveNext);
  const lastDateStr = fmtYMD(effectiveLast);

  // 4b) Tipo del negocio = tipo del PRÓXIMO evento
  const dealBillingFrequency = pickDealFlowTypeForNextEvent(lineItems, nextDateStr);

<<<<<<< HEAD
  // 5) Actualizar cupo a nivel negocio pasando también el negocio completo
  try {
    await updateDealCupo(deal, lineItems);
  } catch (err) {
    console.error("[phase1] Error updateDealCupo deal", dealId, err);
  }

  // 6) Construir mensaje
  const message = effectiveNext ? buildNextBillingMessage({ deal, nextDate: effectiveNext, lineItems }) : "";

  // 7) Actualizar SIEMPRE propiedades del deal (aunque facturacion_activa=false)
=======
  // 5) Actualizar cupo a nivel negocio
  try {
    await updateDealCupo(deal, lineItems);
  } catch (err) {
    logger.error({ module: 'phase1', fn: 'runPhase1', dealId, err }, '[phase1] Error updateDealCupo deal');
  }

  // 6) Construir mensaje
  const message = effectiveNext
    ? buildNextBillingMessage({ deal, nextDate: effectiveNext, lineItems })
    : '';

  // 7) Actualizar propiedades del deal
>>>>>>> pruebas
  const updateBody = {
    properties: {
      facturacion_proxima_fecha: nextDateStr || null,
      facturacion_ultima_fecha: lastDateStr || null,
<<<<<<< HEAD
      facturacion_mensaje_proximo_aviso: message || "",
      // ⚠️ SOLO PARA REPORTING: esta propiedad NO se usa en lógica de facturación
      // La fuente de verdad SIEMPRE es el Line Item
=======
      facturacion_mensaje_proximo_aviso: message || '',
>>>>>>> pruebas
      facturacion_frecuencia_de_facturacion: dealBillingFrequency || null,
    },
  };

  try {
    await hubspotClient.crm.deals.basicApi.update(String(dealId), updateBody);
  } catch (err) {
    logger.error({ module: 'phase1', fn: 'runPhase1', dealId, err }, '[phase1] deal_update_failed: propiedades finales');
    // deals fuera del criterio ticket/line_item → no reportIfActionable
  }

  // 8) "Skip" solo como semántica
  const active = parseBoolFromHubspot(dealProps.facturacion_activa);
  if (!active) {
    return {
      dealId,
      dealName: dealProps.dealname,
      skipped: true,
      reason:
        "facturacion_activa es false; se recalcularon calendarios, contadores, cupo y propiedades del deal",
      nextBillingDate: nextDateStr,
      lastBillingDate: lastDateStr,
    };
  }

  if (!nextBillingDate && !lastBillingDate) {
    return {
      dealId,
      dealName: dealProps.dealname,
      skipped: true,
      reason: "sin fechas útiles (contrato completado o mal configurado)",
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

/*
 * ─────────────────────────────────────────────────────────────
 * CATCHES con reportHubSpotError agregados:
 *
 * En processLineItemsForPhase1() — todos sobre line_items:
 * 1. sanitizeClonedLineItem update → objectType: "line_item"
 * 2. rekey forzado (line_item_key mismatch) → objectType: "line_item"
 * 3. crear line_item_key → objectType: "line_item"
 * 4. limpiar billing_next_date (fechas_completas) → objectType: "line_item"
 *    → con continue donde corresponde (loop for...of sobre lineItems)
 *
 * NO reportados (fuera de criterio ticket/line_item):
 * - activateCupoIfNeeded deal update → solo logger.error (deals)
 * - runPhase1 deal update final → solo logger.error (deals)
 * - mirrorDealToUruguay, normalizeBillingStartDelay, updateDealCupo
 *   → errores de orquestación, no de objeto accionable directo
 * - syncBillingState → lógica interna, solo logger.warn
 *
 * Confirmación: "No se reportan warns a HubSpot;
 *                solo errores 4xx (≠429)" — implementado en reportIfActionable().
 * ─────────────────────────────────────────────────────────────
 */
