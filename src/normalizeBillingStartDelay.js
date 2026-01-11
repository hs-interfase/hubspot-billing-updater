import { hubspotClient } from "./services/hubspotClient.js";

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
  console.log(`\n[normalizeBillingStartDelay] 🔍 Procesando line item ${lineItem.id}...`);
  
  const p = lineItem?.properties || {};
  const existingStart = (p.hs_recurring_billing_start_date ?? "").toString().trim();
  const delayDays = parseInt((p.hs_billing_start_delay_days ?? "").toString(), 10) || 0;
  const delayMonths = parseInt((p.hs_billing_start_delay_months ?? "").toString(), 10) || 0;

  console.log(`[normalizeBillingStartDelay] 📊 Estado actual:`, {
    lineItemId: lineItem.id,
    existingStart,
    delayDays,
    delayMonths,
    rawDelayDays: p.hs_billing_start_delay_days,
    rawDelayMonths: p.hs_billing_start_delay_months
  });

  // Si ya tiene fecha de inicio o no hay retrasos, salir sin cambios.
  if (existingStart || (!delayDays && !delayMonths)) {
    console.log(`[normalizeBillingStartDelay] ⏭️  Saltando: ${existingStart ? 'ya tiene fecha' : 'no hay delays'}`);
    return { changed: false };
  }

  console.log(`[normalizeBillingStartDelay] ✅ Necesita normalización`);

  // Obtener fecha base: createdate del line item, hs_createdate o closedate del deal;
  // si ninguna es válida, usar hoy.
  const candidates = [
    p.createdate,
    p.hs_createdate,
    deal?.properties?.closedate,
  ];
  
  console.log(`[normalizeBillingStartDelay] 📅 Buscando fecha base...`, {
    createdate: p.createdate,
    hs_createdate: p.hs_createdate,
    closedate: deal?.properties?.closedate
  });

  let baseDate = null;
  for (const raw of candidates) {
    if (!raw) continue;
    const d = new Date(raw);
    if (!Number.isNaN(d.getTime())) {
      d.setHours(0, 0, 0, 0);
      baseDate = d;
      console.log(`[normalizeBillingStartDelay] ✅ Fecha base encontrada:`, baseDate.toISOString());
      break;
    }
  }
  if (!baseDate) {
    baseDate = new Date();
    baseDate.setHours(0, 0, 0, 0);
    console.log(`[normalizeBillingStartDelay] ⚠️  Sin fecha válida, usando hoy:`, baseDate.toISOString());
  }

  // Calcular nueva fecha
  let newDate = new Date(baseDate.getTime());
  if (delayDays > 0) {
    console.log(`[normalizeBillingStartDelay] ➕ Añadiendo ${delayDays} días a ${baseDate.toISOString().slice(0,10)}`);
    newDate.setDate(newDate.getDate() + delayDays);
  } else if (delayMonths > 0) {
    console.log(`[normalizeBillingStartDelay] ➕ Añadiendo ${delayMonths} meses a ${baseDate.toISOString().slice(0,10)}`);
    const day = newDate.getDate();
    newDate.setMonth(newDate.getMonth() + delayMonths);
    // Ajuste para fin de mes
    if (newDate.getDate() < day) {
      newDate.setDate(0);
    }
  }

  const iso = newDate.toISOString().slice(0, 10);
  console.log(`[normalizeBillingStartDelay] 📆 Nueva fecha calculada: ${iso}`);

  // HubSpot requiere limpiar delays ANTES de setear fecha
  console.log(`[normalizeBillingStartDelay] 🧹 PASO 1: Limpiando delays...`);
  try {
    await hubspotClient.crm.lineItems.basicApi.update(String(lineItem.id), {
      properties: {
        hs_billing_start_delay_days: "",
        hs_billing_start_delay_months: "",
      },
    });
    console.log(`[normalizeBillingStartDelay] ✅ PASO 1 completado: Delays limpiados`);
  } catch (err) {
    console.error(`[normalizeBillingStartDelay] ❌ ERROR en PASO 1:`, err.message);
    throw err;
  }

  // Esperar un poco para que HubSpot procese
  console.log(`[normalizeBillingStartDelay] ⏳ Esperando 1.5 segundos para que HubSpot procese...`);
  await new Promise(resolve => setTimeout(resolve, 1500));

  console.log(`[normalizeBillingStartDelay] 📝 PASO 2: Seteando fecha de inicio a ${iso}...`);
  try {
    await hubspotClient.crm.lineItems.basicApi.update(String(lineItem.id), {
      properties: {
        hs_recurring_billing_start_date: iso,
      },
    });
    console.log(`[normalizeBillingStartDelay] ✅ PASO 2 completado: Fecha seteada`);
  } catch (err) {
    console.error(`[normalizeBillingStartDelay] ❌ ERROR en PASO 2:`, err.message);
    throw err;
  }

  // Actualizar objeto en memoria
  lineItem.properties = {
    ...p,
    hs_recurring_billing_start_date: iso,
    hs_billing_start_delay_days: "",
    hs_billing_start_delay_months: "",
  };

  console.log(`[normalizeBillingStartDelay] 🎉 Line item ${lineItem.id} normalizado exitosamente a ${iso}\n`);
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
  console.log(`\n[normalizeBillingStartDelay] 🚀 Iniciando normalización de ${lineItems?.length || 0} line items...`);
  if (!Array.isArray(lineItems)) {
    console.log(`[normalizeBillingStartDelay] ⚠️  lineItems no es array, saltando`);
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
      console.error(`[normalizeBillingStartDelay] ❌ Error normalizando line item ${li?.id}:`, err.message);
    }
  }
  
  console.log(`[normalizeBillingStartDelay] 📊 Resumen: ${processed} procesados, ${changed} normalizados, ${errors} errores\n`);
}