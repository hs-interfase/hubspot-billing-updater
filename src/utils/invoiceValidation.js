// src/utils/invoiceValidation.js

import { hubspotClient } from '../hubspotClient.js';
import { generateInvoiceKey } from './idempotency.js';

/**
 * Valida si un invoice_id es legítimo para un line item específico.
 * 
 * Protege contra:
 * - Line items clonados por UI que heredan invoice_id de su fuente
 * - invoice_id asignado manualmente con key incorrecta
 * 
 * @param {Object} params
 * @param {string} params.dealId - ID del Deal
 * @param {string} params.lineItemId - ID del Line Item
 * @param {string} params.invoiceId - ID de la Invoice a validar
 * @param {string} params.billDateYMD - Fecha de facturación (YYYY-MM-DD)
 * @returns {Promise<Object>} { valid: boolean, reason: string, expectedKey?: string, foundKey?: string }
 */
export async function isInvoiceIdValidForLineItem({ dealId, lineItemId, invoiceId, billDateYMD }) {
  // 1) Sin invoiceId => no válido
  if (!invoiceId || invoiceId === 'null' || invoiceId === 'undefined') {
    return { valid: false, reason: 'no_invoice_id' };
  }

  // 2) Calcular expected key usando la MISMA función que usamos para crear invoices
  const expectedInvoiceKey = generateInvoiceKey(dealId, lineItemId, billDateYMD);

  try {
    // 3) Leer invoice y obtener su of_invoice_key
    const invoice = await hubspotClient.crm.objects.basicApi.getById(
      'invoices',
      String(invoiceId),
      ['of_invoice_key']
    );

    const foundInvoiceKey = invoice?.properties?.of_invoice_key || '';

    console.log(`[invoiceValidation] Validando invoice_id=${invoiceId}`);
    console.log(`[invoiceValidation] Expected key: ${expectedInvoiceKey}`);
    console.log(`[invoiceValidation] Found key:    ${foundInvoiceKey}`);

    // 4) Comparar keys
    if (foundInvoiceKey === expectedInvoiceKey) {
      return { 
        valid: true, 
        reason: 'key_match',
        expectedKey: expectedInvoiceKey,
        foundKey: foundInvoiceKey
      };
    }

    // 5) Key no coincide => invoice_id heredado o corrupto
    return { 
      valid: false, 
      reason: 'invoice_id_inherited_or_mismatch',
      expectedKey: expectedInvoiceKey,
      foundKey: foundInvoiceKey
    };

  } catch (err) {
    console.error(`[invoiceValidation] Error leyendo invoice ${invoiceId}:`, err?.message);
    
    // Si la invoice no existe, el ID es inválido
    if (err?.response?.status === 404) {
      return { 
        valid: false, 
        reason: 'invoice_not_found',
        expectedKey: expectedInvoiceKey
      };
    }

    // Otro error => no podemos validar, consideramos inválido por seguridad
    return { 
      valid: false, 
      reason: `validation_error: ${err?.message}`,
      expectedKey: expectedInvoiceKey
    };
  }
}