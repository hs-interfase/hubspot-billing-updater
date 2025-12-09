import { hubspotClient, getDealWithLineItems } from './hubspotClient.js';
import { createBillingTicketForDeal } from './tickets.js';
import { mirrorDealToUruguay } from './dealMirroring.js';
import {
  updateLineItemSchedule,
  computeNextBillingDateFromLineItems,
  computeLastBillingDateFromLineItems,
  computeBillingCountersForLineItem,
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

/**
 * Devuelve un objeto con meses y días para intervalos de facturación nativos.
 * Soporta valores como "weekly", "biweekly", "monthly", "quarterly", "semiannual",
 * "annual", "2 years", "3 years", etc. También maneja equivalentes en español.
 *
 * Si no reconoce la frecuencia, devuelve { months: 0, days: 0 }.
 */
function getNativeInterval(freqRaw) {
  const f = (freqRaw ?? '').toString().trim().toLowerCase();
  switch (f) {
    case 'weekly':
    case 'semanal':
      return { months: 0, days: 7 };
    case 'biweekly':
    case 'every 2 weeks':
    case 'cada dos semanas':
    case 'quincenal':
      return { months: 0, days: 14 };
    case 'monthly':
    case 'mensual':
      return { months: 1, days: 0 };
    case 'quarterly':
    case 'trimestral':
      return { months: 3, days: 0 };
    case 'semiannual':
    case 'semi-annual':
    case 'semi annual':
    case 'semestral':
      return { months: 6, days: 0 };
    case 'annual':
    case 'annually':
    case 'yearly':
    case 'anual':
      return { months: 12, days: 0 };
    case '2 years':
    case '2 años':
    case '2 anios':
    case 'cada 2 años':
    case 'cada dos años':
      return { months: 24, days: 0 };
    case '3 years':
    case '3 años':
    case '3 anios':
    case 'cada 3 años':
      return { months: 36, days: 0 };
    case '4 years':
    case '4 años':
    case '4 anios':
    case 'cada 4 años':
      return { months: 48, days: 0 };
    case '5 years':
    case '5 años':
    case '5 anios':
    case 'cada 5 años':
      return { months: 60, days: 0 };
    default:
      // One-time o irregular no tienen recurrencia
      return { months: 0, days: 0 };
  }
}

/**
 * Suma un intervalo (meses y/o días) a una fecha.
 * Preserva el día del mes cuando sea posible (maneja meses de distinta longitud).
 */
function addInterval(date, interval) {
  let d = new Date(date.getTime());
  // sumar meses
  if (interval.months && interval.months > 0) {
    const day = d.getDate();
    d.setMonth(d.getMonth() + interval.months);
    // ajustar al último día del mes si fuera necesario
    if (d.getDate() < day) {
      d.setDate(0);
    }
  }
  // sumar días
  if (interval.days && interval.days > 0) {
    d.setDate(d.getDate() + interval.days);
  }
  return d;
}

/**
 * Calcula todas las fechas de facturación futuras para un line item basado en las
 * propiedades nativas de suscripción de HubSpot. Solo devuelve fechas desde "today"
 * hasta "today + horizonDays".
 *
 * @param {Object} lineItem
 * @param {Object} options
 * @param {Date} [options.today] Fecha de referencia (defaults a hoy)
 * @param {number} [options.horizonDays] Número de días hacia adelante para calcular (defaults a 30)
 * @returns {Date[]} Array de fechas (objetos Date) dentro de la ventana
 */
function getUpcomingBillingDatesForLineItemNative(lineItem, options = {}) {
  const today = options.today ? new Date(options.today.getTime()) : new Date();
  today.setHours(0, 0, 0, 0);
  const horizonDays = options.horizonDays ?? 30;
  const horizonLimit = new Date(
    today.getTime() + horizonDays * 24 * 60 * 60 * 1000
  );
  const p = lineItem.properties || {};

  // Determinar fecha de inicio: usar preferentemente hs_recurring_billing_start_date o fallback a fecha_inicio_de_facturacion
  const startRaw =
    p.hs_recurring_billing_start_date ||
    p.billing_start_date ||
    p.fecha_inicio_de_facturacion;
  if (!startRaw) return [];
  const startDate = parseLocalDate(startRaw);
  if (!startDate) return [];
  startDate.setHours(0, 0, 0, 0);

  // Determinar frecuencia
  const freqRaw =
    p.hs_recurring_billing_frequency ||
    p.recurringbillingfrequency ||
    p.frecuencia_de_facturacion ||
    null;
  const interval = getNativeInterval(freqRaw);
  // Si no hay intervalo (0 meses y 0 días), no hay recurrencia
  if (!interval.months && !interval.days) {
    // Para "pago único", si la fecha de inicio es futura dentro del horizonte, devolverla
    if (
      startDate.getTime() >= today.getTime() &&
      startDate.getTime() <= horizonLimit.getTime()
    ) {
      return [startDate];
    }
    return [];
  }

  // Determinar número máximo de pagos
  let maxPayments = null;
  const numRaw =
    p.hs_recurring_billing_number_of_payments ||
    p.number_of_payments ||
    p.termino_a ||
    null;
  if (numRaw != null) {
    const n = Number(numRaw);
    if (Number.isFinite(n) && n > 0) {
      maxPayments = n;
    }
  }

  // Determinar término: fijo vs auto-renovación
  const termsRaw =
    p.hs_recurring_billing_terms ||
    p.billing_terms ||
    p.contrato_a ||
    '';
  const termsLower = termsRaw.toString().toLowerCase();
  const isFixed =
    termsLower.includes('fijo') ||
    termsLower.includes('fixed') ||
    termsLower.includes('número');

  const dates = [];
  let current = startDate;
  let count = 0;
  while (current.getTime() <= horizonLimit.getTime()) {
    if (current.getTime() >= today.getTime()) {
      dates.push(new Date(current.getTime()));
    }
    count++;
    if (isFixed && maxPayments != null && count >= maxPayments) {
      break;
    }
    const nextDate = addInterval(current, interval);
    // Protección ante intervalos no válidos
    if (!nextDate || nextDate.getTime() === current.getTime()) {
      break;
    }
    current = nextDate;
  }
  return dates;
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


export async function processDeal(dealId) {
  if (!dealId) {
    throw new Error('processDeal requiere un dealId');
  }

  const { deal, lineItems } = await getDealWithLineItems(dealId);
  const dealProps = deal.properties || {};

  // 0) Si el negocio está pausado → desactivar facturación
  try {
    const pausaVal =
      dealProps.pausa !== undefined
        ? dealProps.pausa
        : dealProps.Pausa !== undefined
        ? dealProps.Pausa
        : null;
    if (pausaVal !== null && parseBoolFromHubspot(pausaVal)) {
      if (parseBoolFromHubspot(dealProps.facturacion_activa)) {
        await hubspotClient.crm.deals.basicApi.update(dealId, {
          properties: { facturacion_activa: 'false' },
        });
        dealProps.facturacion_activa = 'false';
      }
    }
  } catch (err) {
    console.error('ERROR actualizando facturacion_activa por pausa:', err);
  }

  // 🔁 Mirroring ANTES de la lógica de facturación
  try {
    console.log(
      ' → Ejecutando mirrorDealToUruguay (antes de facturación) para deal',
      dealId
    );
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

  // 1) SIEMPRE: recalcular calendario de líneas recurrentes según tu lógica actual
  for (const li of lineItems) {
    const freq = li.properties?.frecuencia_de_facturacion;
    if (isRecurrent(freq)) {
      await updateLineItemSchedule(li);
      // updateLineItemSchedule actualiza también lineItem.properties en memoria
    } else if (isIrregular(freq)) {
      // Irregular: NO tocamos fechas_2..N (se manejan a mano)
    } else {
      // Pago único u otros: por ahora no recalculamos nada especial
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
      avisos_emitidos_facturacion: String(
        counters.avisos_emitidos_facturacion
      ),
      avisos_restantes_facturacion: String(
        counters.avisos_restantes_facturacion
      ),
    };
    // Actualizar en memoria
    li.properties = { ...(li.properties || {}), ...updateProps };
    // Actualizar en HubSpot
    await hubspotClient.crm.lineItems.basicApi.update(li.id, {
      properties: updateProps,
    });
  }

  // 4) Calcular próxima y última fecha de facturación a partir de TODAS las líneas.
  const nextBillingDate = computeNextBillingDateFromLineItems(lineItems, today);
  const lastBillingDate = computeLastBillingDateFromLineItems(lineItems, today);

  // 5) Si la facturación NO está activa, no programamos más
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

  // 8) Última fecha de facturación (la mayor < hoy entre todas las fechas)
  let lastDateStr = '';
  if (lastBillingDate) {
    const yyyyL = lastBillingDate.getFullYear();
    const mmL = String(lastBillingDate.getMonth() + 1).padStart(2, '0');
    const ddL = String(lastBillingDate.getDate()).padStart(2, '0');
    lastDateStr = `${yyyyL}-${mmL}-${ddL}`;
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

  // 10) Actualizar negocio con próxima y última fecha / frecuencia
  const updateBody = {
    properties: {
      facturacion_proxima_fecha: nextDateStr,
      facturacion_mensaje_proximo_aviso: message,
      facturacion_ultima_fecha: lastDateStr,
      facturacion_frecuencia_de_facturacion: dealBillingFrequency,
    },
  };

  await hubspotClient.crm.deals.basicApi.update(dealId, updateBody);

  // 11) Crear tickets de facturación para todas las fechas dentro de los próximos 30 días.
  try {
    const horizon = 30;
    // Recopilar todas las fechas próximas por línea (usando propiedades nativas)
    const upcomingMap = new Map(); // isoDate -> Date object
    for (const li of lineItems) {
      const upcomingList = getUpcomingBillingDatesForLineItemNative(li, {
        today,
        horizonDays: horizon,
      });
      for (const d of upcomingList) {
        const iso = d.toISOString().slice(0, 10);
        if (!upcomingMap.has(iso)) {
          upcomingMap.set(iso, d);
        }
      }
    }
    // Ordenar fechas
    const upcomingDates = Array.from(upcomingMap.values()).sort(
      (a, b) => a - b
    );
    for (const dNext of upcomingDates) {
      // Construir mensaje específico para esa fecha
      const mensajeFecha = buildNextBillingMessage({
        deal,
        nextDate: dNext,
        lineItems,
      });
      await createBillingTicketForDeal(
        deal,
        lineItems,
        {
          proximaFecha: dNext,
          mensaje: mensajeFecha,
        },
        {
          DRY_RUN: process.env.DRY_RUN === 'true',
        }
      );
    }
  } catch (err) {
    console.error(
      'ERROR creando tickets de facturación para próximos 30 días:',
      err
    );
  }

  // 12) Resumen
  return {
    dealId,
    dealName: dealProps.dealname,
    nextBillingDate: nextDateStr || null,
    lastBillingDate: lastDateStr || null,
    lineItemsCount: lineItems.length,
    facturacion_frecuencia_de_facturacion: dealBillingFrequency,
  };
}

