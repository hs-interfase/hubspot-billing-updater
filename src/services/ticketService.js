// src/services/ticketService.js

import { hubspotClient } from '../hubspotClient.js';
import { TICKET_PIPELINE, TICKET_STAGES, isDryRun } from '../config/constants.js';
import { generateTicketKey } from '../utils/idempotency.js';
import { createTicketSnapshots } from './snapshotService.js';

/**
 * Servicio para crear y gestionar tickets de "orden de facturación".
 * Implementa idempotencia mediante of_ticket_key.
 */

/**
 * Busca un ticket existente por clave única (of_ticket_key).
 * Devuelve el ticket si existe, null si no.
 */
async function findTicketByKey(ticketKey) {
  try {
    const searchResp = await hubspotClient.crm.tickets.searchApi.doSearch({
      filterGroups: [
        {
          filters: [
            {
              propertyName: 'of_ticket_key',
              operator: 'EQ',
              value: ticketKey,
            },
          ],
        },
      ],
      properties: ['of_ticket_id', 'of_invoice_id', 'hs_pipeline_stage'],
      limit: 1,
    });

    return searchResp.results?.[0] || null;
  } catch (err) {
    console.warn('[ticketService] Error buscando ticket por key:', ticketKey, err?.message);
    return null;
  }
}

/**
 * Crea un ticket de orden de facturación manual.
 * 
 * @param {Object} deal - Deal de HubSpot
 * @param {Object} lineItem - Line Item de HubSpot
 * @param {string} billingDate - Fecha de facturación (YYYY-MM-DD)
 * @returns {Object} { ticketId, created } - created=true si se creó, false si ya existía
 */
export async function createManualBillingTicket(deal, lineItem, billingDate) {
  const dealId = String(deal.id || deal.properties?.hs_object_id);
  const lineItemId = String(lineItem.id || lineItem.properties?.hs_object_id);
  
  // 1) Generar clave única
  const ticketKey = generateTicketKey(dealId, lineItemId, billingDate);
  
  // 2) Verificar si ya existe
  const existing = await findTicketByKey(ticketKey);
  if (existing) {
    console.log(`[ticketService] Ticket ya existe con key ${ticketKey}, id=${existing.id}`);
    return { ticketId: existing.id, created: false };
  }
  
  // 3) DRY RUN check
  if (isDryRun()) {
    console.log(`[ticketService] DRY_RUN: no se crea ticket real para ${ticketKey}`);
    return { ticketId: null, created: false };
  }
  
  // 4) Crear snapshots
  const snapshots = createTicketSnapshots(deal, lineItem, billingDate);
  
  // 5) Crear ticket
  const ticketProps = {
    subject: `Orden de Facturación - ${deal.properties?.dealname || 'Deal'} - ${billingDate}`,
    hs_pipeline: TICKET_PIPELINE,
    hs_pipeline_stage: TICKET_STAGES.NEW,
    of_deal_id: dealId,
    of_line_item_ids: lineItemId,
    of_ticket_key: ticketKey,
    ...snapshots,
  };
  
  try {
    const createResp = await hubspotClient.crm.tickets.basicApi.create({
      properties: ticketProps,
    });
    const ticketId = createResp.id || createResp.result?.id;
    
    // 6) Asociar ticket a Deal
    try {
      await hubspotClient.crm.associations.v4.basicApi.create(
        'tickets',
        ticketId,
        'deals',
        dealId,
        []
      );
    } catch (err) {
      console.warn('[ticketService] No se pudo asociar ticket a deal:', err?.message);
    }
    
    console.log(`[ticketService] Ticket creado: ${ticketId} para ${ticketKey}`);
    return { ticketId, created: true };
  } catch (err) {
    console.error('[ticketService] Error creando ticket:', err?.response?.body || err?.message || err);
    throw err;
  }
}

/**
 * Actualiza un ticket existente con datos adicionales.
 */
export async function updateTicket(ticketId, properties) {
  try {
    await hubspotClient.crm.tickets.basicApi.update(ticketId, {
      properties,
    });
    console.log(`[ticketService] Ticket ${ticketId} actualizado`);
  } catch (err) {
    console.error('[ticketService] Error actualizando ticket:', err?.response?.body || err?.message);
    throw err;
  }
}
