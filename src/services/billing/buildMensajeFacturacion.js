// src/services/billing/buildMensajeFacturacion.js
//
// Construye (o acumula) el HTML rich-text que se escribe en la propiedad
// `mensaje_de_facturacion` del Deal.
//
// Lógica de acumulación:
//   - Si la propiedad ya contiene un mensaje con fecha de HOY → conserva
//     el HTML existente y agrega el nuevo div de line item al final.
//   - Si la fecha es distinta o la propiedad está vacía → limpia y construye
//     desde cero (encabezado + primer div).
//
// El workflow de HubSpot maneja el delay de 10 min y envío de correo.

import { build } from 'pino-pretty';
import { BILLING_TICKET_PIPELINE_ID } from '../../config/constants.js';
import { hubspotClient } from '../../hubspotClient.js';
import logger from '../../utils/logger.js';

const DEAL_PROPERTY = 'mensaje_de_facturacion';

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────

function todayYMD() {
  return new Date().toISOString().slice(0, 10);
}

/** Extrae la fecha del marker <!--FECHA:YYYY-MM-DD--> del HTML existente */
function extractFechaFromMessage(html) {
  const match = (html || '').match(/<!--FECHA:(\d{4}-\d{2}-\d{2})-->/);
  return match ? match[1] : null;
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

  // Si ya es Irregular o Único, usar tal cual
  if (frecuencia === 'Irregular' || frecuencia === 'Único') return frecuencia;

  // Si es pipeline manual y no es Único → forzar Irregular
  if (pipeline === BILLING_TICKET_PIPELINE_ID && frecuencia !== 'Único') {
    return 'Irregular';
  }

  // Automático → usar valor del snapshot
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
};

// ────────────────────────────────────────────────────────────
// Builders
// ────────────────────────────────────────────────────────────

/** Genera una fila label: value. Si value es null, retorna string vacío (se omite) */
function buildRow(label, value) {
  if (value === null) return '';
  return `<div style="${STYLES.row}"><span style="${STYLES.label}">${label}:</span> ${value}</div>`;
}

/**
 * Construye el encabezado del mensaje (fecha, datos del negocio, datos de facturación).
 * Solo se genera al crear un mensaje nuevo (no al acumular).
 */
function buildHeader(ticket) {
  const tp = ticket?.properties || {};
  const hoy = todayYMD();

  // Extraer nombre del negocio del subject del ticket: "Empresa - Producto - Fecha"
  const dealName = val(tp.subject)
    ? tp.subject.split(' - ')[0].trim()
    : val(tp.of_deal_id) || '-';

  const rows = [
    `<!--FECHA:${hoy}-->`,
    `<div style="${STYLES.container}">`,
    `<div style="${STYLES.header}">📋 Solicitud de Facturación — ${hoy}</div>`,

    // TODO: lógica ISA / Interfase
    // if (condicionISA) { tipo = 'ISA' } else if (condicionInterfase) { tipo = 'Interfase' }

    `<div style="${STYLES.sectionTitle}">🔹 Datos del negocio</div>`,
    buildRow('Negocio', dealName),
    buildRow('Cliente principal', val(tp.nombre_empresa)),
    buildRow('Empresa que factura', val(tp.empresa_que_factura)),   // TODO: confirmar propiedad en ticket
    buildRow('Persona que factura', val(tp.persona_que_factura)),   // TODO: confirmar propiedad en ticket

    `<div style="${STYLES.sectionTitle}">🔹 Datos de facturación</div>`,
    buildRow('Moneda', val(tp.of_moneda)),
    buildRow('Fecha de factura', hoy),
    buildRow('IRAE', val(tp.of_exonera_irae) || 'No'),

    `<hr style="${STYLES.separator}">`,
    `<div style="${STYLES.sectionTitle}">🔹 Detalle de productos</div>`,

    '<!--LINE_ITEMS_START-->',
  ];

  return rows.filter(r => r !== '').join('\n');
}

/**
 * Construye el div de un line item individual.
 * Se usa tanto para el primer item como para los acumulados.
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
    buildRow('Monto unitario', fmtNum(tp.monto_unitario_real)),
    buildRow('Cantidad', fmtNum(tp.cantidad_real)),
    buildRow('Subtotal', fmtNum(tp.subtotal_real)),
    buildRow('IVA', tp.of_iva === 'true' ? 'Sí' : 'No'),
    buildRow('Descuento (%)', fmtNum(tp.descuento_en_porcentaje)),
    buildRow('Descuento (monto unitario)', fmtNum(tp.descuento_por_unidad_real)),
    buildRow('Total a facturar', fmtNum(tp.total_real_a_facturar)),
    buildRow('Frecuencia', frecuencia),
    buildRow('Cantidad de pagos', val(tp.of_cantidad_de_pagos)),
    buildRow('Fecha de solicitud de facturación', todayYMD()),
    buildRow('Observaciones', val(tp.observaciones_ventas)),
    `</div>`,
  ];

  return rows.filter(r => r !== '').join('\n');
}

function buildFooter() {
  return '<!--LINE_ITEMS_END-->\n</div>';
}

// ────────────────────────────────────────────────────────────
// Función principal
// ────────────────────────────────────────────────────────────

/**
 * Construye o acumula el HTML del mensaje de facturación.
 *
 * @param {Object} ticket          - Ticket promovido (con snapshots del deal y line item)
 * @param {string} currentMessage  - Valor actual de `mensaje_de_facturacion` del deal (puede ser null/vacío)
 * @returns {string}               - HTML completo para escribir en la propiedad del deal
 */
export function buildMensajeFacturacion(ticket, currentMessage) {
  const hoy = todayYMD();
  const fechaExistente = extractFechaFromMessage(currentMessage);
  const nuevoDiv = buildLineItemDiv(ticket);

  // ── ACUMULAR: fecha existente es hoy → solo agregar el nuevo div ──
  if (fechaExistente === hoy && currentMessage) {
    const insertPoint = currentMessage.indexOf('<!--LINE_ITEMS_END-->');

    if (insertPoint !== -1) {
      return (
        currentMessage.slice(0, insertPoint) +
        nuevoDiv + '\n' +
        currentMessage.slice(insertPoint)
      );
    }

    // Fallback: si no encuentra el marker, agregar antes del último </div>
    const lastDiv = currentMessage.lastIndexOf('</div>');
    if (lastDiv !== -1) {
      return (
        currentMessage.slice(0, lastDiv) +
        nuevoDiv + '\n' +
        currentMessage.slice(lastDiv)
      );
    }
  }

  // ── NUEVO: fecha distinta o propiedad vacía → construir desde cero ──
  return buildHeader(ticket) + '\n' + nuevoDiv + '\n' + buildFooter();
}

// ────────────────────────────────────────────────────────────
// Función pública: leer deal → construir HTML → escribir propiedad
// ────────────────────────────────────────────────────────────

/**
 * Lee la propiedad actual del deal, construye/acumula el HTML
 * y escribe el resultado en `mensaje_de_facturacion`.
 *
 * Usa optimistic locking: después de escribir, relee la propiedad.
 * Si otro proceso escribió entre medio (race condition), hace merge
 * y reintenta hasta MAX_RETRIES veces.
 *
 * @param {Object} ticket  - Ticket promovido con snapshots
 * @param {string} dealId  - ID del deal (normalmente tp.of_deal_id)
 */
export async function actualizarMensajeFacturacion(ticket, dealId) {
  const MAX_RETRIES = 3;
  const RETRY_DELAY_MS = 2000;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      // 1) Leer el valor actual de la propiedad del deal
      const dealResponse = await hubspotClient.crm.deals.basicApi.getById(
        dealId,
        [DEAL_PROPERTY]
      );
      const currentMessage = dealResponse?.properties?.[DEAL_PROPERTY] || '';

      // 2) Construir / acumular el HTML
      const nuevoHTML = buildMensajeFacturacion(ticket, currentMessage);

      // 3) Escribir la propiedad actualizada en el deal
      await hubspotClient.crm.deals.basicApi.update(dealId, {
        properties: { [DEAL_PROPERTY]: nuevoHTML },
      });

      // 4) Esperar un momento y releer para verificar consistencia
      await new Promise(r => setTimeout(r, RETRY_DELAY_MS));

      const verificacion = await hubspotClient.crm.deals.basicApi.getById(
        dealId,
        [DEAL_PROPERTY]
      );
      const mensajeActual = verificacion?.properties?.[DEAL_PROPERTY] || '';

      // 5) Verificar que nuestro div sigue presente
      const productoNombre = ticket?.properties?.of_producto_nombres || '';
      if (productoNombre && !mensajeActual.includes(productoNombre)) {
        // Otro proceso sobrescribió — releer y hacer merge
        logger.warn(
          {
            module: 'buildMensajeFacturacion',
            fn: 'actualizarMensajeFacturacion',
            dealId,
            ticketId: ticket?.id,
            attempt,
          },
          'Race condition detectada, reintentando merge'
        );
        continue; // reintenta con el valor actualizado
      }

      logger.info(
        {
          module: 'buildMensajeFacturacion',
          fn: 'actualizarMensajeFacturacion',
          dealId,
          ticketId: ticket?.id,
          attempt,
          acumulado: currentMessage ? 'sí' : 'no',
        },
        'mensaje_de_facturacion actualizado'
      );
      return; // éxito

    } catch (err) {
      logger.error(
        {
          module: 'buildMensajeFacturacion',
          fn: 'actualizarMensajeFacturacion',
          dealId,
          ticketId: ticket?.id,
          attempt,
          err,
        },
        'Error al actualizar mensaje_de_facturacion'
      );
      if (attempt === MAX_RETRIES) return; // no interrumpir flujo de facturación
    }
  }
}