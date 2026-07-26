// src/services/notifications/mirrorAlert.js
//
// Email operativo para los AVISOS A DEAL ESPEJO (UY) — complemento del
// billing_error que ya se escribe en el deal mirror vía reportHubSpotError.
//
// Decisión usuaria 25-jul: todos los avisos a mirror van TAMBIÉN por correo,
// además de la prop. Este módulo es el punto compartido del email; cada call
// site sigue escribiendo su billing_error como siempre (comportamiento
// histórico intacto) y llama emailAvisoMirror() al lado.
//
// Destinatario: el destino operativo por defecto de lib/alertService.js →
// sendAlert() manda a ALERT_TO_EMAIL (env; fallback promichfsd@gmail.com).
// No hay destinatario por-deal: los espejos UY los trabaja el equipo operativo.
//
// Llave: DEAL_ALERTS_ENABLED (la misma de dealAlerts.js, mismo parser):
//   · ausente o vacía      → PRENDIDA
//   · 'false' / '0' / 'no' → APAGADA (solo se omite el EMAIL; el billing_error
//                            del deal espejo se escribe igual que siempre)
// Evaluada en cada llamada.
//
// Fire-and-forget: emailAvisoMirror NUNCA lanza.

import { sendAlert } from '../../../lib/alertService.js';
import logger from '../../../lib/logger.js';

const MOD = 'mirrorAlert';

/**
 * ¿Está apagado el email de avisos a mirror? Usa DEAL_ALERTS_ENABLED
 * (mismo parser que alertasApagadas() de dealAlerts). Evaluada por llamada.
 */
export function mirrorEmailApagado(fn, ctx = {}) {
  const raw = (process.env.DEAL_ALERTS_ENABLED ?? '').trim().toLowerCase();
  if (raw === 'false' || raw === '0' || raw === 'no') {
    logger.info({ module: MOD, fn, ...ctx }, 'DEAL_ALERTS_ENABLED=false — email de aviso a mirror OMITIDO (billing_error intacto)');
    return true;
  }
  return false;
}

/**
 * Manda por email un aviso a deal espejo UY (el mismo texto que fue al
 * billing_error del mirror), al destino operativo de alertService.
 *
 * @param {Object} params
 * @param {string|number} params.mirrorDealId
 * @param {string} [params.title] - asunto del email
 * @param {string} params.message - el aviso (idéntico al billing_error)
 * @param {Object} [params.meta]  - datos extra para la tabla del email
 * @param {Object} [deps]
 * @param {Function} [deps.sendAlertFn] - default sendAlert (→ ALERT_TO_EMAIL)
 * @returns {Promise<{emailed:boolean, reason?:string}>} NUNCA lanza.
 */
export async function emailAvisoMirror({ mirrorDealId, title = 'Aviso al deal espejo UY', message, meta = {} }, deps = {}) {
  const fn = 'emailAvisoMirror';
  const { sendAlertFn = sendAlert } = deps;
  try {
    if (mirrorEmailApagado(fn, { mirrorDealId })) {
      return { emailed: false, reason: 'DEAL_ALERTS_ENABLED=false' };
    }
    await sendAlertFn('warning', title, {
      deal_espejo_uy: String(mirrorDealId),
      ...meta,
      mensaje: message,
    });
    logger.info({ module: MOD, fn, mirrorDealId, title }, 'Email de aviso a mirror enviado al destino operativo');
    return { emailed: true };
  } catch (err) {
    logger.warn({ module: MOD, fn, mirrorDealId, err: err?.message }, 'Email de aviso a mirror falló (no bloquea nada)');
    return { emailed: false, reason: 'error' };
  }
}
