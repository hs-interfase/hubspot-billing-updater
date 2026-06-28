// src/services/monitoring/zeroEmission.js
//
// Detección de "zero-emission": tickets del pipeline AUTOMÁTICO que quedaron
// en BILLING_AUTOMATED_READY pero SIN factura (of_invoice_id vacío).
//
// Por qué es una anomalía:
//   En el pipeline auto, Phase 3 promueve el ticket a BILLING_AUTOMATED_READY
//   y emite la factura ficticia en el MISMO paso. No hay etapa intermedia.
//   Por lo tanto, un ticket en READY sin of_invoice_id significa que la emisión
//   falló silenciosamente: el cron "corrió pero no emitió lo que debía".
//
// Usos:
//   - api/healthAudit.js  → check pasivo (status del endpoint /health/audit)
//   - crons (cronDealsBatch, cronWeekendFull) → alerta activa por email al
//     terminar la corrida.

import { hubspotClient } from '../../hubspotClient.js';
import { AUTOMATED_TICKET_PIPELINE, BILLING_AUTOMATED_READY } from '../../config/constants.js';
import logger from '../../../lib/logger.js';

/**
 * Busca tickets AUTO en READY sin factura emitida.
 *
 * @param {Object} [opts]
 * @param {number} [opts.limit=100]  Máximo de tickets a traer.
 * @returns {Promise<Array<{ ticketId: string, dealId: string|null, lineItemKey: string|null, ticketKey: string|null, billingError: string|null }>>}
 */
export async function findStuckAutoEmissions({ limit = 100 } = {}) {
  const resp = await hubspotClient.crm.tickets.searchApi.doSearch({
    filterGroups: [{
      filters: [
        { propertyName: 'hs_pipeline', operator: 'EQ', value: String(AUTOMATED_TICKET_PIPELINE) },
        { propertyName: 'hs_pipeline_stage', operator: 'EQ', value: String(BILLING_AUTOMATED_READY) },
        { propertyName: 'of_invoice_id', operator: 'NOT_HAS_PROPERTY' },
      ],
    }],
    properties: ['hs_object_id', 'of_deal_id', 'of_line_item_key', 'of_ticket_key', 'of_billing_error'],
    limit,
  });

  return (resp?.results || []).map(t => ({
    ticketId: String(t.id),
    dealId: t.properties?.of_deal_id || null,
    lineItemKey: t.properties?.of_line_item_key || null,
    ticketKey: t.properties?.of_ticket_key || null,
    billingError: t.properties?.of_billing_error || null,
  }));
}

/**
 * Detecta tickets atascados y, si hay, envía una alerta crítica por email.
 * Cada ticket se lista con su dealId, lineItemKey y ticketKey para identificarlo.
 * Best-effort: nunca lanza (loguea y sigue) para no romper el cron.
 *
 * @param {Object} params
 * @param {string} params.jobName  Nombre del cron que dispara la alerta.
 * @param {(level: string, title: string, meta: Object) => Promise<any>} params.sendAlert
 *        Función de alerta (lib/alertService.js → sendAlert).
 * @returns {Promise<number>} Cantidad de emisiones pendientes detectadas.
 */
export async function alertOnStuckAutoEmissions({ jobName, sendAlert }) {
  try {
    const stuck = await findStuckAutoEmissions();
    if (stuck.length === 0) return 0;

    // Una fila de la tabla del email por cada ticket, identificable a mano.
    const detalle = {};
    stuck.slice(0, 25).forEach((s, i) => {
      detalle[`#${i + 1}`] =
        `deal ${s.dealId ?? '—'} · LI ${s.lineItemKey ?? '—'} · ticket ${s.ticketKey ?? '—'} (ticketId ${s.ticketId})`;
    });
    if (stuck.length > 25) detalle['…'] = `+${stuck.length - 25} más`;

    await sendAlert(
      'critical',
      `${stuck.length} factura(s) automática(s) sin emitir tras correr ${jobName}`,
      { jobName, pendientes: stuck.length, ...detalle }
    );

    logger.warn(
      { module: 'zeroEmission', jobName, pendientes: stuck.length },
      'Zero-emission: tickets AUTO en READY sin factura — alerta enviada'
    );
    return stuck.length;
  } catch (err) {
    logger.error(
      { module: 'zeroEmission', jobName, err: err?.message },
      'Error en alertOnStuckAutoEmissions (no bloquea el cron)'
    );
    return 0;
  }
}
