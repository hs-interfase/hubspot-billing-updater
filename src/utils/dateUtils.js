// src/utils/dateUtils.js

/**
 * Utilidades para trabajar con fechas en formato YYYY-MM-DD (sin timezone bugs).
 */

/**
 * Devuelve { year, month, day } de una fecha "ahora" en un timezone dado.
 * month viene 1-12.
 */
function getYMDPartsInTZ(date, timeZone) {
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  const parts = dtf.formatToParts(date);
  const year = Number(parts.find(p => p.type === "year")?.value);
  const month = Number(parts.find(p => p.type === "month")?.value);
  const day = Number(parts.find(p => p.type === "day")?.value);

  if (!year || !month || !day) return null;
  return { year, month, day };
}

/**
 * Offset (minutos) entre UTC y el timezone, para un instante dado.
 * Ej: Montevideo suele ser -180.
 */
function getTimeZoneOffsetMinutes(timeZone, utcDate) {
const dtf = new Intl.DateTimeFormat("en-US", {
  timeZone,
  hour12: false,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

  const parts = dtf.formatToParts(utcDate);
  const y = Number(parts.find(p => p.type === "year")?.value);
  const m = Number(parts.find(p => p.type === "month")?.value);
  const d = Number(parts.find(p => p.type === "day")?.value);
let hh = Number(parts.find(p => p.type === "hour")?.value);

// Fix clásico: a veces Intl devuelve 24 en medianoche
if (hh === 24) hh = 0;  const mm = Number(parts.find(p => p.type === "minute")?.value);
  const ss = Number(parts.find(p => p.type === "second")?.value);

  // Esto crea "la misma fecha/hora" pero interpretada como UTC
  const asUTC = Date.UTC(y, m - 1, d, hh, mm, ss);
  const utcMillis = utcDate.getTime();

  // offset = tzTime - utcTime (en minutos)
  return Math.round((asUTC - utcMillis) / 60000);
}

/**
 * Convierte YYYY-MM-DD a millis que representan 00:00 en BILLING_TZ,
 * expresado como timestamp UTC (lo que HubSpot quiere).
 */
function ymdToHubSpotMillisInTZ(ymd, timeZone) {
  const m = ymd.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);

  // Base UTC (00:00Z de ese día) + ajuste por offset
  const baseUTC = Date.UTC(year, month - 1, day, 0, 0, 0);

  // Iteramos 2 veces para que si el offset cambia (DST) quede correcto
  let utc = baseUTC;
  for (let i = 0; i < 2; i++) {
    const offsetMin = getTimeZoneOffsetMinutes(timeZone, new Date(utc));
    utc = baseUTC - offsetMin * 60000;
  }
  return String(utc);
}

/**
 * Devuelve la fecha actual (en BILLING_TZ) en formato YYYY-MM-DD.
 * NO depende del timezone del server.
 */
export function getTodayYMD() {
  const tz = process.env.BILLING_TZ || "America/Montevideo";
  const parts = getYMDPartsInTZ(new Date(), tz);
  if (!parts) return formatDateISO(new Date()); // fallback
  const y = String(parts.year);
  const m = String(parts.month).padStart(2, "0");
  const d = String(parts.day).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Devuelve la fecha actual (00:00 en BILLING_TZ) como millis string para HubSpot.
 */
export function getTodayMillis() {
  const tz = process.env.BILLING_TZ || "America/Montevideo";
  const todayYMD = getTodayYMD();
  return ymdToHubSpotMillisInTZ(todayYMD, tz);
}

/**
 * Convierte un valor de fecha (Date, timestamp o string YYYY-MM-DD/ISO) 
 * a un timestamp en milisegundos, que es el formato que consumen las propiedades 
 * de fecha de HubSpot (por ejemplo hs_invoice_date).
 *
 * @param {string|number|Date} value - Fecha en distintos formatos
 * @returns {string|null} Timestamp en milisegundos como string, o null si no se puede parsear
 */
export function toHubSpotDate(value) {
  if (!value) return null;

  if (typeof value === "number" || /^\d+$/.test(value.toString().trim())) {
    return String(value);
  }

  // ✅ CAMBIO: YYYY-MM-DD => millis representando 00:00 en BILLING_TZ
  if (isYMD(value)) {
    const tz = process.env.BILLING_TZ || "America/Montevideo";
    return ymdToHubSpotMillisInTZ(value, tz);
  }

  if (value instanceof Date) {
    return String(value.getTime());
  }

  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? String(d.getTime()) : null;
}

/**
 * Para propiedades HubSpot tipo DATE (sin hora).
 * SIEMPRE devuelve midnight UTC (00:00:00.000Z).
 * 
 * @param {string|number|Date} value - Fecha en distintos formatos
 * @returns {string|null} Timestamp midnight UTC como string
 */
export function toHubSpotDateOnly(value) {
  if (!value) return null;

  if (typeof value === "number" || /^\d+$/.test(value.toString().trim())) {
    return String(value);
  }

  if (isYMD(value)) {
    return ymdToMidnightUTCMillis(value); // ✅ SIEMPRE midnight UTC
  }

  // Si viene ISO/Date, lo normalizás a YMD en BILLING_TZ y guardás midnight UTC
  const tz = process.env.BILLING_TZ || "America/Montevideo";
  const d = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(d.getTime())) return null;

  const parts = getYMDPartsInTZ(d, tz);
  if (!parts) return null;
  const ymd = `${parts.year}-${String(parts.month).padStart(2,"0")}-${String(parts.day).padStart(2,"0")}`;
  return ymdToMidnightUTCMillis(ymd);
}

/**
 * Para propiedades HubSpot tipo DATETIME (con hora completa).
 * Preserva el timestamp exacto en milisegundos.
 * 
 * @param {string|number|Date} value - Fecha/hora en distintos formatos
 * @returns {string|null} Timestamp en milisegundos como string
 */
export function toHubSpotDateTime(value) {
  if (!value) return null;
  if (typeof value === "number" || /^\d+$/.test(value.toString().trim())) return String(value);

  if (isYMD(value)) {
    // Para YYYY-MM-DD, usamos midnight UTC por consistencia
    return ymdToMidnightUTCMillis(value);
  }

  const d = value instanceof Date ? value : new Date(value);
  return Number.isFinite(d.getTime()) ? String(d.getTime()) : null;
}

export function parseLocalDate(raw) {
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

/**
 * Formatea un Date como YYYY-MM-DD.
 */
export function formatDateISO(date) {
  if (!date) return null;
  const d = new Date(date.getTime());
  d.setHours(0, 0, 0, 0);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

/**
 * Valida si un string es formato YYYY-MM-DD.
 */
export function isYMD(str) {
  return typeof str === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(str.trim());
}

/**
 * Suma meses a una fecha (maneja fin de mes correctamente).
 */
export function addMonths(date, months) {
  const d = new Date(date.getTime());
  d.setMonth(d.getMonth() + months);
  return d;
}

/**
 * Suma días a una fecha.
 */
export function addDays(date, days) {
  const d = new Date(date.getTime());
  d.setDate(d.getDate() + days);
  return d;
}

/**
 * Compara dos fechas (YYYY-MM-DD). Devuelve:
 * - negativo si a < b
 * - 0 si a === b
 * - positivo si a > b
 */
export function compareDates(a, b) {
  const dateA = parseLocalDate(a);
  const dateB = parseLocalDate(b);
  if (!dateA || !dateB) return 0;
  return dateA.getTime() - dateB.getTime();
}

/**
 * Calcula la diferencia en días entre dos fechas.
 */
export function diffDays(dateA, dateB) {
  const a = parseLocalDate(dateA);
  const b = parseLocalDate(dateB);
  if (!a || !b) return null;
  const diff = b.getTime() - a.getTime();
  return Math.floor(diff / (1000 * 60 * 60 * 24));
}

/**
 * YYYY-MM-DD -> millis string a 00:00:00.000Z (DATE-ONLY HubSpot)
 */
export function ymdToMidnightUTCMillis(ymd) {
  const m = ymd.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  return String(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
}
