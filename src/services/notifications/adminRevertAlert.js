// src/services/notifications/adminRevertAlert.js
//
// Email a ADMINISTRACIÓN cuando se REVIERTE una factura para refacturar
// (Bloque 4 del flujo cancelar/revertir). Clon estructural de mirrorAlert.js.
//
// ⚠️ SOLO se dispara con cancelIntent EXPLÍCITO 'revert' (casilla
// revertir_factura / editor en modo revertir). NUNCA con intent null: el cron
// sweep propagateCancelledInvoicesForDeal re-propaga las MISMAS invoices
// canceladas en cada corrida — si este aviso corriera ahí, spamearía a
// administración en cada pasada. El call site (propagacion/invoice.js, rama 5b)
// garantiza el gate; este módulo no decide intents.
//
// Destinatario: env ADMIN_ALERT_TO_EMAIL (trim). Si no está seteada, fallback
// al destino operativo general de lib/alertService.js (ALERT_TO_EMAIL) — mismo
// esquema que MIRROR_ALERT_TO_EMAIL en mirrorAlert.js.
//
// Llave: DEAL_ALERTS_ENABLED (la misma de dealAlerts.js, mismo parser):
//   · ausente o vacía      → PRENDIDA
//   · 'false' / '0' / 'no' → APAGADA (se omite el email; el resto del flujo
//                            de reversión no cambia en nada)
// Evaluada en cada llamada.
//
// Umbral de refuerzo: env REBILL_ALERT_THRESHOLD (default '2'). Si el contador
// of_refacturaciones alcanza el umbral, el título pasa a tono de atención
// ("⚠️ Período refacturado N veces"). '0' o vacía = sin refuerzo (título
// normal siempre). Mismo email, mismo destinatario — solo cambia el título.
//
// Fire-and-forget: notifyAdminOnRevert NUNCA lanza.

import { sendAlert, sendAlertTo } from '../../../lib/alertService.js';
import logger from '../../../lib/logger.js';

const MOD = 'adminRevertAlert';

/**
 * ¿Está apagado el email de aviso a administración? Usa DEAL_ALERTS_ENABLED
 * (mismo parser que mirrorEmailApagado / alertasApagadas). Evaluada por llamada.
 */
export function adminRevertEmailApagado(fn, ctx = {}) {
  const raw = (process.env.DEAL_ALERTS_ENABLED ?? '').trim().toLowerCase();
  if (raw === 'false' || raw === '0' || raw === 'no') {
    logger.info({ module: MOD, fn, ...ctx }, 'DEAL_ALERTS_ENABLED=false — email de reversión a administración OMITIDO');
    return true;
  }
  return false;
}

/**
 * Umbral de refuerzo del aviso de refacturación (REBILL_ALERT_THRESHOLD).
 * Leída POR LLAMADA (testeable sin orden de import).
 *
 *   · ausente            → 2 (default)
 *   · '0' o vacía        → 0 = SIN refuerzo (título normal siempre)
 *   · entero positivo    → ese umbral
 *   · basura / negativo  → 2 (default, valor seguro)
 *
 * @returns {number} 0 = refuerzo desactivado
 */
export function rebillAlertThreshold() {
  const raw = (process.env.REBILL_ALERT_THRESHOLD ?? '2').trim();
  if (raw === '' || raw === '0') return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 2;
}

/**
 * Título del email según contador y umbral. Helper PURO y testeable.
 *
 * @param {number|string|null} contador - of_refacturaciones nuevo (N)
 * @returns {string}
 */
export function buildRevertAlertTitle(contador) {
  const threshold = rebillAlertThreshold();
  const n = Number(contador);
  if (threshold > 0 && Number.isFinite(n) && n >= threshold) {
    return `⚠️ Período refacturado ${n} veces`;
  }
  return 'Factura revertida para refacturar';
}

/**
 * Texto humano del resultado de cupo (mismo criterio que
 * finalizeTicketAfterDefinitiveCancellation en propagacion/invoice.js).
 *
 * @param {Object|null} cupoResult - resultado de revertCupoForInvoice (o null)
 * @returns {string}
 */
function cupoResultTexto(cupoResult) {
  if (!cupoResult || cupoResult.reason === 'no_consumio_o_ya_revertido') {
    return 'no aplica';
  }
  if (cupoResult.reverted) {
    return `re-acreditado +${cupoResult.credito} (restante ${cupoResult.cupoRestanteNuevo})`;
  }
  return `no se pudo re-acreditar: ${cupoResult.reason}`;
}

/**
 * Aviso por email a administración: una factura fue REVERTIDA para refacturar.
 *
 * @param {Object} params
 * @param {string|number|null} params.dealId
 * @param {string|number} params.ticketId
 * @param {string|number} params.invoiceId
 * @param {number|string|null} params.contador   - of_refacturaciones nuevo (N)
 * @param {Object|null} [params.cupoResult]      - resultado de revertCupoForInvoice
 * @param {string|null} [params.motivo]          - motivo_del_ajuste del ticket
 * @param {Object} [deps]
 * @param {Function} [deps.sendAlertFn]   - default sendAlert (→ ALERT_TO_EMAIL)
 * @param {Function} [deps.sendAlertToFn] - default sendAlertTo (usada cuando
 *                                          ADMIN_ALERT_TO_EMAIL está seteada)
 * @returns {Promise<{emailed:boolean, reason?:string}>} NUNCA lanza.
 */
export async function notifyAdminOnRevert(
  { dealId, ticketId, invoiceId, contador, cupoResult = null, motivo = null },
  deps = {}
) {
  const fn = 'notifyAdminOnRevert';
  const { sendAlertFn = sendAlert, sendAlertToFn = sendAlertTo } = deps;
  try {
    if (adminRevertEmailApagado(fn, { ticketId, invoiceId })) {
      return { emailed: false, reason: 'DEAL_ALERTS_ENABLED=false' };
    }

    const title = buildRevertAlertTitle(contador);

    const meta = {
      negocio: dealId ? String(dealId) : undefined,
      ticket: String(ticketId),
      invoice: String(invoiceId),
    };
    const motivoLimpio = String(motivo ?? '').trim();
    if (motivoLimpio) meta.motivo = motivoLimpio;
    const n = Number(contador);
    meta['refacturación'] = Number.isFinite(n) ? `N° ${n}` : '(sin contador)';
    meta.cupo = cupoResultTexto(cupoResult);

    const destinoDedicado = (process.env.ADMIN_ALERT_TO_EMAIL ?? '').trim();
    if (destinoDedicado) {
      await sendAlertToFn({ to: [destinoDedicado], level: 'warning', title, meta });
    } else {
      await sendAlertFn('warning', title, meta);
    }
    logger.info(
      { module: MOD, fn, ticketId, invoiceId, title, destinoDedicado: destinoDedicado || '(operativo default)' },
      'Email de reversión a administración enviado'
    );
    return { emailed: true };
  } catch (err) {
    logger.warn(
      { module: MOD, fn, ticketId, invoiceId, err: err?.message },
      'Email de reversión a administración falló (no bloquea nada)'
    );
    return { emailed: false, reason: 'error' };
  }
}
