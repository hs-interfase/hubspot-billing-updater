// src/services/notifications/dealWonScheduleSummaryAlert.js
//
// Resumen ÚNICO al cierre ganado del negocio, bajo ETAPA_UNICA_ENABLED: UN
// email con todo el cronograma de tickets (no uno por ticket). Ver
// definitivos/PLAN_proximos_cambios_tickets_2026-07-29.md TANDA A punto 3 / §2.2.
//
// ⚠️ Este aviso REEMPLAZA al workflow 1771474299 de PROD (dispara con
// «Próximos a facturar» y notifica al responsable, un email por ticket). Hay
// que apagarlo el mismo día que se prenda ETAPA_UNICA_ENABLED en producción,
// o llegan dos avisos por ticket. Este módulo NO lo apaga — sólo lo asume.
//
// Se dispara UNA sola vez por negocio: la idempotencia (marker en el deal,
// prop RESUMEN_ENVIADO_PROP) la gestiona el caller (associateOnClosedWon.js),
// que es quien corre en cada pasada de phases y sabe si ya se marcó.
//
// Llave: DEAL_ALERTS_ENABLED (mismo parser que el resto de los avisos del
// motor — dealAlerts.js / adminRevertAlert.js). Destinatario: vendedor (owner
// del deal) — es el resumen "para el vendedor", no un aviso por ticket a cada
// responsable distinto (eso es notifyIndividualBillingReminder, a 1 mes).
//
// Fire-and-forget: notifyDealWonScheduleSummary NUNCA lanza.

import { sendAlertTo } from '../../../lib/alertService.js';
import { resolveOwnerEmail } from './dealAlerts.js';
import logger from '../../../lib/logger.js';

const MOD = 'dealWonScheduleSummaryAlert';

// Prop booleana en el DEAL: marca que el resumen ya se envió, para que el
// hook (que corre en cada pasada de phases sobre negocios ya ganados) no lo
// reenvíe siempre. Debe existir en HubSpot antes de prender la flag en prod.
export const RESUMEN_ENVIADO_PROP = 'of_resumen_cronograma_enviado';

/** ¿Está apagado este aviso? Usa DEAL_ALERTS_ENABLED (mismo parser que dealAlerts.js). */
export function dealWonScheduleSummaryApagado(fn, ctx = {}) {
  const raw = (process.env.DEAL_ALERTS_ENABLED ?? '').trim().toLowerCase();
  if (raw === 'false' || raw === '0' || raw === 'no') {
    logger.info({ module: MOD, fn, ...ctx }, 'DEAL_ALERTS_ENABLED=false — resumen de cronograma OMITIDO');
    return true;
  }
  return false;
}

/** Una fila legible por ticket: fecha — line item key (id). PURO y testeable. */
export function formatTicketRow(t) {
  const p = t?.properties || {};
  const fecha = String(p.fecha_resolucion_esperada || '').slice(0, 10) || '(sin fecha)';
  const lik = p.of_line_item_key || '(sin line item)';
  return `${fecha} — ${lik} (${t.id})`;
}

/** Tickets ordenados por fecha ascendente (sin fecha, al final). PURO y testeable. */
export function sortTicketsByFecha(tickets) {
  return [...(tickets || [])].sort((a, b) => {
    const fa = String(a?.properties?.fecha_resolucion_esperada || '').slice(0, 10) || '9999-99-99';
    const fb = String(b?.properties?.fecha_resolucion_esperada || '').slice(0, 10) || '9999-99-99';
    return fa.localeCompare(fb);
  });
}

/**
 * Resumen único al cierre ganado: UN email con todo el cronograma de tickets
 * del negocio (no uno por ticket).
 *
 * @param {Object} params
 * @param {string|number|null} params.dealId
 * @param {string|null} params.dealName
 * @param {string|number|null} params.dealOwnerId - vendedor (hubspot_owner_id del deal)
 * @param {Array} params.tickets                  - tickets del deal (con properties)
 * @param {Object} [deps]
 * @param {Function} [deps.sendAlertToFn]       - default sendAlertTo
 * @param {Function} [deps.resolveOwnerEmailFn] - default resolveOwnerEmail
 * @returns {Promise<{emailed:boolean, reason?:string}>} NUNCA lanza.
 */
export async function notifyDealWonScheduleSummary(
  { dealId, dealName, dealOwnerId, tickets = [] },
  deps = {}
) {
  const fn = 'notifyDealWonScheduleSummary';
  const { sendAlertToFn = sendAlertTo, resolveOwnerEmailFn = resolveOwnerEmail } = deps;
  try {
    if (dealWonScheduleSummaryApagado(fn, { dealId })) {
      return { emailed: false, reason: 'DEAL_ALERTS_ENABLED=false' };
    }

    const dealOwnerEmail = await resolveOwnerEmailFn(dealOwnerId);
    if (!dealOwnerEmail) {
      logger.info({ module: MOD, fn, dealId }, 'Sin email de vendedor resoluble — resumen omitido');
      return { emailed: false, reason: 'sin_destinatario' };
    }

    const filas = sortTicketsByFecha(tickets).map(formatTicketRow);

    const title = `Cronograma de facturación — ${dealName || dealId}`;
    const meta = {
      negocio: dealName ? `${dealName} (${dealId})` : String(dealId ?? ''),
      total_tickets: String(filas.length),
      cronograma: filas.length ? filas.join(' · ') : '(sin tickets)',
    };

    await sendAlertToFn({ to: [dealOwnerEmail], level: 'info', title, meta });

    logger.info(
      { module: MOD, fn, dealId, totalTickets: filas.length },
      'Resumen de cronograma al cierre ganado enviado'
    );
    return { emailed: true };
  } catch (err) {
    logger.warn(
      { module: MOD, fn, dealId, err: err?.message },
      'Resumen de cronograma falló (no bloquea nada)'
    );
    return { emailed: false, reason: 'error' };
  }
}
