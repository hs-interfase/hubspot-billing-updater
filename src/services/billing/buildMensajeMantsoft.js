// src/services/billing/buildMensajeMantsoft.js
//
// Construye el HTML rich-text para la propiedad `mensaje_de_facturacion` del Deal,
// orientado a line items automáticos de Mantsoft (facturacion_automatica=true,
// mansoft_pendiente=true).
//
// A diferencia de buildMensajeFacturacion (que recibe tickets),
// este recibe line items directamente.
// Llamado exclusivamente por cronMensajeMantsoft.js.

import logger from '../../../lib/logger.js';

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────

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
  return new Date().toLocaleTimeString('es-UY', { timeZone: tz, hour: '2-digit', minute: '2-digit' });
}

/** Si el valor es null/undefined/vacío retorna null; si no, retorna el string */
function val(v) {
  if (v === null || v === undefined || v === '') return null;
  return String(v).trim();
}

/** Formatea número a 2 decimales o retorna '-' */
function fmtNum(v) {
  const n = parseFloat(v);
  return isNaN(n) ? '-' : n.toFixed(2);
}

/** Resuelve frecuencia legible desde propiedades del line item */

const FREQ_MAP = {
  weekly:          'Semanal',
  biweekly:        'Quincenal',
  monthly:         'Mensual',
  quarterly:       'Trimestral',
  per_six_months:  'Semestral',
  annually:        'Anual',
  per_two_years:   'Cada 2 años',
  per_three_years: 'Cada 3 años',
  per_four_years:  'Cada 4 años',
  per_five_years:  'Cada 5 años',
};

function resolverFrecuencia(lp) {
  const freq = val(lp.recurringbillingfrequency) || val(lp.hs_recurring_billing_frequency);
  if (!freq) return 'Único';
  return FREQ_MAP[freq.toLowerCase()] || freq;
}

// ────────────────────────────────────────────────────────────
// Estilos inline (compatibles con email HubSpot)
// ────────────────────────────────────────────────────────────

const STYLES = {
  container:     'font-family:Arial,sans-serif;font-size:14px;color:#333;',
  header:        'font-size:16px;font-weight:bold;color:#1a1a1a;margin-bottom:12px;',
  sectionTitle:  'font-size:14px;font-weight:bold;color:#0056b3;margin:16px 0 8px 0;',
  row:           'margin:4px 0;padding:2px 0;',
  label:         'font-weight:bold;color:#555;',
  lineItemDiv:   'background:#f7f9fc;border:1px solid #dde3eb;border-radius:6px;padding:12px;margin:10px 0;',
  lineItemTitle: 'font-size:14px;font-weight:bold;color:#0056b3;margin-bottom:8px;border-bottom:1px solid #dde3eb;padding-bottom:6px;',
  separator:     'border:0;border-top:1px solid #eee;margin:12px 0;',
  footer:        'margin-top:16px;padding-top:8px;border-top:1px solid #dde3eb;font-size:12px;color:#888;',
};

// ────────────────────────────────────────────────────────────
// Builders
// ────────────────────────────────────────────────────────────

function buildRow(label, value) {
  if (value === null) return '';
  return `<div style="${STYLES.row}"><span style="${STYLES.label}">${label}:</span> ${value}</div>`;
}

/**
 * Encabezado del mensaje usando datos del primer line item.
 */
function buildHeader(firstLi, dealName, dealMeta = {}) {
  const lp = firstLi?.properties || {};
  const hoy = todayYMD();

  const empresaEmisora = resolverEmpresaEmisora(lp);

  const rows = [
    `<div style="${STYLES.container}">`,
    `<div style="${STYLES.header}">⚡ Facturación Automática — Mantsoft — ${hoy}</div>`,

    `<div style="${STYLES.sectionTitle}">🔹 Datos del negocio</div>`,
    buildRow('Empresa emisora',     empresaEmisora),
    buildRow('Negocio',             dealName || '-'),
    buildRow('Cliente final',       val(lp.nombre_empresa)),
    buildRow('Cliente que factura', val(dealMeta.empresa_que_factura)),
    buildRow('Persona que factura', val(dealMeta.persona_que_factura)),
    buildRow('Moneda',              val(lp.of_moneda) || val(lp.deal_currency_code)),
    buildRow('Fecha de factura',    hoy),

    `<hr style="${STYLES.separator}">`,
    `<div style="${STYLES.sectionTitle}">🔹 Detalle de productos</div>`,
  ];

  return rows.filter(r => r !== '').join('\n');
}

/**
 * Div de un line item individual.
 */
function buildLineItemDiv(li) {
  const lp = li?.properties || {};
  const frecuencia = resolverFrecuencia(lp);

  const price = parseFloat(lp.price);
  const qty   = parseFloat(lp.quantity);
  const total = !isNaN(price) && !isNaN(qty) ? (price * qty).toFixed(2) : fmtNum(lp.amount);

  // Tipo: prioridad a la propiedad renovacion_automatica del line item;
  // si está vacía, cae a la lógica de fecha_vencimiento_contrato
  const renovacionProp = val(lp.renovacion_automatica);
  const fechaVenc      = val(lp.fecha_vencimiento_contrato)?.slice(0, 10);
  const esRenovacion   = renovacionProp === 'true' || (!renovacionProp && fechaVenc === '2099-12-31');
  const tipoLabel      = esRenovacion ? 'Renovación automática' : 'Plan fijo';

  // Pagos: solo plan fijo
  const pagosRestantes = val(lp.pagos_restantes);
  const totalPagos     = val(lp.hs_recurring_billing_number_of_payments);
  const pagosLabel     = (!esRenovacion && pagosRestantes && totalPagos)
    ? `Quedan ${pagosRestantes} / ${totalPagos} pagos`
    : null;

  // Fecha ancla: solo si difiere de fecha inicio
  const fechaAncla  = val(lp.billing_anchor_date)?.slice(0, 10);
  const fechaInicio = val(lp.hs_recurring_billing_start_date)?.slice(0, 10);
  const anclaLabel  = (fechaAncla && fechaAncla !== fechaInicio) ? fechaAncla : null;

  const rows = [
    `<div style="${STYLES.lineItemDiv}">`,
    `<div style="${STYLES.lineItemTitle}">${val(lp.name) || 'Producto'}</div>`,
    buildRow('Descripción',          val(lp.description)),
    buildRow('Rubro',                val(lp.of_rubro) || val(lp.rubro)),
    buildRow('Nota',                 val(lp.nota)),
    buildRow('Unidad de negocio',    val(lp.unidad_de_negocio)),
    buildRow('Precio unitario',      fmtNum(lp.price)),
    buildRow('Cantidad',             fmtNum(lp.quantity)),
    buildRow('Descuento (%)',        fmtNum(lp.hs_discount_percentage)),
    buildRow('Total',                total),
    buildRow('IVA',                  lp.of_iva === 'true' ? 'Sí' : 'No'),
    buildRow('Frecuencia',           frecuencia),
    buildRow('Inicio de facturación', fechaInicio),
    buildRow('Fecha ancla',          anclaLabel),
    buildRow('Próxima fecha',        val(lp.billing_next_date)?.slice(0, 10)),
    buildRow('Tipo',                 tipoLabel),
    buildRow('Vencimiento contrato', esRenovacion ? null : fechaVenc),
    buildRow('Pagos',                pagosLabel),
    buildRow('Observaciones',        val(lp.observaciones)),
    `</div>`,
  ];

  return rows.filter(r => r !== '').join('\n');
}

function buildFooter(count) {
  const hoy = todayYMD();
  return [
    `<div style="${STYLES.footer}">`,
    `Generado automáticamente — ${hoy} ${horaActual()} — ${count} elemento(s) a facturar`,
    `</div>`,
    `</div>`,
  ].join('\n');
}

// ────────────────────────────────────────────────────────────
// Función principal
// ────────────────────────────────────────────────────────────

/**
 * Construye el HTML completo del mensaje Mantsoft a partir de
 * un array de line items.
 *
 * @param {Object[]} lineItems - Array de line items (con properties)
 * @param {string}   dealName  - Nombre del deal (para el encabezado)
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

  const header = buildHeader(lineItems[0], dealName, dealMeta);
  const lineItemDivs = lineItems.map(li => buildLineItemDiv(li)).join('\n');
  const footer       = buildFooter(lineItems.length);

  return header + '\n' + lineItemDivs + '\n' + footer;
}