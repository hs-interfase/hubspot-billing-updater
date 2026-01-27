// src/utils/resolvePlanYMD.js
import { toYMDInBillingTZ } from './dateUtils.js';

/**
 * Normaliza cualquier input a YYYY-MM-DD.
 * Acepta:
 * - "YYYY-MM-DD"
 * - millis number
 * - ISO string con hora
 */
function normalizeToYMD(raw) {
  if (!raw) return null;

  // number millis
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return new Date(raw).toISOString().slice(0, 10);
  }

  const s = String(raw).trim();
  if (!s) return null;

  // ya viene YYYY-MM-DD (o algo que empieza así)
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);

  // ISO u otros formatos parseables
  const ms = Date.parse(s);
  if (Number.isFinite(ms)) return new Date(ms).toISOString().slice(0, 10);

  return null;
}

/**
 * resolvePlanYMD
 * prioridad:
 * 1) ticket.fecha_resolucion_esperada
 * 2) lineItem.billing_next_date
 * 3) lineItem.hs_recurring_billing_start_date  (fallback permitido one-time)
 * NO usar getTodayYMD.
 */
export function resolvePlanYMD({ lineItemProps = {}, ticketProps = {}, context = {} } = {}) {
  const fromTicketRaw = ticketProps?.fecha_resolucion_esperada;
  // ojo TZ: si viene con hora/UTC, preferimos tu helper para no caer en -1 día
  const fromTicketYMD =
    fromTicketRaw ? (toYMDInBillingTZ(fromTicketRaw) || normalizeToYMD(fromTicketRaw)) : null;

  const fromNextYMD = normalizeToYMD(lineItemProps?.billing_next_date);
  const fromStartYMD = normalizeToYMD(lineItemProps?.hs_recurring_billing_start_date);

  const planYMD = fromTicketYMD || fromNextYMD || fromStartYMD || null;

  if (process.env.DBG_PHASE1 === 'true') {
    console.log('[resolvePlanYMD]', {
      context, // ej: { flow:'PHASE2', dealId, lineItemId, ticketId }
      input: {
        ticket_fecha_resolucion_esperada: fromTicketRaw || null,
        billing_next_date: lineItemProps?.billing_next_date || null,
        hs_recurring_billing_start_date: lineItemProps?.hs_recurring_billing_start_date || null,
      },
      output: { planYMD },
      pickedFrom: fromTicketYMD ? 'ticket.fecha_resolucion_esperada'
        : fromNextYMD ? 'lineItem.billing_next_date'
        : fromStartYMD ? 'lineItem.hs_recurring_billing_start_date'
        : 'null',
    });
  }

  return planYMD;
}
