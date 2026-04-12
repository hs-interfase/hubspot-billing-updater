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
function resolverFrecuencia(lp) {
  const freq = val(lp.recurringbillingfrequency) || val(lp.hs_recurring_billing_frequency);
  if (!freq) return '-';
  const map = {
    monthly:   'Mensual',
    quarterly: 'Trimestral',
    annually:  'Anual',
    weekly:    'Semanal',
    one_time:  'Único',
  };
  return map[freq.toLowerCase()] || freq;
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
function buildHeader(firstLi, dealName) {
  const lp = firstLi?.properties || {};
  const hoy = todayYMD();

  const rows = [
    `<div style="${STYLES.container}">`,
    `<div style="${STYLES.header}">⚡ Facturación Automática Mantsoft — ${hoy}</div>`,

    `<div style="${STYLES.sectionTitle}">🔹 Datos del negocio</div>`,
    buildRow('Negocio', dealName || '-'),
    buildRow('Cliente principal', val(lp.nombre_empresa)),
    buildRow('Empresa que factura', val(lp.empresa_que_factura)),
    buildRow('Persona que factura', val(lp.persona_que_factura)),

    `<div style="${STYLES.sectionTitle}">🔹 Datos de facturación</div>`,
    buildRow('Moneda', val(lp.of_moneda) || val(lp.deal_currency_code)),
    buildRow('Fecha de factura', hoy),

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

  // Calcular total: price * quantity si no hay amount
  const price = parseFloat(lp.price);
  const qty   = parseFloat(lp.quantity);
  const total = !isNaN(price) && !isNaN(qty) ? (price * qty).toFixed(2) : fmtNum(lp.amount);

  const rows = [
    `<div style="${STYLES.lineItemDiv}">`,
    `<div style="${STYLES.lineItemTitle}">${val(lp.name) || 'Producto'}</div>`,
    buildRow('Descripción', val(lp.description)),
    buildRow('Rubro', val(lp.of_rubro) || val(lp.rubro)),
    buildRow('Unidad de negocio', val(lp.unidad_de_negocio)),
    buildRow('Precio unitario', fmtNum(lp.price)),
    buildRow('Cantidad', fmtNum(lp.quantity)),
    buildRow('Descuento (%)', fmtNum(lp.hs_discount_percentage)),
    buildRow('Total', total),
    buildRow('IVA', lp.of_iva === 'true' ? 'Sí' : 'No'),
    buildRow('Frecuencia', frecuencia),
    buildRow('Próxima fecha', val(lp.billing_next_date)?.slice(0, 10)),
    buildRow('Vencimiento contrato', val(lp.fecha_vencimiento_contrato)?.slice(0, 10)),
    buildRow('Pagos restantes', val(lp.pagos_restantes)),
    buildRow('Renovación automática', lp.renovacion_automatica === 'true' ? 'Sí' : null),
    buildRow('Observaciones', val(lp.observaciones_ventas) || val(lp.nota)),
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
export function buildMensajeMantsoft(lineItems, dealName) {
  if (!lineItems || lineItems.length === 0) {
    logger.warn(
      { module: 'buildMensajeMantsoft', fn: 'buildMensajeMantsoft' },
      'Sin line items para construir mensaje Mantsoft'
    );
    return '';
  }

  const header       = buildHeader(lineItems[0], dealName);
  const lineItemDivs = lineItems.map(li => buildLineItemDiv(li)).join('\n');
  const footer       = buildFooter(lineItems.length);

  return header + '\n' + lineItemDivs + '\n' + footer;
}