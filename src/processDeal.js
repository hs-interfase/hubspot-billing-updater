import { hubspotClient, getDealWithLineItems } from './hubspotClient.js';
import { syncLineItemTicketsForDeal } from './tickets.js';
import { mirrorDealToUruguay } from './dealMirroring.js';
import {
  updateLineItemSchedule,
  computeNextBillingDateFromLineItems,
  computeLastBillingDateFromLineItems,
  computeBillingCountersForLineItem,
} from './billingEngine.js';
import { updateBagFieldsForLineItem } from './bagEngine.js';
// -----------------------------
// Helpers de formato / texto
// -----------------------------

function formatMoney(value, currency) {
  const num = Number(value);
  if (Number.isNaN(num)) return `no definido ${currency || ''}`.trim();
  return `${num.toFixed(2)} ${currency || ''}`.trim();
}

function buildLineItemBlock(li, idx, moneda, notaNegocio) {
  const p = li.properties || {};
  const nombreProducto = p.name || `Línea ${idx + 1}`;
  const servicio = p.servicio || '(servicio no definido)';
  const frecuencia =
    p.frecuencia_de_facturacion ||
    p.facturacion_frecuencia_de_facturacion ||
    'no definida';

  // Fecha de inicio de facturación (solo para mostrar en texto)
  let inicioLineaTexto = 'no definida';
  if (p.fecha_inicio_de_facturacion) {
    const str = p.fecha_inicio_de_facturacion.toString().trim();
    const m = str.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) {
      const [_, y, mm, dd] = m;
      inicioLineaTexto = `${dd}/${mm}/${y}`;
    } else {
      const d = new Date(str);
      if (!Number.isNaN(d.getTime())) {
        const y = d.getFullYear();
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        inicioLineaTexto = `${dd}/${mm}/${y}`;
      }
    }
  }

  // Contrato / término
  const contratoA = p.contrato_a || '(sin definir)';
  const terminoA = p.termino_a || '(sin definir)';
  let duracion = 'no definida';

  if (contratoA !== '(sin definir)' && terminoA !== '(sin definir)') {
    duracion = `${contratoA} / ${terminoA}`;
  } else if (contratoA !== '(sin definir)') {
    duracion = `${contratoA}`;
  } else if (terminoA !== '(sin definir)') {
    duracion = `${terminoA}`;
  }

  const tercerosRaw = (p.terceros || '').toString().toLowerCase();
  const esTerceros =
    tercerosRaw === 'true' ||
    tercerosRaw === '1' ||
    tercerosRaw === 'sí' ||
    tercerosRaw === 'si' ||
    tercerosRaw === 'yes';
  const tercerosTexto = esTerceros ? 'Sí, facturación a terceros.' : 'No.';

  const notaLinea = p.nota;
  const notaLineaTexto = notaLinea ? `- Nota de la línea: ${notaLinea}` : null;

  const qty = Number(p.quantity || 1);
  const unitPrice = Number(p.price || 0);
  const total = qty * unitPrice;

  // Datos de pagos / término
  const recurringTerm = p.hs_recurring_billing_period; // "5", "12", "P12M", etc.
  const totalPagos = Number(p.total_de_pagos ?? 0);
  const pagosEmitidos = Number(p.pagos_emitidos ?? 0);
  const pagosRestantes = Number(p.pagos_restantes ?? 0);

  const parts = [
    `Servicio`,
    `- Producto: ${nombreProducto}`,
    `- Servicio: ${servicio}`,
    `- Frecuencia de facturación: ${frecuencia}`,
  ];

  if (inicioLineaTexto !== 'no definida') {
    parts.push(`- Fecha de inicio de facturación: ${inicioLineaTexto}`);
  }
  if (duracion !== 'no definida') {
    parts.push(`- Duración del contrato: ${duracion}`);
  }

  // Bloque de debug visible
  parts.push(
    `- DEBUG contrato_a: ${contratoA}`,
    `- DEBUG termino_a: ${terminoA}`,
    `- DEBUG hs_recurring_billing_period: ${recurringTerm ?? '(sin definir)'}`,
    `- Pagos: ${pagosEmitidos} / ${totalPagos}`,
    `- Pagos restantes: ${pagosRestantes}`
  );

  parts.push(
    `- Facturación a terceros: ${tercerosTexto}`,
    `- Cantidad: ${qty}`,
    `- Precio unitario: ${formatMoney(unitPrice, moneda)}`,
    `- Importe total: ${formatMoney(total, moneda)}`
  );

  if (notaLineaTexto) parts.push(notaLineaTexto);
  if (notaNegocio) {
    parts.push(`- Nota del negocio: ${notaNegocio}`);
  }

  return parts.join('\n');
}

// -----------------------------
// Fechas por línea
// -----------------------------

function parseLocalDate(raw) {
  if (!raw) return null;
  const str = raw.toString().trim();

  const m = str.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    const year = Number(m[1]);
    const month = Number(m[2]); // 1-12
    const day = Number(m[3]); // 1-31
    return new Date(year, month - 1, day);
  }

  const d = new Date(str);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

/**
 * Devuelve todas las fechas de facturación de un line item como strings "YYYY-MM-DD",
 * usando fecha_inicio_de_facturacion y fecha_2…fecha_48.
 */
function collectBillingDateStringsForLineItem(lineItem) {
  const p = lineItem.properties || {};
  const out = [];

  const add = (raw) => {
    if (!raw) return;
    const d = parseLocalDate(raw);
    if (!d || Number.isNaN(d.getTime())) return;
    d.setHours(0, 0, 0, 0);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    out.push(`${y}-${m}-${dd}`);
  };

  add(p.fecha_inicio_de_facturacion);
  for (let i = 2; i <= 48; i++) {
    add(p[`fecha_${i}`]);
  }

  return out;
}

/**
 * Devuelve los line items “relevantes” para una fecha dada,
 * usando exactamente la misma lógica que buildNextBillingMessage:
 *  - primero los que tengan esa fecha exacta
 *  - si no hay, los que tengan alguna fecha
 *  - si no hay, todos
 */
function findRelevantLineItemsForDate(lineItems, targetDate) {
  if (!targetDate || !Array.isArray(lineItems)) return [];

  const yyyy = targetDate.getFullYear();
  const mm = String(targetDate.getMonth() + 1).padStart(2, '0');
  const dd = String(targetDate.getDate()).padStart(2, '0');
  const targetIso = `${yyyy}-${mm}-${dd}`;

  const linesWithDates = lineItems.map((li) => ({
    li,
    dates: collectBillingDateStringsForLineItem(li),
  }));

  let relevantLineItems = [];
  for (const { li, dates } of linesWithDates) {
    if (dates.includes(targetIso)) {
      relevantLineItems.push(li);
    }
  }

  // Fallback: mismas reglas que buildNextBillingMessage
  if (!relevantLineItems.length) {
    const withAnyDates = linesWithDates.filter((x) => x.dates.length).map((x) => x.li);
    relevantLineItems = withAnyDates.length ? withAnyDates : lineItems;
  }

  return relevantLineItems;
}

/**
 * Elige UN line item representativo para la próxima fecha de facturación:
 *  - Prioriza el que tenga aplica_cupo.
 *  - Si ninguno tiene cupo, devuelve el primero.
 */
function pickLineItemForNextBilling(lineItems, nextDate) {
  const relevant = findRelevantLineItemsForDate(lineItems, nextDate);
  if (!relevant.length) return null;

  // Priorizar line item con aplica_cupo
  const withCupo = relevant.find((li) => {
    const aplica = (li.properties?.aplica_cupo || '').toString().trim();
    return !!aplica;
  });

  return withCupo || relevant[0];
}


/**
 * Construye el mensaje de facturación en base a:
 * - Negocio
 * - Próxima fecha de facturación
 * - Line items
 *
 * Solo incluye las líneas que tienen esa fecha como próxima.
 */
function buildNextBillingMessage({ deal, nextDate, lineItems }) {
  const props = deal.properties || {};
  const moneda = props.deal_currency_code || '(sin definir)';
  const yyyy = nextDate.getFullYear();
  const mm = String(nextDate.getMonth() + 1).padStart(2, '0');
  const dd = String(nextDate.getDate()).padStart(2, '0');
  const nextDateIso = `${yyyy}-${mm}-${dd}`;

  // Encontrar líneas relevantes (las que tienen la fecha exacta en su calendario)
  const linesWithDates = lineItems.map((li) => ({
    li,
    dates: collectBillingDateStringsForLineItem(li),
  }));

  let relevantLineItems = [];
  for (const { li, dates } of linesWithDates) {
    if (dates.includes(nextDateIso)) {
      relevantLineItems.push(li);
    }
  }
  // Fallback: si ninguna coincide exactamente, usa las que tengan alguna fecha; si aún no, usa todas.
  if (!relevantLineItems.length) {
    const withAnyDates = linesWithDates.filter((x) => x.dates.length).map((x) => x.li);
    relevantLineItems = withAnyDates.length ? withAnyDates : lineItems;
  }

  // Construir el texto por cada línea relevante
  const parts = relevantLineItems.map((li) => {
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

// -----------------------------
// Helpers de tipo de frecuencia
// -----------------------------

function normalizeFreq(raw) {
  return (raw ?? '').toString().trim().toLowerCase();
}

function isIrregular(freqRaw) {
  return normalizeFreq(freqRaw) === 'irregular';
}

function isOneTime(freqRaw) {
  const f = normalizeFreq(freqRaw);
  return (
    f === 'única' ||
    f === 'unica' ||
    f === 'pago único' ||
    f === 'pago unico'
  );
}

function isRecurrent(freqRaw) {
  const f = normalizeFreq(freqRaw);
  return ['mensual', 'bimestral', 'trimestral', 'semestral', 'anual'].includes(
    f
  );
}

function parseBoolFromHubspot(raw) {
  const v = (raw ?? '').toString().toLowerCase();
  return v === 'true' || v === '1' || v === 'sí' || v === 'si' || v === 'yes';
}

// -----------------------------
// processDeal
// -----------------------------

export async function processDeal(dealId) {
  if (!dealId) {
    throw new Error('processDeal requiere un dealId');
  }

  const { deal, lineItems } = await getDealWithLineItems(dealId);
  const dealProps = deal.properties || {};

  // 🔁 Mirroring ANTES de la lógica de facturación
  try {
    console.log(' → Ejecutando mirrorDealToUruguay (antes de facturación) para deal', dealId);
    const mirrorResult = await mirrorDealToUruguay(dealId);
    console.log('   Resultado mirrorDealToUruguay:', mirrorResult);
  } catch (err) {
    console.error(
      '   ERROR en mirrorDealToUruguay:',
      err.response?.body || err
    );
  }

  if (!lineItems.length) {
    // Sin líneas, no hay nada que programar
    return {
      dealId,
      dealName: dealProps.dealname,
      skipped: true,
      reason: 'sin line items',
    };
  }


  // El propio billingEngine decide si es irregular, pago único, etc.
for (const li of lineItems) {
  try {
    console.log('[processDeal] Recalculando calendario para line item', {
      lineItemId: li.id,
      name: li.properties?.name,
      frecuencia_de_facturacion: li.properties?.frecuencia_de_facturacion,
      hs_recurring_billing_frequency: li.properties?.hs_recurring_billing_frequency,
      hs_recurring_billing_number_of_payments:
        li.properties?.hs_recurring_billing_number_of_payments,
      hs_recurring_billing_start_date:
        li.properties?.hs_recurring_billing_start_date,
    });

    await updateLineItemSchedule(li); // <-- SIEMPRE
  } catch (err) {
    console.error(
      '[processDeal] Error en updateLineItemSchedule para LI',
      li.id,
      err?.response?.data || err.message,
    );
  }
}


  // 2) Definir la fecha de referencia (hoy a medianoche)
  const today = new Date();
  today.setHours(0, 0, 0, 0);

// 3) Calcular y actualizar contadores por línea
for (const li of lineItems) {
  const counters = computeBillingCountersForLineItem(li, today);
  const updateProps = {
    facturacion_total_avisos: String(counters.facturacion_total_avisos),
    avisos_emitidos_facturacion: String(counters.avisos_emitidos_facturacion),
    avisos_restantes_facturacion: String(counters.avisos_restantes_facturacion),
  };

  // Actualizar en memoria
  li.properties = { ...(li.properties || {}), ...updateProps };

  // Actualizar en HubSpot (contadores de facturación)
  await hubspotClient.crm.lineItems.basicApi.update(li.id, {
    properties: updateProps,
  });

  try {
    await updateBagFieldsForLineItem(li, today);
  } catch (err) {
    console.error(
      '[processDeal] Error en updateBagFieldsForLineItem para LI',
      li.id,
      err?.response?.body || err?.message || err
    );
  }
}

  // 4) Calcular próxima y última fecha de facturación a partir de TODAS las líneas.
  const nextBillingDate = computeNextBillingDateFromLineItems(lineItems, today);
  const lastBillingDate = computeLastBillingDateFromLineItems(lineItems, today);

  // --- Ajuste de coherencia ---
  // Si la próxima fecha calculada ya es pasada (menor que hoy),
  // la tratamos como última fecha y dejamos próxima en null.
  let effectiveNextBillingDate = nextBillingDate;
  let effectiveLastBillingDate = lastBillingDate;

  if (nextBillingDate && nextBillingDate.getTime() < today.getTime()) {
    effectiveLastBillingDate = nextBillingDate;
    effectiveNextBillingDate = null;
  }

  // 5) Si la facturación NO está activa:
  if (!parseBoolFromHubspot(dealProps.facturacion_activa)) {
    return {
      dealId,
      dealName: dealProps.dealname,
      skipped: true,
      reason:
        'facturacion_activa es false (solo se recalcularon calendarios de line items)',
      nextBillingDate: nextBillingDate
        ? nextBillingDate.toISOString().slice(0, 10)
        : null,
      lastBillingDate: lastBillingDate
        ? lastBillingDate.toISOString().slice(0, 10)
        : null,
    };
  }

  // 6) Si está activa y no hay ni fechas futuras ni pasadas, algo está raro.
  if (!nextBillingDate && !lastBillingDate) {
    return {
      dealId,
      dealName: dealProps.dealname,
      skipped: true,
      reason: 'sin fechas útiles (contrato completado o mal configurado)',
    };
  }

  // 7) Construir mensaje SOLO si hay próxima fecha.
  let message = '';
  let nextDateStr = '';
  if (effectiveNextBillingDate) {
    message = buildNextBillingMessage({
      deal,
      nextDate: effectiveNextBillingDate,
      lineItems,
    });
    const yyyy = effectiveNextBillingDate.getFullYear();
    const mm = String(effectiveNextBillingDate.getMonth() + 1).padStart(2, '0');
    const dd = String(effectiveNextBillingDate.getDate()).padStart(2, '0');
    nextDateStr = `${yyyy}-${mm}-${dd}`;
  }

  // 8) Última fecha de facturación (la mayor < hoy entre todas las fechas)
  let lastDateStr = '';
  if (effectiveLastBillingDate) {
    const yyyyL = effectiveLastBillingDate.getFullYear();
    const mmL = String(effectiveLastBillingDate.getMonth() + 1).padStart(2, '0');
    const ddL = String(effectiveLastBillingDate.getDate()).padStart(2, '0');
    lastDateStr = `${yyyyL}-${mmL}-${ddL}`;
  }
  
  // 7bis) Info de bolsa ligada a la próxima fecha
  let facturacionTieneBolsa = null;   // null = limpiar en HubSpot
  let pmAsignadoParaBolsa = null;

if (nextBillingDate) {
    const liForNext = pickLineItemForNextBilling(lineItems, nextBillingDate);

    if (liForNext) {
      const aplicaCupo = (liForNext.properties?.aplica_cupo || '').toString().trim();
      if (aplicaCupo) {
        facturacionTieneBolsa = 'true'; // HubSpot espera 'true'/'false' como string
        pmAsignadoParaBolsa = liForNext.properties?.pm_asignado_bolsa || null;
      }

      console.log('[processDeal] Bolsa próxima fecha → LI', {
        dealId,
        lineItemId: liForNext.id,
        aplica_cupo: aplicaCupo,
        pm_asignado_bolsa: liForNext.properties?.pm_asignado_bolsa,
        pm_asignado_que_va_al_deal: pmAsignadoParaBolsa,
      });
    }
  }
  // 9) Derivar facturacion_frecuencia_de_facturacion a nivel negocio según los line items.
  let dealBillingFrequency = dealProps.facturacion_frecuencia_de_facturacion;

  const hasRecurrent = lineItems.some((li) =>
    isRecurrent(li.properties?.frecuencia_de_facturacion)
  );
  const hasIrregular = lineItems.some((li) =>
    isIrregular(li.properties?.frecuencia_de_facturacion)
  );
  const hasOneTime = lineItems.some((li) =>
    isOneTime(li.properties?.frecuencia_de_facturacion)
  );

  if (hasRecurrent) {
    dealBillingFrequency = 'Recurrente';
  } else if (hasIrregular) {
    dealBillingFrequency = 'Irregular';
  } else if (hasOneTime) {
    dealBillingFrequency = 'Pago Único';
  }

  if (nextBillingDate) {
    const liForNext = pickLineItemForNextBilling(lineItems, nextBillingDate);

    if (liForNext) {
      const aplicaCupo = (liForNext.properties?.aplica_cupo || '').toString().trim();
      if (aplicaCupo) {
        facturacionTieneBolsa = 'true'; // HubSpot espera 'true'/'false' como string
        pmAsignadoParaBolsa = liForNext.properties?.pm_asignado_bolsa || null;
      }

      console.log('[processDeal] Bolsa próxima fecha → LI', {
        dealId,
        lineItemId: liForNext.id,
        aplica_cupo: aplicaCupo,
        pm_asignado_bolsa: liForNext.properties?.pm_asignado_bolsa,
        pm_asignado_que_va_al_deal: pmAsignadoParaBolsa,
      });
    }
  }

  // 10) Armar body de actualización del negocio
  const updateBody = {
    properties: {
      // Fechas de facturación
      facturacion_proxima_fecha: nextDateStr || null,
      facturacion_ultima_fecha: lastDateStr || null,
      facturacion_mensaje_proximo_aviso: message || '',

      // Tipo de facturación
      facturacion_frecuencia_de_facturacion: dealBillingFrequency || null,

      // Info de bolsa para la próxima fecha
      facturacion_tiene_bolsa: facturacionTieneBolsa,
      pm_asignado: pmAsignadoParaBolsa,
    },
  };

  // 11) Actualizar negocio
  await hubspotClient.crm.deals.basicApi.update(dealId, updateBody);

  // 12) Sincronizar tickets por line item (ventana de 30 días)
  try {
    await syncLineItemTicketsForDeal({
      deal,
      lineItems,
      today,
    });
  } catch (err) {
    console.error(
      '[processDeal] Error al sincronizar tickets por line item',
      err?.response?.body || err?.message || err
    );
  }

  // 13) Resumen
  return {
    dealId,
    dealName: dealProps.dealname,
    nextBillingDate: nextDateStr || null,
    lastBillingDate: lastDateStr || null,
    lineItemsCount: lineItems.length,
    facturacion_frecuencia_de_facturacion: dealBillingFrequency,
  };
}
