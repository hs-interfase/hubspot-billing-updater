// src/services/snapshotService.js

import { parseNumber, safeString, parseBool } from '../utils/parsers.js';
import { toHubSpotDateOnly } from '../utils/dateUtils.js';

/**
 * Determina la frecuencia del ticket según las reglas del negocio.
 *
 * FUENTE DE VERDAD: Line Item properties
 * - Irregular: si irregular = true (PRIORIDAD MÁXIMA)
 * - Único: si NO es irregular Y frecuencia es null/undefined/"unico"
 * - Frecuente: si tiene frecuencia (mensual, anual, etc.)
 *
 * ⚠️ Esta es la ÚNICA función que debe usarse para calcular frecuencia de facturación.
 * NO duplicar esta lógica en otros lugares.
 */
export function determineTicketFrequency(lineItem) {
  const lp = lineItem?.properties || {};

  const isIrregular = parseBool(lp.irregular);
  if (isIrregular) return 'Irregular';

  const freq = (lp.recurringbillingfrequency || lp.hs_recurring_billing_frequency || '')
    .toString()
    .trim()
    .toLowerCase();

  if (!freq || freq === 'unico' || freq === 'único' || freq === 'one_time') {
    return 'Único';
  }

  return 'Frecuente';
}

/**
 * Detecta si el line item tiene IVA según hs_tax_rate_group_id.
 * ID 16912720 = IVA Uruguay → "true"
 * Cualquier otro valor → "false"
 */
function detectIVA(lineItem) {
  const raw = String(lineItem?.properties?.hs_tax_rate_group_id ?? '').trim();
  const result = raw === '16912720' ? 'true' : 'false';
  console.log('[SNAPSHOT][IVA][A] detectIVA() ->', { raw, result });
  return result;
}

export function extractLineItemSnapshots(lineItem, deal) {
  const lp = lineItem?.properties || {};

  const precioUnitario = parseNumber(lp.price, 0);
  const cantidad = parseNumber(lp.quantity, 0);
  const costoUnitario = parseNumber(lp.hs_cost_of_goods_sold, 0);

  const descuentoPorcentaje = parseNumber(lp.hs_discount_percentage, 0) / 100;
  const descuentoMonto = parseNumber(lp.discount, 0);
  const ivaValue = detectIVA(lineItem);

  console.log(`\n[DBG][SNAPSHOT] Line Item ID: ${lineItem?.id}`);
  console.log('[DBG][SNAPSHOT] Tax/Discount SOURCE:', {
    hs_discount_percentage: lp.hs_discount_percentage,
    discount: lp.discount,
    hs_tax_rate_group_id: lp.hs_tax_rate_group_id,
  });
  console.log('[DBG][SNAPSHOT] Tax/Discount TARGET (ticket):', {
    descuento_en_porcentaje: descuentoPorcentaje,
    descuento_por_unidad_real: descuentoMonto,
    of_iva: ivaValue,
  });

  const costoTotal = costoUnitario * cantidad;
  const montoTotal = parseNumber(lp.amount, precioUnitario * cantidad);

  const frecuencia = determineTicketFrequency(lineItem);

  const rawFreq = (lp.recurringbillingfrequency || lp.hs_recurring_billing_frequency || '')
    .toString()
    .trim()
    .toLowerCase();

  const repetitivo = !!rawFreq && !['unico', 'único', 'one_time'].includes(rawFreq);

  const baseSnapshots = {
    of_producto_nombres: safeString(lp.name),
    of_descripcion_producto: safeString(lp.description),
    of_rubro: safeString(lp.servicio),
    of_subrubro: safeString(lp.subrubro),
    observaciones_ventas: safeString(lp.mensaje_para_responsable),
    nota: safeString(lp.nota),

    // 🔥 UNIDAD DE NEGOCIO AHORA SALE DEL LINE ITEM
    unidad_de_negocio: safeString(lp.unidad_de_negocio),

    // ❌ ELIMINADO: of_pais_operativo (ahora viene del Deal)

    monto_unitario_real: precioUnitario,
    cantidad_real: cantidad,
    descuento_en_porcentaje: descuentoPorcentaje,
    descuento_por_unidad_real: descuentoMonto,
    of_aplica_para_cupo: getCupoType(lineItem, deal),
    of_costo: costoTotal,
    of_margen: parseNumber(lp.porcentaje_margen, 0),
    of_iva: ivaValue,
    reventa: parseBool(lp.reventa),
    of_frecuencia_de_facturacion: frecuencia,
    repetitivo,
  };

  console.log('[SNAPSHOT][CRITICOS][AUTO]', {
    monto_unitario_real: precioUnitario,
    cantidad_real: cantidad,
    descuento_en_porcentaje: descuentoPorcentaje,
    descuento_por_unidad_real: descuentoMonto,
    of_iva: ivaValue,
  });

  console.log('[SNAPSHOT][IVA][B] extractLineItemSnapshots() before return ->', { of_iva: baseSnapshots.of_iva });

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
  const lineItemData = extractLineItemSnapshots(lineItem, deal);
  const lp = lineItem?.properties || {};
  const dp = deal?.properties || {};

  const motivoCancelacion =
    safeString(dp.closed_lost_reason) || safeString(lp.motivo_pausa);

  const out = {
    ...dealData,
    ...lineItemData,

    // Fecha en formato timestamp (luego se pisará como string)
    fecha_resolucion_esperada: expectedDate
      ? toHubSpotDateOnly(expectedDate)
      : null,

    motivo_cancelacion_ticket: motivoCancelacion,
  };

  // Normalizar IVA
  const ivaRaw = out.of_iva;
  out.of_iva =
    String(ivaRaw ?? 'false') === 'true' ? 'true' : 'false';

  // Fecha ordenada a facturar (solo si aplica)
  if (orderedDate) {
    out.of_fecha_de_facturacion =
      toHubSpotDateOnly(orderedDate);
  }

  return out;
}

