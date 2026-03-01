// src/phases/phase1.js
import { hubspotClient, getDealWithLineItems } from '../hubspotClient.js';
import { syncBillingState } from '../services/billing/syncBillingState.js';
import { DEAL_STAGE_LOST } from '../config/constants.js';
import { mirrorDealToUruguay } from '../dealMirroring.js';
import {
  updateLineItemSchedule,
  computeNextBillingDateFromLineItems,
  computeLastBillingDateFromLineItems,
} from '../billingEngine.js';
import { updateDealCupo } from '../utils/propertyHelpers.js';
import { normalizeBillingStartDelay } from '../normalizeBillingStartDelay.js';
import { logDateEnvOnce } from "../utils/dateDebugs.js";
import { parseBool, parseNumber, safeString } from "../utils/parsers.js";
import { computeCupoEstadoFrom } from "../utils/calculateCupoEstado.js";
import { ensureLineItemKey } from '../utils/lineItemKey.js';
import { sanitizeClonedLineItem } from '../services/lineItems/cloneSanitizerService.js';
import { ensureForecastMetaOnLineItem } from '../services/forecast/forecastMetaService.js';
import logger from '../../lib/logger.js';
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

  const shouldActivate = facturacionActiva && tipoRaw !== '';

  const cupoConsumido = dealProps.cupo_consumido;
  const cupoRestante = dealProps.cupo_restante;

  const isConsumidoNull = cupoConsumido === null || cupoConsumido === undefined || cupoConsumido === '';
  const isRestanteNull = cupoRestante === null || cupoRestante === undefined || cupoRestante === '';

  let cupoTotal = 0;
  if (tipo === 'por horas' || tipo === 'por_horas') {
    cupoTotal = parseNumber(dealProps.cupo_total, 0);
  } else if (tipo === 'por monto' || tipo === 'por_monto') {
    cupoTotal = parseNumber(dealProps.cupo_total_monto ?? dealProps.cupo_total, 0);
  }

  const updateProps = {};

  const currentCupoActivo = parseBool(dealProps.cupo_activo);
  if (currentCupoActivo !== shouldActivate) {
    updateProps.cupo_activo = String(shouldActivate);
  }

  if (shouldActivate && isConsumidoNull) {
    updateProps.cupo_consumido = '0';
  }
  if (shouldActivate && isRestanteNull) {
    updateProps.cupo_restante = String(cupoTotal);
  }

  const newCupoEstado = computeCupoEstadoFrom(dealProps, {
    cupo_activo: updateProps.cupo_activo,
    cupo_consumido: updateProps.cupo_consumido,
    cupo_restante: updateProps.cupo_restante,
    tipo_de_cupo: updateProps.tipo_de_cupo,
    cupo_total: updateProps.cupo_total,
    cupo_total_monto: updateProps.cupo_total_monto,
  });

  const currentCupoEstado = dealProps.cupo_estado;

  if (newCupoEstado !== 'Inconsistente' && newCupoEstado && newCupoEstado !== currentCupoEstado) {
    updateProps.cupo_estado = newCupoEstado;
    logger.info({ module: 'phase1', fn: 'activateCupoIfNeeded', dealId, from: currentCupoEstado || '(null)', to: newCupoEstado }, `[cupo:activate] cupo_estado: ${currentCupoEstado || '(null)'} → ${newCupoEstado}`);
  }

  if (Object.keys(updateProps).length === 0) {
    logger.info({ module: 'phase1', fn: 'activateCupoIfNeeded', dealId, cupo_activo: shouldActivate }, '[cupo:activate] sin cambios');
    return;
  }

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
}

function classifyLineItemFlow(li) {
  const p = li?.properties || {};

  const irregular = (p.irregular ?? '').toString().toLowerCase();
  if (irregular === 'true' || irregular === '1' || irregular === 'si' || irregular === 'sí') {
    return 'Irregular';
  }

  const freq = (p.recurringbillingfrequency ?? p.hs_recurring_billing_frequency ?? '')
    .toString()
    .toLowerCase()
    .trim();
  if (freq) return 'Recurrente';

  const num = (p.hs_recurring_billing_number_of_payments ?? '').toString().trim();
  if (num === '1') return 'Pago Único';

  return null;
}

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

function buildNextBillingMessage({ deal, nextDate, lineItems }) {
  const dealName = deal?.properties?.dealname || '';
  const count = Array.isArray(lineItems) ? lineItems.length : 0;
  return `Próxima facturación ${fmtYMD(nextDate)} · ${dealName} · ${count} line items`;
}

async function processLineItemsForPhase1(dealId, lineItems, today, { alsoInitCupo = true } = {}) {
  if (!Array.isArray(lineItems) || lineItems.length === 0) return;

  const debug = process.env.DBG_PHASE1 === 'true';

  function parseLineItemKey(lineItemKey) {
    if (!lineItemKey) return null;
    const parts = String(lineItemKey).split(':');
    if (parts.length < 2) return null;
    return { dealId: parts[0], lineItemId: parts[1] };
  }

  for (const li of lineItems) {
    try {
      const existingKey = String(li.properties?.line_item_key || '').trim();
      const parsed = parseLineItemKey(existingKey);

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
        await updateLineItemSchedule(li);
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
    }
  }
}

export async function runPhase1(dealId) {
  if (!dealId) throw new Error('runPhase1 requiere un dealId');

  const { deal, lineItems } = await getDealWithLineItems(dealId);
  const dealProps = deal.properties || {};

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
  }

  // 1) Mirroring (si corresponde)
  let mirrorResult = null;
  try {
    mirrorResult = await mirrorDealToUruguay(dealId);
  } catch (err) {
    logger.error({ module: 'phase1', fn: 'runPhase1', dealId, err }, '[phase1] Error en mirrorDealToUruguay');
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
    await activateCupoIfNeeded(dealId, dealProps, lineItems);
  } catch (err) {
    logger.error({ module: 'phase1', fn: 'runPhase1', dealId, err }, '[phase1] Error en activateCupoIfNeeded');
  }

  // 2) Procesar negocio original: calendario + contadores + cupo por línea
  await processLineItemsForPhase1(dealId, lineItems, today, { alsoInitCupo: true });

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
await processLineItemsForPhase1(mirrorResult.targetDealId, mirrorLineItems, today, { alsoInitCupo: true });
      try {
        await updateDealCupo(mirrorDeal, mirrorLineItems);
      } catch (err) {
        logger.error({ module: 'phase1', fn: 'runPhase1', mirrorDealId: mirrorResult.targetDealId, err }, '[phase1] Error updateDealCupo en espejo UY');
      }
    } catch (err) {
      logger.error({ module: 'phase1', fn: 'runPhase1', mirrorDealId: mirrorResult.targetDealId, err }, '[phase1] No se pudo obtener o procesar el deal espejo');
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
  const updateBody = {
    properties: {
      facturacion_proxima_fecha: nextDateStr || null,
      facturacion_ultima_fecha: lastDateStr || null,
      facturacion_mensaje_proximo_aviso: message || '',
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
      reason: 'facturacion_activa es false; se recalcularon calendarios, contadores, cupo y propiedades del deal',
      nextBillingDate: nextDateStr,
      lastBillingDate: lastDateStr,
    };
  }

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
