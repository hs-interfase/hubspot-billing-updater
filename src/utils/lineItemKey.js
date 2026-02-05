// src/utils/lineItemKey.js
import crypto from 'crypto';

/**
 * Genera un string corto aleatorio para evitar colisiones.
 * Ej: "7f3a9c" (hex de 3 bytes)
 */
export function randShort(bytes = 3) {
  return crypto.randomBytes(bytes).toString('hex'); // 3 bytes => 6 chars
}

export function isBlank(v) {
  return v == null || String(v).trim() === '';
}

/**
 * Formato: <dealId>:<lineItemIdOriginal>:<randShort>
 * Ej: "55261281948:50351077463:7f3a9c"
 */
export function buildLineItemKey({ dealId, lineItemIdOriginal, random = randShort() }) {
  if (isBlank(dealId)) throw new Error('buildLineItemKey: dealId requerido');
  if (isBlank(lineItemIdOriginal)) throw new Error('buildLineItemKey: lineItemIdOriginal requerido');
  return `${String(dealId)}:${String(lineItemIdOriginal)}:${String(random)}`;
}

/**
 * Pure helper: decide si hay que crear/reemplazar key o no.
 *
 * Reglas:
 * - Si forceNew=true => siempre generar una nueva key (shouldUpdate=true)
 * - Si existe line_item_key y NO está en blanco => no tocar (shouldUpdate=false)
 * - Si está vacío => generar uno nuevo (shouldUpdate=true)
 *
 * Devuelve:
 * { key, shouldUpdate }
 */
export function ensureLineItemKey({ dealId, lineItem, forceNew = false } = {}) {
  const currentRaw = lineItem?.properties?.line_item_key;
  const current = isBlank(currentRaw) ? '' : String(currentRaw).trim();

  // Forzar nueva key (caso mismatch / clon)
  if (forceNew) {
    const lineItemIdOriginal = lineItem?.id; // usamos el id actual como base
    const key = buildLineItemKey({ dealId, lineItemIdOriginal });
    return { key, shouldUpdate: true };
  }

  // Si ya existe, no tocar
  if (current) {
    return { key: current, shouldUpdate: false };
  }

  // Si no existe, crear
  const lineItemIdOriginal = lineItem?.id;
  const key = buildLineItemKey({ dealId, lineItemIdOriginal });
  return { key, shouldUpdate: true };
}

