// src/phases/phase1.js
//
// Implementa la Fase 1 del flujo de facturación.
// Esta fase se ejecuta para TODOS los negocios relevantes, sin importar su etapa.
// Incluye: mirroring a Uruguay, actualización de calendarios,
// cálculo de contadores, inicialización de cupo y definición
// de fechas de próxima/última facturación.

import { hubspotClient, getDealWithLineItems } from '../hubspotClient.js';
import { mirrorDealToUruguay } from '../dealMirroring.js';
import {
  updateLineItemSchedule,
  computeNextBillingDateFromLineItems,
  computeLastBillingDateFromLineItems,
  computeBillingCountersForLineItem,
} from '../billingEngine.js';
import { initLineItemCupo, updateDealCupo } from '../cupo.js';

/**
 * Normaliza un booleano proveniente de HubSpot.
 * Acepta "true", "1", "sí", "si", "yes".
 */
function parseBoolFromHubspot(raw) {
  const v = (raw ?? '').toString().toLowerCase();
  return v === 'true' || v === '1' || v === 'sí' || v === 'si' || v === 'yes';
}

/**
 * Construye el mensaje de próxima facturación.
 * Usa computeBillingCountersForLineItem para cada línea relevante.
 */
function buildNextBillingMessage({ deal, nextDate, lineItems }) {
  const props = deal.properties || {};
  const moneda = props.deal_currency_code || '(sin definir)';
  const yyyy = nextDate.getFullYear();
  const mm = String(nextDate.getMonth() + 1).padStart(2, '0');
  const dd = String(nextDate.getDate()).padStart(2, '0');
  const nextDateIso = `${yyyy}-${mm}-${dd}`;

  // Selecciona line items que tengan esa fecha exacta; fallback: los que tengan alguna fecha; si no, todos
  const linesWithDates = lineItems.map((li) => {
    const p = li.properties || {};
    const dates = [];
    if (p.fecha_inicio_de_facturacion) {
      dates.push(p.fecha_inicio_de_facturacion.toString().split('T')[0]);
    }
    for (let i = 2; i <= 48; i++) {
      const key = `fecha_${i}`;
      if (p[key]) dates.push(p[key].toString().split('T')[0]);
    }
    return { li, dates };
  });
  let relevant = [];
  for (const { li, dates } of linesWithDates) {
    if (dates.includes(nextDateIso)) relevant.push(li);
  }
  if (!relevant.length) {
    const withAnyDates = linesWithDates.filter((x) => x.dates.length).map((x) => x.li);
    relevant = withAnyDates.length ? withAnyDates : lineItems;
  }

  // Construye texto por cada línea relevante
  const parts = relevant.map((li) => {
    const p = li.properties || {};
    const counters = computeBillingCountersForLineItem(li, nextDate);
    const cuotaActual = counters.avisos_emitidos_facturacion + 1;
    const totalCuotas = counters.facturacion_total_avisos;
    const nombreProducto = p.name || 'Producto sin nombre';
    const qty = Number(p.quantity || 1);
    const unitPrice = Number(p.price || 0);
    const importe = qty * unitPrice;
    return `${nombreProducto}: cuota ${cuotaActual} de ${totalCuotas} — Importe estimado ${importe.toFixed(
      2
    )} ${moneda}`;
  });
  return parts.join('\n');
}

/**
 * Determina la frecuencia de facturación a nivel negocio según los line items.
 */
function deriveDealBillingFrequency(lineItems) {
  let hasRecurrent = false;
  let hasIrregular = false;
  let hasOneTime = false;
  for (const li of lineItems) {
    const freq = (li.properties?.frecuencia_de_facturacion || '').toString().trim().toLowerCase();
    if (['mensual', 'bimestral', 'trimestral', 'semestral', 'anual'].includes(freq)) {
      hasRecurrent = true;
    } else if (
      freq === 'única' ||
      freq === 'unica' ||
      freq === 'pago único' ||
      freq === 'pago unico'
    ) {
      hasOneTime = true;
    } else if (freq === 'irregular') {
      hasIrregular = true;
    }
  }
  if (hasRecurrent) return 'Recurrente';
  if (hasIrregular) return 'Irregular';
  if (hasOneTime) return 'Pago Único';
  return null;
}

/**
 * Ejecuta la Fase 1 para un negocio.
 *
 * @param {string} dealId
 * @returns {Promise<Object>} Resumen con fechas y estado.
 */
export async function runPhase1(dealId) {
  if (!dealId) throw new Error('runPhase1 requiere un dealId');
  // Obtener negocio y line items
  const { deal, lineItems } = await getDealWithLineItems(dealId);
  const dealProps = deal.properties || {};

  // 1. Mirroring (si corresponde)
  try {
    await mirrorDealToUruguay(dealId);
  } catch (err) {
    console.error('[phase1] Error en mirrorDealToUruguay:', err?.response?.body || err);
  }

  if (!lineItems || !lineItems.length) {
    return {
      dealId,
      dealName: dealProps.dealname,
      skipped: true,
      reason: 'sin line items',
    };
  }

  // 2. Recalcular calendarios y contadores por línea
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (const li of lineItems) {
    try {
      // recalcular calendario (irregular/recurrente/pago único)
      await updateLineItemSchedule(li);
    } catch (err) {
      console.error('[phase1] Error en updateLineItemSchedule para line item', li.id, err);
    }
  }

  // Calcular contadores y actualizar en HubSpot
  for (const li of lineItems) {
    const counters = computeBillingCountersForLineItem(li, today);
    const updateProps = {
      facturacion_total_avisos: String(counters.facturacion_total_avisos),
      avisos_emitidos_facturacion: String(counters.avisos_emitidos_facturacion),
      avisos_restantes_facturacion: String(counters.avisos_restantes_facturacion),
    };
    li.properties = { ...(li.properties || {}), ...updateProps };
    await hubspotClient.crm.lineItems.basicApi.update(String(li.id), { properties: updateProps });

    // Inicializar cupo de la línea
    try {
      await initLineItemCupo(li);
    } catch (err) {
      console.error('[phase1] Error en initLineItemCupo para line item', li.id, err);
    }
  }

  // 3. Calcular próxima y última fecha de facturación
  const nextBillingDate = computeNextBillingDateFromLineItems(lineItems, today);
  const lastBillingDate = computeLastBillingDateFromLineItems(lineItems, today);

  let effectiveNext = nextBillingDate;
  let effectiveLast = lastBillingDate;
  if (nextBillingDate && nextBillingDate.getTime() < today.getTime()) {
    effectiveLast = nextBillingDate;
    effectiveNext = null;
  }

  // Si facturacion_activa es false -> no programar avisos
  if (!parseBoolFromHubspot(dealProps.facturacion_activa)) {
    return {
      dealId,
      dealName: dealProps.dealname,
      skipped: true,
      reason: 'facturacion_activa es false; solo se recalcularon calendarios',
      nextBillingDate: nextBillingDate ? nextBillingDate.toISOString().slice(0, 10) : null,
      lastBillingDate: lastBillingDate ? lastBillingDate.toISOString().slice(0, 10) : null,
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

  // Construir mensaje de próxima facturación
  let message = '';
  let nextDateStr = '';
  if (effectiveNext) {
    message = buildNextBillingMessage({
      deal,
      nextDate: effectiveNext,
      lineItems,
    });
    const y = effectiveNext.getFullYear();
    const m = String(effectiveNext.getMonth() + 1).padStart(2, '0');
    const d = String(effectiveNext.getDate()).padStart(2, '0');
    nextDateStr = `${y}-${m}-${d}`;
  }
  let lastDateStr = '';
  if (effectiveLast) {
    const y = effectiveLast.getFullYear();
    const m = String(effectiveLast.getMonth() + 1).padStart(2, '0');
    const d = String(effectiveLast.getDate()).padStart(2, '0');
    lastDateStr = `${y}-${m}-${d}`;
  }

  // Derivar tipo de facturación a nivel negocio
  const dealBillingFrequency = deriveDealBillingFrequency(lineItems);

  // Actualizar propiedades de cupo a nivel negocio
  await updateDealCupo(dealId, lineItems);

  // Construir body de actualización del negocio
  const updateBody = {
    properties: {
      facturacion_proxima_fecha: nextDateStr || null,
      facturacion_ultima_fecha: lastDateStr || null,
      facturacion_mensaje_proximo_aviso: message || '',
      facturacion_frecuencia_de_facturacion: dealBillingFrequency || null,
    },
  };
  await hubspotClient.crm.deals.basicApi.update(String(dealId), updateBody);

  return {
    dealId,
    dealName: dealProps.dealname,
    nextBillingDate: nextDateStr || null,
    lastBillingDate: lastDateStr || null,
    lineItemsCount: lineItems.length,
    facturacion_frecuencia_de_facturacion: dealBillingFrequency,
  };
}
