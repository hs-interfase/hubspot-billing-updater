// src/processDeal.js
import { hubspotClient, getDealWithLineItems } from './hubspotClient.js';
import {
  updateLineItemSchedule,
  computeNextBillingDateFromLineItems,
    computeLastBillingDateFromLineItems,
  computeLineItemCounters,
} from './billingEngine.js';


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
 * Construye el mensaje de facturación en base a:
 * - Negocio
 * - Próxima fecha de facturación
 * - Line items
 *
 * Solo incluye las líneas que tienen esa fecha como próxima
 * (en fecha_inicio_de_facturacion o en alguna fecha_N).
 */
function buildNextBillingMessage({ deal, nextDate, lineItems }) {
  const props = deal.properties || {};
  const moneda = props.deal_currency_code || '(sin definir)';
  const notaNegocio = props.nota || null;

  const yyyy = nextDate.getFullYear();
  const mm = String(nextDate.getMonth() + 1).padStart(2, '0');
  const dd = String(nextDate.getDate()).padStart(2, '0');
  const nextDateIso = `${yyyy}-${mm}-${dd}`;

  // 1) Buscar las líneas que tengan esa fecha en su calendario
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

  // 2) Si ninguna coincide EXACTAMENTE, usamos las que tengan alguna fecha;
  //    si ni siquiera eso, usamos todos los line items.
  if (!relevantLineItems.length) {
    const withAnyDates = linesWithDates
      .filter((x) => x.dates.length)
      .map((x) => x.li);
    relevantLineItems = withAnyDates.length ? withAnyDates : lineItems;
  }

  const lineBlocks = relevantLineItems.map((li, idx) =>
    [
      `------------------------------`,
      buildLineItemBlock(li, idx + 1, moneda, notaNegocio),
    ].join('\n')
  );

  return lineBlocks.join('\n\n');
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

  if (!lineItems.length) {
    // Sin líneas, no hay nada que programar
    return {
      dealId,
      dealName: dealProps.dealname,
      skipped: true,
      reason: 'sin line items',
    };
  }

  // 1) SIEMPRE: recalcular calendario de líneas recurrentes.
  //    Esto debe ocurrir independientemente de facturacion_activa,
  //    para que los importados queden coherentes (fecha_2, fecha_3, total_de_pagos, etc.).
  for (const li of lineItems) {
    const freq = li.properties?.frecuencia_de_facturacion;

    if (isRecurrent(freq)) {
      await updateLineItemSchedule(li);

      // IMPORTANTE:
      // updateLineItemSchedule debe actualizar también lineItem.properties en memoria:
      // lineItem.properties = { ...lineItem.properties, ...updates }
      // para que a partir de acá las funciones "vean" las nuevas fechas.
    } else if (isIrregular(freq)) {
      // Irregular: NO tocamos fechas_2..N (se manejan a mano)
    } else {
      // Pago único u otros: por ahora no recalculamos nada especial
    }
  }

  // 2) Calcular próxima y última fecha de facturación a partir de TODAS las líneas.
  //    Usa fecha_inicio + fecha_2…fecha_48.
  // Suponiendo que ya tienes "lineItems" como array de line items del deal
const today = new Date();
  today.setHours(0, 0, 0, 0);

for (const item of lineItems) {
  const counters = computeLineItemCounters(item, today);

  // Prepara el objeto de propiedades a actualizar.
  const updateProperties = {
    facturacion_total_avisos: String(counters.totalAvisos),
    avisos_emitidos_facturacion: String(counters.avisosEmitidos),
    avisos_restantes_facturacion: String(counters.avisosRestantes)
  };

  // Actualiza las propiedades del line item en HubSpot
  // Ajusta la llamada según tu cliente/servicio; aquí se usa el cliente oficial
  await hubspotClient.crm.lineItems.basicApi.update(item.id, {
    properties: updateProperties
  });
}


  const nextBillingDate = computeNextBillingDateFromLineItems(lineItems, today);
  const lastBillingDate = computeLastBillingDateFromLineItems(lineItems, today); // <-- función nueva en billingEngine.js

  // 3) Si la facturación NO está activa:
  //    dejamos solo recalculados los calendarios de line items y NO tocamos el negocio.
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

  // 4) Si está activa y no hay ni fechas futuras ni pasadas, algo está raro.
  if (!nextBillingDate && !lastBillingDate) {
    return {
      dealId,
      dealName: dealProps.dealname,
      skipped: true,
      reason: 'sin fechas útiles (contrato completado o mal configurado)',
    };
  }

  // 5) Construir mensaje SOLO si hay próxima fecha.
  let message = '';
  let nextDateStr = '';

  if (nextBillingDate) {
    message = buildNextBillingMessage({
      deal,
      nextDate: nextBillingDate,
      lineItems,
    });

    const yyyy = nextBillingDate.getFullYear();
    const mm = String(nextBillingDate.getMonth() + 1).padStart(2, '0');
    const dd = String(nextBillingDate.getDate()).padStart(2, '0');
    nextDateStr = `${yyyy}-${mm}-${dd}`;
  }

  // 6) Última fecha de facturación (la mayor < hoy entre todas las fechas)
  let lastDateStr = '';
  if (lastBillingDate) {
    const yyyyL = lastBillingDate.getFullYear();
    const mmL = String(lastBillingDate.getMonth() + 1).padStart(2, '0');
    const ddL = String(lastBillingDate.getDate()).padStart(2, '0');
    lastDateStr = `${yyyyL}-${mmL}-${ddL}`;
  }

  // 7) Derivar facturacion_frecuencia_de_facturacion a nivel negocio según los line items.
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

  

  // 8) Actualizar negocio (solo si facturacion_activa es true, ya estamos en esa rama).
  const updateBody = {
    properties: {
      facturacion_proxima_fecha: nextDateStr,                  // puede ir vacío si ya no hay futuras
      facturacion_mensaje_proximo_aviso: message,              // vacío si no hay próxima
      facturacion_ultima_fecha: lastDateStr,                   // <-- AJUSTA el nombre a la propiedad real
      facturacion_frecuencia_de_facturacion: dealBillingFrequency,
    },
  };

  await hubspotClient.crm.deals.basicApi.update(dealId, updateBody);


  
  // 9) Resumen
  return {
    dealId,
    dealName: dealProps.dealname,
    nextBillingDate: nextDateStr || null,
    lastBillingDate: lastDateStr || null,
    lineItemsCount: lineItems.length,
    facturacion_frecuencia_de_facturacion: dealBillingFrequency,
  };
}

