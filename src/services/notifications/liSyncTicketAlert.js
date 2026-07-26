// src/services/notifications/liSyncTicketAlert.js
//
// Aviso al RESPONSABLE del ticket cuando el sync quirúrgico LI→ticket
// (syncLineItemPropToTicket) escribió cambios en un ticket que ya está en
// "Próximos a Facturar": el vendedor tocó el line item y el cambio aterrizó
// en un ticket que el responsable está por facturar → tiene que enterarse.
//
// SIN correo (decisión usuaria 25-jul): el aviso es SOLO la escritura de
// of_billing_error en el ticket (writeTicketBillingError, con timestamp),
// que dispara el workflow de HubSpot que crea la tarea al owner del ticket.
//
// ── Env nueva: LI_SYNC_OWNER_ALERT_ENABLED ───────────────────────────────────
// MISMA semántica que DEAL_ALERTS_ENABLED (dealAlerts.js):
//   · ausente o vacía          → PRENDIDA (no apagar por accidente)
//   · 'false' / '0' / 'no'     → APAGADA (se omite el aviso; el sync sigue)
// Se evalúa EN CADA LLAMADA (cambiarla en Railway no requiere redeploy del
// worker, solo del proceso). Pensada para migraciones/corridas masivas donde
// el sync LI→ticket correría en lote y los avisos serían una avalancha.
//
// Fire-and-forget: avisarResponsableTicketPorSyncLI NUNCA lanza — cualquier
// error se loguea con warn y se devuelve en el resultado.

import { writeTicketBillingError } from './dealAlerts.js';
import logger from '../../../lib/logger.js';

const MOD = 'liSyncTicketAlert';

/**
 * ¿Está apagada la llave LI_SYNC_OWNER_ALERT_ENABLED?
 * Mismo parser que alertasApagadas() de dealAlerts: solo 'false'/'0'/'no'
 * apagan; ausente/vacía = prendida. Evaluada en cada llamada.
 */
export function liSyncAlertasApagadas(fn, ctx = {}) {
  const raw = (process.env.LI_SYNC_OWNER_ALERT_ENABLED ?? '').trim().toLowerCase();
  if (raw === 'false' || raw === '0' || raw === 'no') {
    logger.info({ module: MOD, fn, ...ctx }, 'LI_SYNC_OWNER_ALERT_ENABLED=false — aviso OMITIDO (el sync ya corrió)');
    return true;
  }
  return false;
}

/**
 * Avisa al responsable de UN ticket que el sync quirúrgico LI→ticket le
 * escribió cambios estando en "Próximos a Facturar".
 *
 * Flujo: flag → mensaje → writeTicketErrorFn (of_billing_error del ticket,
 * que dispara el workflow de HubSpot → tarea al owner). Sin correo.
 *
 * @param {Object} params
 * @param {string|number} params.ticketId
 * @param {string|number|null} [params.ticketOwnerId] - hubspot_owner_id del ticket.
 *   Hoy NO condiciona nada (el workflow de HubSpot resuelve el owner); queda en
 *   la firma por si a futuro se usa en el texto o para otro canal.
 * @param {string|number} params.lineItemId
 * @param {string|null}   [params.lineItemName]
 * @param {string}        params.propertyName - prop del LI que cambió el vendedor
 * @param {Object}        params.patch - claves de ticket efectivamente escritas
 * @param {string|number|null} [params.dealId]
 * @param {Object} [deps] - inyectables para tests
 * @param {Function} [deps.writeTicketErrorFn] - default writeTicketBillingError
 * @returns {Promise<{notified:boolean, reason?:string}>} NUNCA lanza.
 */
export async function avisarResponsableTicketPorSyncLI({
  ticketId,
  ticketOwnerId = null, // eslint-disable-line no-unused-vars — ver JSDoc
  lineItemId,
  lineItemName = null,
  propertyName,
  patch = {},
  dealId = null,
}, deps = {}) {
  const fn = 'avisarResponsableTicketPorSyncLI';
  const { writeTicketErrorFn = writeTicketBillingError } = deps;

  try {
    if (liSyncAlertasApagadas(fn, { ticketId, lineItemId, propertyName })) {
      return { notified: false, reason: 'LI_SYNC_OWNER_ALERT_ENABLED=false' };
    }

    const liName = lineItemName || String(lineItemId ?? '');
    const cambios = Object.entries(patch || {})
      .map(([k, v]) => `${k}="${v ?? ''}"`)
      .join(', ');

    const msg =
      `El vendedor modificó el elemento de pedido "${liName}" (${lineItemId}): ` +
      `propiedad ${propertyName}. Cambios aplicados a este ticket: ${cambios}. ` +
      `Verificá los datos antes de facturar.`;

    // of_billing_error del ticket → workflow de HubSpot → tarea al owner
    await writeTicketErrorFn(String(ticketId), msg);

    logger.info({ module: MOD, fn, ticketId, dealId, propertyName }, 'Responsable del ticket avisado (of_billing_error)');
    return { notified: true };
  } catch (err) {
    logger.warn(
      { module: MOD, fn, ticketId, lineItemId, propertyName, err: err?.message },
      'Aviso al responsable del ticket falló (no bloquea el sync)'
    );
    return { notified: false, reason: 'error' };
  }
}
