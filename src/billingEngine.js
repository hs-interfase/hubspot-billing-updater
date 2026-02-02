// src/billingEngine.js
import { hubspotClient } from './hubspotClient.js';

// LEGACY (calendar-based): se mantiene comentado para rollback.
// import { resolveNextBillingDate } from './utils/resolveNextBillingDate.js';

import { getTodayYMD, parseLocalDate, formatDateISO } from "./utils/dateUtils.js";

/**
 * =============================================================================
 * MIGRACIÓN A ANCHOR-BASED (sin borrar calendario)
 * - Fuente de verdad: billing_anchor_date + frecuencia/intervalo => billing_next_date
 * - Calendario fecha_2..fecha_48 queda como LEGACY (comentado / no usado)
 * =============================================================================
 */

// -----------------------------
// Helpers de fechas / frecuencia
// -----------------------------
// Helper: calcula la próxima fecha >= todayYmd usando startRaw e interval
function computeNextFromInterval({ startRaw, interval, todayYmd, addInterval, formatDateISO, parseLocalDate }) {
  if (!startRaw || !interval) return null;
  const start = parseLocalDate(startRaw);
  if (!start || Number.isNaN(start.getTime())) return null;
  const startYmd = formatDateISO(start);
  if (startYmd >= todayYmd) return startYmd;
  let current = new Date(start.getTime());
  let prevMs = current.getTime();
  for (let iter = 0; iter < 5000; iter++) {
    current = addInterval(current, interval);
    const ms = current.getTime();
    if (!Number.isFinite(ms)) return null;
    const ymd = formatDateISO(current);
    if (ymd >= todayYmd) return ymd;
    if (ms === prevMs) break; // no avanza
    prevMs = ms;
  }
  return null;
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
 *
 * Anchor-based:
 * - Soporta irregular puntual vía: irregular=true + fecha_irregular_puntual (YYYY-MM-DD)
 * - Soporta urgente vía: facturar_ahora=true (solo válido para pago único sin fecha)
 */
function getEffectiveBillingConfig(lineItem) {
  const p = lineItem.properties || {};

  console.log('[getEffectiveBillingConfig][RAW]', {
    lineItemId: lineItem.id,
    name: p.name,
    recurringbillingfrequency: p.recurringbillingfrequency,
    hs_recurring_billing_frequency: p.hs_recurring_billing_frequency,
    hs_recurring_billing_start_date: p.hs_recurring_billing_start_date,
    hs_recurring_billing_number_of_payments: p.hs_recurring_billing_number_of_payments,
    hs_recurring_billing_period: p.hs_recurring_billing_period, // solo debug
    number_of_payments: p.number_of_payments,
    frecuencia_de_facturacion: p.frecuencia_de_facturacion,
    irregular: p.irregular,

    // ✅ NUEVO (anchor-world)
    fecha_irregular_puntual: p.fecha_irregular_puntual,
    facturar_ahora: p.facturar_ahora,
    billing_anchor_date: p.billing_anchor_date,
  });

  // ¿Es irregular?
  const freqCustom = (p.frecuencia_de_facturacion ?? '').toString().trim().toLowerCase();
  const irregularFlagRaw = (p.irregular ?? '').toString().toLowerCase();

  const isIrregular =
    freqCustom === 'irregular' ||
    irregularFlagRaw === 'true' ||
    irregularFlagRaw === '1' ||
    irregularFlagRaw === 'sí' ||
    irregularFlagRaw === 'si' ||
    irregularFlagRaw === 'yes';

  // ✅ NUEVO: flags/fechas útiles para decisiones en updateLineItemSchedule
  const facturarAhoraRaw = (p.facturar_ahora ?? '').toString().trim().toLowerCase();
  const isFacturarAhora =
    facturarAhoraRaw === 'true' ||
    facturarAhoraRaw === '1' ||
    facturarAhoraRaw === 'sí' ||
    facturarAhoraRaw === 'si' ||
    facturarAhoraRaw === 'yes';

  const fechaIrregularPuntualRaw = (p.fecha_irregular_puntual ?? '').toString().slice(0, 10) || null;

  // 🔑 Frecuencia efectiva
  const freqKey =
    p.recurringbillingfrequency ||          // internal values: monthly, weekly...
    p.hs_recurring_billing_frequency ||     // por si HS rellena esta
    '';                                     // ✅ no usamos frecuencia_de_facturacion aquí

  const frequency = freqKey.toString().trim();

  // ✅ Si frequency es vacío/null y NO es irregular → es pago único
  let interval = null;
  if (!frequency && !isIrregular) {
    interval = null; // pago único
  } else if (frequency) {
    interval = getIntervalFromFrequency(frequency);
  } else {
    interval = null; // irregular
  }

  // Fecha de inicio
  const startRaw =
    p.hs_recurring_billing_start_date ||    // ✅ PRIMERO el nombre oficial de HubSpot
    p.recurringbillingstartdate ||
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

  let numberOfPayments = null;
  if (numRaw !== null && numRaw !== undefined && numRaw !== '') {
    const n = Number.parseInt(numRaw.toString().trim(), 10);
    if (Number.isFinite(n) && n > 0) numberOfPayments = n;
  }

  const maxOccurrences =
    numberOfPayments && Number.isFinite(numberOfPayments)
      ? numberOfPayments
      : 24;

  console.log('[getEffectiveBillingConfig][SUMMARY]', {
    lineItemId: lineItem.id,
    isIrregular,
    frequency,
    interval,
    startDate: startDate ? formatDateISO(startDate) : null,
    numberOfPayments,
    maxOccurrences,

    isFacturarAhora,
    fechaIrregularPuntualRaw,
  });

  return {
    isIrregular,
    isFacturarAhora,          
    fechaIrregularPuntualRaw, 
    frequency,
    interval,
    startDate,
    maxOccurrences,
  };
}

// Actualiza el calendario y contadores de un line item en HubSpot.
// MIGRACIÓN: Anchor-based. Calendario queda LEGACY comentado (no se usa / no se escribe).
export async function updateLineItemSchedule(lineItem) {
  if (!lineItem || !lineItem.id) {
    console.warn('[updateLineItemSchedule] lineItem inválido:', lineItem);
    return lineItem;
  }

  const p = lineItem.properties || {};
  const config = getEffectiveBillingConfig(lineItem);

  // =========================================================
  // REGLA PREDOMINANTE:
  // si fechas_completas = true => billing_next_date = '' y salir
  // (no calcular nada más)
  // =========================================================
  const fechasCompletasFlag =
    String(p.fechas_completas || '').trim().toLowerCase() === 'true';

  if (fechasCompletasFlag) {
    const updates = { billing_next_date: '', };

    // opcional debug
    if (process.env.DBG_PHASE1 === 'true') {
      console.log('[updateLineItemSchedule] fechas_completas=true => billing_next_date=""', {
        lineItemId: lineItem.id,
      });
    }

    await hubspotClient.crm.lineItems.basicApi.update(String(lineItem.id), {
      properties: updates,
    });

    lineItem.properties = { ...p, ...updates };
    return lineItem;
  }


  const isIrregular = config?.isIrregular === true;
  const interval = config?.interval ?? null;
  const startDate = config?.startDate ?? null;

  const isFacturarAhora =
    config?.isFacturarAhora ??
    (() => {
      const raw = (p.facturar_ahora ?? '').toString().trim().toLowerCase();
      return raw === 'true' || raw === '1' || raw === 'sí' || raw === 'si' || raw === 'yes';
    })();

  const fechaIrregularPuntualRaw =
    config?.fechaIrregularPuntualRaw ??
    ((p.fecha_irregular_puntual ?? '').toString().slice(0, 10) || null);

  // --------------------------------------------
  // 0) Irregular (override puntual) - MANUAL NO EXISTE
  // --------------------------------------------
  // Regla:
  // - irregular=true + fecha_irregular_puntual => override puntual del next date
  // - irregular=true + SIN fecha_irregular_puntual => ESTADO INVÁLIDO -> billing_error
  if (isIrregular) {
    if (fechaIrregularPuntualRaw) {
      const updatesIrregular = {
        billing_next_date: fechaIrregularPuntualRaw,
        billing_error: '', // limpia error si estaba
      };

      console.log('[updateLineItemSchedule] irregular puntual → set billing_next_date', {
        lineItemId: lineItem.id,
        billing_next_date: fechaIrregularPuntualRaw,
      });

      await hubspotClient.crm.lineItems.basicApi.update(lineItem.id, {
        properties: updatesIrregular,
      });

      lineItem.properties = { ...p, ...updatesIrregular };
      return lineItem;
    }

    const msg =
      'irregular=true pero falta fecha_irregular_puntual. Completar la fecha puntual o desactivar irregular.';

    console.warn('[updateLineItemSchedule] ⚠️ irregular=true sin fecha puntual (manual no soportado)', {
      lineItemId: lineItem.id,
    });

    const updatesError = { billing_error: msg };

    await hubspotClient.crm.lineItems.basicApi.update(lineItem.id, {
      properties: updatesError,
    });

    lineItem.properties = { ...p, ...updatesError };
    return lineItem;
  }

  // --------------------------------------------
  // 1) Validación: falta startDate
  // --------------------------------------------
  // Regla nueva:
  // - SOLO permitimos "usar hoy" si es pago único + facturar_ahora=true
  // - En cualquier otro caso: WARN + billing_error (para notificar al owner)
  if (!startDate) {
    const isOneTime = !interval;

    if (isOneTime && isFacturarAhora) {
      const todayYmd = getTodayYMD();
      const effectiveStart = parseLocalDate(todayYmd);
      const iso = formatDateISO(effectiveStart);

      const updatesUrgentOneTime = {
        recurringbillingstartdate: iso,
        billing_next_date: iso,
        billing_error: '',
      };

      if (Object.prototype.hasOwnProperty.call(p, 'fecha_inicio_de_facturacion')) {
        updatesUrgentOneTime.fecha_inicio_de_facturacion = iso;
      }

      console.log('[updateLineItemSchedule] ✅ pago único urgente sin startDate → usando HOY', {
        lineItemId: lineItem.id,
        today: todayYmd,
      });

      await hubspotClient.crm.lineItems.basicApi.update(lineItem.id, {
        properties: updatesUrgentOneTime,
      });

      lineItem.properties = { ...p, ...updatesUrgentOneTime };
      return lineItem;
    }

    const msg =
      'Falta fecha de inicio de facturación en el line item. Setear hs_recurring_billing_start_date (Start date) para calcular próximas fechas.';

    console.warn('[updateLineItemSchedule] ⚠️ Falta startDate → no se calcula schedule', {
      lineItemId: lineItem.id,
      isOneTime,
      isFacturarAhora,
      frequency: config?.frequency,
    });

    const updatesError = { billing_error: msg };

    await hubspotClient.crm.lineItems.basicApi.update(lineItem.id, {
      properties: updatesError,
    });

    lineItem.properties = { ...p, ...updatesError };
    return lineItem;
  }

  // Si llegamos acá, hay startDate y es regular
  const todayYmd = getTodayYMD();

  // ✅ si ya hay last_ticketed_date, la próxima debe ser DESPUÉS de esa fecha
  const lastTicketedYmd = (p.last_ticketed_date || '').toString().slice(0, 10);

  let effectiveTodayYmd = todayYmd;
  if (lastTicketedYmd) {
    const d = parseLocalDate(lastTicketedYmd);
    if (d && !Number.isNaN(d.getTime())) {
      d.setDate(d.getDate() + 1);
      const plusOne = formatDateISO(d);
      if (plusOne > effectiveTodayYmd) effectiveTodayYmd = plusOne;
    }
  }

  // --------------------------------------------
  // 2) Pago único (con startDate)
  // --------------------------------------------
  if (!interval) {
    const iso = formatDateISO(startDate);

    // Si ya existe last_ticketed_date, ese pago único ya tuvo ticket => next null
    const nextYmd = lastTicketedYmd ? '' : iso;

    const updatesOneTime = {
      recurringbillingstartdate: iso,
      billing_next_date: nextYmd, // '' => null en HubSpot
      billing_error: '',
    };

    if (Object.prototype.hasOwnProperty.call(p, 'fecha_inicio_de_facturacion')) {
      updatesOneTime.fecha_inicio_de_facturacion = iso;
    }

    if (process.env.DBG_PHASE1 === 'true') {
      console.log(`[billing_next_date][ONE_TIME] LI ${lineItem.id} => ${nextYmd || '(null)'}`, {
        last_ticketed_date: lastTicketedYmd || null,
      });
    }

    await hubspotClient.crm.lineItems.basicApi.update(lineItem.id, {
      properties: updatesOneTime,
    });

    lineItem.properties = { ...p, ...updatesOneTime };
    return lineItem;
  }

  // --------------------------------------------
  // 3) Recurrente anchor-based (sin calendario)
  // --------------------------------------------
  // NOTE (post-migration):
  // Esta lógica asume tickets parciales.
  // En la migración histórica se debe recalcular:
  // - pagos_emitidos desde tickets reales
  // - pagos_restantes
  // - billing_anchor_date efectivo
  // y luego regenerar billing_next_date en batch.
  
  const updatesRecurring = {
    billing_error: '',
  };

  // ✅ Inicializar billing_anchor_date solo si está vacío
  // Preferimos: startDate (ya parseado) como fallback seguro si HS no trae string.
  try {
    const currentAnchor = (p.billing_anchor_date ?? '').toString().slice(0, 10) || '';
    const startFromHS = (p.hs_recurring_billing_start_date ?? '').toString().slice(0, 10) || '';
    const startFallback = startDate ? formatDateISO(startDate) : '';

    if (!currentAnchor && (startFromHS || startFallback)) {
      updatesRecurring.billing_anchor_date = startFromHS || startFallback;

      if (process.env.DBG_PHASE1 === 'true') {
        console.log('[updateLineItemSchedule] ✅ billing_anchor_date inicializada', {
          lineItemId: lineItem.id,
          billing_anchor_date: updatesRecurring.billing_anchor_date,
        });
      }
    }
  } catch (e) {
    console.warn('[updateLineItemSchedule] ⚠️ no se pudo inicializar billing_anchor_date', {
      lineItemId: lineItem.id,
      error: e?.message || e,
    });
  }

  // Anchor efectivo para calcular next
  const anchorStartRaw =
    (p.billing_anchor_date || '').toString().slice(0, 10) ||
    (updatesRecurring.billing_anchor_date || '').toString().slice(0, 10) ||
    (p.hs_recurring_billing_start_date || '').toString().slice(0, 10) ||
    (p.recurringbillingstartdate || '').toString().slice(0, 10) ||
    (p.fecha_inicio_de_facturacion || '').toString().slice(0, 10) ||
    formatDateISO(startDate);

// Piso duro: no permitir next antes de startdate
const startYmd = formatDateISO(startDate);
let floorYmd = effectiveTodayYmd;
if (startYmd && startYmd > floorYmd) floorYmd = startYmd;

const nextYmd = computeNextFromInterval({
  startRaw: anchorStartRaw,
  interval,
  todayYmd: floorYmd,
  addInterval,
  formatDateISO,
  parseLocalDate,
});


updatesRecurring.billing_next_date = nextYmd || '';

if (process.env.DBG_PHASE1 === 'true') {
  console.log(`[billing_next_date][ANCHOR] LI ${lineItem.id} => ${nextYmd || '(null)'}`, {
    anchorStartRaw,
    effectiveTodayYmd,
    startYmd,
    floorYmd,
    last_ticketed_date: lastTicketedYmd || null,
  });
}


  // Mantener coherencia de start date alias (sin calendario)
  const isoStart = formatDateISO(startDate);
  updatesRecurring.recurringbillingstartdate = isoStart;

  if (Object.prototype.hasOwnProperty.call(p, 'fecha_inicio_de_facturacion')) {
    updatesRecurring.fecha_inicio_de_facturacion = isoStart;
  }

  // Guard: skip if empty
  if (Object.keys(updatesRecurring).length === 0) {
    console.log('[billingEngine] ⊘ SKIP_EMPTY_UPDATE: No recurring properties to update');
    return lineItem;
  }

  await hubspotClient.crm.lineItems.basicApi.update(lineItem.id, {
    properties: updatesRecurring,
  });

  lineItem.properties = { ...p, ...updatesRecurring };
  return lineItem;
}

// ================================
// Anchor-based counters & getters
// (Calendario fecha_2..48 queda LEGACY comentado)
// ================================

// Devuelve la próxima fecha de facturación para un line item.
// - NUEVO (anchor-based): usa billing_next_date como fuente de verdad.
// - Si falta, calcula con billing_anchor_date + interval.
// - Irregular: SOLO válido si hay fecha_irregular_puntual (no existe más “manual mode” sin fecha).
// - Calendario fecha_2..48: LEGACY (no se usa / no se lee / no se escribe).

function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

// Devuelve la última fecha de facturación (la mayor < today) usando señales nuevas.
// Antes: recorría todas las fechas del calendario.
// Ahora: usa last_ticketed_date (máximo) como fuente de “última facturada”.
export function computeLastBillingDateFromLineItems(lineItems, today = new Date()) {
  const todayStart = startOfDay(today);
  let maxPast = null;

  for (const li of lineItems) {
    const p = li?.properties || {};
    const raw = (p.last_ticketed_date || "").toString().slice(0, 10);
    if (!raw) continue;

    const d = parseLocalDate(raw);
    if (!d || Number.isNaN(d.getTime())) continue;

    const dStart = startOfDay(d);
    if (dStart.getTime() < todayStart.getTime()) {
      if (!maxPast || dStart.getTime() > maxPast.getTime()) {
        maxPast = dStart;
      }
    }
  }

  return maxPast; // puede ser null si no hay last_ticketed_date
}

// Anchor-based: colecta SOLO señales “nuevas”.
// Dejar la función porque otras partes del archivo la llaman, pero ya no lee calendario.
function collectAllBillingDatesFromLineItem(lineItem) {
  const p = lineItem?.properties || {};
  const dates = [];

  const add = (raw) => {
    if (!raw) return;
    const d = parseLocalDate(raw);
    if (!d || Number.isNaN(d.getTime())) return;
    d.setHours(0, 0, 0, 0);
    dates.push(d);
  };

  // ✅ Señales actuales (anchor-based)
  add((p.last_ticketed_date || "").toString().slice(0, 10));
  add((p.billing_next_date || "").toString().slice(0, 10));
  add(p.fecha_inicio_de_facturacion || p.hs_recurring_billing_start_date);
  add((p.fecha_irregular_puntual || "").toString().slice(0, 10));

  // ---------------------------------------------------------
  // LEGACY (calendario) - NO SE USA en anchor-based
  // for (let i = 2; i <= 48; i++) {
  //   add(p[`fecha_${i}`]);
  // }
  // ---------------------------------------------------------

  dates.sort((a, b) => a - b);
  return dates;
}

export function getNextBillingDateForLineItem(lineItem, today = new Date()) {
  const p = lineItem?.properties || {};

  // 1) Respetar contadores: si ya se hicieron todos los pagos, no hay próxima fecha
const total = Number(p.hs_recurring_billing_number_of_payments) || 0;
  const emitidos = Number(p.pagos_emitidos) || 0;

  if (total > 0 && emitidos >= total) {
    return null;
  }

  // todayYmd respetando el "today" recibido
  let todayYmd = getTodayYMD();
  if (today instanceof Date && !Number.isNaN(today.getTime())) {
    todayYmd = formatDateISO(today); // YYYY-MM-DD
  }

  // 2) Fuente de verdad: billing_next_date (si es >= hoy, devolvemos eso)
  const persisted = (p.billing_next_date ?? "").toString().slice(0, 10);
  if (persisted && persisted >= todayYmd) {
    return parseLocalDate(persisted);
  }

  // 3) Irregular: SOLO si hay fecha_irregular_puntual futura (manual sin fecha ya no existe)
  const irregularRaw = (p.irregular ?? "").toString().trim().toLowerCase();
  const isIrregular =
    irregularRaw === "true" ||
    irregularRaw === "1" ||
    irregularRaw === "sí" ||
    irregularRaw === "si" ||
    irregularRaw === "yes";

  if (isIrregular) {
    const puntual = (p.fecha_irregular_puntual ?? "").toString().slice(0, 10);
    if (puntual && puntual >= todayYmd) return parseLocalDate(puntual);
    return null;
  }

  // 4) Configuración efectiva (interval / startDate)
  const config = getEffectiveBillingConfig(lineItem);
  const interval = config?.interval ?? null;
  const startDate = config?.startDate ?? null;

  // 5) effectiveTodayYmd: si hay last_ticketed_date, la próxima debe ser desde +1 día
 /* const lastTicketedYmd = (p.last_ticketed_date || "").toString().slice(0, 10);
  let effectiveTodayYmd = todayYmd;

  if (lastTicketedYmd) {
    const d = parseLocalDate(lastTicketedYmd);
    if (d && !Number.isNaN(d.getTime())) {
      d.setDate(d.getDate() + 1);
      const plusOne = formatDateISO(d);
      if (plusOne > effectiveTodayYmd) effectiveTodayYmd = plusOne;
    }
  }
    */
   // 5) effectiveTodayYmd: frontera dura — NUNCA ir antes del último ticket emitido
const lastTicketedYmd = (p.last_ticketed_date || "").toString().slice(0, 10);
/*
let effectiveTodayYmd = todayYmd;

if (lastTicketedYmd) {
  const d = parseLocalDate(lastTicketedYmd);
  if (d && !Number.isNaN(d.getTime())) {
    d.setDate(d.getDate() + 1);
    const plusOne = formatDateISO(d);
    if (plusOne > effectiveTodayYmd) effectiveTodayYmd = plusOne; 
  }
}
*/

  // 6) Pago único: si ya fue ticketiado -> no hay próxima. Si no, startDate si es >= effectiveToday.
  if (!interval) {
    if (!startDate) return null;
    if (lastTicketedYmd) return null;

    const iso = formatDateISO(startDate);
    return iso >= effectiveTodayYmd ? parseLocalDate(iso) : null;
  }

  // 7) Recurrente anchor-based: computeNextFromInterval(anchorStart, interval, effectiveTodayYmd)
  const anchorStartRaw =
    (p.billing_anchor_date || "").toString().slice(0, 10) ||
    (p.hs_recurring_billing_start_date || "").toString().slice(0, 10) ||
    (p.recurringbillingstartdate || "").toString().slice(0, 10) ||
    (p.fecha_inicio_de_facturacion || "").toString().slice(0, 10) ||
    (startDate ? formatDateISO(startDate) : null);

  if (!anchorStartRaw) return null;

/*  const nextYmd = computeNextFromInterval({
    startRaw: anchorStartRaw,
    interval,
    todayYmd: effectiveTodayYmd,  
    addInterval,
    formatDateISO,
    parseLocalDate,
  });
*/
// Piso duro: nunca antes del startDate real
const startYmd = startDate ? formatDateISO(startDate) : null;

let floorYmd = effectiveTodayYmd;
if (startYmd && startYmd > floorYmd) floorYmd = startYmd;

const nextYmd = computeNextFromInterval({
  startRaw: anchorStartRaw,
  interval,
  todayYmd: floorYmd,
  addInterval,
  formatDateISO,
  parseLocalDate,
});




  return nextYmd ? parseLocalDate(nextYmd) : null;

  // ---------------------------------------------------------
  // LEGACY (calendario + resolveNextBillingDate) - NO SE USA
  //
  // const allDates = collectAllBillingDatesFromLineItem(lineItem);
  // const upcomingDates = (allDates || [])
  //   .filter((d) => d instanceof Date && !Number.isNaN(d.getTime()))
  //   .filter((d) => formatDateISO(d) >= todayYmd)
  //   .map((d) => formatDateISO(d));
  //
  // const startRaw =
  //   p.hs_recurring_billing_start_date ||
  //   p.recurringbillingstartdate ||
  //   p.fecha_inicio_de_facturacion ||
  //   null;
  //
  // const nextLegacy = resolveNextBillingDate({
  //   lineItemProps: p,
  //   upcomingDates,
  //   startRaw,
  //   interval: config.interval,
  //   addInterval,
  // });
  //
  // return nextLegacy ? parseLocalDate(nextLegacy) : null;
  // ---------------------------------------------------------
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
 * Contadores “simples” sin calendario:
 * - totalAvisos / emitidos / restantes: usa total_de_pagos y pagos_emitidos.
 * - proximaFecha: usa getNextBillingDateForLineItem (anchor-based).
 * - ultimaFecha: usa last_ticketed_date.
 *
 * (Esto evita depender de fecha_2..48)
 */

export function computeLineItemCounters(lineItem, today = new Date()) {
  const props = lineItem?.properties || {};

  const total = Number(props.hs_recurring_billing_number_of_payments) || 0;
  const emitidos = Number(props.pagos_emitidos) || 0;
  const restantes = total > emitidos ? total - emitidos : 0;

  const proximaFecha = getNextBillingDateForLineItem(lineItem, today);

  let ultimaFecha = null;
  const lastTicketedYmd = (props.last_ticketed_date || "").toString().slice(0, 10);
  if (lastTicketedYmd) {
    const d = parseLocalDate(lastTicketedYmd);
    if (d && !Number.isNaN(d.getTime())) {
      ultimaFecha = d;
    }
  }

  return {
    totalAvisos: total,
    avisosEmitidos: emitidos,
    avisosRestantes: restantes,
    proximaFecha,
    ultimaFecha,
  };

  // ---------------------------------------------------------
  // LEGACY (calendario) - NO SE USA
  //
  // const fechas = [];
  // if (props.fecha_inicio_de_facturacion) { ... }
  // for (let i = 2; i <= 48; i++) { ... }
  // ---------------------------------------------------------
}

/**
 * Variante con nombres de propiedades usados en tu CRM:
 * - facturacion_total_avisos, avisos_emitidos_facturacion, avisos_restantes_facturacion
 * - proximaFecha, ultimaFecha
 *
 * Sin calendario.
 */
export function computeBillingCountersForLineItem(lineItem, today = new Date()) {
  const p = lineItem?.properties || {};

const total = Number(p.hs_recurring_billing_number_of_payments) || 0;
  const emitidos = Number(p.pagos_emitidos) || 0;
  const restantes = total > emitidos ? total - emitidos : 0;

  const proximaFecha = getNextBillingDateForLineItem(lineItem, today);

  let ultimaFecha = null;
  const lastTicketedYmd = (p.last_ticketed_date || "").toString().slice(0, 10);
  if (lastTicketedYmd) {
    const d = parseLocalDate(lastTicketedYmd);
    if (d && !Number.isNaN(d.getTime())) {
      d.setHours(0, 0, 0, 0);
      ultimaFecha = d;
    }
  }

  return {
    facturacion_total_avisos: total,
    avisos_emitidos_facturacion: emitidos,
    avisos_restantes_facturacion: restantes,
    proximaFecha,
    ultimaFecha,
  };

  // ---------------------------------------------------------
  // LEGACY (calendario) - NO SE USA
  //
  // const dates = collectAllBillingDatesFromLineItem(lineItem);
  // for (const d of dates) { ... }
  // ---------------------------------------------------------
}

