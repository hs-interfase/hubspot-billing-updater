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
import {  updateBagFieldsForLineItem } from '../bagEngine.js';

function classifyLineItemFlow(li) {
  const p = li?.properties || {};

  // Irregular tiene prioridad
  const irregular = (p.facturacion_irregular ?? '').toString().toLowerCase();
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

    // 3) cupo por línea
    if (alsoInitCupo) {
      try {
        await updateBagFieldsForLineItem(li);
      } catch (err) {
        console.error('[phase1] Error en updateBagFieldsForLineItem para line item', li.id, err);
      }
    }
  }
}

export async function runPhase1(dealId) {
  if (!dealId) throw new Error('runPhase1 requiere un dealId');

  // Obtener negocio y line items
  const { deal, lineItems } = await getDealWithLineItems(dealId);
  const dealProps = deal.properties || {};

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

  // 2) Procesar negocio original: calendario + contadores + cupo por línea
  await processLineItemsForPhase1(lineItems, today, { alsoInitCupo: true });

// 2.1) Procesar espejo UY (si existe): calendario + contadores + cupo por línea
if (mirrorResult?.mirrored && mirrorResult?.targetDealId) {
  try {
    const { deal: mirrorDeal, lineItems: mirrorLineItems } =
      await getDealWithLineItems(mirrorResult.targetDealId);

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
