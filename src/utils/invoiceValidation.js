// src/utils/invoiceValidation.js

import { hubspotClient } from '../hubspotClient.js';
import { buildInvoiceKey } from './invoiceKey.js';
import logger from '../../lib/logger.js';

/**
 * Valida si un invoice_id es legítimo para un line item específico.
 *
 * Protege contra:
 * - Line items clonados por UI que heredan invoice_id de su fuente
 * - invoice_id asignado manualmente con key incorrecta
 *
 * @param {Object} params
 * @param {string} params.dealId   - ID del Deal
 * @param {string} params.lik      - Line Item Key (line_item_key)
 * @param {string} params.invoiceId    - ID de la Invoice a validar
 * @param {string} params.billDateYMD  - Fecha de facturación (YYYY-MM-DD)
 * @returns {Promise<Object>} { valid: boolean, reason: string, expectedKey?: string, foundKey?: string }
 */
export async function isInvoiceIdValidForLineItem({ dealId, lik, invoiceId, billDateYMD }) {
  // 1) Sin invoiceId => no válido
  if (!invoiceId || invoiceId === 'null' || invoiceId === 'undefined') {
    return { valid: false, reason: 'no_invoice_id' };
  }

  // 2) Calcular expected key usando LIK (mismo formato que al crear invoices)
  const expectedInvoiceKey = buildInvoiceKey(dealId, lik, billDateYMD);

  const log = logger.child({ module: 'invoiceValidation', dealId, lik, invoiceId, billDateYMD });

  try {
    // 3) Leer invoice y obtener su of_invoice_key
    const invoice = await hubspotClient.crm.objects.basicApi.getById(
      'invoices',
      String(invoiceId),
      ['of_invoice_key']
    );

    const foundInvoiceKey = invoice?.properties?.of_invoice_key || '';

    log.info({ expectedInvoiceKey, foundInvoiceKey }, `[invoiceValidation] Validando invoice_id=${invoiceId}`);
    log.info({ expectedInvoiceKey }, `[invoiceValidation] Expected key: ${expectedInvoiceKey}`);
    log.info({ foundInvoiceKey }, `[invoiceValidation] Found key:    ${foundInvoiceKey}`);

    // 4) Comparar keys
    if (foundInvoiceKey === expectedInvoiceKey) {
      return { valid: true, reason: 'key_match', expectedKey: expectedInvoiceKey, foundKey: foundInvoiceKey };
    }

    return { valid: false, reason: 'invoice_id_inherited_or_mismatch', expectedKey: expectedInvoiceKey, foundKey: foundInvoiceKey };

  } catch (err) {
    log.error(
      { err: err?.message || String(err), status: err?.response?.status },
      `[invoiceValidation] Error leyendo invoice ${invoiceId}:`
    );

    if (err?.response?.status === 404) {
      return { valid: false, reason: 'invoice_not_found', expectedKey: expectedInvoiceKey };
    }

    return { valid: false, reason: `validation_error: ${err?.message}`, expectedKey: expectedInvoiceKey };
  }
}