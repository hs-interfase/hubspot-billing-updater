// src/services/ticketService.js

import { hubspotClient } from '../hubspotClient.js';
import { TICKET_PIPELINE, TICKET_STAGES, isDryRun } from '../config/constants.js';
import { generateTicketKey } from '../utils/idempotency.js';
import { createTicketSnapshots } from './snapshotService.js';
import { getTodayYMD } from '../utils/dateUtils.js';
import { parseBool } from '../utils/parsers.js';

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
 * Determina el stage correcto del ticket según la fecha de facturación y flag "facturar ahora".
 * - Si lineItem.facturar_ahora === true: READY (urgente)
 * - Si es HOY o MAÑANA: READY
 * - Si es después: NEW
 */
function getTicketStage(billingDate, lineItem) {
  const lp = lineItem?.properties || {};
  
  // Prioridad 1: Si el vendedor pidió facturar ahora → INVOICED
  if (parseBool(lp.facturar_ahora)) {
    return TICKET_STAGES.INVOICED;
  }
  
  // Prioridad 2: Si es hoy o mañana → READY
  const today = getTodayYMD();
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().slice(0, 10);
  
  if (billingDate === today || billingDate === tomorrowStr) {
    return TICKET_STAGES.READY;
  }
  
  // Por defecto: NEW
  return TICKET_STAGES.NEW;
}

/**
 * Obtiene los IDs de empresas asociadas al deal.
 */
async function getDealCompanies(dealId) {
  try {
    const resp = await hubspotClient.crm.associations.v4.basicApi.getPage(
      'deals',
      String(dealId),
      'companies',
      100
    );
    return (resp.results || []).map(r => String(r.toObjectId));
  } catch (err) {
    console.warn('[ticketService] Error obteniendo companies del deal:', err?.message);
    return [];
  }
}

/**
 * Obtiene los IDs de contactos asociados al deal.
 */
async function getDealContacts(dealId) {
  try {
    const resp = await hubspotClient.crm.associations.v4.basicApi.getPage(
      'deals',
      String(dealId),
      'contacts',
      100
    );
    return (resp.results || []).map(r => String(r.toObjectId));
  } catch (err) {
    console.warn('[ticketService] Error obteniendo contacts del deal:', err?.message);
    return [];
  }
}

/**
 * Asocia el ticket a empresas, contactos y line item.
 */
async function createTicketAssociations(ticketId, dealId, lineItemId, companyIds, contactIds) {
  const associations = [];
  
  // Deal
  associations.push(
    hubspotClient.crm.associations.v4.basicApi.create('tickets', ticketId, 'deals', dealId, [])
      .catch(err => console.warn('[ticketService] Error asociando deal:', err?.message))
  );
  
  // Line Item
  associations.push(
    hubspotClient.crm.associations.v4.basicApi.create('tickets', ticketId, 'line_items', lineItemId, [])
      .catch(err => console.warn('[ticketService] Error asociando line item:', err?.message))
  );
  
  // Companies
  for (const companyId of companyIds) {
    associations.push(
      hubspotClient.crm.associations.v4.basicApi.create('tickets', ticketId, 'companies', companyId, [])
        .catch(err => console.warn('[ticketService] Error asociando company:', err?.message))
    );
  }
  
  // Contacts
  for (const contactId of contactIds) {
    associations.push(
      hubspotClient.crm.associations.v4.basicApi.create('tickets', ticketId, 'contacts', contactId, [])
        .catch(err => console.warn('[ticketService] Error asociando contact:', err?.message))
    );
  }
  
  await Promise.all(associations);
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
  
  // 5) Crear título del ticket: Negocio | Producto | Rubro | Fecha
  const dealName = deal.properties?.dealname || 'Deal';
  const productName = lineItem.properties?.name || 'Producto';
  const rubro = lineItem.properties?.servicio || 'Sin rubro';
  
  // 6) Determinar stage según fecha y flag "facturar ahora"
 const stage = getTicketStage(billingDate, lineItem);
  
  // 7) Verificar si el vendedor solicitó "facturar ahora" (agregar nota en descripción)
  const lp = lineItem.properties || {};
  const facturarAhoraRaw = (lp.facturar_ahora ?? '').toString().toLowerCase();
  const facturarAhoraLineItem = 
    facturarAhoraRaw === 'true' ||
    facturarAhoraRaw === '1' ||
    facturarAhoraRaw === 'sí' ||
    facturarAhoraRaw === 'si' ||
    facturarAhoraRaw === 'yes';
  
  // Agregar nota urgente si el vendedor pidió facturar ahora
  let descripcionProducto = snapshots.descripcion_producto || '';
  if (facturarAhoraLineItem) {
    const notaUrgente = '⚠️ URGENTE: Vendedor solicitó facturar ahora.';
    descripcionProducto = descripcionProducto 
      ? `${notaUrgente}\n\n${descripcionProducto}`
      : notaUrgente;
  }
  
  const ticketProps = {
    subject: `${dealName} | ${productName} | ${rubro} | ${billingDate}`,
    hs_pipeline: TICKET_PIPELINE,
    hs_pipeline_stage: stage,
    of_deal_id: dealId,
    of_line_item_ids: lineItemId,
    of_ticket_key: ticketKey,
    ...snapshots,
    descripcion_producto: descripcionProducto, // Sobrescribir con nota urgente si aplica
  };
  
  try {
    // 8) Crear el ticket
    const createResp = await hubspotClient.crm.tickets.basicApi.create({
      properties: ticketProps,
    });
    const ticketId = createResp.id || createResp.result?.id;
    
    // 9) Obtener asociaciones del deal (empresas y contactos)
    const [companyIds, contactIds] = await Promise.all([
      getDealCompanies(dealId),
      getDealContacts(dealId),
    ]);
    
    // 10) Crear todas las asociaciones
    await createTicketAssociations(ticketId, dealId, lineItemId, companyIds, contactIds);
    
    const stageLabel = stage === TICKET_STAGES.READY ? 'READY' : 'NEW';
    const urgentLabel = facturarAhoraLineItem ? ' [URGENTE]' : '';
    console.log(`[ticketService] Ticket creado: ${ticketId} para ${ticketKey} (stage: ${stageLabel}${urgentLabel})`);
    
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