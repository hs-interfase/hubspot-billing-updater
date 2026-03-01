// src/propagacion/tickets/cancelForecastTickets.js

import { hubspotClient } from '../../hubspotClient.js';
import logger from '../../../lib/logger.js';
import {
  FORECAST_MANUAL_STAGES,
  FORECAST_AUTO_STAGES,
  CANCELLED_STAGE_BY_PIPELINE,
  isForecastStage,
} from '../../config/constants.js';

// Unión de todos los stages forecast (manuales + automáticos)
const FORECAST_STAGES = new Set([...FORECAST_MANUAL_STAGES, ...FORECAST_AUTO_STAGES]);

function isForecastTicket(ticket) {
  const stage = String(ticket?.properties?.hs_pipeline_stage || '');
  return isForecastStage(stage);
}

async function findTicketsByLineItemKey(lineItemKey) {
  if (!lineItemKey) return [];

  const body = {
    filterGroups: [
      {
        filters: [
          { propertyName: 'of_line_item_key', operator: 'EQ', value: String(lineItemKey) },
        ],
      },
    ],
    properties: ['hs_pipeline', 'hs_pipeline_stage', 'of_ticket_key', 'of_line_item_key'],
    limit: 100,
  };

  const resp = await hubspotClient.crm.tickets.searchApi.doSearch(body);
  return resp?.results || [];
}

/**
 * Cancela todos los tickets en stage FORECAST para los line items del deal.
 *
 * @param {Object} params
 * @param {Array}  params.lineItems         - Line items del deal
 * @param {string} params.closedLostReason  - Motivo de cancelación (puede ser vacío)
 */
export async function cancelForecastTickets({ lineItems, closedLostReason }) {
  const motivo = closedLostReason?.trim() || 'Negocio perdido';

  let totalCancelled = 0;
  let totalErrors = 0;

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
      tickets = await findTicketsByLineItemKey(lineItemKey);
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

    const forecastTickets = tickets.filter(isForecastTicket);

    if (!forecastTickets.length) {
      logger.debug(
        { module: 'cancelForecastTickets', lineItemId: li.id, lineItemKey, totalFound: tickets.length },
        'Sin tickets forecast para cancelar'
      );
      continue;
    }

    logger.info(
      { module: 'cancelForecastTickets', lineItemId: li.id, lineItemKey, count: forecastTickets.length },
      'Cancelando tickets forecast'
    );

    for (const ticket of forecastTickets) {
      const ticketId = ticket.id;
      const pipeline = String(ticket?.properties?.hs_pipeline || '');
      const cancelledStage = CANCELLED_STAGE_BY_PIPELINE[pipeline];

      if (!cancelledStage) {
        logger.warn(
          { module: 'cancelForecastTickets', ticketId, pipeline },
          'Pipeline desconocido, no se puede determinar stage de cancelación'
        );
        totalErrors++;
        continue;
      }

      try {
        await hubspotClient.crm.tickets.basicApi.update(String(ticketId), {
          properties: {
            hs_pipeline_stage: cancelledStage,
            motivo_cancelacion_del_ticket: motivo,
          },
        });

        totalCancelled++;

        logger.info(
          { module: 'cancelForecastTickets', ticketId, pipeline, cancelledStage, motivo },
          'Ticket forecast cancelado'
        );
      } catch (err) {
        logger.error(
          { module: 'cancelForecastTickets', ticketId, pipeline, err },
          'Error cancelando ticket forecast'
        );
        totalErrors++;
      }
    }
  }

  logger.info(
    { module: 'cancelForecastTickets', totalCancelled, totalErrors },
    'cancelForecastTickets completado'
  );

  return { totalCancelled, totalErrors };
}