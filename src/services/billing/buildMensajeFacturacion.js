// src/services/billing/buildMensajeFacturacion.js
//
// Construye el HTML rich-text para la propiedad `mensaje_de_facturacion` del Deal.
//
// v3 — Empresa emisora por product_id, nuevo header con cliente final + cliente que factura,
//       orden de campos según requerimiento de Victoria.

import { TICKET_PIPELINE } from '../../config/constants.js';
import logger from '../../../lib/logger.js';
import { buildTicketUrl } from '../../utils/hubspotPortal.js';
import { EMPRESA_EMISORA_MAP } from './empresaEmisora.js'; // dedupe con buildMensajeMantsoft

// SHOW_NULLS quedó sin uso el 4-ago-2026: las filas sin dato ahora se muestran
// SIEMPRE (ver buildRow), así que el flag de debug ya no hace falta.

// EMPRESA_EMISORA_MAP → importado de ./empresaEmisora.js (dedupe con buildMensajeMantsoft, 2026-07-09)

function esUrgente(ticket) {
  return String(ticket?.properties?.facturacion_urgente || '')
    .trim().toLowerCase() === 'true';
}

/**
 * ¿Es NOTA DE CRÉDITO? Se detecta por el SIGNO del ticket (cantidad o subtotal
 * negativos, el modelo de NC), con el flag `nc` copiado del LI como respaldo.
 * Mismo criterio que consumeCupo / el aviso al mirror.
 */
function esNotaCredito(ticket) {
  const tp = ticket?.properties || {};
  const cant = parseFloat(tp.cantidad_real);
  const sub = parseFloat(tp.subtotal_real);
  const porSigno = (Number.isFinite(cant) && cant < 0) || (Number.isFinite(sub) && sub < 0);
  const porFlag = String(tp.nc || '').trim().toLowerCase() === 'true';
  return porSigno || porFlag;
}

/**
 * Determina la empresa emisora según el product_id del ticket.
 * Usa `producto_id` (snapshotteado desde hs_product_id del line item).
 */
function resolverEmpresaEmisora(ticket) {
  const tp = ticket?.properties || {};
  const productId = String(tp.producto_id || '').trim();
  return EMPRESA_EMISORA_MAP[productId] || '-';
}

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

/** Formatea un número a 2 decimales, o retorna null si no es numérico */
function fmtNum(v) {
  const n = parseFloat(v);
  return isNaN(n) ? null : n.toFixed(2);
}

/**
 * Fecha en DÍA/MES/AÑO (pedido de la usuaria, 4-ago-2026).
 * Entra `2026-08-04` (o un ISO con hora) y sale `04/08/2026`.
 * Si no matchea el formato esperado, devuelve el valor tal cual.
 */
function fmtFecha(v) {
  const s = val(v);
  if (s === null) return null;
  const m = s.slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : s;
}

/** ¿El rubro es "Otro"? Entonces el detalle viene en `nota`. */
function rubroEsOtro(v) {
  return String(val(v) || '').toLowerCase().startsWith('otro');
}

/** Booleano 'true'/'false' → 'Sí'/'No' (null si no hay dato) */
function fmtBoolSiNo(v) {
  const s = val(v);
  if (s === null) return null;
  const t = s.toLowerCase();
  if (t === 'true' || t === 'sí' || t === 'si') return 'Sí';
  if (t === 'false' || t === 'no') return 'No';
  return s;
}

/** exonera_irae: true → 'Exento', false → 'Aplica' (null si no hay dato) */
function fmtIrae(v) {
  const s = val(v);
  if (s === null) return null;
  const t = s.toLowerCase();
  if (t === 'true' || t === 'sí' || t === 'si') return 'Exento';
  if (t === 'false' || t === 'no') return 'Aplica';
  return s;
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

  return frecuencia || null;
}

// ────────────────────────────────────────────────────────────
// Estilos inline (compatibles con email HubSpot)
// ────────────────────────────────────────────────────────────

const STYLES = {
  container: 'font-family:Arial,sans-serif;font-size:14px;color:#333;',
  header: 'font-size:16px;font-weight:bold;color:#1a1a1a;margin-bottom:12px;',
  sectionTitle: 'font-size:14px;font-weight:bold;color:#0056b3;margin:16px 0 8px 0;',
  urgentBanner: 'background:#fff3e0;border:1px solid #ff9800;border-radius:6px;padding:10px 12px;margin:10px 0;color:#b35900;font-weight:bold;',
  lineItemDivUrgent: 'background:#fff8f0;border:2px solid #ff9800;border-radius:6px;padding:12px;margin:10px 0;',
  urgentBadge: 'color:#e65100;font-weight:bold;',
  ncBanner: 'background:#fdecef;border:1px solid #e0356b;border-radius:6px;padding:10px 12px;margin:10px 0;color:#a81e4d;font-weight:bold;',
  lineItemDivNC: 'background:#fdf2f5;border:2px solid #e0356b;border-radius:6px;padding:12px;margin:10px 0;',
  ncBadge: 'color:#c81e5b;font-weight:bold;',
  row: 'margin:4px 0;padding:2px 0;',
  label: 'font-weight:bold;color:#555;',
  lineItemDiv: 'background:#f7f9fc;border:1px solid #dde3eb;border-radius:6px;padding:12px;margin:10px 0;',
  lineItemTitle: 'font-size:14px;font-weight:bold;color:#0056b3;margin-bottom:8px;border-bottom:1px solid #dde3eb;padding-bottom:6px;',
  separator: 'border:0;border-top:1px solid #eee;margin:12px 0;',
  footer: 'margin-top:16px;padding-top:8px;border-top:1px solid #dde3eb;font-size:12px;color:#888;',
  nullVal: 'color:#b0b0b0;font-style:italic;',
  link: 'color:#0056b3;text-decoration:underline;',
};

// ────────────────────────────────────────────────────────────
// Builders
// ────────────────────────────────────────────────────────────

/**
 * Una fila del mensaje. LA ETIQUETA SIEMPRE SE MUESTRA.
 *
 * Decisión de la usuaria (4-ago-2026), que revierte el criterio anterior de
 * esconder las filas sin dato: hay que ver que el campo existe y que vino vacío.
 * O sea «Rubro:» a secas, no la ausencia de la fila ni un "(sin datos)".
 */
function buildRow(label, value) {
  const v = (value === null || value === undefined || value === '') ? '' : value;
  return `<div style="${STYLES.row}"><span style="${STYLES.label}">${label}:</span> ${v}</div>`;
}

// Alias histórico: antes distinguía "esta fila va sí o sí" de las demás. Ahora
// todas van siempre, así que es lo mismo. Se mantiene para no tocar call sites.
const buildRowAlways = buildRow;

/**
 * Fila que SÓLO aparece si tiene contenido — la excepción a la regla de arriba.
 * Se usa para los campos que la usuaria no quiere ver salvo en el caso raro en
 * que traigan algo (4-ago-2026).
 */
function buildRowSiTiene(label, value) {
  if (value === null || value === undefined || value === '') return '';
  return buildRow(label, value);
}

/**
 * Construye el encabezado del mensaje.
 *
 * - Empresa emisora: resuelta por product_id del primer ticket
 *   (si todos los tickets son del mismo producto; si hay mix, se toma el primero)
 * - Cliente final: nombre_empresa + empresa_id del ticket (beneficiario)
 * - Cliente que factura: company typeId=9 del deal (quien paga)
 * - Moneda: del deal (todos los tickets de un deal tienen la misma moneda)
 */
function buildHeader(firstTicket, dealName, dealMeta = {}) {
  const tp = firstTicket?.properties || {};
  const hoy = todayYMD();

  // ENTIDAD FACTURADORA (quién emite la factura). La fuente de verdad es la prop
  // `entidad_facturadora` del ticket (valores del select: 'Interfase UY | ISA UY |
  // ISA PY | Interfase PY'); si todavía no llegó, se cae al mapa por producto.
  const entidadFacturadora = val(tp.entidad_facturadora) || resolverEmpresaEmisora(firstTicket);

  // Cliente final (beneficiario): viene snapshotteado en el ticket
  const clienteFinalNombre = val(tp.nombre_empresa);
  const clienteFinalId     = val(tp.empresa_id);
  const clienteFinalLabel  = clienteFinalNombre
    ? `${clienteFinalNombre}${clienteFinalId ? ` (ID: ${clienteFinalId})` : ''}`
    : null;

  // Cliente que factura (quien paga): viene del dealMeta resuelto por typeId=9
  const clienteFacturaNombre = val(dealMeta.empresa_que_factura);
  const clienteFacturaId     = val(dealMeta.empresa_que_factura_id);
  const clienteFacturaLabel  = clienteFacturaNombre
    ? `${clienteFacturaNombre}${clienteFacturaId ? ` (ID: ${clienteFacturaId})` : ''}`
    : null;

  // ── Encabezado = los 4 campos de NEGOCIO de la lista (5-ago-2026) ──────────
  // La moneda y la fecha esperada se fueron al bloque del ítem: son de cada
  // ticket, no del negocio. Tomarlas del primero mentía cuando un negocio tenía
  // varios tickets con distinta fecha.
  const rows = [
    `<div style="${STYLES.container}">`,
    `<div style="${STYLES.header}">📋 Solicitud de Facturación — ${fmtFecha(hoy)}</div>`,

    `<div style="${STYLES.sectionTitle}">🔹 Datos del negocio</div>`,
    buildRowAlways('Entidad facturadora', entidadFacturadora),
    buildRow('Nombre del negocio',        dealName || '-'),
    buildRow('Empresa Principal',         clienteFinalLabel),
    buildRowAlways('Cliente Factura',     clienteFacturaLabel),

    `<hr style="${STYLES.separator}">`,
    `<div style="${STYLES.sectionTitle}">🔹 Detalle de productos</div>`,
  ];

  return rows.filter(r => r !== '').join('\n');
}

/**
 * Construye el div de un line item individual.
 * Orden según requerimiento de Victoria:
 * nombre → descripción → rubro → unidad de negocio →
 * cantidad → subtotal → total → frecuencia → observaciones
 */
function buildLineItemDiv(ticket, portalId = null) {
  const tp = ticket?.properties || {};
  const frecuencia = resolverFrecuencia(ticket);
  const urgente = esUrgente(ticket);
  const nc = esNotaCredito(ticket);

  const ticketId  = ticket?.id || tp.hs_object_id || null;
  const ticketUrl = buildTicketUrl(portalId, ticketId);
  const ticketLink = ticketUrl
    ? `<a href="${ticketUrl}" style="${STYLES.link}">Ver ticket #${ticketId}</a>`
    : null;

  const divStyle = nc ? STYLES.lineItemDivNC : (urgente ? STYLES.lineItemDivUrgent : STYLES.lineItemDiv);

  const rows = [
    `<div style="${divStyle}">`,
    `<div style="${STYLES.lineItemTitle}">${val(tp.of_producto_nombres) || 'Producto'}${
      nc ? ` — <span style="${STYLES.ncBadge}">↩️ NOTA DE CRÉDITO</span>` : ''
    }${
      urgente ? ` — <span style="${STYLES.urgentBadge}">⚡ FACTURACIÓN URGENTE</span>` : ''
    }</div>`,
    // ── El ORDEN de acá abajo es el de la lista del 5-ago-2026 ───────────────
    // (campos 5 a 18: los 4 primeros son del negocio y salen en el encabezado).
    // ⚠️ Ese orden pone CANTIDAD antes que PRECIO UNITARIO, o sea al revés de
    // lo que se había pedido el 4-ago. Manda la lista nueva.
    buildRow('Fecha de facturación esperada', fmtFecha(tp.fecha_resolucion_esperada)),
    buildRow('Descripción del ticket',    val(tp.content)),
    buildRow('Rubro',                     val(tp.of_rubro)),
    // La nota sólo tiene sentido cuando el rubro es "Otro": ahí va el detalle.
    // No está en la lista, pero se queda pegada al rubro, que es donde sirve.
    rubroEsOtro(tp.of_rubro) ? buildRow('Nota', val(tp.nota)) : '',
    buildRow('Área',                      val(tp.area)),
    buildRow('Moneda',                    val(tp.of_moneda)),
    buildRow('Cantidad',                  fmtNum(tp.cantidad_real)),
    buildRow('Precio unitario',           fmtNum(tp.monto_unitario_real)),
    // subtotal_real NO lleva IVA; total_real_a_facturar SÍ (calculada en HubSpot).
    buildRow('Monto total',               fmtNum(tp.subtotal_real)),
    buildRow('IVA',                       fmtBoolSiNo(tp.of_iva)),
    buildRow('Monto total con impuestos', fmtNum(tp.total_real_a_facturar)),
    buildRow('IRAE',                      fmtIrae(tp.exonera_irae)),
    buildRow('Opera Trading',             fmtBoolSiNo(tp.opera_trading)),
    buildRow('Condición de Pago',         val(tp.condicion_de_pago)),
    buildRow('Observaciones',             val(tp.observaciones)),

    // ── Fuera de la lista: se dejan porque ya se venían mandando ─────────────
    buildRow('Producto',                  val(tp.of_producto) || val(tp.of_producto_nombres)),
    buildRow('Unidad de Negocio',         val(tp.unidad_de_negocio)),
    buildRow('Descripción del producto',  val(tp.of_descripcion_producto)),
    // Distinta de la esperada de arriba: ésta es el inicio de facturación del LI.
    buildRow('Fecha de inicio de facturación', fmtFecha(tp.fecha_inicio_de_facturacion)),
    buildRow('Ticket',                    ticketLink),
    `</div>`,
  ];

  return rows.filter(r => r !== '').join('\n');
}

function buildFooter(ticketIds) {
  const hoy = todayYMD();
  return [
    `<div style="${STYLES.footer}">`,
    `Generado automáticamente — ${fmtFecha(hoy)} ${horaActual()} — ${ticketIds.length} elemento(s) de pedido`,
    `</div>`,
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
 * @param {Object}   dealMeta - { empresa_que_factura, empresa_que_factura_id, persona_que_factura }
 * @returns {string}          - HTML completo
 */
export function buildMensajeFacturacion(tickets, dealName, dealMeta = {}) {
  if (!tickets || tickets.length === 0) return '';

  const urgentes = tickets.filter(esUrgente).length;
  const banner = urgentes > 0
    ? `<div style="${STYLES.urgentBanner}">⚡ Esta solicitud incluye ${urgentes} ítem(s) de FACTURACIÓN URGENTE solicitada manualmente desde el contrato.</div>`
    : '';

  const ncs = tickets.filter(esNotaCredito).length;
  const ncBanner = ncs > 0
    ? `<div style="${STYLES.ncBanner}">↩️ Esta solicitud incluye ${ncs} NOTA(S) DE CRÉDITO — se emiten en negativo y, si la línea consumía cupo, se lo devuelven al negocio.</div>`
    : '';

  const portalId     = dealMeta.portalId || null;
  const header       = buildHeader(tickets[0], dealName, dealMeta);
  const lineItemDivs = tickets.map(t => buildLineItemDiv(t, portalId)).join('\n');
  const ticketIds    = tickets.map(t => t.id || t.properties?.hs_object_id || '?');
  const footer       = buildFooter(ticketIds);

  return header
    + (ncBanner ? '\n' + ncBanner : '')
    + (banner ? '\n' + banner : '')
    + '\n' + lineItemDivs + '\n' + footer;
}

// ── Legacy export (mantener compatibilidad temporal) ──
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














/*


// src/services/billing/buildMensajeFacturacion.js
//
// Construye el HTML rich-text para la propiedad `mensaje_de_facturacion` del Deal.
//
// v3 — Batch: recibe un array de tickets y construye el mensaje completo
// de una sola pasada.
//
// Llamado exclusivamente por cronMensajeFacturacion.js después de agrupar
// todos los tickets READY de un deal.

import { TICKET_PIPELINE } from '../../config/constants.js';
import logger from '../../../lib/logger.js';

// ────────────────────────────────────────────────────────────
// Mapa producto_id → empresa facturante
// ────────────────────────────────────────────────────────────

const EMPRESA_POR_PRODUCTO = {
  '33688819740': 'Interfase',     // iSCert
  '33688695865': 'Interfase',     // PayRoll
  '33695559578': 'ISA',           // Flota
  '33688695870': 'ISA',           // iJServ
  '33688819739': 'ISA',           // iGDoc
  '33695807329': 'ISA',           // Portal
  '33688695889': 'ISA PY',        // MiRecibo
  '33695559589': 'ISA PY',        // MiFactura
  '33695559590': 'ISA PY',        // i2
  '33688943634': 'ISA Proyectos', // Proyectos
};

function resolverEmpresa(ticket) {
  const productoId = val(ticket?.properties?.producto_id);
  if (!productoId) return 'ISA PY';
  return EMPRESA_POR_PRODUCTO[productoId] ?? 'ISA PY';
}

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

function val(v) {
  if (v === null || v === undefined || v === '') return null;
  return String(v).trim();
}

function fmtNum(v) {
  const n = parseFloat(v);
  return isNaN(n) ? '-' : n.toFixed(2);
}

function resolverFrecuencia(ticket) {
  const tp = ticket?.properties || {};
  const frecuencia = val(tp.of_frecuencia_de_facturacion);
  const pipeline = val(tp.hs_pipeline);

  if (frecuencia === 'Irregular' || frecuencia === 'Único') return frecuencia;

  if (pipeline === TICKET_PIPELINE && frecuencia !== 'Único') {
    return 'Irregular';
  }

  return frecuencia || null;
}

// ────────────────────────────────────────────────────────────
// Estilos inline
// ────────────────────────────────────────────────────────────

const STYLES = {
  container:      'font-family:Arial,sans-serif;font-size:14px;color:#333;',
  header:         'font-size:16px;font-weight:bold;color:#1a1a1a;margin-bottom:12px;',
  sectionTitle:   'font-size:14px;font-weight:bold;color:#0056b3;margin:16px 0 8px 0;',
  row:            'margin:4px 0;padding:2px 0;',
  label:          'font-weight:bold;color:#555;',
  lineItemDiv:    'background:#f7f9fc;border:1px solid #dde3eb;border-radius:6px;padding:12px;margin:10px 0;',
  lineItemTitle:  'font-size:14px;font-weight:bold;color:#0056b3;margin-bottom:8px;border-bottom:1px solid #dde3eb;padding-bottom:6px;',
  empresaISA:     'color:#0056b3;font-weight:bold;',
  empresaInterfase: 'color:#6a0dad;font-weight:bold;',
  empresaISAPY:   'color:#e07b00;font-weight:bold;',
  separator:      'border:0;border-top:1px solid #eee;margin:12px 0;',
  footer:         'margin-top:16px;padding-top:8px;border-top:1px solid #dde3eb;font-size:12px;color:#888;',
};

function empresaStyle(empresa) {
  if (empresa === 'Interfase') return STYLES.empresaInterfase;
  if (empresa === 'ISA PY' || empresa === 'ISA Proyectos') return STYLES.empresaISAPY;
  return STYLES.empresaISA;
}

// ────────────────────────────────────────────────────────────
// Builders
// ────────────────────────────────────────────────────────────

function buildRow(label, value) {
  if (value === null || value === undefined || value === '') return '';
  return `<div style="${STYLES.row}"><span style="${STYLES.label}">${label}:</span> ${value}</div>`;
}

function buildHeader(firstTicket, dealName) {
  const tp = firstTicket?.properties || {};
  const hoy = todayYMD();

  return [
    `<div style="${STYLES.container}">`,
    `<div style="${STYLES.header}">📋 Solicitud de Facturación — ${hoy}</div>`,

    `<div style="${STYLES.sectionTitle}">🔹 Datos del negocio</div>`,
    buildRow('Nombre del Negocio', dealName || '-'),
    buildRow('Cliente', val(tp.nombre_empresa)),
    buildRow('Moneda', val(tp.of_moneda)),

    `<hr style="${STYLES.separator}">`,
    `<div style="${STYLES.sectionTitle}">🔹 Detalle de productos</div>`,
  ].filter(r => r !== '').join('\n');
}

function buildLineItemDiv(ticket) {
  const tp = ticket?.properties || {};
  const frecuencia = resolverFrecuencia(ticket);
  const empresa = resolverEmpresa(ticket);
  const esUnico = frecuencia === 'Único';

  // Contacto factura: primero empresa, luego persona, sino vacío
  const contactoLabel = val(tp.empresa_que_factura)
    ? buildRow('Empresa que factura', val(tp.empresa_que_factura))
    : val(tp.persona_que_factura)
      ? buildRow('Persona que factura', val(tp.persona_que_factura))
      : '';

  return [
    `<div style="${STYLES.lineItemDiv}">`,
    `<div style="${STYLES.lineItemTitle}">`,
    `  ${val(tp.of_producto_nombres) || 'Producto'}`,
    `  — <span style="${empresaStyle(empresa)}">${empresa}</span>`,
    `</div>`,

    buildRow('Fecha de factura', todayYMD()),
    contactoLabel,
    buildRow('Descripción', val(tp.of_descripcion_producto)),
    buildRow('Rubro', val(tp.of_rubro)),
    buildRow('Unidad de Negocio', val(tp.unidad_de_negocio)),
    buildRow('Cantidad', fmtNum(tp.cantidad_real)),
    buildRow('Subtotal', fmtNum(tp.subtotal_real)),
    buildRow('Total a facturar', fmtNum(tp.total_real_a_facturar)),
    buildRow('Frecuencia de Facturación', frecuencia),
    buildRow('Observaciones', val(tp.observaciones)),

    !esUnico
      ? buildRow(
          'Fecha de vencimiento del contrato',
          val(tp.fecha_resolucion_esperada)?.slice(0, 10)
        )
      : '',

    `</div>`,
  ].filter(r => r !== '').join('\n');
}

function buildFooter(ticketIds) {
  const hoy = todayYMD();
  return [
    `<div style="${STYLES.footer}">`,
    `Generado automáticamente — ${hoy} ${horaActual()} — ${ticketIds.length} elemento(s) de pedido`,
    `</div>`,
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
/*
export function buildMensajeFacturacion(tickets, dealName) {
  if (!tickets || tickets.length === 0) return '';

  const header = buildHeader(tickets[0], dealName);
  const lineItemDivs = tickets.map(t => buildLineItemDiv(t)).join('\n');
  const ticketIds = tickets.map(t => t.id || t.properties?.hs_object_id || '?');
  const footer = buildFooter(ticketIds);

  return header + '\n' + lineItemDivs + '\n' + footer;
}

// ── Legacy export ──
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
*/