// src/services/ticketService.js

import { hubspotClient } from '../hubspotClient.js';
import { 
  TICKET_PIPELINE, 
  TICKET_STAGES, 
  AUTOMATED_TICKET_PIPELINE,     
  AUTOMATED_TICKET_INITIAL_STAGE, 
  isDryRun 
} from '../config/constants.js';
import { generateTicketKey } from '../utils/idempotency.js';
import { createTicketSnapshots } from './snapshotService.js';
import { getTodayYMD } from '../utils/dateUtils.js';
import { parseBool } from '../utils/parsers.js';

/**
 * Servicio para crear y gestionar tickets de "orden de facturación".
 * Implementa idempotencia mediante of_ticket_key.
 */


/**
 * Helpers para crear/actualizar tickets de forma robusta.
 * Detecta propiedades faltantes en HubSpot y reintenta sin ellas.
 */

function getMissingPropertyNameFromHubSpotError(e) {
  const body = e?.body || e?.response?.body;
  const ctx = body?.errors?.[0]?.context?.propertyName?.[0];
  if (ctx) return ctx;

  const msg = body?.message || "";
  const m = msg.match(/Property \"(.+?)\" does not exist/);
  return m?.[1] || null;
}

async function safeCreateTicket(hubspotClient, payload) {
  let current = structuredClone(payload);

  for (let i = 0; i < 5; i++) {
    try {
      return await hubspotClient.crm.tickets.basicApi.create(current);
    } catch (e) {
      const missing = getMissingPropertyNameFromHubSpotError(e);
      if (!missing) throw e;

      if (current?.properties?.[missing] === undefined) throw e;

      console.warn(`[ticketService] Missing property "${missing}". Retrying without it...`);
      delete current.properties[missing];
    }
  }
  throw new Error("safeCreateTicket: too many retries removing missing properties");
}

async function safeUpdateTicket(hubspotClient, ticketId, payload) {
  let current = structuredClone(payload);

  for (let i = 0; i < 5; i++) {
    try {
      return await hubspotClient.crm.tickets.basicApi.update(ticketId, current);
    } catch (e) {
      const missing = getMissingPropertyNameFromHubSpotError(e);
      if (!missing) throw e;

      if (current?.properties?.[missing] === undefined) throw e;

      console.warn(`[ticketService] Missing property "${missing}". Retrying update without it...`);
      delete current.properties[missing];
    }
  }
  throw new Error("safeUpdateTicket: too many retries removing missing properties");
}

/**
 * Busca un ticket existente por clave única (of_ticket_key).

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
// src/services/ticketService.js

export async function createManualBillingTicket(deal, lineItem, billingDate) {
  const dealId = String(deal?.id || deal?.properties?.hs_object_id);
  const lineItemId = String(lineItem?.id || lineItem?.properties?.hs_object_id);

  const dp = deal?.properties || {};
  const lp = lineItem?.properties || {};

  // ✅ ID estable para idempotencia (sirve tanto para PY como para espejo UY)
  // - En espejo UY, lp.of_line_item_py_origen_id viene seteado al crear el line item espejo
  // - En PY normal, no existe y usamos el ID real del line item
  const stableLineId = lp.of_line_item_py_origen_id
    ? `PYLI:${String(lp.of_line_item_py_origen_id)}`
    : `LI:${lineItemId}`;

  // ✅ Key idempotente
  const ticketKey = generateTicketKey(dealId, stableLineId, billingDate);

  console.log('[ticketService] 🔍 MANUAL - stableLineId:', stableLineId, '(real:', lineItemId, ')');
  console.log('[ticketService] 🔍 MANUAL - ticketKey:', ticketKey);

  // 1) Verificar si ya existe
  const existing = await findTicketByKey(ticketKey);
  if (existing) {
    console.log(`[ticketService] Ticket ya existe con key ${ticketKey}, id=${existing.id}`);
    return { ticketId: existing.id, created: false };
  }

  // 2) DRY RUN
  if (isDryRun()) {
    console.log(`[ticketService] DRY_RUN: no se crea ticket real para ${ticketKey}`);
    return { ticketId: null, created: false };
  }

  // 3) Snapshots
  const snapshots = createTicketSnapshots(deal, lineItem, billingDate);

  // 4) Título
  const dealName = dp.dealname || 'Deal';
  const productName = lp.name || 'Producto';
  const rubro = lp.servicio || 'Sin rubro';

  // 5) Stage según fecha y flag
  const stage = getTicketStage(billingDate, lineItem);

  // 6) Facturar ahora -> nota urgente en descripción
  const facturarAhoraRaw = (lp.facturar_ahora ?? '').toString().toLowerCase();
  const facturarAhoraLineItem =
    facturarAhoraRaw === 'true' ||
    facturarAhoraRaw === '1' ||
    facturarAhoraRaw === 'sí' ||
    facturarAhoraRaw === 'si' ||
    facturarAhoraRaw === 'yes';

  let descripcionProducto = snapshots.descripcion_producto || '';
  if (facturarAhoraLineItem) {
    const notaUrgente = '⚠️ URGENTE: Vendedor solicitó facturar ahora.';
    descripcionProducto = descripcionProducto
      ? `${notaUrgente}\n\n${descripcionProducto}`
      : notaUrgente;
  }

  // 7) Owner (PM) y vendedor (informativo)
  const vendedorId = dp.hubspot_owner_id ? String(dp.hubspot_owner_id) : null;
  const pmAsignado = dp.pm_asignado_cupo
    ? String(dp.pm_asignado_cupo)
    : (dp.hubspot_owner_id ? String(dp.hubspot_owner_id) : null);

  console.log('[ticketService] MANUAL - vendedorId:', vendedorId, 'pmAsignado:', pmAsignado);

  // 8) Props del ticket
  const ticketProps = {
    subject: `${dealName} | ${productName} | ${rubro} | ${billingDate}`,
    hs_pipeline: TICKET_PIPELINE,
    hs_pipeline_stage: stage,

    // ✅ MANUAL: asignar owner (PM). Si no hay, no mandes la prop (evita errores raros)
    ...(pmAsignado ? { hubspot_owner_id: pmAsignado } : {}),

    of_deal_id: dealId,
    of_line_item_ids: lineItemId,

    // 🔑 clave idempotente (con stableLineId adentro)
    of_ticket_key: ticketKey,

    ...snapshots,

    // si querés que sea editable, esto NO es snapshot: lo tomamos del deal al crear
    ...(vendedorId ? { of_propietario_secundario: vendedorId } : {}),

    ...(pmAsignado ? { pm_asignado: pmAsignado } : {}),

    descripcion_producto: descripcionProducto,
  };

  console.log('[ticketService] 🔍 MANUAL - of_propietario_secundario:', ticketProps.of_propietario_secundario);
  console.log('[ticketService] 🔍 MANUAL - hubspot_owner_id:', ticketProps.hubspot_owner_id);
  console.log('[ticketService] 🔍 MANUAL - pm_asignado:', ticketProps.pm_asignado);

  try {
    // 9) Crear ticket
    const createResp = await safeCreateTicket(hubspotClient, { properties: ticketProps });    const ticketId = createResp.id || createResp.result?.id;

    // 10) Asociaciones
    const [companyIds, contactIds] = await Promise.all([
      getDealCompanies(dealId),
      getDealContacts(dealId),
    ]);

    await createTicketAssociations(ticketId, dealId, lineItemId, companyIds, contactIds);

    const stageLabel =
      stage === TICKET_STAGES.READY ? 'READY' :
      stage === TICKET_STAGES.INVOICED ? 'INVOICED' :
      'NEW';

    const urgentLabel = facturarAhoraLineItem ? ' [URGENTE]' : '';

    console.log(`[ticketService] Ticket manual creado: ${ticketId} para ${ticketKey} (stage: ${stageLabel}${urgentLabel})`);
    console.log(`[ticketService] Owner (PM): ${pmAsignado}, Vendedor: ${vendedorId}`);

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
await safeUpdateTicket(hubspotClient, ticketId, {
  properties,
});
    console.log(`[ticketService] Ticket ${ticketId} actualizado`);
  } catch (err) {
    console.error('[ticketService] Error actualizando ticket:', err?.response?.body || err?.message);
    throw err;
  }
}

/**
 * Crea un ticket de orden de facturación automática en el pipeline específico.
 * Idempotente: si ya existe un ticket con la misma clave, lo devuelve.
 * 
 * @param {Object} deal - El deal de HubSpot.
 * @param {Object} lineItem - El line item de HubSpot.
 * @param {string} billingDate - La fecha objetivo de facturación (YYYY-MM-DD).
 * @returns {Object} { ticketId, created } - `created` es true si se creó, false si ya existía.
 */
export async function createAutoBillingTicket(deal, lineItem, billingDate) {
const dealId = String(deal.id || deal.properties?.hs_object_id);
const lineItemId = String(lineItem.id || lineItem.properties?.hs_object_id);
const dp = deal.properties || {};
const lp = lineItem.properties || {};

// Determinar ID estable para idempotencia (usar origen PY si existe)
const stableLineId = lp.of_line_item_py_origen_id
  ? `PYLI:${String(lp.of_line_item_py_origen_id)}`
  : `LI:${lineItemId}`;

console.log('[ticketService] 🔍 AUTO - stableLineId:', stableLineId, '(real:', lineItemId, ')');

const ticketKey = generateTicketKey(dealId, stableLineId, billingDate);
console.log('[ticketService] 🔍 AUTO - ticketKey:', ticketKey); 
  // Buscar ticket existente por clave
  const existing = await findTicketByKey(ticketKey);
  if (existing) {
    return { ticketId: existing.id, created: false };
  }
  
  // Si es DRY_RUN, no crear
  if (isDryRun()) {
    console.log(`[ticketService] DRY_RUN: no se crea ticket automático para ${ticketKey}`);
    return { ticketId: null, created: false };
  }
  
  // Preparar el payload
  const snapshots = createTicketSnapshots(deal, lineItem, billingDate);
  const dealName = deal.properties?.dealname || 'Deal';
  const productName = lineItem.properties?.name || 'Producto';
  const rubro = lineItem.properties?.servicio || 'Sin rubro';
  
// Determinar vendedor
const vendedorId = dp.hubspot_owner_id ? String(dp.hubspot_owner_id) : null;

console.log('[ticketService] AUTO - vendedorId:', vendedorId);

// Construir propiedades del ticket
const ticketProps = {
  subject: `${dealName} | ${productName} | ${rubro} | ${billingDate}`,
  hs_pipeline: AUTOMATED_TICKET_PIPELINE,
  hs_pipeline_stage: AUTOMATED_TICKET_INITIAL_STAGE,
  // ❌ NO asignar hubspot_owner_id en tickets automáticos
  of_deal_id: dealId,
  of_line_item_ids: lineItemId,
  of_ticket_key: ticketKey,
  ...snapshots,
};

// Override of_propietario_secundario con vendedorId si existe
if (vendedorId) {
  ticketProps.of_propietario_secundario = vendedorId;
}

console.log('[ticketService] 🔍 AUTO - of_propietario_secundario:', ticketProps.of_propietario_secundario);
console.log('[ticketService] 🔍 AUTO - hubspot_owner_id:', ticketProps.hubspot_owner_id);

try {
  // Crear el ticket
const createResp = await safeCreateTicket(hubspotClient, { properties: ticketProps });
  const ticketId = createResp.id || createResp.result?.id;

  // Obtener y crear asociaciones
  const [companyIds, contactIds] = await Promise.all([
    getDealCompanies(dealId),
    getDealContacts(dealId)
  ]);
  
  await createTicketAssociations(ticketId, dealId, lineItemId, companyIds, contactIds);
  
    console.log(`[ticketService] Ticket automático creado: ${ticketId} para ${ticketKey}`);
  console.log(`[ticketService] Vendedor: ${vendedorId}`);
  
  return { ticketId, created: true };
  } catch (err) {
    console.error('[ticketService] Error creando ticket automático:', err?.response?.body || err?.message || err);
    throw err;
  }
}