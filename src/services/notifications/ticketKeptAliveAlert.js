// src/services/notifications/ticketKeptAliveAlert.js
//
// Aviso al vendedor + responsable cuando, al perder/suspender un negocio bajo
// ETAPA_UNICA_ENABLED, cancelForecastTickets cancela todos los tickets no
// notificados del negocio MENOS el ticket manual con fecha más cercana a hoy
// (queda vivo para que se evalúe a mano si se cancela o se cobra). Ver
// definitivos/PLAN_proximos_cambios_tickets_2026-07-29.md TANDA A punto 2.
//
// Llave: DEAL_ALERTS_ENABLED (mismo parser que dealAlerts.js / adminRevertAlert.js):
//   · ausente o vacía      → PRENDIDA
//   · 'false' / '0' / 'no' → APAGADA (se omite el email; la cancelación no cambia)
//
// Destinatarios: vendedor (owner del deal) + responsable (owner del ticket que
// queda vivo) — mismo patrón de dos destinatarios que alertDerivacionCompleta
// (dealAlerts.js: vendedor + responsable del LI).
//
// Fire-and-forget: notifyTicketKeptAlive NUNCA lanza.

import { sendAlertTo } from '../../../lib/alertService.js';
import { resolveOwnerEmail } from './dealAlerts.js';
import logger from '../../../lib/logger.js';

const MOD = 'ticketKeptAliveAlert';

/** ¿Está apagado este aviso? Usa DEAL_ALERTS_ENABLED (mismo parser que dealAlerts.js). */
export function ticketKeptAliveAlertApagado(fn, ctx = {}) {
  const raw = (process.env.DEAL_ALERTS_ENABLED ?? '').trim().toLowerCase();
  if (raw === 'false' || raw === '0' || raw === 'no') {
    logger.info({ module: MOD, fn, ...ctx }, 'DEAL_ALERTS_ENABLED=false — aviso de ticket conservado OMITIDO');
    return true;
  }
  return false;
}

/**
 * Aviso por email: al perder/suspender el negocio, este ticket manual quedó
 * vivo (no se canceló) por ser el de fecha más cercana a hoy.
 *
 * @param {Object} params
 * @param {string|number|null} params.dealId
 * @param {string|null} params.dealName
 * @param {string|number|null} params.dealOwnerId   - vendedor (hubspot_owner_id del deal)
 * @param {string|number} params.ticketId
 * @param {string|number|null} params.ticketOwnerId - responsable (hubspot_owner_id del ticket)
 * @param {string|null} params.fechaResolucionEsperada
 * @param {string|null} params.motivo                - motivo de la pérdida/suspensión
 * @param {Object} [deps]
 * @param {Function} [deps.sendAlertToFn]     - default sendAlertTo
 * @param {Function} [deps.resolveOwnerEmailFn] - default resolveOwnerEmail
 * @returns {Promise<{emailed:boolean, reason?:string}>} NUNCA lanza.
 */
export async function notifyTicketKeptAlive(
  { dealId, dealName, dealOwnerId, ticketId, ticketOwnerId, fechaResolucionEsperada = null, motivo = null },
  deps = {}
) {
  const fn = 'notifyTicketKeptAlive';
  const { sendAlertToFn = sendAlertTo, resolveOwnerEmailFn = resolveOwnerEmail } = deps;
  try {
    if (ticketKeptAliveAlertApagado(fn, { dealId, ticketId })) {
      return { emailed: false, reason: 'DEAL_ALERTS_ENABLED=false' };
    }

    const emailTargets = new Set();

    const dealOwnerEmail = await resolveOwnerEmailFn(dealOwnerId);
    if (dealOwnerEmail) emailTargets.add(dealOwnerEmail);

    const ticketOwnerEmail = await resolveOwnerEmailFn(ticketOwnerId);
    if (ticketOwnerEmail) emailTargets.add(ticketOwnerEmail);

    if (emailTargets.size === 0) {
      logger.info({ module: MOD, fn, dealId, ticketId }, 'Sin destinatarios resolubles — aviso omitido');
      return { emailed: false, reason: 'sin_destinatarios' };
    }

    const negocioLabel = dealName ? `${dealName} (${dealId})` : String(dealId ?? '');
    const title = `Ticket manual conservado al perder/suspender — ${dealName || dealId}`;
    const meta = {
      negocio: negocioLabel,
      ticket: String(ticketId),
      fecha: fechaResolucionEsperada || '(sin fecha)',
      motivo: motivo || '(sin motivo)',
      mensaje: 'Los demás tickets no notificados del negocio se cancelaron. Este quedó vivo por ser el manual con fecha más cercana a hoy — revisar a mano si corresponde cancelarlo o cobrarlo.',
    };

    await sendAlertToFn({ to: [...emailTargets], level: 'warning', title, meta });

    logger.info(
      { module: MOD, fn, dealId, ticketId, emailsSent: emailTargets.size },
      'Aviso de ticket conservado enviado'
    );
    return { emailed: true };
  } catch (err) {
    logger.warn(
      { module: MOD, fn, dealId, ticketId, err: err?.message },
      'Aviso de ticket conservado falló (no bloquea nada)'
    );
    return { emailed: false, reason: 'error' };
  }
}
