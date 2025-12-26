// src/utils/dateUtils.js

/**
 * Utilidades para trabajar con fechas en formato YYYY-MM-DD (sin timezone bugs).
 */

/**
 * Parsea una fecha desde string YYYY-MM-DD o timestamp.
 * Devuelve un Date en hora local (00:00:00).
 */
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
 * Devuelve la fecha de hoy en formato YYYY-MM-DD.
 */
export function getTodayYMD() {
  return formatDateISO(new Date());
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
