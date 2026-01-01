import { hubspotClient } from "../hubspotClient.js";

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
  const p = lineItem?.properties || {};
  const existingStart = (p.hs_recurring_billing_start_date ?? "").toString().trim();
  const delayDays = parseInt((p.hs_billing_start_delay_days ?? "").toString(), 10) || 0;
  const delayMonths = parseInt((p.hs_billing_start_delay_months ?? "").toString(), 10) || 0;

  // Si ya tiene fecha de inicio o no hay retrasos, salir sin cambios.
  if (existingStart || (!delayDays && !delayMonths)) {
    return { changed: false };
  }

  // Obtener fecha base: createdate del line item, hs_createdate o closedate del deal;
  // si ninguna es válida, usar hoy.
  const candidates = [
    p.createdate,
    p.hs_createdate,
    deal?.properties?.closedate,
  ];
  let baseDate = null;
  for (const raw of candidates) {
    if (!raw) continue;
    const d = new Date(raw);
    if (!Number.isNaN(d.getTime())) {
      d.setHours(0, 0, 0, 0);
      baseDate = d;
      break;
    }
  }
  if (!baseDate) {
    baseDate = new Date();
    baseDate.setHours(0, 0, 0, 0);
  }

  // Calcular nueva fecha
  let newDate = new Date(baseDate.getTime());
  if (delayDays > 0) {
    newDate.setDate(newDate.getDate() + delayDays);
  } else if (delayMonths > 0) {
    const day = newDate.getDate();
    newDate.setMonth(newDate.getMonth() + delayMonths);
    // Ajuste para fin de mes
    if (newDate.getDate() < day) {
      newDate.setDate(0);
    }
  }
  const iso = newDate.toISOString().slice(0, 10);

  // Preparar update: fijar fecha de inicio y limpiar delays
  const updateProps = {
    hs_recurring_billing_start_date: iso,
    hs_billing_start_delay_days: null,
    hs_billing_start_delay_months: null,
  };

  await hubspotClient.crm.lineItems.basicApi.update(String(lineItem.id), {
    properties: updateProps,
  });
  // Actualizar objeto en memoria
  lineItem.properties = { ...p, ...updateProps };
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
  if (!Array.isArray(lineItems)) return;
  for (const li of lineItems) {
    try {
      await normalizeBillingStartDelayForLineItem(li, deal);
    } catch (err) {
      console.error("[normalizeBillingStartDelay] Error normalizando line item", li?.id, err);
    }
  }
}
