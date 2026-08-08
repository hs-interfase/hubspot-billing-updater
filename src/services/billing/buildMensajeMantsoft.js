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
import { parseBool } from '../../utils/parsers.js';
import { buildDealUrl } from '../../utils/hubspotPortal.js';
import { EMPRESA_EMISORA_MAP } from './empresaEmisora.js'; // dedupe con buildMensajeFacturacion

// SHOW_NULLS quedó sin uso el 4-ago-2026: las filas sin dato ahora se muestran
// SIEMPRE (ver buildRow), así que el flag de debug ya no hace falta.
import {
  parseMansoftSnapshot,
  buildMansoftSnapshot,
  diffMansoftSnapshots,
} from './mansoftSnapshot.js';
import {
  IVA_UY_TAX_GROUP_ID,
  IVA_PY_TAX_GROUP_ID,
  EXENTO_TAX_GROUP_ID,
} from '../../config/constants.js';

const TAX_GROUP_LABELS = {
  [IVA_UY_TAX_GROUP_ID]:      'IVA 22% (UY)',
  [IVA_PY_TAX_GROUP_ID]:      'IVA (PY)',
  [EXENTO_TAX_GROUP_ID]:      'Exento',
};

function resolveTaxLabel(taxGroupId) {
  const raw = String(taxGroupId ?? '').trim();
  return TAX_GROUP_LABELS[raw] || raw || '-';
}

// EMPRESA_EMISORA_MAP → importado de ./empresaEmisora.js (dedupe con buildMensajeFacturacion, 2026-07-09)

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
  return isNaN(n) ? null : n.toFixed(2);
}

function fmtValDiff(v) {
  // Para mostrar un valor en el diff (before/after). Vacío/null → "(vacío)".
  if (v === null || v === undefined || v === '') return '<em>(vacío)</em>';
  return String(v);
}

/** Booleano 'true'/'false' → 'Sí'/'No' (null si no hay dato). Mismo criterio que buildMensajeFacturacion. */
function fmtBoolSiNo(v) {
  const s = val(v);
  if (s === null) return null;
  const t = s.toLowerCase();
  if (t === 'true' || t === 'sí' || t === 'si') return 'Sí';
  if (t === 'false' || t === 'no') return 'No';
  return s;
}

/**
 * Fecha en DÍA/MES/AÑO (pedido de la usuaria, 4-ago-2026).
 * Entra `2026-08-04` (o un ISO con hora) y sale `04/08/2026`.
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

/** exonera_irae: true → 'Exento', false → 'Aplica' (null si no hay dato). */
function fmtIrae(v) {
  const s = val(v);
  if (s === null) return null;
  const t = s.toLowerCase();
  if (t === 'true' || t === 'sí' || t === 'si') return 'Exento';
  if (t === 'false' || t === 'no') return 'Aplica';
  return s;
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
  nullVal:       'color:#b0b0b0;font-style:italic;',
  link:          'color:#0056b3;text-decoration:underline;',
};

// ────────────────────────────────────────────────────────────
// Builders de bloques
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
 * Fila que SÓLO aparece si tiene contenido. En el aviso de facturación
 * AUTOMÁTICA la usuaria no quiere ver Observaciones ni Descripción del ticket
 * (4-ago-2026) — salvo el caso raro en que traigan algo, que entonces importa.
 */
function buildRowSiTiene(label, value) {
  if (value === null || value === undefined || value === '') return '';
  return buildRow(label, value);
}

/**
 * Construye el encabezado del mensaje completo (único por deal/día).
 */
function buildHeader(firstLi, dealName, dealMeta = {}) {
  const lp = firstLi?.properties || {};
  const hoy = todayYMD();

  // ⚠️ `empresa_que_factura` significa cosas distintas en cada objeto:
  //   - en el LINE ITEM es la ENTIDAD FACTURADORA (quién emite) — es la que el motor
  //     copia al ticket como `entidad_facturadora` (syncLineItemPropToTicket.js:68);
  //   - en el dealMeta (company typeId=9 del negocio) es el CLIENTE QUE PAGA.
  // Los dos van al mensaje, con el nombre que usa Victoria para cada uno.
  const entidadFacturadora = val(lp.empresa_que_factura) || resolverEmpresaEmisora(lp);
  const clienteFinal     = val(dealMeta.empresa_que_factura);
  const personaFactura   = val(dealMeta.persona_que_factura);
  const empresaPrincipal = val(lp.nombre_empresa);

  const rows = [
    `<div style="${STYLES.container}">`,
    `<div style="${STYLES.header}">📋 Aviso Mantsoft — ${fmtFecha(hoy)}</div>`,

    `<div style="${STYLES.sectionTitle}">🔹 Datos del negocio</div>`,
    buildRowAlways('Entidad facturadora', entidadFacturadora),
    buildRow('Nombre del negocio',   dealName || '-'),
    buildRow('Empresa Principal',    empresaPrincipal),
    buildRowAlways('Cliente Factura', clienteFinal),
    // Fuera de la lista, se dejan porque ya se venían mandando.
    buildRow('Persona que factura',  personaFactura),
    buildRow('Fecha del aviso',      fmtFecha(hoy)),
    // El link al negocio se movió AL FINAL del mensaje (4-ago-2026): va después
    // del progreso de pagos. Ver buildFooter.
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

  // Subtotal (#16 de la lista de Victoria). El line item no tiene una propiedad de
  // subtotal: es precio unitario × cantidad, ANTES del descuento. `amount` ya viene
  // con el descuento aplicado, por eso son dos filas distintas.
  const precioNum = parseFloat(lp.price);
  const cantNum   = parseFloat(lp.quantity);
  const subtotal  = (Number.isFinite(precioNum) && Number.isFinite(cantNum))
    ? (precioNum * cantNum).toFixed(2)
    : null;

  const freqRaw    = val(lp.recurringbillingfrequency) || val(lp.hs_recurring_billing_frequency);
  const frecuencia = freqRaw || null;

  const esRenovacion = String(lp.renovacion_automatica || '').toLowerCase() === 'true';
  const tipoLabel    = esRenovacion ? 'Renovación automática' : 'Plan fijo';

  // ── Fechas: contrato (manual) vs facturación (calculada) ──
  const inicioContrato = val(lp.inicio_del_contrato)?.slice(0, 10);          // Inicio del contrato
  const vigenciaContrato = val(lp.fin_del_contrato)?.slice(0, 10);           // Fin / vigencia del contrato
  const fechaInicioFact = val(lp.hs_recurring_billing_start_date)?.slice(0, 10); // cuándo se factura
  const fechaAncla  = val(lp.billing_anchor_date)?.slice(0, 10);
  const anclaLabel  = (fechaAncla && fechaAncla !== fechaInicioFact) ? fechaAncla : null;

  // ── Pagos ──
  //
  // El PROGRESO DE PAGOS tiene que salir siempre, en los tres tipos de aviso
  // (alta, baja y edición) — pedido de la usuaria del 4-ago-2026. Como los tres
  // bloques comparten estas filas, alcanza con armarlo bien acá.
  //
  // Antes se calculaba sólo con tres combinaciones y se caía a null en el resto
  // (p.ej. con pagos_restantes pero sin total, o en una renovación automática sin
  // ningún pago emitido todavía), y la fila desaparecía del mensaje.
  const totalPagos     = val(lp.hs_recurring_billing_number_of_payments);
  const pagosEmitidos  = val(lp.pagos_emitidos);
  const pagosRestantes = val(lp.pagos_restantes);
  const cantidadPagos  = totalPagos || (esRenovacion ? 'Renovación automática' : null);

  const nTotal = parseFloat(totalPagos);
  const nEmit  = parseFloat(pagosEmitidos);
  const nRest  = parseFloat(pagosRestantes);
  const hayTotal = Number.isFinite(nTotal);
  const hayEmit  = Number.isFinite(nEmit);
  const hayRest  = Number.isFinite(nRest);

  let progresoPagos;
  if (hayEmit && hayTotal && hayRest) {
    progresoPagos = `${nEmit} de ${nTotal} emitidos — quedan ${nRest}`;
  } else if (hayEmit && hayTotal) {
    progresoPagos = `${nEmit} de ${nTotal} emitidos`;
  } else if (hayRest && hayTotal) {
    progresoPagos = `Quedan ${nRest} de ${nTotal}`;
  } else if (hayEmit && hayRest) {
    progresoPagos = `${nEmit} emitidos — quedan ${nRest}`;
  } else if (hayEmit) {
    progresoPagos = `${nEmit} emitidos`;
  } else if (hayRest) {
    progresoPagos = `Quedan ${nRest}`;
  } else if (esRenovacion) {
    progresoPagos = 'Renovación automática — sin tope de pagos';
  } else {
    progresoPagos = null; // buildRowAlways lo muestra como "(sin datos)"
  }

  // 🔴 El RUBRO del line item vive en `servicio` (snapshotService.js:289 lo copia
  // al ticket como `of_rubro`). Antes se leía `of_rubro || rubro`, y NINGUNA de
  // las dos existe en el line item ⇒ el rubro nunca salía en este mensaje.
  const rubro = val(lp.servicio);

  return [
    // ── El ORDEN de acá abajo es el de la lista del 5-ago-2026 ───────────────
    // (campos 5 a 21: los 4 primeros son del negocio y salen en el encabezado).
    // ⚠️ Igual que en el mensaje manual, la lista pone CANTIDAD antes que
    // PRECIO UNITARIO — al revés de lo pedido el 4-ago. Manda la lista nueva.
    buildRow('Fecha de inicio de facturación', fmtFecha(fechaInicioFact)),
    buildRow('Fecha de inicio de contrato',    fmtFecha(inicioContrato)),
    buildRow('Fecha de fin de contrato',       fmtFecha(vigenciaContrato)),
    buildRow('Momento de facturación',    val(lp.momento_de_facturacion)),
    // Ahora sale SIEMPRE: la lista lo pide como dato necesario del alta.
    buildRowAlways('Descripción del ticket', val(lp.content)),
    buildRow('Rubro',                     rubro),
    // La nota sólo tiene sentido cuando el rubro es "Otro": ahí va el detalle.
    // No está en la lista, pero se queda pegada al rubro, que es donde sirve.
    rubroEsOtro(rubro) ? buildRow('Nota', val(lp.nota)) : '',
    buildRow('Área',                      val(lp.area)),
    buildRow('Moneda',                    val(lp.of_moneda)),
    buildRow('Cantidad',                  fmtNum(lp.quantity)),
    buildRow('Precio unitario',           fmtNum(lp.price)),
    // `amount` es el neto (precio×cantidad MENOS descuento) y hs_post_tax_amount
    // es el mismo importe con impuestos — nativa de HubSpot, así no hay que
    // inventar la tasa de cada país.
    buildRow('Monto total',               total),
    buildRow('IVA',                       resolveTaxLabel(lp.hs_tax_rate_group_id)),
    buildRow('Monto total con impuestos', fmtNum(lp.hs_post_tax_amount)),
    buildRow('IRAE',                      fmtIrae(lp.exonera_irae)),
    buildRow('Opera Trading',             fmtBoolSiNo(lp.opera_trading)),
    buildRow('Condición de Pago',         val(lp.condiciones_de_pago)),

    // ── Fuera de la lista: se dejan porque ya se venían mandando ─────────────
    buildRow('ID line item',              val(li?.id) || val(lp.hs_object_id)),
    buildRow('Producto',                  val(lp.name)),
    buildRow('Unidad de negocio',         val(lp.unidad_de_negocio)),
    buildRow('Descripción del producto',  val(lp.description)),
    // Precio×cantidad ANTES del descuento: por eso no es el «Monto total».
    buildRow('Monto sin descuento',       subtotal),

    buildRow('Descuento (%)',             fmtNum(lp.hs_discount_percentage)),

    // El cronograma queda SÓLO acá, en las automáticas: la facturación manual
    // se quedó con una única fecha (4-ago-2026).
    buildRow('Frecuencia',                frecuencia),
    buildRow('Fecha ancla',               fmtFecha(anclaLabel)),
    buildRow('Próxima facturación',       fmtFecha(lp.billing_next_date)),
    buildRow('Tipo',                      tipoLabel),
    buildRow('Cantidad de pagos',         cantidadPagos),
    buildRow('Pagos emitidos',            pagosEmitidos),
    buildRow('Pagos restantes',           pagosRestantes),

    buildRowSiTiene('Observaciones',      val(lp.observaciones)),

    // El progreso de pagos cierra el bloque (4-ago-2026).
    buildRowAlways('Progreso de pagos',   progresoPagos),
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
  const esDefinitivo = String(lp.es_definitivo || '').toLowerCase() === 'true';
  const rows = [
    `<div style="${STYLES.lineItemDivBaja}">`,
    `<div style="${STYLES.lineItemTitle}">🛑 ${val(lp.name) || 'Producto'}</div>`,
    ...buildLineItemBaseRows(li),
    buildRow('Fecha de baja',  val(lp.fecha_de_baja)?.slice(0, 10)),
    buildRow('Motivo',         val(lp.motivo_de_pausa)),
    buildRow('Tipo de baja',   esDefinitivo ? 'Definitiva' : 'Temporal'),
    `</div>`,
  ];
  return rows.filter(r => r !== '').join('\n');
}

function buildFooter(count, dealMeta = {}) {
  const hoy = todayYMD();

  // El link al negocio va ACÁ ABAJO, después del progreso de pagos del último
  // bloque (4-ago-2026). Antes vivía en el encabezado.
  const dealUrl = buildDealUrl(dealMeta.portalId, dealMeta.dealId);
  const dealLink = dealUrl
    ? `<a href="${dealUrl}" style="${STYLES.link}">Ver negocio #${dealMeta.dealId}</a>`
    : null;

  return [
    dealLink ? buildRow('Negocio', dealLink) : '',
    `<div style="${STYLES.footer}">`,
    `Generado automáticamente — ${fmtFecha(hoy)} ${horaActual()} — ${count} elemento(s) notificado(s)`,
    `</div>`,
    `</div>`,
  ].filter(r => r !== '').join('\n');
}

// ────────────────────────────────────────────────────────────
// Clasificación de line items (alta vs edicion)
// ────────────────────────────────────────────────────────────

/**
 * Clasifica cada LI en 'migra' / 'alta' / 'edicion' / 'baja' y calcula el diff.
 *
 * Reglas (en orden de prioridad):
 * - pausa=true                          → baja
 * - mig_migracion_historica && SIN snapshot previo → 'migra' (LI migrado: NO se avisa
 *   al admin; se onboardea en silencio). Gana sobre cualquier tipo explícito (ej. un
 *   workflow que setea tipo='alta' al crear). Una vez estampado el snapshot → edición.
 * - tipo explícito 'baja'/'alta'/'edicion' → ese tipo
 * - sin tipo, con snapshot previo       → edicion (fallback defensivo)
 * - sin tipo, sin snapshot previo       → alta (fallback defensivo)
 */
export function classifyLineItem(li) {
  const p = li?.properties || {};
  const tipoRaw = String(p.mansoft_tipo_aviso || '').trim().toLowerCase();
  const prevSnap = parseMansoftSnapshot(p.mansoft_ultimo_snapshot);
  const currSnap = buildMansoftSnapshot(li);
  const diffs = diffMansoftSnapshots(prevSnap, currSnap);

  // Estado actual manda: si la línea está en pausa, es baja (nunca edición),
  // sin importar qué cambió o qué quedó en mansoft_tipo_aviso.
  if (parseBool(p.pausa)) return { tipo: 'baja', diffs: [] };

  // Migración: LI marcado con mig_migracion_historica y aún sin snapshot previo → 'migra'
  // (no se avisa alta). Gana sobre el tipo explícito (resuelve el caso del workflow de HS
  // que pone tipo='alta' al crear). Cuando ya hay snapshot estampado, cae a edición normal.
  if (parseBool(p.mig_migracion_historica) && !prevSnap) return { tipo: 'migra', diffs: [] };

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

  parts.push(buildFooter(totalNotificados, dealMeta));

  return parts.join('\n');
}