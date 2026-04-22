// src/services/billing/buildMensajeMantsoft.js
//
// Construye el HTML rich-text para la propiedad `mensaje_mansoft` del Deal.
//
// Soporta dos tipos de aviso por line item:
//   - 'alta'    → primer aviso, muestra datos completos del contrato
//   - 'edicion' → LI ya avisado, muestra datos base + cambios detectados
//
// Si un deal tiene LIs mezclados, se divide en dos secciones:
//   🆕 ALTAS DE HOY
//   🔄 EDICIONES DE HOY
//
// Si un LI individual tiene tipo='alta' pero además hay diff contra snapshot,
// gana ALTA (el contrato se avisa entero).
//
// Llamado exclusivamente por cronMensajeMantsoft.js.

import logger from '../../../lib/logger.js';
import {
  parseMansoftSnapshot,
  buildMansoftSnapshot,
  diffMansoftSnapshots,
} from './mansoftSnapshot.js';

// ────────────────────────────────────────────────────────────
// Mapeo hs_product_id → empresa emisora
// ────────────────────────────────────────────────────────────

const EMPRESA_EMISORA_MAP = {
  '33688819739': 'ISA',
  '33695807329': 'ISA',
  '33695559578': 'ISA',
  '33688695870': 'ISA',
  '33688695865': 'Interfase',
  '33688819740': 'Interfase',
  '33695559590': 'ISA PY',
  '33688695889': 'ISA PY',
  '33695559589': 'ISA PY',
  '33688943634': 'ISA PY',
};

function resolverEmpresaEmisora(lp) {
  const productId = String(lp.hs_product_id || '').trim();
  return EMPRESA_EMISORA_MAP[productId] || '-';
}

// ────────────────────────────────────────────────────────────
// Helpers de fecha/formato
// ────────────────────────────────────────────────────────────

function todayYMD() {
  const tz = process.env.BILLING_TZ || 'America/Montevideo';
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = dtf.formatToParts(new Date());
  const y = parts.find(p => p.type === 'year')?.value;
  const m = parts.find(p => p.type === 'month')?.value;
  const d = parts.find(p => p.type === 'day')?.value;
  return `${y}-${m}-${d}`;
}

function horaActual() {
  const tz = process.env.BILLING_TZ || 'America/Montevideo';
  return new Date().toLocaleTimeString('es-UY', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
  });
}

function val(v) {
  if (v === null || v === undefined || v === '') return null;
  return String(v).trim();
}

function fmtNum(v) {
  const n = parseFloat(v);
  return isNaN(n) ? '-' : n.toFixed(2);
}

function fmtValDiff(v) {
  // Para mostrar un valor en el diff (before/after). Vacío/null → "(vacío)".
  if (v === null || v === undefined || v === '') return '<em>(vacío)</em>';
  return String(v);
}

// ────────────────────────────────────────────────────────────
// Estilos inline
// ────────────────────────────────────────────────────────────

const STYLES = {
  container:     'font-family:Arial,sans-serif;font-size:14px;color:#333;',
  header:        'font-size:16px;font-weight:bold;color:#1a1a1a;margin-bottom:12px;',
  sectionTitle:  'font-size:15px;font-weight:bold;color:#0056b3;margin:18px 0 8px 0;',
  sectionAlta:   'font-size:15px;font-weight:bold;color:#1a7f37;margin:18px 0 8px 0;',
  sectionEdit:   'font-size:15px;font-weight:bold;color:#9a6700;margin:18px 0 8px 0;',
  sectionBaja:   'font-size:15px;font-weight:bold;color:#b02a2a;margin:18px 0 8px 0;',
  row:           'margin:4px 0;padding:2px 0;',
  label:         'font-weight:bold;color:#555;',
  lineItemDiv:   'background:#f7f9fc;border:1px solid #dde3eb;border-radius:6px;padding:12px;margin:10px 0;',
  lineItemDivAlta: 'background:#f0f9f4;border:1px solid #b3dfc5;border-radius:6px;padding:12px;margin:10px 0;',
  lineItemDivEdit: 'background:#fff8e6;border:1px solid #e6d28a;border-radius:6px;padding:12px;margin:10px 0;',
  lineItemDivBaja: 'background:#fbeeee;border:1px solid #e0b4b4;border-radius:6px;padding:12px;margin:10px 0;',
  lineItemTitle: 'font-size:14px;font-weight:bold;color:#0056b3;margin-bottom:8px;border-bottom:1px solid #dde3eb;padding-bottom:6px;',
  diffTitle:     'font-size:13px;font-weight:bold;color:#9a6700;margin:10px 0 6px 0;',
  diffRow:       'margin:2px 0;padding:2px 0;font-family:monospace;font-size:13px;',
  footer:        'margin-top:16px;padding-top:8px;border-top:1px solid #dde3eb;font-size:12px;color:#888;',
};

// ────────────────────────────────────────────────────────────
// Builders de bloques
// ────────────────────────────────────────────────────────────

function buildRow(label, value) {
  if (value === null) return '';
  return `<div style="${STYLES.row}"><span style="${STYLES.label}">${label}:</span> ${value}</div>`;
}

/**
 * Construye el encabezado del mensaje completo (único por deal/día).
 */
function buildHeader(firstLi, dealName, dealMeta = {}) {
  const lp = firstLi?.properties || {};
  const hoy = todayYMD();

  const empresaEmisora   = resolverEmpresaEmisora(lp);
  const clienteFinal     = val(dealMeta.empresa_que_factura);
  const personaFactura   = val(dealMeta.persona_que_factura);

  const rows = [
    `<div style="${STYLES.container}">`,
    `<div style="${STYLES.header}">📋 Aviso Mantsoft — ${hoy}</div>`,

    `<div style="${STYLES.sectionTitle}">🔹 Datos del negocio</div>`,
    buildRow('Empresa emisora',      empresaEmisora),
    buildRow('Nombre del negocio',   dealName || '-'),
    buildRow('Empresa que factura',  clienteFinal),
    buildRow('Persona que factura',  personaFactura),
    buildRow('Fecha del aviso',      hoy),
  ];

  return rows.filter(r => r !== '').join('\n');
}

/**
 * Construye el bloque de datos base de un line item.
 * Es el mismo bloque que se usaba antes en el mensaje único,
 * ahora reutilizable tanto para 'alta' como para 'edicion'.
 */
function buildLineItemBaseRows(li) {
  const lp = li?.properties || {};

  const total = fmtNum(lp.amount);

  const fechaVenc  = val(lp.fecha_vencimiento_contrato)?.slice(0, 10);
  const freqRaw    = val(lp.recurringbillingfrequency) || val(lp.hs_recurring_billing_frequency);
  const frecuencia = freqRaw || '-';

  const esRenovacion = String(lp.renovacion_automatica || '').toLowerCase() === 'true';
  const tipoLabel    = esRenovacion ? 'Renovación automática' : 'Plan fijo';

  const pagosRestantes = val(lp.pagos_restantes);
  const totalPagos     = val(lp.hs_recurring_billing_number_of_payments);
  const pagosLabel     = (!esRenovacion && pagosRestantes && totalPagos)
    ? `Quedan ${pagosRestantes} / ${totalPagos} pagos`
    : null;

  const fechaAncla  = val(lp.billing_anchor_date)?.slice(0, 10);
  const fechaInicio = val(lp.hs_recurring_billing_start_date)?.slice(0, 10);
  const anclaLabel  = (fechaAncla && fechaAncla !== fechaInicio) ? fechaAncla : null;

  return [
    buildRow('Descripción',           val(lp.description)),
    buildRow('Rubro',                 val(lp.of_rubro) || val(lp.rubro)),
    buildRow('Nota',                  val(lp.nota)),
    buildRow('Unidad de negocio',     val(lp.unidad_de_negocio)),
    buildRow('Precio unitario',       fmtNum(lp.price)),
    buildRow('Cantidad',              fmtNum(lp.quantity)),
    buildRow('Descuento (%)',         fmtNum(lp.hs_discount_percentage)),
    buildRow('Total',                 total),
    buildRow('IVA',                   lp.of_iva === 'true' ? 'Sí' : 'No'),
    buildRow('Moneda',                val(lp.of_moneda)),
    buildRow('Frecuencia',            frecuencia),
    buildRow('Inicio de facturación', fechaInicio),
    buildRow('Fecha ancla',           anclaLabel),
    buildRow('Próxima fecha',         val(lp.billing_next_date)?.slice(0, 10)),
    buildRow('Tipo',                  tipoLabel),
    buildRow('Vencimiento contrato',  esRenovacion ? null : fechaVenc),
    buildRow('Pagos',                 pagosLabel),
    buildRow('Observaciones',         val(lp.observaciones)),
  ].filter(r => r !== '');
}

/** Bloque para LI de alta */
function buildLineItemAltaDiv(li) {
  const lp = li?.properties || {};
  const rows = [
    `<div style="${STYLES.lineItemDivAlta}">`,
    `<div style="${STYLES.lineItemTitle}">🆕 ${val(lp.name) || 'Producto'}</div>`,
    ...buildLineItemBaseRows(li),
    `</div>`,
  ];
  return rows.join('\n');
}

/** Bloque de diff para un LI de edición */
function buildDiffBlock(diffs) {
  if (!diffs || diffs.length === 0) return '';
  const rows = [
    `<div style="${STYLES.diffTitle}">🔄 Cambios detectados:</div>`,
  ];
  for (const d of diffs) {
    rows.push(
      `<div style="${STYLES.diffRow}">• <strong>${d.label}</strong>: ${fmtValDiff(d.before)} → ${fmtValDiff(d.after)}</div>`
    );
  }
  return rows.join('\n');
}

/** Bloque para LI de edición */
function buildLineItemEdicionDiv(li, diffs) {
  const lp = li?.properties || {};
  const rows = [
    `<div style="${STYLES.lineItemDivEdit}">`,
    `<div style="${STYLES.lineItemTitle}">🔄 ${val(lp.name) || 'Producto'}</div>`,
    ...buildLineItemBaseRows(li),
    buildDiffBlock(diffs),
    `</div>`,
  ];
  return rows.filter(r => r !== '').join('\n');
}

/** Bloque para LI de baja */
function buildLineItemBajaDiv(li) {
  const lp = li?.properties || {};
  const rows = [
    `<div style="${STYLES.lineItemDivBaja}">`,
    `<div style="${STYLES.lineItemTitle}">🛑 ${val(lp.name) || 'Producto'}</div>`,
    ...buildLineItemBaseRows(li),
    `</div>`,
  ];
  return rows.join('\n');
}

function buildFooter(count) {
  const hoy = todayYMD();
  return [
    `<div style="${STYLES.footer}">`,
    `Generado automáticamente — ${hoy} ${horaActual()} — ${count} elemento(s) notificado(s)`,
    `</div>`,
    `</div>`,
  ].join('\n');
}

// ────────────────────────────────────────────────────────────
// Clasificación de line items (alta vs edicion)
// ────────────────────────────────────────────────────────────

/**
 * Clasifica cada LI en 'alta' o 'edicion' y calcula el diff si corresponde.
 *
 * Reglas:
 * - tipo explícito 'alta' en el LI  → alta (gana siempre, aunque haya diff)
 * - tipo explícito 'edicion'        → edicion con diff
 * - sin tipo, con snapshot previo   → edicion (fallback defensivo)
 * - sin tipo, sin snapshot previo   → alta (fallback defensivo)
 */
function classifyLineItem(li) {
  const p = li?.properties || {};
  const tipoRaw = String(p.mansoft_tipo_aviso || '').trim().toLowerCase();
  const prevSnap = parseMansoftSnapshot(p.mansoft_ultimo_snapshot);
  const currSnap = buildMansoftSnapshot(li);
  const diffs = diffMansoftSnapshots(prevSnap, currSnap);

  if (tipoRaw === 'baja') return { tipo: 'baja', diffs: [] };
  if (tipoRaw === 'alta') return { tipo: 'alta', diffs: [] };
  if (tipoRaw === 'edicion') return { tipo: 'edicion', diffs };

  // Fallback si no llegó el tipo (p.ej. LI seteado por código viejo)
  if (prevSnap) return { tipo: 'edicion', diffs };
  return { tipo: 'alta', diffs: [] };
}

// ────────────────────────────────────────────────────────────
// Función principal
// ────────────────────────────────────────────────────────────

/**
 * Construye el HTML completo del mensaje Mantsoft a partir de
 * un array de line items.
 *
 * @param {Object[]} lineItems - Array de line items (con properties)
 * @param {string}   dealName
 * @param {Object}   dealMeta  - { empresa_que_factura, persona_que_factura }
 * @returns {string}           - HTML completo, o '' si no hay items
 */
export function buildMensajeMantsoft(lineItems, dealName, dealMeta = {}) {
  if (!lineItems || lineItems.length === 0) {
    logger.warn(
      { module: 'buildMensajeMantsoft', fn: 'buildMensajeMantsoft' },
      'Sin line items para construir mensaje Mantsoft'
    );
    return '';
  }

  // DESPUÉS
  // Clasificar
  const altas    = [];
  const bajas    = [];
  const ediciones = []; // { li, diffs }

  for (const li of lineItems) {
    const { tipo, diffs } = classifyLineItem(li);
    if (tipo === 'alta') {
      altas.push(li);
    } else if (tipo === 'baja') {
      bajas.push(li);
    } else {
      ediciones.push({ li, diffs });
    }
  }

  // Si ediciones sin diffs, descartarlas (no hay nada que avisar realmente).
  // Esto cubre el caso raro donde alguien seteó mansoft_pendiente=true manualmente
  // sin cambios reales en watched props.
  const edicionesConDiff = ediciones.filter(e => e.diffs.length > 0);

  const totalNotificados = altas.length + bajas.length + edicionesConDiff.length;
  if (totalNotificados === 0) {
    logger.info(
      { module: 'buildMensajeMantsoft', fn: 'buildMensajeMantsoft', dealName },
      'No hay altas, bajas ni ediciones con diff — mensaje vacío'
    );
    return '';
  }

  const header = buildHeader(lineItems[0], dealName, dealMeta);

  const parts = [header];

  if (altas.length > 0) {
    parts.push(`<div style="${STYLES.sectionAlta}">🆕 Altas de hoy (${altas.length})</div>`);
    for (const li of altas) {
      parts.push(buildLineItemAltaDiv(li));
    }
  }

  if (bajas.length > 0) {
    parts.push(`<div style="${STYLES.sectionBaja}">🛑 Bajas de hoy (${bajas.length})</div>`);
    for (const li of bajas) {
      parts.push(buildLineItemBajaDiv(li));
    }
  }

  if (edicionesConDiff.length > 0) {
    parts.push(`<div style="${STYLES.sectionEdit}">🔄 Ediciones de hoy (${edicionesConDiff.length})</div>`);
    for (const { li, diffs } of edicionesConDiff) {
      parts.push(buildLineItemEdicionDiv(li, diffs));
    }
  }

  parts.push(buildFooter(totalNotificados));

  return parts.join('\n');
}