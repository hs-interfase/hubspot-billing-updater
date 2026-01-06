// src/utils/idempotency.js

/**
 * Genera claves únicas para evitar duplicados en tickets y facturas.
 * Source of truth: buildInvoiceKey()
 */
import { buildInvoiceKey } from "./invoiceKey.js";

/**
 * Genera una clave única para un ticket manual.
 * Formato canónico: <dealId>::<lineItemId>::<fechaFacturacion>
 */
export function generateTicketKey(dealId, lineItemId, billingDate) {
  return buildInvoiceKey(dealId, lineItemId, billingDate);
}

/**
 * Genera una clave única para una factura.
 * Formato canónico: <dealId>::<lineItemId>::<fechaFacturacion>
 */
export function generateInvoiceKey(dealId, lineItemId, billingDate) {
  return buildInvoiceKey(dealId, lineItemId, billingDate);
}
