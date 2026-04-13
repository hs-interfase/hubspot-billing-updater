// src/services/billing/buildMensajeFacturacion.js
//
// Construye el HTML rich-text para la propiedad `mensaje_de_facturacion` del Deal.
//
// v2 — Batch: recibe un array de tickets y construye el mensaje completo
// de una sola pasada. Elimina toda la lógica de acumulación incremental,
// race conditions y optimistic locking.
//
// Llamado exclusivamente por cronMensajeFacturacion.js después de agrupar
// todos los tickets READY de un deal.

import { TICKET_PIPELINE } from '../../config/constants.js';
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

/** Si el valor es null/undefined/vacío, retorna null; si no, retorna el string */
function val(v) {
  if (v === null || v === undefined || v === '') return null;
  return String(v).trim();
}

/** Formatea un número a 2 decimales, o retorna '-' si no es numérico */
function fmtNum(v) {
  const n = parseFloat(v);
  return isNaN(n) ? '-' : n.toFixed(2);
}

/** Resuelve la frecuencia para mostrar en el mensaje */
function resolverFrecuencia(ticket) {
  const tp = ticket?.properties || {};
  const frecuencia = val(tp.of_frecuencia_de_facturacion);
  const pipeline = val(tp.hs_pipeline);

  if (frecuencia === 'Irregular' || frecuencia === 'Único') return frecuencia;

  if (pipeline === TICKET_PIPELINE && frecuencia !== 'Único') {
    return 'Irregular';
  }

  return frecuencia || '-';
}

// ────────────────────────────────────────────────────────────
// Estilos inline (compatibles con email HubSpot)
// ────────────────────────────────────────────────────────────

const STYLES = {
  container: 'font-family:Arial,sans-serif;font-size:14px;color:#333;',
  header: 'font-size:16px;font-weight:bold;color:#1a1a1a;margin-bottom:12px;',
  sectionTitle: 'font-size:14px;font-weight:bold;color:#0056b3;margin:16px 0 8px 0;',
  row: 'margin:4px 0;padding:2px 0;',
  label: 'font-weight:bold;color:#555;',
  lineItemDiv: 'background:#f7f9fc;border:1px solid #dde3eb;border-radius:6px;padding:12px;margin:10px 0;',
  lineItemTitle: 'font-size:14px;font-weight:bold;color:#0056b3;margin-bottom:8px;border-bottom:1px solid #dde3eb;padding-bottom:6px;',
  separator: 'border:0;border-top:1px solid #eee;margin:12px 0;',
  footer: 'margin-top:16px;padding-top:8px;border-top:1px solid #dde3eb;font-size:12px;color:#888;',
};

// ────────────────────────────────────────────────────────────
// Builders
// ────────────────────────────────────────────────────────────

function buildRow(label, value) {
  if (value === null) return '';
  return `<div style="${STYLES.row}"><span style="${STYLES.label}">${label}:</span> ${value}</div>`;
}

/**
 * Construye el encabezado del mensaje usando datos del primer ticket.
 */
function buildHeader(firstTicket, dealName, dealMeta = {}) {
  const tp = firstTicket?.properties || {};
  const hoy = todayYMD();

  const rows = [
    `<div style="${STYLES.container}">`,
    `<div style="${STYLES.header}">📋 Solicitud de Facturación — ${hoy}</div>`,

    `<div style="${STYLES.sectionTitle}">🔹 Datos del negocio</div>`,
    buildRow('Negocio', dealName || '-'),
    buildRow('Cliente', val(tp.nombre_empresa)),
    buildRow('Empresa que factura', val(dealMeta.empresa_que_factura)),
    buildRow('Persona que factura', val(dealMeta.persona_que_factura)),
    buildRow('Fecha de factura', hoy),

    `<hr style="${STYLES.separator}">`,
    `<div style="${STYLES.sectionTitle}">🔹 Detalle de productos</div>`,
  ];

  return rows.filter(r => r !== '').join('\n');
}

/**
 * Construye el div de un line item individual.
 */
function buildLineItemDiv(ticket) {
  const tp = ticket?.properties || {};
  const frecuencia = resolverFrecuencia(ticket);

  const rows = [
    `<div style="${STYLES.lineItemDiv}">`,
    `<div style="${STYLES.lineItemTitle}">${val(tp.of_producto_nombres) || 'Producto'}</div>`,
    buildRow('Descripción', val(tp.of_descripcion_producto)),
    buildRow('Rubro', val(tp.of_rubro)),
    buildRow('Unidad de negocio', val(tp.unidad_de_negocio)),
    buildRow('Moneda', val(tp.of_moneda)),
    buildRow('Cantidad', fmtNum(tp.cantidad_real)),
    buildRow('Subtotal', fmtNum(tp.subtotal_real)),
    buildRow('Total a facturar', fmtNum(tp.total_real_a_facturar)),
    buildRow('Frecuencia', frecuencia),
    buildRow('Observaciones', val(tp.observaciones_ventas)),
    `</div>`,
  ];

  return rows.filter(r => r !== '').join('\n');
}

function buildFooter(ticketIds) {
  const hoy = todayYMD();
  return [
    `<div style="${STYLES.footer}">`,
`Generado automáticamente — ${hoy} ${horaActual()} — ${ticketIds.length} elemento(s) de pedido`,    `</div>`,
    `</div>`,
  ].join('\n');
}

// ────────────────────────────────────────────────────────────
// Función principal (batch)
// ────────────────────────────────────────────────────────────

/**
 * Construye el HTML completo del mensaje de facturación a partir de
 * un array de tickets.
 *
 * @param {Object[]} tickets  - Array de tickets (con properties)
 * @param {string}   dealName - Nombre del deal (para el encabezado)
 * @returns {string}          - HTML completo
 */

export function buildMensajeFacturacion(tickets, dealName, dealMeta = {}) {
  if (!tickets || tickets.length === 0) return '';

  const header = buildHeader(tickets[0], dealName, dealMeta);
  const lineItemDivs = tickets.map(t => buildLineItemDiv(t)).join('\n');
  const ticketIds = tickets.map(t => t.id || t.properties?.hs_object_id || '?');
  const footer = buildFooter(ticketIds);

  return header + '\n' + lineItemDivs + '\n' + footer;
}

// ── Legacy export (mantener compatibilidad temporal) ──
// Si alguien todavía llama actualizarMensajeFacturacion, loguea warning
export async function actualizarMensajeFacturacion(ticket, dealId) {
  logger.warn(
    {
      module: 'buildMensajeFacturacion',
      fn: 'actualizarMensajeFacturacion',
      dealId,
      ticketId: ticket?.id,
    },
    '⚠️ actualizarMensajeFacturacion LEGACY llamada — esta función ya no se usa, el cron se encarga'
  );
}