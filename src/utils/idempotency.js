// src/utils/idempotency.js

/**
 * Genera claves únicas para evitar duplicados en tickets y facturas.
 */

/**
 * Genera una clave única para un ticket manual.
 * Formato: <dealId>::<lineItemId>::<fechaFacturacion>
 */
export function generateTicketKey(dealId, lineItemId, billingDate) {
  return `${dealId}::${lineItemId}::${billingDate}`;
}

/**
 * Genera una clave única para una factura.
 * Formato: <dealId>::<lineItemId>::<fechaFacturacion>
 */
export function generateInvoiceKey(dealId, lineItemId, billingDate) {
  return `${dealId}::${lineItemId}::${billingDate}`;
}
