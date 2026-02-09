import crypto from 'crypto';
import { getEffectiveBillingConfig } from '../../billingEngine.js';
import { parseLocalDate, formatDateISO, addInterval } from '../../utils/dateUtils.js';  
import { hubspotClient } from '../../hubspotClient.js';
function stableStringify(obj) {
  return JSON.stringify(obj, Object.keys(obj).sort());
}

function hashSignature(payload) {
  const s = stableStringify(payload);
  return crypto.createHash('sha1').update(s).digest('hex');
}

function computeContractEndYmd({ startYmd, interval, term }) {
  if (!startYmd) return '';
  if (!term || term <= 0) return '';

  // Pago único (interval null) -> vencimiento = start
  if (!interval) return startYmd;

  let d = parseLocalDate(startYmd);
  if (!d) return '';

  // última fecha = start + (term-1) intervalos
  for (let i = 1; i < term; i++) {
    d = addInterval(d, interval);
  }
  return formatDateISO(d);
}

// Ajustá estos nombres según tu config real
function getTermAndAutorenew(lineItem, config) {
  const p = lineItem.properties || {};

  const autorenew =
    config?.autorenew === true ||
    String(p.autorenew || '').toLowerCase() === 'true';

  const termRaw =
    config?.term ??
    p.hs_recurring_billing_number_of_payments ??
    p.term; // por si lo tenés

  const term = termRaw ? Number(termRaw) : null;
  return { autorenew, term: Number.isFinite(term) ? term : null };
}

export async function ensureForecastMetaOnLineItem(lineItem) {
  const p = lineItem.properties || {};
  const config = getEffectiveBillingConfig(lineItem);

  const startRaw =
    (p.hs_recurring_billing_start_date || '').toString().slice(0, 10) ||
    (p.recurringbillingstartdate || '').toString().slice(0, 10) ||
    (p.fecha_inicio_de_facturacion || '').toString().slice(0, 10) ||
    ''; // si ya lo normalizaste

  const interval = config?.interval ?? null;

  const { autorenew, term } = getTermAndAutorenew(lineItem, config);

  // --- Firma: si no hay start, no hay forecast
  let signature = '';
  if (startRaw) {
    const payload = {
      start: startRaw,
      interval: interval ? String(interval) : 'ONE_TIME',
      autorenew: !!autorenew,
      term: term ?? null,
      // opcional: monto/moneda si impactan forecast
      currency: p.currency || p.hs_currency || null,
      amount: p.amount || p.hs_recurring_billing_amount || null,
    };
    signature = hashSignature(payload);
  }

  // --- Facturas restantes (visible): solo para TERM
  const facturasRestantes = (!autorenew && term && term > 0) ? String(term) : '';

  // --- Vencimiento contrato: solo para TERM
  const vencimiento = (!autorenew && term && term > 0)
    ? computeContractEndYmd({ startYmd: startRaw, interval, term })
    : '';

  const updates = {};
  if ((p.forecast_signature || '') !== signature) updates.forecast_signature = signature;
  if ((p.facturas_restantes || '') !== facturasRestantes) updates.facturas_restantes = facturasRestantes;
  if ((p.fecha_vencimiento_contrato || '') !== vencimiento) updates.fecha_vencimiento_contrato = vencimiento;

  if (Object.keys(updates).length) {
    await hubspotClient.crm.lineItems.basicApi.update(String(lineItem.id), { properties: updates });
    lineItem.properties = { ...p, ...updates };
  }
}
