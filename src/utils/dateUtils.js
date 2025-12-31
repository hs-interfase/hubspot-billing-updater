// src/utils/dateUtils.js

/**
 * Utilidades para trabajar con fechas en formato YYYY-MM-DD (sin timezone bugs).
 */

/**
 * Parsea una fecha desde string YYYY-MM-DD o timestamp.
 * Devuelve un Date en hora local (00:00:00).
 */

// src/utils/dateUtils.js

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

  // Si ya viene como número o string numérico, lo usamos tal cual
  if (typeof value === 'number' || /^\d+$/.test(value.toString().trim())) {
    return String(value);
  }

  // Si viene en formato YYYY-MM-DD, convertimos a Date local a medianoche
  if (isYMD(value)) {
    const d = parseLocalDate(value);
    return d ? String(d.getTime()) : null;
  }

  // Si es un objeto Date
  if (value instanceof Date) {
    return String(value.getTime());
  }

  // Fallback: intentar parsear cualquier string de fecha
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? String(d.getTime()) : null;
}

/**
 * Devuelve la fecha actual (00:00 hora local) en formato YYYY-MM-DD.
 */
export function getTodayYMD() {
  return formatDateISO(new Date());
}

/**
 * Devuelve la fecha actual (00:00 hora local) como timestamp en milisegundos.
 */
export function getTodayMillis() {
  const today = parseLocalDate(getTodayYMD());
  return today ? String(today.getTime()) : null;
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
