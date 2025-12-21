// src/dealBillingFields.js
import { hubspotClient } from './hubspotClient.js';

/** Devuelve un objeto con todas las fechas de facturación de los line items ordenadas */
function collectAllLineItemDates(lineItems = []) {
  const dates = [];
  for (const li of lineItems) {
    const p = li.properties || {};
    const add = (raw) => {
      if (!raw) return;
      const d = new Date(raw.toString());
      if (Number.isNaN(d.getTime())) return;
      d.setHours(0, 0, 0, 0);
      dates.push({ date: d, li });
    };
    // fecha de inicio + calendario generado (fecha_2..fecha_48)
    add(p.fecha_inicio_de_facturacion || p.hs_recurring_billing_start_date);
    for (let i = 2; i <= 48; i++) add(p[`fecha_${i}`]);
  }
  dates.sort((a, b) => a.date - b.date);
  return dates;
}

/** Devuelve un resumen de frecuencia a nivel negocio según sus line items */
function computeDealFrequencySummary(lineItems = []) {
  let repetitivo = false;
  for (const li of lineItems) {
    const p = li.properties || {};
    const freq = (p.frecuencia_de_facturacion ?? '').toString().trim().toLowerCase();
    const irregular =
      (p.irregular ?? '').toString().trim().toLowerCase() === 'true' ||
      (p.facturacion_irregular ?? '').toString().trim().toLowerCase() === 'true';
    const isUnique =
      ['unique', 'one_time', 'one-time', 'once', 'unico', 'único'].includes(freq);
    if (!(isUnique && !irregular)) {
      repetitivo = true;
      break;
    }
  }
  return repetitivo ? 'Recurrente' : 'Pago único';
}

/**
 * Calcula próxima/última fecha, mensaje y frecuencia, y actualiza el negocio.
 * Se usa en Fase 2 (closed won) para reflejar la próxima facturación.
 *
 * @param {Object} params.dealId    ID del deal (string)
 * @param {Object} params.deal      Objeto del negocio con properties
 * @param {Array}  params.lineItems Array de line items del negocio
 * @param {Date}   params.today     Fecha de referencia (default = hoy)
 * @returns {Promise<Object>}       Resumen con nextBillingDate y lastBillingDate
 */
export async function updateDealBillingFieldsFromLineItems({
  dealId,
  deal,
  lineItems,
  today = new Date(),
}) {
  const props = deal?.properties || {};
  const todayMid = new Date(today);
  todayMid.setHours(0, 0, 0, 0);

  // Recoger todas las fechas de facturación
  const all = collectAllLineItemDates(lineItems);
  const future = all.filter((x) => x.date >= todayMid);
  const past = all.filter((x) => x.date < todayMid);
  const next = future.length ? future[0] : null;
  const last = past.length ? past[past.length - 1] : null;

  const toDateString = (d) => (d ? d.toISOString().slice(0, 10) : '');
  const nextStr = next ? toDateString(next.date) : '';
  const lastStr = last ? toDateString(last.date) : '';

  // Calcular resumen de frecuencia
  const freqSummary = computeDealFrequencySummary(lineItems);

  // Construir mensaje de aviso si hay próxima fecha
  let msg = '';
  if (next) {
    const liProps = next.li?.properties || {};
    const producto = liProps.name || '';
    const servicio = liProps.servicio ? ` (${liProps.servicio})` : '';
    msg = `${props.dealname || '(sin negocio)'} | ${producto}${servicio} | ${nextStr}`;
  }

  // Actualizar propiedades en el negocio
  await hubspotClient.crm.deals.basicApi.update(String(dealId), {
    properties: {
      facturacion_proxima_fecha: nextStr || null,
      facturacion_ultima_fecha: lastStr || null,
      facturacion_frecuencia_de_facturacion: freqSummary || null,
      facturacion_mensaje_proximo_aviso: msg || null,
    },
  });

  return {
    nextBillingDate: nextStr || null,
    lastBillingDate: lastStr || null,
    facturacion_frecuencia_de_facturacion: freqSummary,
    facturacion_mensaje_proximo_aviso: msg,
  };
}
