// src/services/snapshotService.js

import { parseNumber, safeString, parseBool } from '../utils/parsers.js';

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
function determineTicketFrequency(lineItem) {
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
 * Convierte boolean a formato HubSpot "Si" / "No"
 */
function boolToSiNo(value) {
  return parseBool(value) ? 'Si' : 'No';
}

/**
 * Detecta si el line item tiene IVA según el tipo impositivo.
 * tax_rate = "IVA" o "IVA Uruguay 22%" → "Si"
 * Cualquier otro valor → "No"
 */
function detectIVA(lineItem) {
  const lp = lineItem?.properties || {};
  const tipoImpositivo = safeString(lp.tax_rate || '').toLowerCase();

  // Si contiene "iva" en el nombre, entonces tiene IVA
  if (tipoImpositivo.includes('iva')) return 'Si';

  return 'No';
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
 * Extrae los snapshots principales de un line item.
 */
export function extractLineItemSnapshots(lineItem, deal) {
  const lp = lineItem?.properties || {};

  // Valores base
  const precioUnitario = parseNumber(lp.price, 0); // = valor hora para cupos
  const cantidad = parseNumber(lp.quantity, 0); // = horas para cupos
  const costoUnitario = parseNumber(lp.hs_cost_of_goods_sold, 0);
  const descuentoPorcentaje = parseNumber(lp.discount, 0);

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

  const repetitivo = !!rawFreq && !['unico', 'único', 'one_time'].includes(rawFreq);

  return {
    of_producto_nombres: safeString(lp.name),
    descripcion_producto: safeString(lp.description),
    of_rubro: safeString(lp.servicio),
    nota: safeString(lp.nota),
    of_pais_operativo: safeString(lp.pais_operativo),
    of_aplica_para_cupo: getCupoType(lineItem, deal), // "Por Horas", "Por Monto" o null
    of_monto_unitario: precioUnitario, // ✅ price = monto unitario (valor hora para cupos)
    of_cantidad: cantidad, // ✅ cantidad = horas reales para cupos (modificable por responsable)
    of_costo: costoTotal, // ✅ costo total (unitario × cantidad)
    of_margen: parseNumber(lp.porcentaje_margen, 0),
    of_descuento: descuentoPorcentaje, // ✅ descuento en % (ej: 10)
    iva: detectIVA(lineItem), // ✅ "Si" si tax_rate contiene "iva"
    reventa: parseBool(lp.reventa),
    of_frecuencia_de_facturacion: frecuencia, // ✅ Irregular / Único / Frecuente
    repetitivo,
    of_monto_total: montoTotal, // ✅ monto total sugerido (snapshot inmutable)
    monto_real_a_facturar: montoTotal, // ✅ Inicia igual que of_monto_total. En MANUAL es editable (no hay sync). En AUTO se mantiene igual.
  };
}

/**
 * Extrae datos del Deal que se copian al Ticket.
 */
export function extractDealSnapshots(deal) {
  const dp = deal?.properties || {};

  return {
    of_moneda: safeString(dp.deal_currency_code || 'USD'),
    of_tipo_de_cupo: safeString(dp.tipo_de_cupo),
    of_pais_operativo: safeString(dp.pais_operativo),
    hubspot_owner_id: safeString(dp.pm_asignado_cupo),
    of_propietario_secundario: safeString(dp.hubspot_owner_id),
  };
}

/**
 * Combina snapshots de Deal y Line Item en un objeto listo para el Ticket.
 *
 * NUEVO MODELO DE FECHAS (sin período):
 * - expectedDate (planificada/esperada desde Line Item) → hs_resolution_due_date
 * - orderedDate (cuando se manda a facturar) → of_fecha_facturacion
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

  const out = {
    ...dealData,
    ...lineItemData,

    // 📅 FECHA ESPERADA/PLANIFICADA (siempre desde Line Item)
    hs_resolution_due_date: safeString(expectedDate),

    // 📅 FECHA REAL (solo desde Invoice cuando Nodum = EMITIDA)
    // of_fecha_facturacion_real: (se setea después)

    motivo_cancelacion_ticket: motivoCancelacion,
  };

  // 📅 FECHA ORDENADA A FACTURAR (solo si aplica)
  if (orderedDate) {
    out.of_fecha_facturacion = safeString(orderedDate);
  }

  return out;
}
