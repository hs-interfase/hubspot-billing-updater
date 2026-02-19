// src/billingEngine.js
import { hubspotClient } from './hubspotClient.js';
import { getTodayYMD, parseLocalDate, formatDateISO, addInterval } from "./utils/dateUtils.js";
import logger from "../lib/logger.js";
import { reportHubSpotError } from "./utils/hubspotErrorCollector.js"; // src/ → mismo nivel

/**
 * Reporta a HubSpot solo errores accionables (4xx excepto 429).
 * 429 y 5xx son transitorios → solo logger.error, sin reporte al objeto.
 */
function reportIfActionable({ objectType, objectId, message, err }) {
  const status = err?.response?.status ?? err?.statusCode ?? null;
  if (status === null) {
    // Sin status conocido → reportar por precaución
    reportHubSpotError({ objectType, objectId, message });
    return;
  }
  if (status === 429 || status >= 500) {
    // Transitorio (rate-limit o error de servidor) → no spamear HubSpot
    return;
  }
  if (status >= 400 && status < 500) {
    // Accionable: configuración inválida, objeto no existe, permisos, etc.
    reportHubSpotError({ objectType, objectId, message });
  }
}

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
 * Lee las propiedades del line item y devuelve la configuración efectiva de facturación.
 * - Usa primero las propiedades nativas de HubSpot.
 * - Luego hace fallback a tu frecuencia custom SOLO para el intervalo.
 *
 * Anchor-based:
 * - Soporta irregular puntual vía: irregular=true + fecha_irregular_puntual (YYYY-MM-DD)
 * - Soporta urgente vía: facturar_ahora=true (solo válido para pago único sin fecha)
 */
export function getEffectiveBillingConfig(lineItem) {
  const p = lineItem.properties || {};

  logger.debug({
    module: 'billingEngine',
    fn: 'getEffectiveBillingConfig',
    lineItemId: lineItem.id,
    name: p.name,
    recurringbillingfrequency: p.recurringbillingfrequency,
    hs_recurring_billing_frequency: p.hs_recurring_billing_frequency,
    hs_recurring_billing_start_date: p.hs_recurring_billing_start_date,
    hs_recurring_billing_number_of_payments: p.hs_recurring_billing_number_of_payments,
    hs_recurring_billing_period: p.hs_recurring_billing_period,
    number_of_payments: p.number_of_payments,
    frecuencia_de_facturacion: p.frecuencia_de_facturacion,
    irregular: p.irregular,
    fecha_irregular_puntual: p.fecha_irregular_puntual,
    facturar_ahora: p.facturar_ahora,
    billing_anchor_date: p.billing_anchor_date,
  }, '[getEffectiveBillingConfig] RAW props');

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
    p.recurringbillingfrequency ||
    p.hs_recurring_billing_frequency ||
    '';

  const frequency = freqKey.toString().trim();

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
    p.hs_recurring_billing_start_date ||
    p.recurringbillingstartdate ||
    p.fecha_inicio_de_facturacion;

  const startDate = parseLocalDate(startRaw);

  logger.debug({
    module: 'billingEngine',
    fn: 'getEffectiveBillingConfig',
    lineItemId: lineItem.id,
    startRaw,
    parsedStartDate: startDate ? formatDateISO(startDate) : null,
  }, '[getEffectiveBillingConfig] DATE parse');

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
      : null;

  logger.debug({
    module: 'billingEngine',
    fn: 'getEffectiveBillingConfig',
    lineItemId: lineItem.id,
    isIrregular,
    frequency,
    interval,
    startDate: startDate ? formatDateISO(startDate) : null,
    numberOfPayments,
    maxOccurrences,
    isFacturarAhora,
    fechaIrregularPuntualRaw,
  }, '[getEffectiveBillingConfig] SUMMARY');

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
    logger.warn({ module: 'billingEngine', fn: 'updateLineItemSchedule', lineItem }, 'lineItem inválido recibido');
    return lineItem;
  }

  const p = lineItem.properties || {};
  const config = getEffectiveBillingConfig(lineItem);

  // =========================================================
  // REGLA PREDOMINANTE:
  // si fechas_completas = true => billing_next_date = '' y salir
  // =========================================================
  const fechasCompletasFlag =
    String(p.fechas_completas || '').trim().toLowerCase() === 'true';

  if (fechasCompletasFlag) {
    const updates = { billing_next_date: '' };

    logger.debug({
      module: 'billingEngine',
      fn: 'updateLineItemSchedule',
      lineItemId: lineItem.id,
    }, 'fechas_completas=true => billing_next_date vacío, saliendo');

    try {
      await hubspotClient.crm.lineItems.basicApi.update(String(lineItem.id), {
        properties: updates,
      });
    } catch (err) {
      logger.error({ err, lineItemId: lineItem.id }, 'line_item_update_failed: fechas_completas path');
      reportIfActionable({
        objectType: 'line_item',
        objectId: lineItem.id,
        message: `line_item_update_failed (fechas_completas): ${err?.message || err}`,
        err,
      });
    }

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
  // 0) Irregular (override puntual)
  // --------------------------------------------
  if (isIrregular) {
    if (fechaIrregularPuntualRaw) {
      const updatesIrregular = {
        billing_next_date: fechaIrregularPuntualRaw,
        billing_error: '',
      };

      logger.info({
        module: 'billingEngine',
        fn: 'updateLineItemSchedule',
        lineItemId: lineItem.id,
        billing_next_date: fechaIrregularPuntualRaw,
      }, 'irregular puntual → set billing_next_date');

      try {
        await hubspotClient.crm.lineItems.basicApi.update(lineItem.id, {
          properties: updatesIrregular,
        });
      } catch (err) {
        logger.error({ err, lineItemId: lineItem.id }, 'line_item_update_failed: irregular puntual path');
        reportIfActionable({
          objectType: 'line_item',
          objectId: lineItem.id,
          message: `line_item_update_failed (irregular puntual): ${err?.message || err}`,
          err,
      });
      }

      lineItem.properties = { ...p, ...updatesIrregular };
      return lineItem;
    }

    const msg =
      'irregular=true pero falta fecha_irregular_puntual. Completar la fecha puntual o desactivar irregular.';

    logger.warn({
      module: 'billingEngine',
      fn: 'updateLineItemSchedule',
      lineItemId: lineItem.id,
    }, 'irregular=true sin fecha puntual (manual no soportado)');

    const updatesError = { billing_error: msg };

    try {
      await hubspotClient.crm.lineItems.basicApi.update(lineItem.id, {
        properties: updatesError,
      });
    } catch (err) {
      logger.error({ err, lineItemId: lineItem.id }, 'line_item_update_failed: irregular sin fecha puntual');
      reportIfActionable({
        objectType: 'line_item',
        objectId: lineItem.id,
        message: `line_item_update_failed (irregular sin fecha_irregular_puntual): ${err?.message || err}`,
        err,
      });
    }

    lineItem.properties = { ...p, ...updatesError };
    return lineItem;
  }

  // --------------------------------------------
  // 1) Validación: falta startDate
  // --------------------------------------------
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

      logger.info({
        module: 'billingEngine',
        fn: 'updateLineItemSchedule',
        lineItemId: lineItem.id,
        today: todayYmd,
      }, 'pago único urgente sin startDate → usando HOY');

      try {
        await hubspotClient.crm.lineItems.basicApi.update(lineItem.id, {
          properties: updatesUrgentOneTime,
        });
      } catch (err) {
        logger.error({ err, lineItemId: lineItem.id }, 'line_item_update_failed: pago único urgente');
        reportIfActionable({
          objectType: 'line_item',
          objectId: lineItem.id,
          message: `line_item_update_failed (pago único urgente): ${err?.message || err}`,
          err,
      });
      }

      lineItem.properties = { ...p, ...updatesUrgentOneTime };
      return lineItem;
    }

    const msg =
      'Falta fecha de inicio de facturación en el line item. Setear hs_recurring_billing_start_date (Start date) para calcular próximas fechas.';

    logger.warn({
      module: 'billingEngine',
      fn: 'updateLineItemSchedule',
      lineItemId: lineItem.id,
      isOneTime,
      isFacturarAhora,
      frequency: config?.frequency,
    }, 'Falta startDate → no se calcula schedule');

    const updatesError = { billing_error: msg };

    try {
      await hubspotClient.crm.lineItems.basicApi.update(lineItem.id, {
        properties: updatesError,
      });
    } catch (err) {
      logger.error({ err, lineItemId: lineItem.id }, 'line_item_update_failed: falta startDate');
      reportIfActionable({
        objectType: 'line_item',
        objectId: lineItem.id,
        message: `line_item_update_failed (falta startDate): ${err?.message || err}`,
        err,
      });
    }

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
      billing_next_date: nextYmd,
      billing_error: '',
    };

    if (Object.prototype.hasOwnProperty.call(p, 'fecha_inicio_de_facturacion')) {
      updatesOneTime.fecha_inicio_de_facturacion = iso;
    }

    logger.debug({
      module: 'billingEngine',
      fn: 'updateLineItemSchedule',
      lineItemId: lineItem.id,
      nextYmd: nextYmd || '(null)',
      last_ticketed_date: lastTicketedYmd || null,
    }, '[billing_next_date] ONE_TIME');

    try {
      await hubspotClient.crm.lineItems.basicApi.update(lineItem.id, {
        properties: updatesOneTime,
      });
    } catch (err) {
      logger.error({ err, lineItemId: lineItem.id }, 'line_item_update_failed: pago único con startDate');
      reportIfActionable({
        objectType: 'line_item',
        objectId: lineItem.id,
        message: `line_item_update_failed (pago único): ${err?.message || err}`,
        err,
      });
    }

    lineItem.properties = { ...p, ...updatesOneTime };
    return lineItem;
  }

  // --------------------------------------------
  // 3) Recurrente anchor-based (sin calendario)
  // --------------------------------------------
  const updatesRecurring = {
    billing_error: '',
  };

  // ✅ Inicializar billing_anchor_date solo si está vacío
  try {
    const currentAnchor = (p.billing_anchor_date ?? '').toString().slice(0, 10) || '';
    const startFromHS = (p.hs_recurring_billing_start_date ?? '').toString().slice(0, 10) || '';
    const startFallback = startDate ? formatDateISO(startDate) : '';

    if (!currentAnchor && (startFromHS || startFallback)) {
      updatesRecurring.billing_anchor_date = startFromHS || startFallback;

      logger.debug({
        module: 'billingEngine',
        fn: 'updateLineItemSchedule',
        lineItemId: lineItem.id,
        billing_anchor_date: updatesRecurring.billing_anchor_date,
      }, 'billing_anchor_date inicializada');
    }
  } catch (err) {
    logger.warn({
      err,
      module: 'billingEngine',
      fn: 'updateLineItemSchedule',
      lineItemId: lineItem.id,
    }, 'no se pudo inicializar billing_anchor_date');
    reportIfActionable({
      objectType: 'line_item',
      objectId: lineItem.id,
      message: `billing_anchor_date_init_failed: ${err?.message || err}`,
      err,
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

  // =====================================================
  // ✅ CAP POR PLAN FIJO (maxOccurrences)
  // =====================================================
  const isAutoRenewMode =
    String(p.renovacion_automatica || '').toLowerCase() === 'true';

  const maxOccurrences =
    !isAutoRenewMode && Number.isFinite(Number(config?.maxOccurrences))
      ? Number(config.maxOccurrences)
      : null;

  let lastPlannedYmd = null;

  if (maxOccurrences && maxOccurrences > 0 && interval && startYmd) {
    let cur = parseLocalDate(startYmd);
    for (let i = 1; i < maxOccurrences; i++) {
      cur = addInterval(cur, interval);
    }
    lastPlannedYmd = formatDateISO(cur);

    if (lastTicketedYmd && lastTicketedYmd >= lastPlannedYmd) {
      updatesRecurring.billing_next_date = '';

      logger.debug({
        module: 'billingEngine',
        fn: 'updateLineItemSchedule',
        lineItemId: lineItem.id,
        startYmd,
        maxOccurrences,
        lastPlannedYmd,
        last_ticketed_date: lastTicketedYmd,
      }, '[billing_next_date] CAP_END → null');
    }
  }

  // Si NO quedó nulo por CAP_END, calculamos next normal
  if (updatesRecurring.billing_next_date !== '') {
    const nextYmd = computeNextFromInterval({
      startRaw: startYmd,
      interval,
      todayYmd: floorYmd,
      addInterval,
      formatDateISO,
      parseLocalDate,
    });

    let cappedNext = nextYmd || '';

    if (lastPlannedYmd) {
      if (
        (lastTicketedYmd && lastTicketedYmd >= lastPlannedYmd) ||
        (cappedNext && cappedNext > lastPlannedYmd)
      ) {
        cappedNext = '';
      }
    }

    updatesRecurring.billing_next_date = cappedNext;

    logger.debug({
      module: 'billingEngine',
      fn: 'updateLineItemSchedule',
      lineItemId: lineItem.id,
      anchorStartRaw,
      effectiveTodayYmd,
      startYmd,
      floorYmd,
      last_ticketed_date: lastTicketedYmd || null,
      maxOccurrences: maxOccurrences || null,
      lastPlannedYmd,
      rawNextYmd: nextYmd || null,
      cappedNext: cappedNext || '(null)',
    }, '[billing_next_date] ANCHOR_CAP');
  }

  // Mantener coherencia de start date alias (sin calendario)
  const isoStart = formatDateISO(startDate);
  updatesRecurring.recurringbillingstartdate = isoStart;

  if (Object.prototype.hasOwnProperty.call(p, 'fecha_inicio_de_facturacion')) {
    updatesRecurring.fecha_inicio_de_facturacion = isoStart;
  }

  if (Object.keys(updatesRecurring).length === 0) {
    logger.debug({ module: 'billingEngine', fn: 'updateLineItemSchedule', lineItemId: lineItem.id }, 'SKIP_EMPTY_UPDATE: sin propiedades recurrentes a actualizar');
    return lineItem;
  }

  try {
    await hubspotClient.crm.lineItems.basicApi.update(lineItem.id, {
      properties: updatesRecurring,
    });
  } catch (err) {
    logger.error({ err, lineItemId: lineItem.id }, 'line_item_update_failed: recurrente anchor-based');
    reportIfActionable({
      objectType: 'line_item',
      objectId: lineItem.id,
      message: `line_item_update_failed (recurrente anchor): ${err?.message || err}`,
      err,
      });
  }

  lineItem.properties = { ...p, ...updatesRecurring };
  return lineItem;
}

// ================================
// Anchor-based counters & getters
// ================================

function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

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

  return maxPast;
}

// Anchor-based: colecta SOLO señales "nuevas".
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

  add((p.last_ticketed_date || "").toString().slice(0, 10));
  add((p.billing_next_date || "").toString().slice(0, 10));
  add(p.fecha_inicio_de_facturacion || p.hs_recurring_billing_start_date);
  add((p.fecha_irregular_puntual || "").toString().slice(0, 10));

  // ---------------------------------------------------------
  // LEGACY (calendario) - NO SE USA en anchor-based
  // for (let i = 2; i <= 48; i++) { add(p[`fecha_${i}`]); }
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
    todayYmd = formatDateISO(today);
  }

  // 2) Fuente de verdad: billing_next_date (si es >= hoy, devolvemos eso)
  const persisted = (p.billing_next_date ?? "").toString().slice(0, 10);
  if (persisted && persisted >= todayYmd) {
    return parseLocalDate(persisted);
  }

  // 3) Irregular: SOLO si hay fecha_irregular_puntual futura
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

  // 5) effectiveTodayYmd: frontera dura — NUNCA ir antes del último ticket emitido
  const lastTicketedYmd = (p.last_ticketed_date || "").toString().slice(0, 10);
  let effectiveTodayYmd = todayYmd;

  // 6) Pago único
  if (!interval) {
    if (!startDate) return null;
    if (lastTicketedYmd) return null;

    const iso = formatDateISO(startDate);
    return iso >= effectiveTodayYmd ? parseLocalDate(iso) : null;
  }

  // 7) Recurrente anchor-based
  const anchorStartRaw =
    (p.billing_anchor_date || "").toString().slice(0, 10) ||
    (p.hs_recurring_billing_start_date || "").toString().slice(0, 10) ||
    (p.recurringbillingstartdate || "").toString().slice(0, 10) ||
    (p.fecha_inicio_de_facturacion || "").toString().slice(0, 10) ||
    (startDate ? formatDateISO(startDate) : null);

  if (!anchorStartRaw) return null;

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

  return minDate;
}

/**
 * Contadores simples sin calendario:
 * - proximaFecha: usa getNextBillingDateForLineItem (anchor-based).
 * - ultimaFecha: usa last_ticketed_date.
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
  // ---------------------------------------------------------
}

/**
 * Variante con nombres de propiedades usados en tu CRM:
 * - facturacion_total_avisos, avisos_emitidos_facturacion, avisos_restantes_facturacion
 * - proximaFecha, ultimaFecha
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
  // ---------------------------------------------------------
}
