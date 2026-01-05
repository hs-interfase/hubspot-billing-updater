// src/services/snapshotService.js

import { parseNumber, safeString, parseBool } from '../utils/parsers.js';

/**
 * Determina la frecuencia del ticket según las reglas del negocio.
 * - Irregular: si facturacion_irregular = true
 * - Único: si NO es irregular Y frecuencia es null/undefined/"unico"
 * - Frecuente: si tiene frecuencia (semanal, mensual, etc.)
 */
function determineTicketFrequency(lineItem) {
  const lp = lineItem?.properties || {};
  
  const isIrregular = parseBool(lp.facturacion_irregular);
  if (isIrregular) return 'Irregular';
  
  const freq = (lp.recurringbillingfrequency || lp.hs_recurring_billing_frequency || '').toString().trim().toLowerCase();
  
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
 * tipo_impositivo = "IVA" o "IVA Uruguay 22%" → "Si"
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
    iva: detectIVA(lineItem), // ✅ "Si" si tipo_impositivo contiene "iva"
    reventa: parseBool(lp.reventa),
    of_frecuencia_de_facturacion: determineTicketFrequency(lineItem), // ✅ Irregular / Único / Frecuente
    of_monto_total: montoTotal, // ✅ monto total inicial (modificable por responsable)
    monto_real_a_facturar: montoTotal, // ✅ Empieza igual que monto_total, se ajustará según ediciones del responsable
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
    of_pais_operativo: safeString(dp.pais_operativo), // Fallback si line item no tiene
    responsable_asignado: safeString(dp.pm_asignado_cupo), // ✅ PM asignado al cupo (también irá como owner del ticket)
    vendedor: safeString(dp.hubspot_owner_id), // ✅ Vendedor (owner del deal, irá como propietario secundario del ticket)
  };
}

/**
 * Combina snapshots de Deal y Line Item en un objeto listo para el Ticket.
 * 
 * @param {Object} deal - Deal de HubSpot
 * @param {Object} lineItem - Line Item de HubSpot
 * @param {string} billingDate - Fecha planificada de facturación (YYYY-MM-DD)
 * @returns {Object} Propiedades listas para crear el ticket
 */
export function createTicketSnapshots(deal, lineItem, billingDate) {
  const dealData = extractDealSnapshots(deal);
  const lineItemData = extractLineItemSnapshots(lineItem, deal); // Pasar deal para cupo
  const lp = lineItem?.properties || {};
  const dp = deal?.properties || {};
  
  // Motivo cancelación: primero motivo_pausa del line item, luego closed_lost_reason del deal
  const motivoCancelacion = safeString(lp.motivo_pausa) || safeString(dp.closed_lost_reason);
  
  return {
    ...dealData,
    ...lineItemData,
    of_fecha_de_facturacion: billingDate, // 📅 Fecha planificada/estipulada (la que corresponde a esta facturación)
    // 📅 of_fecha_real_de_facturacion: Se completa cuando se genera la factura (no va en snapshot inicial)
    motivo_cancelacion_ticket: motivoCancelacion,
  };
}