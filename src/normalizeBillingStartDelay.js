// src/normalizeBillingStartDelay.js
import { hubspotClient } from "./hubspotClient.js";
import logger from "../lib/logger.js";
import { reportIfActionable } from "./utils/errorReporting.js";

/**
 * Normaliza los campos hs_billing_start_delay_days y hs_billing_start_delay_months
 * de un line item y los convierte en una fecha concreta en hs_recurring_billing_start_date.
 * Si ya existe una fecha de inicio o no hay valores de retraso, no hace nada.
 *
 * @param {Object} lineItem - El line item con sus propiedades.
 * @param {Object} deal - El negocio padre, usado para calcular la fecha base.
 * @returns {Promise<{changed: boolean, updatedStartDate?: string}>}
 */
export async function normalizeBillingStartDelayForLineItem(lineItem, deal) {
  logger.info({ module: 'normalizeBillingStartDelay', fn: 'normalizeBillingStartDelayForLineItem', lineItemId: lineItem.id }, `[normalizeBillingStartDelay] 🔍 Procesando line item ${lineItem.id}...`);

  const p = lineItem?.properties || {};
  const existingStart = (p.hs_recurring_billing_start_date ?? "").toString().trim();
  const delayDays = parseInt((p.hs_billing_start_delay_days ?? "").toString(), 10) || 0;
  const delayMonths = parseInt((p.hs_billing_start_delay_months ?? "").toString(), 10) || 0;

  logger.info({
    module: 'normalizeBillingStartDelay',
    fn: 'normalizeBillingStartDelayForLineItem',
    lineItemId: lineItem.id,
    existingStart,
    delayDays,
    delayMonths,
    rawDelayDays: p.hs_billing_start_delay_days,
    rawDelayMonths: p.hs_billing_start_delay_months,
  }, '[normalizeBillingStartDelay] 📊 Estado actual');

  // Si ya tiene fecha de inicio o no hay retrasos, salir sin cambios.
  if (existingStart || (!delayDays && !delayMonths)) {
    logger.info({ module: 'normalizeBillingStartDelay', fn: 'normalizeBillingStartDelayForLineItem', lineItemId: lineItem.id, reason: existingStart ? 'ya tiene fecha' : 'no hay delays' }, `[normalizeBillingStartDelay] ⏭️  Saltando`);
    return { changed: false };
  }

  logger.info({ module: 'normalizeBillingStartDelay', fn: 'normalizeBillingStartDelayForLineItem', lineItemId: lineItem.id }, '[normalizeBillingStartDelay] ✅ Necesita normalización');

  // Obtener fecha base: createdate del line item, hs_createdate o closedate del deal;
  // si ninguna es válida, usar hoy.
  const candidates = [
    p.createdate,
    p.hs_createdate,
    deal?.properties?.closedate,
  ];

  logger.info({
    module: 'normalizeBillingStartDelay',
    fn: 'normalizeBillingStartDelayForLineItem',
    lineItemId: lineItem.id,
    createdate: p.createdate,
    hs_createdate: p.hs_createdate,
    closedate: deal?.properties?.closedate,
  }, '[normalizeBillingStartDelay] 📅 Buscando fecha base...');

  let baseDate = null;
  for (const raw of candidates) {
    if (!raw) continue;
    const d = new Date(raw);
    if (!Number.isNaN(d.getTime())) {
      d.setHours(0, 0, 0, 0);
      baseDate = d;
      logger.info({ module: 'normalizeBillingStartDelay', fn: 'normalizeBillingStartDelayForLineItem', lineItemId: lineItem.id, baseDate: baseDate.toISOString() }, '[normalizeBillingStartDelay] ✅ Fecha base encontrada');
      break;
    }
  }
  if (!baseDate) {
    baseDate = new Date();
    baseDate.setHours(0, 0, 0, 0);
    logger.warn({ module: 'normalizeBillingStartDelay', fn: 'normalizeBillingStartDelayForLineItem', lineItemId: lineItem.id, baseDate: baseDate.toISOString() }, '[normalizeBillingStartDelay] ⚠️  Sin fecha válida, usando hoy');
  }

  // Calcular nueva fecha
  let newDate = new Date(baseDate.getTime());
  if (delayDays > 0) {
    logger.info({ module: 'normalizeBillingStartDelay', fn: 'normalizeBillingStartDelayForLineItem', lineItemId: lineItem.id, delayDays, base: baseDate.toISOString().slice(0, 10) }, `[normalizeBillingStartDelay] ➕ Añadiendo ${delayDays} días`);
    newDate.setDate(newDate.getDate() + delayDays);
  } else if (delayMonths > 0) {
    logger.info({ module: 'normalizeBillingStartDelay', fn: 'normalizeBillingStartDelayForLineItem', lineItemId: lineItem.id, delayMonths, base: baseDate.toISOString().slice(0, 10) }, `[normalizeBillingStartDelay] ➕ Añadiendo ${delayMonths} meses`);
    const day = newDate.getDate();
    newDate.setMonth(newDate.getMonth() + delayMonths);
    // Ajuste para fin de mes
    if (newDate.getDate() < day) {
      newDate.setDate(0);
    }
  }

  const iso = newDate.toISOString().slice(0, 10);
  logger.info({ module: 'normalizeBillingStartDelay', fn: 'normalizeBillingStartDelayForLineItem', lineItemId: lineItem.id, iso }, `[normalizeBillingStartDelay] 📆 Nueva fecha calculada: ${iso}`);

  // HubSpot requiere limpiar delays ANTES de setear fecha
  logger.info({ module: 'normalizeBillingStartDelay', fn: 'normalizeBillingStartDelayForLineItem', lineItemId: lineItem.id }, '[normalizeBillingStartDelay] 🧹 PASO 1: Limpiando delays...');
  try {
    await hubspotClient.crm.lineItems.basicApi.update(String(lineItem.id), {
      properties: {
        hs_billing_start_delay_days: "",
        hs_billing_start_delay_months: "",
      },
    });
    logger.info({ module: 'normalizeBillingStartDelay', fn: 'normalizeBillingStartDelayForLineItem', lineItemId: lineItem.id }, '[normalizeBillingStartDelay] ✅ PASO 1 completado: Delays limpiados');
  } catch (err) {
    logger.error({ module: 'normalizeBillingStartDelay', fn: 'normalizeBillingStartDelayForLineItem', lineItemId: lineItem.id, err }, '[normalizeBillingStartDelay] ❌ ERROR en PASO 1');
    reportIfActionable({
      objectType: 'line_item',
      objectId: lineItem.id,
      message: `line_item_update_failed (PASO 1 limpiar delays): ${err?.message || err}`,
      err,
    });
    throw err;
  }

  // Esperar un poco para que HubSpot procese
  logger.info({ module: 'normalizeBillingStartDelay', fn: 'normalizeBillingStartDelayForLineItem', lineItemId: lineItem.id }, '[normalizeBillingStartDelay] ⏳ Esperando 1.5 segundos para que HubSpot procese...');
  await new Promise(resolve => setTimeout(resolve, 1500));

  logger.info({ module: 'normalizeBillingStartDelay', fn: 'normalizeBillingStartDelayForLineItem', lineItemId: lineItem.id, iso }, `[normalizeBillingStartDelay] 📝 PASO 2: Seteando fecha de inicio a ${iso}...`);
  try {
    await hubspotClient.crm.lineItems.basicApi.update(String(lineItem.id), {
      properties: {
        hs_recurring_billing_start_date: iso,
      },
    });
    logger.info({ module: 'normalizeBillingStartDelay', fn: 'normalizeBillingStartDelayForLineItem', lineItemId: lineItem.id }, '[normalizeBillingStartDelay] ✅ PASO 2 completado: Fecha seteada');
  } catch (err) {
    logger.error({ module: 'normalizeBillingStartDelay', fn: 'normalizeBillingStartDelayForLineItem', lineItemId: lineItem.id, err }, '[normalizeBillingStartDelay] ❌ ERROR en PASO 2');
    reportIfActionable({
      objectType: 'line_item',
      objectId: lineItem.id,
      message: `line_item_update_failed (PASO 2 setear fecha inicio): ${err?.message || err}`,
      err,
    });
    throw err;
  }

  // Actualizar objeto en memoria
  lineItem.properties = {
    ...p,
    hs_recurring_billing_start_date: iso,
    hs_billing_start_delay_days: "",
    hs_billing_start_delay_months: "",
  };

  logger.info({ module: 'normalizeBillingStartDelay', fn: 'normalizeBillingStartDelayForLineItem', lineItemId: lineItem.id, iso }, `[normalizeBillingStartDelay] 🎉 Line item ${lineItem.id} normalizado exitosamente a ${iso}`);
  return { changed: true, updatedStartDate: iso };
}

/**
 * Normaliza todos los line items de un negocio. Itera sobre cada elemento,
 * aplica la conversión y registra los errores sin interrumpir el resto.
 *
 * @param {Array<Object>} lineItems
 * @param {Object} deal
 */
export async function normalizeBillingStartDelay(lineItems, deal) {
  logger.info({ module: 'normalizeBillingStartDelay', fn: 'normalizeBillingStartDelay', count: lineItems?.length || 0 }, `[normalizeBillingStartDelay] 🚀 Iniciando normalización de ${lineItems?.length || 0} line items...`);

  if (!Array.isArray(lineItems)) {
    logger.warn({ module: 'normalizeBillingStartDelay', fn: 'normalizeBillingStartDelay' }, '[normalizeBillingStartDelay] ⚠️  lineItems no es array, saltando');
    return;
  }

  let processed = 0;
  let changed = 0;
  let errors = 0;

  for (const li of lineItems) {
    try {
      const result = await normalizeBillingStartDelayForLineItem(li, deal);
      processed++;
      if (result.changed) changed++;
    } catch (err) {
      errors++;
      logger.error({ module: 'normalizeBillingStartDelay', fn: 'normalizeBillingStartDelay', lineItemId: li?.id, err }, `[normalizeBillingStartDelay] ❌ Error normalizando line item ${li?.id}`);
      // reportIfActionable no aplica acá: el error ya fue reportado (y re-thrown)
      // desde normalizeBillingStartDelayForLineItem en PASO 1 o PASO 2.
      continue;
    }
  }

  logger.info({ module: 'normalizeBillingStartDelay', fn: 'normalizeBillingStartDelay', processed, changed, errors }, `[normalizeBillingStartDelay] 📊 Resumen: ${processed} procesados, ${changed} normalizados, ${errors} errores`);
}

/*
 * ─────────────────────────────────────────────────────────────
 * CATCHES con reportHubSpotError agregados:
 *
 * 1. normalizeBillingStartDelayForLineItem() — PASO 1
 *    hubspotClient.crm.lineItems.basicApi.update() limpiar delays
 *    → objectType: "line_item", objectId: lineItem.id
 *    → re-throw para cortar flujo (comportamiento original preservado)
 *
 * 2. normalizeBillingStartDelayForLineItem() — PASO 2
 *    hubspotClient.crm.lineItems.basicApi.update() setear fecha inicio
 *    → objectType: "line_item", objectId: lineItem.id
 *    → re-throw para cortar flujo (comportamiento original preservado)
 *
 * NO reportado por segunda vez:
 * - normalizeBillingStartDelay() catch del loop → el error ya fue
 *   reportado en PASO 1 o PASO 2 antes del re-throw; doble reporte
 *   sería spam. Solo logger.error + continue.
 *
 * Confirmación: "No se reportan warns a HubSpot;
 *                solo errores 4xx (≠429)" — implementado en reportIfActionable().
 * ─────────────────────────────────────────────────────────────
 */