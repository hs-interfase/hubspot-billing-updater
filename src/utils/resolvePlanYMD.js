// src/utils/resolvePlanYMD.js
import { toYMDInBillingTZ } from './dateUtils.js';
import { fechaNotificadaDelLineItem } from './ticketFrontera.js';
import logger from '../../lib/logger.js';

function normalizeToYMD(raw) {
  if (!raw) return null;

  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return new Date(raw).toISOString().slice(0, 10);
  }

  const s = String(raw).trim();
  if (!s) return null;

  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);

  const ms = Date.parse(s);
  if (Number.isFinite(ms)) return new Date(ms).toISOString().slice(0, 10);

  return null;
}

export function resolvePlanYMD({ lineItemProps = {}, ticketProps = {}, context = {} } = {}) {
  const fromTicketRaw = ticketProps?.fecha_resolucion_esperada;
  const fromTicketYMD =
    fromTicketRaw ? (toYMDInBillingTZ(fromTicketRaw) || normalizeToYMD(fromTicketRaw)) : null;

// Después:
  const fromNextYMD = normalizeToYMD(lineItemProps?.billing_next_date);
  const fromStartYMD = normalizeToYMD(lineItemProps?.hs_recurring_billing_start_date);

  // TANDA C: `last_ticketed_date` se elimina → se lee la fecha NOTIFICADO.
  // Sólo aplica al flujo PHASE3, que es el pipeline AUTOMÁTICO: ahí las dos
  // fechas coinciden hoy (PROMOTED y DERIVED sólo difieren en «Próximos a
  // facturar», que es una etapa manual), así que el cambio no mueve nada del
  // automático y deja el manual bien si alguna vez cae por acá.
  const fromLastTicketedYMD =
    context?.flow === 'PHASE3'
      ? normalizeToYMD(fechaNotificadaDelLineItem(lineItemProps || {}) || null)
      : null;

  const resolvedNext =
    fromLastTicketedYMD && fromNextYMD && fromNextYMD > fromLastTicketedYMD
      ? fromLastTicketedYMD
      : fromNextYMD;

  const planYMD = fromTicketYMD || resolvedNext || (context?.flow === 'PHASE3' ? fromLastTicketedYMD : null) || fromStartYMD || null;

  if (process.env.DBG_PHASE1 === 'true') {
    const log = logger.child({ module: 'resolvePlanYMD', ...(context || {}) });

    log.debug(
      {
        input: {
          fecha_resolucion_esperada: fromTicketRaw || null,
          billing_next_date: lineItemProps?.billing_next_date || null,
          hs_recurring_billing_start_date: lineItemProps?.hs_recurring_billing_start_date || null,
        },
        output: { planYMD },
        pickedFrom: fromTicketYMD
          ? 'ticket.fecha_resolucion_esperada'
          : fromNextYMD
            ? 'lineItem.billing_next_date'
            : fromStartYMD
              ? 'lineItem.hs_recurring_billing_start_date'
              : 'null',
      },
      '[resolvePlanYMD]'
    );
  }

  return planYMD;
}
