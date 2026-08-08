// src/services/notifications/ticketCancelledByEngineAlert.js
//
// EL MOTOR NO BORRA: CANCELA Y AVISA (PLAN §2.4).
//
// Bajo ETAPA_UNICA_ENABLED, cuando a Phase P le SOBRA un ticket no notificado
// (cambió la frecuencia, se acortó el plan, el line item dejó de existir…) ya no
// lo archiva: lo manda a la etapa CANCELADO y avisa. Es la misma respuesta que
// dio la usuaria al caso "cambia la frecuencia después de ganar": *se rearma
// pero avisando*. Cierra por diseño la pérdida silenciosa de tickets migrados o
// promovidos a mano.
//
// UN email por line item (o por negocio, en la limpieza de huérfanos) con la
// lista de fechas, no uno por ticket — mismo criterio que el resumen de la
// TANDA A: el cronograma se rearma entero, avisar renglón por renglón es ruido.
//
// Llave: DEAL_ALERTS_ENABLED (mismo parser que dealAlerts.js):
//   · ausente o vacía      → PRENDIDA
//   · 'false' / '0' / 'no' → APAGADA (se omite el email; la cancelación NO cambia)
//
// Destinatarios: vendedor (owner del negocio) + responsables (owners de los
// tickets cancelados) — mismo patrón de dos puntas que ticketKeptAliveAlert.js.
//
// Fire-and-forget: notifyTicketsCancelledByEngine NUNCA lanza.

import { sendAlertTo } from '../../../lib/alertService.js';
import { resolveOwnerEmail } from './dealAlerts.js';
import logger from '../../../lib/logger.js';

const MOD = 'ticketCancelledByEngineAlert';

/** ¿Está apagado este aviso? Usa DEAL_ALERTS_ENABLED (mismo parser que dealAlerts.js). */
export function ticketCancelledAlertApagado(fn, ctx = {}) {
  const raw = (process.env.DEAL_ALERTS_ENABLED ?? '').trim().toLowerCase();
  if (raw === 'false' || raw === '0' || raw === 'no') {
    logger.info({ module: MOD, fn, ...ctx }, 'DEAL_ALERTS_ENABLED=false — aviso de tickets cancelados OMITIDO');
    return true;
  }
  return false;
}

/**
 * Aviso por email: el motor canceló estos tickets del cronograma no notificado.
 *
 * @param {Object} params
 * @param {string|number|null} params.dealId
 * @param {string|null} [params.dealName]
 * @param {string|number|null} [params.dealOwnerId] - vendedor
 * @param {string|null} [params.lineItemName]
 * @param {string|number|null} [params.lineItemId]
 * @param {Array<{ticketId:string|number, fecha:string|null, ownerId:string|number|null}>} params.cancelados
 * @param {string} params.motivo - por qué sobraban (texto corto, va en el mail)
 * @param {Object} [deps] - inyectables sólo para tests (defaults = producción)
 * @returns {Promise<{emailed:boolean, reason?:string}>} NUNCA lanza.
 */
export async function notifyTicketsCancelledByEngine(
  { dealId, dealName = null, dealOwnerId = null, lineItemName = null, lineItemId = null, cancelados = [], motivo = '' },
  deps = {}
) {
  const fn = 'notifyTicketsCancelledByEngine';
  const { sendAlertToFn = sendAlertTo, resolveOwnerEmailFn = resolveOwnerEmail } = deps;
  try {
    if (!cancelados.length) return { emailed: false, reason: 'sin_cancelados' };
    if (ticketCancelledAlertApagado(fn, { dealId, lineItemId })) {
      return { emailed: false, reason: 'DEAL_ALERTS_ENABLED=false' };
    }

    const emailTargets = new Set();
    const dealOwnerEmail = await resolveOwnerEmailFn(dealOwnerId);
    if (dealOwnerEmail) emailTargets.add(dealOwnerEmail);

    const ownerIds = [...new Set(cancelados.map(c => c?.ownerId).filter(Boolean).map(String))];
    for (const oid of ownerIds) {
      const email = await resolveOwnerEmailFn(oid);
      if (email) emailTargets.add(email);
    }

    if (emailTargets.size === 0) {
      logger.info({ module: MOD, fn, dealId, lineItemId }, 'Sin destinatarios resolubles — aviso omitido');
      return { emailed: false, reason: 'sin_destinatarios' };
    }

    const fechas = cancelados
      .map(c => c?.fecha || `(ticket ${c?.ticketId})`)
      .sort()
      .join(', ');

    const negocioLabel = dealName ? `${dealName} (${dealId})` : String(dealId ?? '');
    const title = `Cronograma rearmado: ${cancelados.length} ticket(s) cancelado(s) — ${dealName || dealId}`;
    const meta = {
      negocio: negocioLabel,
      producto: lineItemName || (lineItemId ? `LI ${lineItemId}` : '(varios)'),
      cancelados: String(cancelados.length),
      fechas,
      motivo: motivo || '(sin motivo)',
      mensaje:
        'El motor rearmó el cronograma y estos tickets ya no corresponden. NO se borraron: quedaron en la etapa CANCELADO, a la vista. ' +
        'Si alguno tenía que facturarse igual, avisar a administración.',
    };

    await sendAlertToFn({ to: [...emailTargets], level: 'warning', title, meta });

    logger.info(
      { module: MOD, fn, dealId, lineItemId, cancelados: cancelados.length, emailsSent: emailTargets.size },
      'Aviso de tickets cancelados por el motor enviado'
    );
    return { emailed: true };
  } catch (err) {
    logger.warn(
      { module: MOD, fn, dealId, lineItemId, err: err?.message },
      'Aviso de tickets cancelados falló (no bloquea nada)'
    );
    return { emailed: false, reason: 'error' };
  }
}
