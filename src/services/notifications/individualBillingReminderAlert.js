// src/services/notifications/individualBillingReminderAlert.js
//
// Aviso INDIVIDUAL al responsable cuando falta ~1 mes (MANUAL_TICKET_LOOKAHEAD_DAYS)
// para la fecha de un ticket manual no notificado. Bajo ETAPA_UNICA_ENABLED, la
// ventana de 30 días deja de mover la etapa del ticket (eso queda en el núcleo
// de Phase P/Phase 2, fuera de esta tanda) y sobrevive SÓLO como disparador de
// este aviso. Ver definitivos/PLAN_proximos_cambios_tickets_2026-07-29.md
// TANDA A punto 3 / §2.2.
//
// ⚠️ Este es el ÚNICO aviso al responsable que manda el motor. El resumen al
// cierre ganado que había implementado la TANDA A se SACÓ el 30-jul (decisión
// usuaria: lo arma ella con un workflow de HubSpot), junto con la prop
// `of_resumen_cronograma_enviado`, que ya no va.
// Sigue en pie apagar el workflow 1771474299 de PROD (dispara con «Próximos a
// facturar» y notifica al responsable) el día que se prenda
// ETAPA_UNICA_ENABLED, o llegan dos avisos por ticket.
//
// Idempotencia: prop booleana en el TICKET (AVISO_1MES_ENVIADO_PROP). El
// caller (phase2.js) decide cuándo llamar esto (una vez por line item y
// pasada); sin marker se reenviaría en cada corrida del cron mientras el
// ticket siga dentro de la ventana.
//
// Llave: DEAL_ALERTS_ENABLED (mismo parser que el resto de los avisos).
// Destinatario: responsable (owner del ticket); si el ticket no tiene owner
// todavía, cae al vendedor (owner del deal) — mismo fallback que
// assignTicketOwners.js.
//
// Fire-and-forget: notifyIndividualBillingReminder NUNCA lanza.

import { sendAlertTo } from '../../../lib/alertService.js';
import { resolveOwnerEmail } from './dealAlerts.js';
import { MANUAL_TICKET_LOOKAHEAD_DAYS } from '../../config/constants.js';
import logger from '../../../lib/logger.js';

const MOD = 'individualBillingReminderAlert';

// Prop booleana en el TICKET: marca que el aviso individual ya se envió para
// esa fecha. Debe existir en HubSpot antes de prender la flag en prod.
export const AVISO_1MES_ENVIADO_PROP = 'of_aviso_1mes_enviado';

/** ¿Está apagado este aviso? Usa DEAL_ALERTS_ENABLED (mismo parser que dealAlerts.js). */
export function individualBillingReminderApagado(fn, ctx = {}) {
  const raw = (process.env.DEAL_ALERTS_ENABLED ?? '').trim().toLowerCase();
  if (raw === 'false' || raw === '0' || raw === 'no') {
    logger.info({ module: MOD, fn, ...ctx }, 'DEAL_ALERTS_ENABLED=false — aviso individual OMITIDO');
    return true;
  }
  return false;
}

/**
 * Aviso individual: a este ticket manual le falta ~1 mes para su fecha.
 *
 * @param {Object} params
 * @param {string|number|null} params.dealId
 * @param {string|null} params.dealName
 * @param {string|number|null} params.dealOwnerId    - vendedor (fallback si el ticket no tiene owner)
 * @param {string|number} params.ticketId
 * @param {string|number|null} params.ticketOwnerId  - responsable (owner del ticket)
 * @param {string|null} params.fechaResolucionEsperada
 * @param {string|null} [params.lineItemName]
 * @param {Object} [deps]
 * @param {Function} [deps.sendAlertToFn]       - default sendAlertTo
 * @param {Function} [deps.resolveOwnerEmailFn] - default resolveOwnerEmail
 * @returns {Promise<{emailed:boolean, reason?:string}>} NUNCA lanza.
 */
export async function notifyIndividualBillingReminder(
  { dealId, dealName, dealOwnerId, ticketId, ticketOwnerId, fechaResolucionEsperada = null, lineItemName = null },
  deps = {}
) {
  const fn = 'notifyIndividualBillingReminder';
  const { sendAlertToFn = sendAlertTo, resolveOwnerEmailFn = resolveOwnerEmail } = deps;
  try {
    if (individualBillingReminderApagado(fn, { dealId, ticketId })) {
      return { emailed: false, reason: 'DEAL_ALERTS_ENABLED=false' };
    }

    const responsableEmail =
      (await resolveOwnerEmailFn(ticketOwnerId)) ||
      (await resolveOwnerEmailFn(dealOwnerId));

    if (!responsableEmail) {
      logger.info({ module: MOD, fn, dealId, ticketId }, 'Sin destinatario resoluble — aviso omitido');
      return { emailed: false, reason: 'sin_destinatario' };
    }

    const title = `Facturación próxima (dentro de ${MANUAL_TICKET_LOOKAHEAD_DAYS} días) — ${dealName || dealId}`;
    const meta = {
      negocio: dealName ? `${dealName} (${dealId})` : String(dealId ?? ''),
      ticket: String(ticketId),
      elemento_de_pedido: lineItemName || undefined,
      fecha: fechaResolucionEsperada || '(sin fecha)',
    };

    await sendAlertToFn({ to: [responsableEmail], level: 'info', title, meta });

    logger.info(
      { module: MOD, fn, dealId, ticketId },
      'Aviso individual de facturación próxima enviado'
    );
    return { emailed: true };
  } catch (err) {
    logger.warn(
      { module: MOD, fn, dealId, ticketId, err: err?.message },
      'Aviso individual falló (no bloquea nada)'
    );
    return { emailed: false, reason: 'error' };
  }
}
