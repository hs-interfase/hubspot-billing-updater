// src/utils/parsers.js

/**
 * Parsea un booleano en HubSpot (acepta "true", "1", "sí", "si", "yes").
 */
export function parseBool(raw) {
  const v = (raw ?? '').toString().trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'sí' || v === 'si' || v === 'yes';
}

/**
 * Parsea un número de forma segura.
 */
export function parseNumber(raw, defaultValue = 0) {
  const n = parseFloat(raw);
  return isNaN(n) ? defaultValue : n;
}

/**
 * Convierte cualquier valor a string seguro.
 */
export function safeString(raw) {
  if (raw === null || raw === undefined) return '';
  return String(raw).trim();
}
