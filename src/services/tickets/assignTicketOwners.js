// src/services/tickets/assignTicketOwners.js

import { hubspotClient } from '../../hubspotClient.js';
import { isDryRun } from '../../config/constants.js';
import logger from '../../../lib/logger.js';

const OWNER_ASSIGN_STAGES = new Set([
  process.env.DEAL_STAGE_CLOSED_WON || 'closedwon',
  process.env.DEAL_STAGE_EN_EJECUCION || 'en_ejecucion',
  process.env.DEAL_STAGE_FINALIZADO || 'finalizado',
]);

/**
 * Determina si el deal califica para asignar owner en sus tickets.
 * Condición: dealstage es closedwon, en_ejecucion o finalizado.
 */
export function dealQualifiesForOwnerAssignment(dealProps) {
  const stage = String(dealProps?.dealstage || '');
  return OWNER_ASSIGN_STAGES.has(stage);
}

/**
 * Busca tickets sin hubspot_owner_id asociados a un line item.
 */
async function findUnownedTicketsForLineItem(lineItemId) {
  const resp = await hubspotClient.crm.tickets.searchApi.doSearch({
    filterGroups: [
      {
        filters: [
          {
            propertyName: 'of_line_item_ids',
            operator: 'CONTAINS_TOKEN',
            value: String(lineItemId),
          },
        ],
      },
    ],
    properties: ['hubspot_owner_id', 'of_ticket_key', 'of_line_item_ids'],
    limit: 50,
  });

  return (resp?.results || []).filter(t => !t.properties?.hubspot_owner_id);
}

/**
 * Asigna hubspot_owner_id a todos los tickets (sin owner) de cada line item,
 * tomando el valor de responsable_asignado del line item.
 *
 * Solo corre si el deal califica (closedwon o posterior).
 *
 * @param {string} dealId
 * @param {Array}  lineItems - line items del deal (con properties)
 * @param {Object} dealProps - properties del deal
 */
export async function assignTicketOwners({ dealId, lineItems, dealProps }) {
  if (!dealQualifiesForOwnerAssignment(dealProps)) {
    logger.debug(
      { module: 'assignTicketOwners', dealId, dealstage: dealProps?.dealstage },
      'Deal no califica para asignación de owner, omitiendo'
    );
    return { assigned: 0, skipped: 0 };
  }

  let assigned = 0;
  let skipped = 0;

  for (const lineItem of lineItems) {
    const lineItemId = String(lineItem?.id || lineItem?.properties?.hs_object_id);
    const responsable = lineItem?.properties?.responsable_asignado
      ? String(lineItem.properties.responsable_asignado).trim()
      : null;

    if (!responsable) {
      logger.debug(
        { module: 'assignTicketOwners', dealId, lineItemId },
        'Line item sin responsable_asignado, omitiendo'
      );
      skipped++;
      continue;
    }

    let tickets;
    try {
      tickets = await findUnownedTicketsForLineItem(lineItemId);
    } catch (err) {
      logger.warn(
        { module: 'assignTicketOwners', dealId, lineItemId, err },
        'Error buscando tickets sin owner para line item'
      );
      skipped++;
      continue;
    }

    if (!tickets.length) {
      logger.debug(
        { module: 'assignTicketOwners', dealId, lineItemId },
        'No hay tickets sin owner para este line item'
      );
      continue;
    }

    const updates = tickets.map(ticket => {
      if (isDryRun()) {
        logger.info(
          { module: 'assignTicketOwners', dealId, lineItemId, ticketId: ticket.id, responsable },
          'DRY_RUN: hubspot_owner_id no asignado'
        );
        return Promise.resolve();
      }

      return hubspotClient.crm.tickets.basicApi
        .update(String(ticket.id), {
          properties: { hubspot_owner_id: responsable },
        })
        .then(() => {
          logger.info(
            { module: 'assignTicketOwners', dealId, lineItemId, ticketId: ticket.id, responsable },
            'hubspot_owner_id asignado en ticket'
          );
          assigned++;
        })
        .catch(err => {
          logger.warn(
            { module: 'assignTicketOwners', dealId, lineItemId, ticketId: ticket.id, err },
            'Error asignando owner en ticket'
          );
          skipped++;
        });
    });

    await Promise.allSettled(updates);
  }

  logger.info(
    { module: 'assignTicketOwners', dealId, assigned, skipped },
    'assignTicketOwners completado'
  );

  return { assigned, skipped };
}