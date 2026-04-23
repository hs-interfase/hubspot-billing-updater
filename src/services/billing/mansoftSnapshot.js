// src/services/billing/mansoftSnapshot.js
//
// Helper para detectar cambios en line items automáticos que disparan
// aviso Mantsoft de EDICIÓN.
//
// Uso:
//   const snap = buildMansoftSnapshot(lineItem);
//   const prev = parseMansoftSnapshot(lineItem.properties.mansoft_ultimo_snapshot);
//   const diff = diffMansoftSnapshots(prev, snap);  // [] si no cambió nada
//
// El snapshot se serializa como JSON y se guarda en la propiedad
// `mansoft_ultimo_snapshot` del line item. Sólo se incluyen las
// propiedades que disparan aviso de edición (watched props), no
// las display-only.

import logger from '../../../lib/logger.js';
import { hubspotClient } from '../../hubspotClient.js';

// ────────────────────────────────────────────────────────────
// Propiedades que disparan aviso de edición
// ────────────────────────────────────────────────────────────

export const MANSOFT_WATCHED_PROPS = [
  'billing_anchor_date',
  'hs_recurring_billing_start_date',
  'price',
  'quantity',
  'hs_discount_percentage',
  'of_iva',
  'of_exonera_irae',
  'of_moneda',
  'recurringbillingfrequency',
  'hs_recurring_billing_frequency',
  'hs_recurring_billing_number_of_payments',
  'renovacion_automatica',
  'description',
  'observaciones',
  'nota',
  'pausa',
];

// Etiquetas legibles para mostrar en el mensaje de edición
export const MANSOFT_PROP_LABELS = {
  billing_anchor_date:                       'Fecha ancla',
  hs_recurring_billing_start_date:           'Inicio de facturación',
  price:                                     'Precio unitario',
  quantity:                                  'Cantidad',
  hs_discount_percentage:                    'Descuento (%)',
  of_iva:                                    'IVA',
  of_exonera_irae:                           'Exonera IRAE',
  of_moneda:                                 'Moneda',
  recurringbillingfrequency:                 'Frecuencia',
  hs_recurring_billing_frequency:            'Frecuencia (HS)',
  hs_recurring_billing_number_of_payments:   'Nro. de pagos',
  renovacion_automatica:                     'Renovación automática',
  description:                               'Descripción',
  observaciones:                             'Observaciones',
  nota:                                      'Nota', 
  pausa:                                     'Pausa',
};

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────

/** Normaliza un valor para comparación estable */
function normalize(v) {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).trim();
  // Fechas que llegan como ISO con time — nos quedamos con YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return s.slice(0, 10);
  return s;
}

// ────────────────────────────────────────────────────────────
// API pública
// ────────────────────────────────────────────────────────────

/**
 * Construye el snapshot del line item con sólo las watched props.
 * @param {Object} lineItem - line item con .properties
 * @returns {Object} snapshot normalizado
 */
export function buildMansoftSnapshot(lineItem) {
  const p = lineItem?.properties || {};
  const snap = {};
  for (const prop of MANSOFT_WATCHED_PROPS) {
    snap[prop] = normalize(p[prop]);
  }
  return snap;
}

/**
 * Parsea un snapshot serializado desde la propiedad del LI.
 * @param {string|null|undefined} raw
 * @returns {Object|null} snapshot parseado, o null si no se puede parsear
 */
export function parseMansoftSnapshot(raw) {
  if (!raw) return null;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object') return parsed;
    return null;
  } catch (err) {
    logger.warn(
      { module: 'mansoftSnapshot', fn: 'parseMansoftSnapshot', err: err?.message },
      'No se pudo parsear mansoft_ultimo_snapshot, se trata como vacío'
    );
    return null;
  }
}

/**
 * Serializa un snapshot para guardarlo en HubSpot.
 * @param {Object} snap
 * @returns {string} JSON string
 */
export function serializeMansoftSnapshot(snap) {
  return JSON.stringify(snap || {});
}

/**
 * Compara dos snapshots y retorna lista de diferencias.
 * @param {Object|null} prev - snapshot anterior (null = primer aviso)
 * @param {Object} curr - snapshot actual
 * @returns {Array<{prop:string, label:string, before:*, after:*}>}
 */
export function diffMansoftSnapshots(prev, curr) {
  if (!prev || typeof prev !== 'object') return [];
  const diffs = [];
  for (const prop of MANSOFT_WATCHED_PROPS) {
    const before = normalize(prev[prop]);
    const after  = normalize(curr?.[prop]);
    if (before !== after) {
      diffs.push({
        prop,
        label: MANSOFT_PROP_LABELS[prop] || prop,
        before,
        after,
      });
    }
  }
  return diffs;
}

/**
 * Indica si el line item ya tiene snapshot previo (i.e. ya fue notificado alguna vez).
 */
export function hasPreviousSnapshot(lineItem) {
  const raw = lineItem?.properties?.mansoft_ultimo_snapshot;
  return !!parseMansoftSnapshot(raw);
}


/**
 * Marca un line item como pendiente de aviso Mantsoft tipo 'baja'.
 *
 * Regla de prioridad de mansoft_tipo_aviso:
 *   baja > alta > edicion > vacío
 *
 * - Si ya está en 'baja' → no hace nada.
 * - Si está en 'alta', 'edicion' o vacío → pisa a 'baja'.
 *
 * La baja se avisa SIEMPRE, haya habido alta previa o no.
 *
 * @param {string|number} lineItemId
 * @param {Object} opts
 * @param {string} [opts.tipoActual] - valor actual de mansoft_tipo_aviso (si se tiene)
 * @returns {Promise<boolean>} true si se actualizó, false si ya estaba en baja
 */
export async function markMansoftBaja(lineItemId, { tipoActual = '' } = {}) {
  const actual = String(tipoActual || '').trim().toLowerCase();

  if (actual === 'baja') {
    logger.debug(
      { module: 'mansoftSnapshot', fn: 'markMansoftBaja', lineItemId },
      'LI ya marcado como baja, no se actualiza'
    );
    return false;
  }

  await hubspotClient.crm.lineItems.basicApi.update(String(lineItemId), {
    properties: {
      mansoft_pendiente: 'true',
      mansoft_tipo_aviso: 'baja',
    },
  });

  logger.info(
    { module: 'mansoftSnapshot', fn: 'markMansoftBaja', lineItemId, tipoAnterior: actual || '(vacío)' },
    'LI marcado como baja Mantsoft'
  );
  return true;
}