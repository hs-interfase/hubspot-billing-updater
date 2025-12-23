// src/billingEngine.js
import { hubspotClient } from './hubspotClient.js';

// -----------------------------
// Helpers de fechas / frecuencia
// -----------------------------

function parseLocalDate(raw) {
  if (!raw) return null;
  const str = raw.toString().trim();

  // Formato YYYY-MM-DD
  const m = str.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    const year = Number(m[1]);
    const month = Number(m[2]); // 1-12
    const day = Number(m[3]);   // 1-31
    return new Date(year, month - 1, day);
  }

  const d = new Date(str);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function formatDateISO(date) {
  const d = new Date(date.getTime());
  d.setHours(0, 0, 0, 0);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

/**
 * Devuelve un intervalo { months, days } a partir de una frecuencia textual.
 * Soporta tanto los valores nativos (en inglés) como tus labels en español.
 */
function getIntervalFromFrequency(freqRaw) {
  const f = (freqRaw ?? '').toString().trim().toLowerCase();

  // Mapeo por internal value de recurringbillingfrequency
  switch (f) {
    case 'weekly':
      return { months: 0, days: 7 };

    case 'biweekly':
      return { months: 0, days: 14 };

    case 'monthly':
      return { months: 1, days: 0 };

    case 'quarterly':
      return { months: 3, days: 0 };

    case 'per_six_months':
      return { months: 6, days: 0 };

    case 'annually':
      return { months: 12, days: 0 };

    case 'per_two_years':
      return { months: 24, days: 0 };

    case 'per_three_years':
      return { months: 36, days: 0 };

    case 'per_four_years':
      return { months: 48, days: 0 };

    case 'per_five_years':
      return { months: 60, days: 0 };
  }

  // Fallback a textos viejos por si aparecen en tus customs
  switch (f) {
    case 'week':
    case 'semanal':
      return { months: 0, days: 7 };

    case 'every 2 weeks':
    case 'cada dos semanas':
    case 'quincenal':
      return { months: 0, days: 14 };

    case 'month':
    case 'mensual':
      return { months: 1, days: 0 };

    case 'bimestral':
    case 'every 2 months':
      return { months: 2, days: 0 };

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

    default:
      return null;
  }
}

/**
 * Suma un intervalo (meses y/o días) a una fecha.
 * Preserva el día del mes cuando sea posible.
 */
function addInterval(date, interval) {
  let d = new Date(date.getTime());

  if (interval.months && interval.months > 0) {
    const day = d.getDate();
    d.setMonth(d.getMonth() + interval.months);
    // Ajuste para fines de mes (31 → 30/28, etc.)
    if (d.getDate() < day) {
      d.setDate(0);
    }
  }

  if (interval.days && interval.days > 0) {
    d.setDate(d.getDate() + interval.days);
  }

  return d;
}

/**
 * Lee las propiedades del line item y devuelve la configuración efectiva de facturación.
 * - Usa primero las propiedades nativas de HubSpot.
 * - Luego hace fallback a tu frecuencia custom SOLO para el intervalo.
 * - NO usa más total_de_pagos ni termino_a para calcular cuántas cuotas generar.
 */
function getEffectiveBillingConfig(lineItem) {
  const p = lineItem.properties || {};

  console.log('[getEffectiveBillingConfig][RAW]', {
    lineItemId: lineItem.id,
    name: p.name,
    recurringbillingfrequency: p.recurringbillingfrequency,
    hs_recurring_billing_frequency: p.hs_recurring_billing_frequency,
    hs_recurring_billing_start_date: p.hs_recurring_billing_start_date,
    hs_recurring_billing_number_of_payments:
      p.hs_recurring_billing_number_of_payments,
    hs_recurring_billing_period: p.hs_recurring_billing_period, // solo debug
    number_of_payments: p.number_of_payments,
    frecuencia_de_facturacion: p.frecuencia_de_facturacion,
    facturacion_irregular: p.facturacion_irregular,
  });

  // ¿Es irregular?
  const freqCustom = (p.frecuencia_de_facturacion ?? '')
    .toString()
    .trim()
    .toLowerCase();
  const irregularFlagRaw = (p.facturacion_irregular ?? '')
    .toString()
    .toLowerCase();

  const isIrregular =
    freqCustom === 'irregular' ||
    irregularFlagRaw === 'true' ||
    irregularFlagRaw === '1' ||
    irregularFlagRaw === 'sí' ||
    irregularFlagRaw === 'si' ||
    irregularFlagRaw === 'yes';

  // 🔑 Frecuencia efectiva (para el intervalo)
  const freqKey =
    p.recurringbillingfrequency ||              // internal values: monthly, weekly...
    p.hs_recurring_billing_frequency ||         // por si HS rellena esta
    p.frecuencia_de_facturacion ||              // tu campo custom
    '';

  const frequency = freqKey.toString().trim();
  const interval = getIntervalFromFrequency(frequency);

  // Fecha de inicio
  const startRaw =
    p.hs_recurring_billing_start_date ||
    p.billing_start_date ||
    p.fecha_inicio_de_facturacion;
  const startDate = parseLocalDate(startRaw);

  console.log('[getEffectiveBillingConfig][DATE]', {
    lineItemId: lineItem.id,
    startRaw,
    parsedStartDate: startDate ? formatDateISO(startDate) : null,
  });

  // Número de pagos
  const numRaw =
    p.hs_recurring_billing_number_of_payments || p.number_of_payments || null;

  console.log('[getEffectiveBillingConfig][NUM_RAW]', {
    lineItemId: lineItem.id,
    numRaw,
    typeofNumRaw: typeof numRaw,
  });

  let numberOfPayments = null;
  if (numRaw !== null && numRaw !== undefined && numRaw !== '') {
    const n = Number.parseInt(numRaw.toString().trim(), 10);
    if (Number.isFinite(n) && n > 0) {
      numberOfPayments = n;
    }
  }

  const maxOccurrences =
    numberOfPayments && Number.isFinite(numberOfPayments)
      ? numberOfPayments
      : 48;

  console.log('[getEffectiveBillingConfig][SUMMARY]', {
    lineItemId: lineItem.id,
    isIrregular,
    frequency,
    interval,
    startDate: startDate ? formatDateISO(startDate) : null,
    numberOfPayments,
    maxOccurrences,
  });

  return {
    isIrregular,
    frequency,
    interval,
    startDate,
    maxOccurrences,
  };
}

// Actualiza el calendario y contadores de un line item en HubSpot.
export async function updateLineItemSchedule(lineItem) {
  if (!lineItem || !lineItem.id) {
    console.warn('[updateLineItemSchedule] lineItem inválido:', lineItem);
    return lineItem;
  }

  const p = lineItem.properties || {};
  const config = getEffectiveBillingConfig(lineItem);
  const { isIrregular, interval, startDate, maxOccurrences } = config;

  // Helper: limpiar fechas_2..fecha_24 si quedaron de una config anterior
  const clearCalendarFields = (updatesObj) => {
    for (let i = 2; i <= 24; i++) {
      const key = `fecha_${i}`;
      if (p[key]) updatesObj[key] = '';
    }
  };

  // Caso 1: irregular → sincroniza solo la fecha de inicio (y limpia calendario recomendado)
  if (isIrregular) {
    // Si tu rama irregular hoy "no hace nada", al menos te recomiendo:
    // - setear hs_recurring_billing_start_date / fecha_inicio_de_facturacion si hay startDate
    // - limpiar fecha_2..fecha_24 (ajuste 2 aplicado también acá)
    if (startDate) {
      const iso = formatDateISO(startDate);
      const updatesIrregular = {
        hs_recurring_billing_start_date: iso,
      };
      if (Object.prototype.hasOwnProperty.call(p, 'fecha_inicio_de_facturacion')) {
        updatesIrregular.fecha_inicio_de_facturacion = iso;
      }
      clearCalendarFields(updatesIrregular);

      await hubspotClient.crm.lineItems.basicApi.update(lineItem.id, {
        properties: updatesIrregular,
      });
      lineItem.properties = { ...p, ...updatesIrregular };
    } else {
      // si no hay startDate, igual conviene limpiar calendario para no dejar basura
      const updatesIrregular = {};
      clearCalendarFields(updatesIrregular);
      if (Object.keys(updatesIrregular).length) {
        await hubspotClient.crm.lineItems.basicApi.update(lineItem.id, {
          properties: updatesIrregular,
        });
        lineItem.properties = { ...p, ...updatesIrregular };
      }
    }
    return lineItem;
  }

  // Caso 2: falta startDate → usar hoy como default SIN re-asignar constante
  let effectiveStart = startDate;
  if (!effectiveStart) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    effectiveStart = today;
    console.log('[updateLineItemSchedule] Sin fecha de inicio, usando hoy', {
      lineItemId: lineItem.id,
      today: formatDateISO(today),
      frequency: config.frequency,
    });
  }

  // Caso 3: no hay intervalo → pago único: sincroniza fecha inicio y limpia calendario (ajuste 2)
  if (!interval) {
    const iso = formatDateISO(effectiveStart);
    const updatesOneTime = {
      hs_recurring_billing_start_date: iso,
    };

    if (Object.prototype.hasOwnProperty.call(p, 'fecha_inicio_de_facturacion')) {
      updatesOneTime.fecha_inicio_de_facturacion = iso;
    }

    // ✅ Ajuste 2: limpiar fechas_2..fecha_24 para evitar tickets fantasma
    clearCalendarFields(updatesOneTime);

    await hubspotClient.crm.lineItems.basicApi.update(lineItem.id, {
      properties: updatesOneTime,
    });

    lineItem.properties = { ...p, ...updatesOneTime };
    return lineItem;
  }

  // Generar calendario para recurrentes
  const dates = [];
  let current = new Date(effectiveStart.getTime());
  current.setHours(0, 0, 0, 0);

  for (let i = 0; i < maxOccurrences && i < 48; i++) {
    dates.push(new Date(current.getTime()));
    const next = addInterval(current, interval);
    if (!next || next.getTime() === current.getTime()) break;
    current = next;
  }

  if (!dates.length) {
    console.log('[updateLineItemSchedule] No se generaron fechas', lineItem.id);
    return lineItem;
  }

  const isoDates = dates.map((d) => formatDateISO(d));

  const updatesRecurring = {
    hs_recurring_billing_start_date: isoDates[0],
  };

  if (Object.prototype.hasOwnProperty.call(p, 'fecha_inicio_de_facturacion')) {
    updatesRecurring.fecha_inicio_de_facturacion = isoDates[0];
  }

  // fecha_2 … fecha_24 (tu realidad)
  for (let i = 1; i < 24; i++) {
    const key = `fecha_${i + 1}`;
    if (i < isoDates.length) {
      updatesRecurring[key] = isoDates[i];
    } else if (p[key]) {
      updatesRecurring[key] = '';
    }
  }

  console.log(
    '[updateLineItemSchedule] Calendario generado para lineItem',
    lineItem.id,
    'fechas:',
    isoDates,
    'updates:',
    updatesRecurring
  );

  await hubspotClient.crm.lineItems.basicApi.update(lineItem.id, {
    properties: updatesRecurring,
  });

  lineItem.properties = { ...p, ...updatesRecurring };
  return lineItem;
}

// Devuelve la próxima fecha de facturación para un line item.
// - Para regulares: usa el calendario calculado y el contador de pagos emitidos.
// - Para irregulares: toma la fecha inicial y fecha_2…fecha_48 introducidas manualmente.
 
function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

// Devuelve la última fecha de facturación (la mayor < today)
// usando todas las fechas de todos los line items
// (fecha_inicio_de_facturacion, fecha_2, fecha_3, ...).

export function computeLastBillingDateFromLineItems(
  lineItems,
  today = new Date()
) {
  const todayStart = startOfDay(today);
  let maxPast = null;

  for (const li of lineItems) {
    // Esta función ya existe en billingEngine porque la usa getNextBillingDateForLineItem
    const allDates = collectAllBillingDatesFromLineItem(li); // array de Date

    for (const d of allDates) {
      const dStart = startOfDay(d);

      // solo nos interesan fechas estrictamente en el pasado
      if (dStart.getTime() < todayStart.getTime()) {
        if (!maxPast || dStart.getTime() > maxPast.getTime()) {
          maxPast = dStart;
        }
      }
    }
  }

  return maxPast; // puede ser null si no hay fechas pasadas
}


function collectAllBillingDatesFromLineItem(lineItem) {
  const p = lineItem.properties || {};
  const dates = [];

  const add = (raw) => {
    if (!raw) return;
    const d = parseLocalDate(raw);
    if (!d || Number.isNaN(d.getTime())) return;
    d.setHours(0, 0, 0, 0);
    dates.push(d);
  };

  // fecha inicial: alias o nativa
  add(p.fecha_inicio_de_facturacion || p.hs_recurring_billing_start_date);

  // fechas 2..48 (tanto para recurrentes como para irregulares)
  for (let i = 2; i <= 48; i++) {
    add(p[`fecha_${i}`]);
  }

  dates.sort((a, b) => a - b);
  return dates;
}

export function getNextBillingDateForLineItem(lineItem, today = new Date()) {
  const p = lineItem.properties || {};

  // 1) Respetar contadores: si ya se hicieron todos los pagos, no hay próxima fecha
  const total = Number(p.total_de_pagos) || 0;
  const emitidos = Number(p.pagos_emitidos) || 0;

  if (total > 0 && emitidos >= total) {
    // contrato terminado para esta línea
    return null;
  }

  // 2) Lógica de fechas: elegir la MENOR fecha >= hoy (sin asumir orden)
  const todayStart = startOfDay(today);
  const allDates = collectAllBillingDatesFromLineItem(lineItem);

  if (!allDates.length) return null;

  let candidate = null;
  for (const d of allDates) {
    if (!(d instanceof Date) || Number.isNaN(d.getTime())) continue;
    if (d.getTime() < todayStart.getTime()) continue;

    if (!candidate || d.getTime() < candidate.getTime()) {
      candidate = d;
    }
  }

  return candidate; // puede ser null si todas quedaron en el pasado
}

export function computeNextBillingDateFromLineItems(lineItems, today = new Date()) {
  let minDate = null;

  for (const li of lineItems) {
    const next = getNextBillingDateForLineItem(li, today);
    if (!next) continue;

    if (!minDate || next < minDate) {
      minDate = next;
    }
  }

  return minDate; // puede ser null si no hay ninguna fecha futura
}

/**
 * Calcula los contadores de facturación para un line item.
 * - totalAvisos: total de fechas programadas (inicio + fechas_n).
 * - avisosEmitidos: número de fechas ya pasadas respecto de "today".
 * - avisosRestantes: totalAvisos - avisosEmitidos.
 * - proximaFecha: primera fecha futura o igual a today (puede usarse a nivel de deal).
 * - ultimaFecha: última fecha pasada (puede usarse a nivel de deal).
 *
 * @param {Object} lineItem - Objeto de line item proveniente de HubSpot.
 * @param {Date} [today] - Fecha de referencia (por defecto, hoy).
 * @returns {Object}
 */
export function computeLineItemCounters(lineItem, today = new Date()) {
  const props = lineItem.properties || {};
  const fechas = [];

  // Añadir la fecha de inicio de facturación
  if (props.fecha_inicio_de_facturacion) {
    const inicio = new Date(props.fecha_inicio_de_facturacion);
    if (!isNaN(inicio)) {
      fechas.push(inicio);
    }
  }

  // Recorrer las propiedades fecha_2 a fecha_48 y agregarlas si existen
  for (let i = 2; i <= 48; i++) {
    const key = `fecha_${i}`;
    const value = props[key];
    if (value) {
      const d = new Date(value);
      if (!isNaN(d)) {
        fechas.push(d);
      }
    }
  }

  // Ordenar las fechas de forma ascendente
  fechas.sort((a, b) => a - b);

  const totalAvisos = fechas.length;
  let avisosEmitidos = 0;
  let proximaFecha = null;
  let ultimaFecha = null;

  // Contabilizar cuántas fechas ya pasaron y cuál es la próxima
  for (const fecha of fechas) {
    if (fecha < today) {
      avisosEmitidos++;
      ultimaFecha = fecha;
    } else if (!proximaFecha) {
      proximaFecha = fecha;
    }
  }

  const avisosRestantes = totalAvisos - avisosEmitidos;

  return {
    totalAvisos,
    avisosEmitidos,
    avisosRestantes,
    proximaFecha,
    ultimaFecha
  };
}


/**
 * Calcula los contadores de facturación para un line item.
 *
 * - facturacion_total_avisos: total de fechas programadas.
 * - avisos_emitidos_facturacion: cuántas fechas son < today.
 * - avisos_restantes_facturacion: total - emitidos.
 * - proximaFecha y ultimaFecha: próximas/últimas fechas de facturación.
 *
 * @param {Object} lineItem
 * @param {Date} [today]
 * @returns {Object}
 */
export function computeBillingCountersForLineItem(lineItem, today = new Date()) {
  // Normaliza "today" al comienzo del día
  const startOfDay = (d) => {
    const copy = new Date(d);
    copy.setHours(0, 0, 0, 0);
    return copy;
  };
  const todayStart = startOfDay(today);

  // Usa la función interna collectAllBillingDatesFromLineItem (ya existe en este archivo)
  const dates = collectAllBillingDatesFromLineItem(lineItem);

  let emitidos = 0;
  let proximaFecha = null;
  let ultimaFecha = null;
  for (const d of dates) {
    const dStart = startOfDay(d);
    if (dStart.getTime() < todayStart.getTime()) {
      emitidos++;
      ultimaFecha = dStart;
    } else if (!proximaFecha) {
      proximaFecha = dStart;
    }
  }

  const totalAvisos = dates.length;
  const restantes = totalAvisos > emitidos ? totalAvisos - emitidos : 0;

  return {
    facturacion_total_avisos: totalAvisos,
    avisos_emitidos_facturacion: emitidos,
    avisos_restantes_facturacion: restantes,
    proximaFecha,
    ultimaFecha,
  };
}
