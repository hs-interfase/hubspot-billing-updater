// src/services/snapshotService.js

import { parseNumber, safeString, parseBool } from '../utils/parsers.js';

/**
 * Crea snapshots de datos del Deal y Line Item para copiarlos al Ticket.
 * Esto garantiza que el responsable vea datos inmutables sin depender
 * de cambios posteriores en el Deal o Line Item.
 */

/**
 * Extrae los snapshots principales de un line item.
 */
export function extractLineItemSnapshots(lineItem) {
  const lp = lineItem?.properties || {};
  
  return {
    precio_hora_snapshot: parseNumber(lp.price, 0),
    horas_previstas_snapshot: parseNumber(lp.quantity, 0),
    monto_original_snapshot: parseNumber(lp.price, 0) * parseNumber(lp.quantity, 0),
    of_producto_nombres: safeString(lp.name),
  };
}

/**
 * Extrae datos del Deal que se copian al Ticket.
 */
export function extractDealSnapshots(deal) {
  const dp = deal?.properties || {};
  
  return {
    of_moneda: safeString(dp.deal_currency_code || 'USD'),
    of_pais_operativo: safeString(dp.pais_operativo),
    of_rubro: safeString(dp.dealname), // O el campo que uses para rubro
    responsable_asignado: safeString(dp.responsable_asignado || dp.hubspot_owner_id),
  };
}

/**
 * Combina snapshots de Deal y Line Item en un objeto listo para el Ticket.
 */
export function createTicketSnapshots(deal, lineItem, billingDate) {
  const dealData = extractDealSnapshots(deal);
  const lineItemData = extractLineItemSnapshots(lineItem);
  const lp = lineItem?.properties || {};
  
  return {
    ...dealData,
    ...lineItemData,
    of_fecha_de_facturacion: billingDate,
    monto_real_a_facturar: lineItemData.monto_original_snapshot,
    horas_reales_usadas: lineItemData.horas_previstas_snapshot,
    of_aplica_cupo: parseBool(lp.parte_del_cupo),
  };
}
