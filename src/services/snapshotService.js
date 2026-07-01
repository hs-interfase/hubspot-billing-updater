// src/services/snapshotService.js

import { parseNumber, safeString, parseBool } from '../utils/parsers.js';
import { toHubSpotDateOnly } from '../utils/dateUtils.js';
import logger from '../../lib/logger.js';
import { reportIfActionable } from '../utils/errorReporting.js';
import {
  IVA_UY_TAX_GROUP_ID,
  IVA_PY_TAX_GROUP_ID,
  EXENTO_TAX_GROUP_ID,
} from '../config/constants.js';

/**
 * Determina la frecuencia del ticket según las reglas del negocio.
 *
 * FUENTE DE VERDAD: Line Item properties
 *
 * Valores internos esperados en la propiedad del ticket:
 * - Único
 * - Irregular
 * - Frecuente
 * - Mensual
 * - Bimestral
 * - Trimestral
 * - Semestral
 * - Anual
 *
 * Prioridad:
 * 1. Irregular: si irregular = true
 * 2. Único: si no hay frecuencia o si la frecuencia indica pago único
 * 3. Frecuencias conocidas de HubSpot
 * 4. Frecuente: cualquier otra frecuencia no reconocida
 *
 * ⚠️ Esta es la ÚNICA función que debe usarse para calcular frecuencia de facturación.
 */
export function determineTicketFrequency(lineItem) {
  const lp = lineItem?.properties || {};

  const isIrregular = parseBool(lp.irregular);
  if (isIrregular) return 'Irregular';

  const freq = (
    lp.recurringbillingfrequency ||
    lp.hs_recurring_billing_frequency ||
    ''
  )
    .toString()
    .trim()
    .toLowerCase();

  if (
    !freq ||
    freq === 'unico' ||
    freq === 'único' ||
    freq === 'one_time' ||
    freq === 'one-time' ||
    freq === 'pago_unico' ||
    freq === 'pago único'
  ) {
    return 'Único';
  }

  const frequencyMap = {
    monthly: 'Mensual',
    quarterly: 'Trimestral',
    per_six_months: 'Semestral',
    annually: 'Anual',

    // Por si HubSpot o tu sistema llega a usar estas variantes
    bimonthly: 'Bimestral',
    bi_monthly: 'Bimestral',
    every_two_months: 'Bimestral',
  };

  return frequencyMap[freq] || 'Frecuente';
}

/**
 * Detecta taxes del line item según hs_tax_rate_group_id y exonera_irae.
 *
 * IVA:
 * - IVA UY => 'true'
 * - IVA PY => 'true'
 * - IVA UY + IRAE => 'true'
 * - Exento IVA => 'false'
 * - IRAE puro => 'false'
 * - Cualquier otro valor => ''
 *
 * IRAE:
 * - exonera_irae = false / no => 'true'
 * - exonera_irae = true / sí => 'false'
 * - fallback por tax group IRAE / IVA UY + IRAE => 'true'
 * - Cualquier otro valor => ''
 */


function parseYesNoBool(value) {
  if (value === null || value === undefined || value === '') return null;

  const raw = String(value).trim().toLowerCase();

  if (['true', '1', 'si', 'sí', 'yes', 'y'].includes(raw)) return true;
  if (['false', '0', 'no', 'n'].includes(raw)) return false;

  return null;
}

function detectIVA(lineItem) {
  const raw = String(lineItem?.properties?.hs_tax_rate_group_id ?? '').trim();

  let result;

  if (
    raw &&
    (
      (IVA_UY_TAX_GROUP_ID && raw === IVA_UY_TAX_GROUP_ID) ||
      (IVA_PY_TAX_GROUP_ID && raw === IVA_PY_TAX_GROUP_ID)
    )
  ) {
    result = 'true';
  } else if (
    raw &&
    (EXENTO_TAX_GROUP_ID && raw === EXENTO_TAX_GROUP_ID)
  ) {
    result = 'false';
  } else {
    result = '';
  }

  logger.info({
    module: 'snapshotService',
    fn: 'detectIVA',
    raw,
    result,
    IVA_UY_TAX_GROUP_ID,
    IVA_PY_TAX_GROUP_ID,
    EXENTO_TAX_GROUP_ID,
  }, '[SNAPSHOT][IVA][A] detectIVA()');

  return result;
}

function detectIRAE(lineItem) {
  const lp = lineItem?.properties || {};
  const rawTaxGroupId = String(lp.hs_tax_rate_group_id ?? '').trim();
  const exoneraIraeRaw = lp.exonera_irae;
  const exoneraIrae = parseYesNoBool(exoneraIraeRaw);

  let result;

  // Fuente principal: propiedad explícita del Line Item.
  // exonera_irae = no / false => aplica IRAE.
  // exonera_irae = sí / true => no aplica IRAE.
  if (exoneraIrae === false) {
    result = 'true';
  } else if (exoneraIrae === true) {
    result = 'false';
  } else {
    result = '';
  }

  logger.info({
    module: 'snapshotService',
    fn: 'detectIRAE',
    rawTaxGroupId,
    exonera_irae: exoneraIraeRaw,
    exoneraIrae,
    result,
  }, '[SNAPSHOT][IRAE][A] detectIRAE()');

  return result;
}

export function extractLineItemSnapshots(lineItem, deal) {
  const lp = lineItem?.properties || {};

  // Valores base
  const precioUnitario = parseNumber(lp.price, 0); // = valor hora para cupos
  const cantidad = parseNumber(lp.quantity, 0); // = horas para cupos
  const costoUnitario = parseNumber(lp.hs_cost_of_goods_sold, 0);

  // TAX & DISCOUNT desde Line Item
  const descuentoPorcentaje = parseNumber(lp.hs_discount_percentage, 0) / 100; // ✅ Convertir basis points a %
  const descuentoMonto = parseNumber(lp.discount, 0); // descuento por unidad en moneda del deal
  const ivaValue = detectIVA(lineItem);
  const iraeValue = detectIRAE(lineItem);

  // 🐛 DEBUG: Log valores fuente y destino
  logger.info({ module: 'snapshotService', fn: 'extractLineItemSnapshots', lineItemId: lineItem?.id }, `[DBG][SNAPSHOT] Line Item ID: ${lineItem?.id}`);
  logger.info({
    module: 'snapshotService',
    fn: 'extractLineItemSnapshots',
    lineItemId: lineItem?.id,
    hs_discount_percentage: lp.hs_discount_percentage,
    discount: lp.discount,
    hs_tax_rate_group_id: lp.hs_tax_rate_group_id,
    exonera_irae: lp.exonera_irae,
  }, '[DBG][SNAPSHOT] Tax/Discount SOURCE');

  logger.info({
    module: 'snapshotService',
    fn: 'extractLineItemSnapshots',
    lineItemId: lineItem?.id,
    descuento_en_porcentaje: descuentoPorcentaje,
    descuento_por_unidad_real: descuentoMonto,
    of_iva: ivaValue,
    exonera_irae: iraeValue === 'true' ? 'false' : iraeValue === 'false' ? 'true' : '',
  }, '[DBG][SNAPSHOT] Tax/Discount TARGET (ticket)');

  // Calcular costo total (unitario × cantidad)
  const costoTotal = costoUnitario * cantidad;

  // Calcular monto total (price × quantity, ya viene calculado en amount)
  const montoTotal = parseNumber(lp.amount, precioUnitario * cantidad);

  // Frecuencia simplificada (fuente: Line Item)
  const frecuencia = determineTicketFrequency(lineItem);

  // "repetitivo" (legacy): depende de si el Line Item tiene billing frequency (no vacío y no "unico")
  const rawFreq = (lp.recurringbillingfrequency || lp.hs_recurring_billing_frequency || '')
    .toString()
    .trim()
    .toLowerCase();

const repetitivo = !!rawFreq && ![
  'unico',
  'único',
  'one_time',
  'one-time',
  'pago_unico',
  'pago único',
].includes(rawFreq);


  // ⚠️  of_rubro: validar antes de incluir (async validation se hará en createTicketSnapshots)
  const baseSnapshots = {
    of_cantidad_de_pagos: parseNumber(lp.hs_recurring_billing_number_of_payments, null),
    of_producto_nombres: safeString(lp.name),
    of_descripcion_producto: safeString(lp.description),
    of_rubro: safeString(lp.servicio),
    of_subrubro: safeString(lp.subrubro),
    area: safeString(lp.area), // select del line item → select homónimo del ticket (mismas opciones)
    of_codigo_rubro: safeString(lp.of_codigo_rubro),
    momento_de_facturacion: safeString(lp.momento_de_facturacion),
    observaciones: safeString(lp.mensaje_para_responsable),
    nota: safeString(lp.nota),
    of_pais_operativo: safeString(deal?.properties?.pais_operativo || lp.pais_operativo),
    monto_unitario_real: precioUnitario,
    cantidad_real: cantidad,
    descuento_en_porcentaje: descuentoPorcentaje,
    descuento_por_unidad_real: descuentoMonto,
    of_aplica_para_cupo: getCupoType(lineItem, deal), // "Por Horas", "Por Monto" o null
    of_costo: costoTotal, // ✅ costo total (unitario × cantidad)
    of_margen: montoTotal - costoTotal, // ✅ margen bruto = subtotal pre-IVA (lp.amount) − costo total. Antes leía lp.hs_margin (no se fetchea → siempre 0).
    of_iva: ivaValue,
    exonera_irae: iraeValue === 'true' ? 'false' : iraeValue === 'false' ? 'true' : '',
    reventa: parseBool(lp.reventa),
    opera_trading: parseBool(lp.opera_trading),
    of_frecuencia_de_facturacion: frecuencia, // ✅ Irregular / Único / Frecuente
    nc: parseBool(lp.nc), // NC: se setea a mano en el LI y se propaga al ticket (solo registro)
    repetitivo,
  };

  logger.info({
    module: 'snapshotService',
    fn: 'extractLineItemSnapshots',
    lineItemId: lineItem?.id,
    monto_unitario_real: precioUnitario,
    cantidad_real: cantidad,
    descuento_en_porcentaje: descuentoPorcentaje,
    descuento_por_unidad_real: descuentoMonto,
    of_iva: ivaValue,
    exonera_irae: baseSnapshots.exonera_irae,
  }, '[SNAPSHOT][CRITICOS][AUTO]');

  logger.info({
    module: 'snapshotService',
    fn: 'extractLineItemSnapshots',
    lineItemId: lineItem?.id,
    of_iva: baseSnapshots.of_iva,
    exonera_irae: baseSnapshots.exonera_irae,
  }, '[SNAPSHOT][IVA][B] extractLineItemSnapshots() before return');

  return baseSnapshots;
}

/**
 * Convierte el tipo de cupo del line item a formato HubSpot.
 * Si parte_del_cupo es false, devuelve null (no aplica cupo).
 * Si es true, devuelve "Por Horas" o "Por Monto" según tipo_de_cupo del deal.
 */
function getCupoType(lineItem, deal) {
  const lp = lineItem?.properties || {};
  const dp = deal?.properties || {};

  const aplicaCupo = parseBool(lp.parte_del_cupo);
  if (!aplicaCupo) return null; // No aplica cupo

  const tipoCupo = safeString(dp.tipo_de_cupo);
  // Normalizar el valor
  if (tipoCupo.toLowerCase().includes('hora')) return 'Por Horas';
  if (tipoCupo.toLowerCase().includes('monto')) return 'Por Monto';

  return null; // Valor desconocido
}

/**
 * Extrae datos del Deal que se copian al Ticket.
 * Nota: hubspot_owner_id NO se extrae aquí (viene del Line Item).
 */
export function extractDealSnapshots(deal) {
  const dp = deal?.properties || {};

  return {
    of_moneda: safeString(dp.deal_currency_code || 'USD'),
    of_tipo_de_cupo: safeString(dp.tipo_de_cupo),
    of_pais_operativo: safeString(dp.pais_operativo),
    of_propietario_secundario: safeString(dp.hubspot_owner_id),
    mig_id_crm_origen: safeString(dp.id_crm_origen),
    mig_id_cliente_nodum: safeString(dp.id_cliente_nodum),
  };
}

/**
 * Combina snapshots de Deal y Line Item en un objeto listo para el Ticket.
 *
 * NUEVO MODELO DE FECHAS (sin período):
 * - expectedDate (planificada/esperada desde Line Item) → fecha_resolucion_esperada
 * - orderedDate (cuando se manda a facturar) → of_fecha_de_facturacion
 *
 * Regla: En MANUAL normal, orderedDate debe ser null (NO se setea).
 * En AUTO, orderedDate == expectedDate.
 * En FACTURAR AHORA, orderedDate = HOY y expectedDate sigue siendo la planificada del Line Item.
 *
 * @param {Object} deal
 * @param {Object} lineItem
 * @param {string} expectedDate (YYYY-MM-DD)
 * @param {string|null} orderedDate (YYYY-MM-DD) o null
 * @returns {Object}
 */
export function createTicketSnapshots(deal, lineItem, expectedDate, orderedDate = null) {
  const dealData = extractDealSnapshots(deal);
  const lineItemData = extractLineItemSnapshots(lineItem, deal); // Pasar deal para cupo
  const lp = lineItem?.properties || {};
  const dp = deal?.properties || {};

  // Motivo cancelación: primero motivo_pausa del line item, luego closed_lost_reason del deal
  const motivoCancelacion = safeString(lp.motivo_pausa) || safeString(dp.closed_lost_reason);

  // ✅ C) Construir título del invoice
  const liShort = safeString(lp.name) || `Flota`;
  const invoiceTitle = `${safeString(dp.dealname) || 'Deal'} - ${liShort} - ${expectedDate}`;

  const out = {
    ...dealData,
    ...lineItemData,

    // ✅ B) FECHA ESPERADA/PLANIFICADA (siempre desde billDateYMD usado en key)
    // Convertir YYYY-MM-DD a timestamp ms (midnight UTC)
    fecha_resolucion_esperada: expectedDate ? toHubSpotDateOnly(expectedDate) : null,

    // 📅 FECHA REAL (solo desde Invoice cuando Nodum = EMITIDA)
    // of_fecha_facturacion_real: (se setea después)

    motivo_cancelacion_del_ticket: motivoCancelacion,

    // ✅ C) Título del invoice para usar después
    subject: invoiceTitle,
  };

  logger.info({
    module: 'snapshotService',
    fn: 'createTicketSnapshots',
    of_iva: out.of_iva,
  }, '[SNAPSHOT][IVA][C] createTicketSnapshots() after merge');

  // ✅ Garantizar que of_iva siempre sea 'true' o 'false', nunca '' o null
  const ivaRaw = out.of_iva;
  out.of_iva = ivaRaw === 'true' ? 'true' : ivaRaw === 'false' ? 'false' : '';
  logger.info({
    module: 'snapshotService',
    fn: 'createTicketSnapshots',
    before: ivaRaw,
    after: out.of_iva,
  }, '[SNAPSHOT][IVA][FIX] of_iva normalizado');

  // ✅ Garantizar que exonera_irae siempre sea 'true' o 'false', nunca null
  const iraeRaw = out.exonera_irae;
  out.exonera_irae = iraeRaw === 'true' ? 'true' : iraeRaw === 'false' ? 'false' : '';
  
  logger.info({
    module: 'snapshotService',
    fn: 'createTicketSnapshots',
    before: iraeRaw,
    after: out.exonera_irae,
  }, '[SNAPSHOT][IRAE][FIX] exonera_irae normalizado');

  // ✅ B) FECHA ORDENADA A FACTURAR (solo si aplica, ej: urgente)
  // Convertir YYYY-MM-DD a timestamp ms
  if (orderedDate) {
    out.of_fecha_de_facturacion = toHubSpotDateOnly(orderedDate);
  }

  return out;
}

/*
 * ─────────────────────────────────────────────────────────────
 * CATCHES con reportHubSpotError agregados: NINGUNO
 *
 * Este archivo no contiene bloques try/catch con ticketId ni
 * lineItemId en contexto de error accionable de HubSpot API.
 * Es un módulo puro de transformación de datos (sin llamadas a
 * hubspotClient), por lo que reportIfActionable está disponible
 * pero no se invoca en esta versión.
 *
 * Confirmación: "No se reportan warns a HubSpot;
 *                solo errores 4xx (≠429)" — regla implementada
 *                en reportIfActionable(), lista para uso si se
 *                agregan llamadas API en el futuro.
 * ─────────────────────────────────────────────────────────────
 */
