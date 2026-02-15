// src/billing/mode.js
import { parseBool } from '../../utils/parsers.js';
// AUTO_RENEW = tiene frecuencia y NO tiene número de pagos (pagos = plan fijo)
export function isAutoRenew({ properties }) {
  const p = properties || {};

  // algunos line items usan una u otra
  const freq =
    (p.recurringbillingfrequency ?? '') ||
    (p.hs_recurring_billing_frequency ?? '');

  const paymentsRaw =
    p.hs_recurring_billing_number_of_payments ?? p.number_of_payments;

  const payments = paymentsRaw ? Number(paymentsRaw) : 0;

  // opcional: si tenés un flag explícito "renovacion_automatica"
  // lo respetamos cuando existe
  if (p.renovacion_automatica != null && String(p.renovacion_automatica).trim() !== '') {
    return parseBool(p.renovacion_automatica);
  }

  return String(freq).trim() !== '' && !(payments > 0);
}
