// src/propagacion/tickets/cancelForecastTickets.js

import { hubspotClient } from '../../hubspotClient.js';
import logger from '../../../lib/logger.js';
import {
  CANCELLED_STAGE_BY_PIPELINE,
  TICKET_PIPELINE,
  PROXIMOS_A_FACTURAR_STAGE,
  isForecastStage,
} from '../../config/constants.js';
import { etapaUnicaEnabled } from '../../config/etapaUnicaFlags.js';
import { getTodayYMD, diffDays } from '../../utils/dateUtils.js';
import { notifyTicketKeptAlive } from '../../services/notifications/ticketKeptAliveAlert.js';

function isForecastTicket(ticket) {
  const stage = String(ticket?.properties?.hs_pipeline_stage || '');
  return isForecastStage(stage);
}

// Bajo ETAPA_UNICA_ENABLED: "no notificado" = forecast (manual hasta 75% +
// auto completo) O «Próximos a facturar» manual — todo lo que está del lado
// futuro de la frontera (ver PLAN_proximos_cambios_tickets_2026-07-29.md §2.0).
// Los tickets ya en Notificado/Emitido/etc. no entran acá: son intocables.
function isNotNotifiedTicket(ticket) {
  const stage = String(ticket?.properties?.hs_pipeline_stage || '');
  return isForecastStage(stage) || (Boolean(PROXIMOS_A_FACTURAR_STAGE) && stage === PROXIMOS_A_FACTURAR_STAGE);
}

async function findTicketsByLineItemKey(lineItemKey, client) {
  if (!lineItemKey) return [];

  const body = {
    filterGroups: [
      {
        filters: [
          { propertyName: 'of_line_item_key', operator: 'EQ', value: String(lineItemKey) },
        ],
      },
    ],
    properties: [
      'hs_pipeline', 'hs_pipeline_stage', 'of_ticket_key', 'of_line_item_key',
      'fecha_resolucion_esperada', 'hubspot_owner_id',
    ],
    limit: 100,
  };

  const resp = await client.crm.tickets.searchApi.doSearch(body);
  return resp?.results || [];
}

/**
 * El ticket MANUAL (pipeline === TICKET_PIPELINE) con fecha_resolucion_esperada
 * más cercana a hoy (por valor absoluto de la diferencia en días). Empate →
 * la fecha más próxima al futuro, y si sigue empatado, el id más bajo
 * (determinístico, mismo criterio que associateOnClosedWon.js).
 */
function pickClosestManualTicket(tickets, todayYMD) {
  let best = null;
  let bestAbsDiff = Infinity;
  let bestDiff = Infinity;

  for (const t of tickets) {
    const pipeline = String(t?.properties?.hs_pipeline || '');
    if (pipeline !== TICKET_PIPELINE) continue;

    const fecha = String(t?.properties?.fecha_resolucion_esperada || '').slice(0, 10);
    if (!fecha) continue;

    const diff = diffDays(todayYMD, fecha);
    if (diff === null) continue;
    const absDiff = Math.abs(diff);

    const mejor =
      absDiff < bestAbsDiff ||
      (absDiff === bestAbsDiff && diff > bestDiff) ||
      (absDiff === bestAbsDiff && diff === bestDiff && Number(t.id) < Number(best?.id ?? Infinity));

    if (mejor) {
      best = t;
      bestAbsDiff = absDiff;
      bestDiff = diff;
    }
  }

  return best;
}

async function cancelTicket(ticket, motivo, client) {
  const ticketId = ticket.id;
  const pipeline = String(ticket?.properties?.hs_pipeline || '');
  const cancelledStage = CANCELLED_STAGE_BY_PIPELINE[pipeline];

  if (!cancelledStage) {
    logger.warn(
      { module: 'cancelForecastTickets', ticketId, pipeline },
      'Pipeline desconocido, no se puede determinar stage de cancelación'
    );
    return { cancelled: false, error: true };
  }

  try {
    await client.crm.tickets.basicApi.update(String(ticketId), {
      properties: {
        hs_pipeline_stage: cancelledStage,
        motivo_cancelacion_del_ticket: motivo,
      },
    });

    logger.info(
      { module: 'cancelForecastTickets', ticketId, pipeline, cancelledStage, motivo },
      'Ticket forecast cancelado'
    );
    return { cancelled: true, error: false };
  } catch (err) {
    logger.error(
      { module: 'cancelForecastTickets', ticketId, pipeline, err },
      'Error cancelando ticket forecast'
    );
    return { cancelled: false, error: true };
  }
}

/**
 * Cancela tickets del deal cuando se pierde/suspende.
 *
 * Flag ETAPA_UNICA_ENABLED apagada (default): comportamiento IDÉNTICO al de
 * siempre — cancela todos los tickets en stage FORECAST de los line items.
 *
 * Flag prendida: cancela TODOS los tickets no notificados del negocio (forecast
 * + «Próximos a facturar» manual, de todos los line items) MENOS el ticket
 * MANUAL con fecha_resolucion_esperada más cercana a hoy, que queda vivo para
 * que se evalúe a mano si se cancela o se cobra. Avisa al vendedor (owner del
 * deal) y al responsable (owner de ese ticket) explicando por qué quedó vivo.
 *
 * @param {Object} params
 * @param {Array}  params.lineItems         - Line items del deal
 * @param {string} params.closedLostReason  - Motivo de cancelación (puede ser vacío)
 * @param {string|number|null} [params.dealId]
 * @param {Object|null} [params.dealProps]  - deal.properties (dealname, hubspot_owner_id)
 * @param {Object} [deps] - inyectables sólo para tests (defaults = producción)
 * @param {Object} [deps.client] - default hubspotClient
 * @param {Function} [deps.notifyTicketKeptAliveFn] - default notifyTicketKeptAlive
 */
export async function cancelForecastTickets({ lineItems, closedLostReason, dealId = null, dealProps = null }, deps = {}) {
  const motivo = closedLostReason?.trim() || 'Negocio perdido';
  const etapaUnica = etapaUnicaEnabled();
  const {
    client = hubspotClient,
    notifyTicketKeptAliveFn = notifyTicketKeptAlive,
  } = deps;

  let totalCancelled = 0;
  let totalErrors = 0;

  // Sólo bajo la flag: se juntan los tickets no-notificados de TODOS los line
  // items antes de cancelar, porque el ticket que queda vivo se elige a nivel
  // NEGOCIO, no por line item.
  const notNotifiedCandidates = [];

  for (const li of lineItems || []) {
    const p = li?.properties || {};
    const lineItemKey = p.line_item_key || p.of_line_item_key || '';

    if (!lineItemKey) {
      logger.debug(
        { module: 'cancelForecastTickets', lineItemId: li.id },
        'Line item sin line_item_key, saltando'
      );
      continue;
    }

    let tickets;
    try {
      tickets = await findTicketsByLineItemKey(lineItemKey, client);
    } catch (err) {
      logger.error(
        { module: 'cancelForecastTickets', lineItemId: li.id, lineItemKey, err },
        'Error buscando tickets por line_item_key'
      );
      totalErrors++;
      continue;
    }

    logger.info(
      {
        module: 'cancelForecastTickets',
        lineItemId: li.id,
        lineItemKey,
        totalFound: tickets.length,
        stages: tickets.map(t => ({
          id: t.id,
          pipeline: t?.properties?.hs_pipeline,
          stage: t?.properties?.hs_pipeline_stage,
        })),
      },
      'Tickets encontrados por line_item_key'
    );

    const candidateTickets = etapaUnica
      ? tickets.filter(isNotNotifiedTicket)
      : tickets.filter(isForecastTicket);

    if (!candidateTickets.length) {
      logger.debug(
        { module: 'cancelForecastTickets', lineItemId: li.id, lineItemKey, totalFound: tickets.length },
        'Sin tickets para cancelar'
      );
      continue;
    }

    if (etapaUnica) {
      notNotifiedCandidates.push(...candidateTickets);
      continue;
    }

    // Comportamiento original: cancela ya mismo, un line item a la vez.
    logger.info(
      { module: 'cancelForecastTickets', lineItemId: li.id, lineItemKey, count: candidateTickets.length },
      'Cancelando tickets forecast'
    );

    for (const ticket of candidateTickets) {
      const r = await cancelTicket(ticket, motivo, client);
      if (r.cancelled) totalCancelled++;
      if (r.error) totalErrors++;
    }
  }

  if (etapaUnica && notNotifiedCandidates.length) {
    const keeper = pickClosestManualTicket(notNotifiedCandidates, getTodayYMD());

    logger.info(
      {
        module: 'cancelForecastTickets',
        dealId,
        totalCandidates: notNotifiedCandidates.length,
        keeperTicketId: keeper?.id ?? null,
      },
      'Etapa única: cancelando todos los tickets no notificados menos el manual más cercano a hoy'
    );

    for (const ticket of notNotifiedCandidates) {
      if (keeper && String(ticket.id) === String(keeper.id)) continue;
      const r = await cancelTicket(ticket, motivo, client);
      if (r.cancelled) totalCancelled++;
      if (r.error) totalErrors++;
    }

    if (keeper) {
      try {
        await notifyTicketKeptAliveFn({
          dealId,
          dealName: dealProps?.dealname || null,
          dealOwnerId: dealProps?.hubspot_owner_id || null,
          ticketId: keeper.id,
          ticketOwnerId: keeper?.properties?.hubspot_owner_id || null,
          fechaResolucionEsperada: String(keeper?.properties?.fecha_resolucion_esperada || '').slice(0, 10) || null,
          motivo,
        });
      } catch (err) {
        logger.warn(
          { module: 'cancelForecastTickets', dealId, ticketId: keeper.id, err },
          'Aviso de ticket conservado falló (no bloquea)'
        );
      }
    }
  }

  logger.info(
    { module: 'cancelForecastTickets', totalCancelled, totalErrors },
    'cancelForecastTickets completado'
  );

  return { totalCancelled, totalErrors };
}
