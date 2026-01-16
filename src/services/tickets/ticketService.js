// src/services/ticketService.js

import { hubspotClient } from '../../hubspotClient.js';
import { 
  TICKET_PIPELINE, 
  TICKET_STAGES, 
  AUTOMATED_TICKET_PIPELINE,     
  AUTOMATED_TICKET_INITIAL_STAGE, 
  isDryRun 
} from '../../config/constants.js';
import { generateTicketKey } from '../../utils/idempotency.js';
import { createTicketSnapshots } from '../snapshotService.js';
import { getTodayYMD, getTomorrowYMD } from '../../utils/dateUtils.js';
import { parseBool } from '../../utils/parsers.js';

/**
 * Servicio para crear y gestionar tickets de "orden de facturación".
 * Implementa idempotencia mediante of_ticket_key.
 * Incluye deduplicación automática de tickets clonados por UI.
 */


/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  DEDUPLICACIÓN DE TICKETS CLONADOS POR UI                       ║
 * ╚══════════════════════════════════════════════════════════════════╝
 * 
 * Problema: HubSpot permite clonar line items desde la UI, y cuando un 
 * line item tiene tickets asociados, también clona los tickets.
 * 
 * Solución: Identificar el ticket canónico (el que tiene ticketKey exacta)
 * y marcar los demás como DUPLICADO_UI para evitar confusiones.
 * 
 * Propiedades usadas:
 * - of_ticket_key: Clave única canónica (dealId::stableLineId::YYYY-MM-DD)
 * - of_estado: Estado del ticket (DUPLICADO_UI para tickets clonados)
 * - of_es_duplicado_clon: Flag booleano adicional para identificar clones
 */

/**
 * Genera la clave canónica de un ticket.
 * Formato: dealId::stableLineId::YYYY-MM-DD
 */
function buildTicketKey(dealId, stableLineId, billDateYMD) {
  return generateTicketKey(dealId, stableLineId, billDateYMD);
}

/**
 * Busca TODOS los tickets asociados a un Deal.
 */
async function getTicketsForDeal(dealId) {
  try {
    // Associations v4: deal -> tickets
    const assoc = await hubspotClient.crm.associations.v4.basicApi.getPage(
      'deals',
      String(dealId),
      'tickets',
      100
    );

    const ticketIds = (assoc.results || []).map(r => String(r.toObjectId));
    if (!ticketIds.length) return [];

    // Batch read tickets
    const resp = await hubspotClient.crm.tickets.batchApi.read({
      inputs: ticketIds.map(id => ({ id })),
      properties: [
        'hs_object_id',
        'subject',
        'of_ticket_key',
        'of_fecha_de_facturacion',
        'of_line_item_ids',
        'of_estado',
        'of_es_duplicado_clon',
        'of_deal_id',
        'hs_pipeline_stage',
        'nota',
        'createdate',
        'hs_createdate',
      ],
    });

    return (resp.results || []).map(t => ({
      id: String(t.id),
      properties: t.properties || {},
       createdate: t.properties?.createdate || null,
    }));
  } catch (err) {
    console.warn('[ticketService] Error obteniendo tickets del deal:', err?.message);
    return [];
  }
}

/**
 * Marca tickets duplicados "clonados por UI" para que no molesten.
 * - Mantiene el canónico
 * - Marca el resto como DUPLICADO_UI
 */
async function markDuplicateTickets({ canonicalTicketId, duplicates, reason }) {
  if (!duplicates || duplicates.length === 0) return;
  
  console.log(`[ticketService] 🧹 Marcando ${duplicates.length} ticket(s) como DUPLICADO_UI`);
  
  for (const t of duplicates) {
    const id = t.id;
    if (id === canonicalTicketId) continue;

    try {
      const currentNote = t.properties?.nota || '';
      const newNote = `${currentNote}\n[auto ${getTodayYMD()}] Marcado DUPLICADO_UI: ${reason}`.trim();
      
      const patch = {
        properties: {
          of_estado: 'DUPLICADO_UI',
          of_es_duplicado_clon: 'true',
          nota: newNote,
        },
      };

      await safeUpdateTicket(hubspotClient, String(id), patch);
      console.log(`   ✓ Ticket ${id} marcado como DUPLICADO_UI`);
    } catch (err) {
      console.warn(`   ⚠️ No se pudo marcar ticket ${id} como duplicado:`, err?.message);
    }
  }
}

/**
 * Dado dealId + fecha, devuelve:
 * - canonical: ticket con ticketKey exacta (si existe)
 * - duplicates: tickets que "parecen" de esa fecha pero no son canónicos (UI clones)
 */
function parseLineItemIds(raw) {
  if (!raw) return [];
  const s = String(raw).trim();
  // si alguna vez llega como "id1;id2" o "id1,id2"
  return s.split(/[;,]/).map(x => x.trim()).filter(Boolean);
}

/**
 * Extrae el lineId de un ticket key y lo normaliza.
 * Formato esperado: "dealId::LI:lineId::date" o "dealId::PYLI:lineId::date"
 * 
 * Ejemplos:
 *   "123::LI:456::2026-01-14" → "456"
 *   "123::LI:LI:456::2026-01-14" → "456" (normaliza duplicado)
 *   "123::PYLI:789::2026-01-14" → "PYLI:789" (mantiene prefijo especial)
 */
function extractLineIdFromTicketKey(ticketKey) {
  if (!ticketKey) return null;
  const parts = ticketKey.split('::');
  if (parts.length !== 3) return null;
  
  let lineIdPart = parts[1]; // Ej: "LI:123" o "PYLI:456" o "LI:LI:123" (bug)
  
  // Si tiene prefijo PYLI:, mantenerlo tal cual
  if (lineIdPart.startsWith('PYLI:')) {
    return lineIdPart;
  }
  
  // Remover TODOS los prefijos LI: duplicados
  while (lineIdPart.startsWith('LI:')) {
    lineIdPart = lineIdPart.substring(3);
  }
  
  return lineIdPart;
}

async function findCanonicalAndDuplicates({ dealId, expectedKey, billDateYMD, lineItemId }) {
  const tickets = await getTicketsForDeal(dealId);

  const candidates = tickets.filter(t => {
    const k = (t.properties?.of_ticket_key || '').trim();
    const d = (t.properties?.of_fecha_de_facturacion || '').trim();
    const liIds = parseLineItemIds(t.properties?.of_line_item_ids);

    // 1) Todos los que tengan la key esperada entran sí o sí
    if (k === expectedKey) return true;

    // 2) Heurística para clones UI: mismo lineItem y misma fecha (o fecha vacía)
    // ✅ Usar extractLineIdFromTicketKey para normalizar el lineId del ticket key
    const ticketLineId = extractLineIdFromTicketKey(k);
    const normalizedLineItemId = String(lineItemId);
    
    const sameLI = liIds.includes(String(lineItemId)) || ticketLineId === normalizedLineItemId;
    const sameDate = d === billDateYMD;

    return sameLI && (sameDate || !d);
  });

  // --- canónicos por key ---
  const byKey = candidates.filter(t => (t.properties?.of_ticket_key || '').trim() === expectedKey);

  // Elegir canónico: el MÁS VIEJO (createdate menor)
  let canonical = null;
  if (byKey.length) {
canonical = byKey
   .slice()
   .sort((a, b) => getTicketCreatedMs(a) - getTicketCreatedMs(b))[0];
  }
  // Duplicados:
  // - si hay canonical: todo lo demás en candidates que NO sea ese canonical
  //   (incluye otros con la misma key!)
  const duplicates = canonical
    ? candidates.filter(t => t.id !== canonical.id)
    : [];

  return { canonical, duplicates };
}

function getTicketCreatedMs(t) {
  const p = t.properties || {};
  const raw = p.createdate || p.hs_createdate || p.hs_created_at;
  const ms = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(ms) ? ms : Number.MAX_SAFE_INTEGER;
}

export async function archiveClonedTicketsByKey({ expectedKey, dealId, dryRun = false }) {
  // 1) Search por of_ticket_key exacto
  const searchBody = {
    filterGroups: [{
      filters: [
        { propertyName: "of_ticket_key", operator: "EQ", value: expectedKey },
        // opcional: reforzar con dealId si lo guardás en ticket
        // { propertyName: "of_deal_id", operator: "EQ", value: String(dealId) },
      ],
    }],
    properties: ["of_ticket_key", "createdate", "hs_createdate", "hs_object_id"],
    limit: 100,
  };

  const resp = await hubspotClient.crm.tickets.searchApi.doSearch(searchBody);
  const tickets = resp.results || [];

  if (tickets.length <= 1) return { kept: tickets[0]?.id || null, archived: [] };

  // 2) Ordenar por createdate asc y archivar todos menos el primero
tickets.sort((a, b) => getTicketCreatedMs(a) - getTicketCreatedMs(b));

  const kept = String(tickets[0].id);
  const clones = tickets.slice(1).map(t => String(t.id));

  if (!dryRun) {
    for (const id of clones) {
      await hubspotClient.crm.tickets.basicApi.archive(id);
    }
  }

  return { kept, archived: clones };
}

/**
 * Asegura que existe un ticket canónico y marca los duplicados.
 * Esta es la función principal que reemplaza la lógica de creación simple.
 * 
 * @param {Object} params
 * @param {string} params.dealId - ID del deal
 * @param {string} params.stableLineId - ID estable del line item (ej: "LI:123" o "PYLI:456")
 * @param {string} params.billDateYMD - Fecha de facturación (YYYY-MM-DD)
 * @param {Function} params.buildTicketPayload - Función que construye el payload del ticket
 * @returns {Promise<Object>} { ticketId, created, ticketKey, duplicatesMarked }
 */
export async function ensureTicketCanonical({
  dealId,
  stableLineId,
  billDateYMD,
  lineItemId,
  buildTicketPayload,
}) {
   if (!lineItemId) throw new Error('ensureTicketCanonical: lineItemId es requerido para deduplicación UI');

  const expectedKey = buildTicketKey(dealId, stableLineId, billDateYMD);

  console.log(`[ticketService] 🔍 ensureTicketCanonical`);
  console.log(`   dealId: ${dealId}`);
  console.log(`   stableLineId: ${stableLineId}`);
  console.log(`   billDateYMD: ${billDateYMD}`);
  console.log(`   expectedKey: ${expectedKey}`);
  
  // ✅ Verificación anti-duplicación de prefijo
  if (expectedKey.includes('LI:LI:')) {
    console.error(`\n❌ ERROR: expectedKey contiene prefijo duplicado LI:LI:`);
    console.error(`   expectedKey: ${expectedKey}`);
    console.error(`   stableLineId: ${stableLineId}`);
    throw new Error(`Ticket key inválido con prefijo duplicado: ${expectedKey}`);
  }

    await archiveClonedTicketsByKey({ expectedKey, dealId, dryRun: isDryRun() });

  // 1) Buscar canonical + duplicates por deal/fecha
  const { canonical, duplicates } = await findCanonicalAndDuplicates({
    dealId,
    expectedKey,
    billDateYMD,
    lineItemId,
  });

  // 2) Si existe canonical, marcar duplicados y devolver canonical
  if (canonical) {
    console.log(`   ✓ Ticket canónico existente: ${canonical.id}`);
    
    if (duplicates.length) {
      console.log(`   🧹 Encontrados ${duplicates.length} duplicado(s), marcando...`);
      await markDuplicateTickets({
        canonicalTicketId: canonical.id,
        duplicates,
        reason: `Existe ticketKey canónica ${expectedKey}`,
      });
    }
    
    return { 
      ticketId: canonical.id, 
      created: false, 
      ticketKey: expectedKey, 
      duplicatesMarked: duplicates.length 
    };
  }

  // 3) Si no existe, crear ticket canónico
  console.log(`   🆕 Creando ticket canónico...`);
  
  if (isDryRun()) {
    console.log(`   DRY_RUN: no se crea ticket ${expectedKey}`);
    return { ticketId: null, created: false, ticketKey: expectedKey, duplicatesMarked: 0 };
  }

  const payload = await buildTicketPayload({ dealId, stableLineId, billDateYMD, expectedKey });

  const created = await safeCreateTicket(hubspotClient, payload);
  const newId = String(created.id || created.result?.id);

  console.log(`   ✓ Ticket canónico creado: ${newId}`);

  // 4) Luego de crear, volver a buscar y marcar duplicados si aparecieron por clon UI
  const post = await findCanonicalAndDuplicates({ dealId, expectedKey, billDateYMD, lineItemId });
  if (post.duplicates.length) {
    console.log(`   🧹 Después de crear, encontrados ${post.duplicates.length} duplicado(s) UI, marcando...`);
    await markDuplicateTickets({
      canonicalTicketId: newId,
      duplicates: post.duplicates,
      reason: `Se creó ticket canónico ${expectedKey}`,
    });
  }

  return { 
    ticketId: newId, 
    created: true, 
    ticketKey: expectedKey, 
    duplicatesMarked: post.duplicates.length 
  };
}


/**
 * Helpers para crear/actualizar tickets de forma robusta.
 * Detecta propiedades faltantes en HubSpot y reintenta sin ellas.
 */

export function getMissingPropertyNameFromHubSpotError(e) {
  const body = e?.body || e?.response?.body;
  const ctx = body?.errors?.[0]?.context?.propertyName?.[0];
  if (ctx) return ctx;

  const msg = body?.message || "";
  const m = msg.match(/Property \"(.+?)\" does not exist/);
  return m?.[1] || null;
}

export async function safeCreateTicket(hubspotClient, payload) {
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

export async function safeUpdateTicket(hubspotClient, ticketId, payload) {
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
 * Devuelve el ticket si existe, null si no.
 */
export async function findTicketByKey(ticketKey) {
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
export function getTicketStage(billingDate, lineItem) {
  const lp = lineItem?.properties || {};
  
  // Prioridad 1: Si el vendedor pidió facturar ahora → INVOICED
  if (parseBool(lp.facturar_ahora)) {
    return TICKET_STAGES.READY;
  }
  
  // Prioridad 2: Si es hoy o mañana → READY
  const today = getTodayYMD();
  const tomorrowStr = getTomorrowYMD(); // helper
  
  if (billingDate === today || billingDate === tomorrowStr) {
    return TICKET_STAGES.READY;
  }
  
  // Por defecto: NEW
  return TICKET_STAGES.NEW;
}

/**
 * Obtiene los IDs de empresas asociadas al deal.
 */
export async function getDealCompanies(dealId) {
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
export async function getDealContacts(dealId) {
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
export async function createTicketAssociations(ticketId, dealId, lineItemId, companyIds, contactIds) {
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
 * Con deduplicación: marca tickets clonados por UI como DUPLICADO_UI.
 * 
 * @param {Object} deal - El deal de HubSpot.
 * @param {Object} lineItem - El line item de HubSpot.
 * @param {string} billingDate - La fecha objetivo de facturación (YYYY-MM-DD).
 * @returns {Object} { ticketId, created, duplicatesMarked } - `created` es true si se creó, false si ya existía.
 */
export async function createAutoBillingTicket(deal, lineItem, billingDate) {
  const dealId = String(deal.id || deal.properties?.hs_object_id);
  const lineItemId = String(lineItem.id || lineItem.properties?.hs_object_id);
  const dp = deal.properties || {};
  const lp = lineItem.properties || {};

  // Determinar ID estable para idempotencia (usar origen PY si existe)
  // ⚠️ IMPORTANTE: NO agregar prefijo LI: aquí, buildInvoiceKey() lo agregará
  const stableLineId = lp.of_line_item_py_origen_id
    ? `PYLI:${String(lp.of_line_item_py_origen_id)}`
    : lineItemId; // ✅ Solo el ID numérico, SIN prefijo LI:

  console.log('[ticketService] 🔍 AUTO - stableLineId:', stableLineId, '(real:', lineItemId, ')');

  // Usar la nueva función de deduplicación
  const result = await ensureTicketCanonical({
    dealId,
    stableLineId,
    billDateYMD: billingDate,
    lineItemId,
    buildTicketPayload: async ({ dealId: _dealId, stableLineId: _stableLineId, billDateYMD, expectedKey }) => {
      // Re-declarar dp y lp dentro del scope de la función
      const dp = deal.properties || {};
      const lp = lineItem.properties || {};
      // Determinar fechas según reglas
      const expectedDate = billDateYMD;
      const orderedDate = billDateYMD; // En auto: orderedDate = expectedDate

      console.log(`[ticketService] 📅 AUTO - Fechas:`);
      console.log(`   - expectedDate: ${expectedDate} (siempre = billingDate)`);
      console.log(`   - orderedDate: ${orderedDate} (= expectedDate en auto)`);

      // Preparar el payload con nueva firma
      const snapshots = createTicketSnapshots(deal, lineItem, expectedDate, orderedDate);

      console.log(`[ticketService] 💰 AUTO - Montos iniciales:`);
      console.log(`   - of_monto_total: ${snapshots.of_monto_total}`);
      console.log(`   - monto_real_a_facturar: ${snapshots.monto_real_a_facturar}`);
      console.log(`   ℹ️ En tickets AUTOMÁTICOS, ambos montos permanecen iguales (snapshot inmutable).`);
      console.log(`   ℹ️ NO se sincroniza con cambios posteriores del Line Item.`);

      console.log(`[ticketService] 📊 AUTO - Frecuencia:`);
      console.log(`   - of_frecuencia_de_facturacion: ${snapshots.of_frecuencia_de_facturacion}`);
      console.log(`   - repetitivo: ${snapshots.repetitivo}`);

      console.log('[ticketService] 🔍 AUTO - fecha_de_resolucion_esperada:', snapshots.fecha_de_resolucion_esperada);
      console.log('[ticketService] 🔍 AUTO - of_fecha_de_facturacion:', snapshots.of_fecha_de_facturacion ?? '(no seteada)');

      const dealName = deal.properties?.dealname || 'Deal';
      const productName = lineItem.properties?.name || 'Producto';
      const rubro = snapshots.of_rubro || 'Sin rubro';
      
      // Determinar vendedor
      const vendedorId = dp.hubspot_owner_id ? String(dp.hubspot_owner_id) : null;

      console.log('[ticketService] AUTO - vendedorId:', vendedorId);

      // Construir propiedades del ticket
      const ticketProps = {
        subject: `${dealName} | ${productName} | ${rubro} | ${billDateYMD}`,
        hs_pipeline: AUTOMATED_TICKET_PIPELINE,
        hs_pipeline_stage: AUTOMATED_TICKET_INITIAL_STAGE,
        of_deal_id: _dealId,
        of_line_item_ids: lineItemId,
        of_ticket_key: expectedKey,
        ...snapshots,
      };

      // Override of_propietario_secundario con vendedorId si existe
      if (vendedorId) {
        ticketProps.of_propietario_secundario = vendedorId;
      }

      console.log('[ticketService] 🔍 AUTO - of_propietario_secundario:', ticketProps.of_propietario_secundario);
      console.log('[ticketService] 🔍 AUTO - hubspot_owner_id:', ticketProps.hubspot_owner_id);

      return { properties: ticketProps };
    },
  });

  const { ticketId, created, duplicatesMarked } = result;

  // Si se creó el ticket, crear asociaciones
  if (created && ticketId) {
    try {
      const [companyIds, contactIds] = await Promise.all([
        getDealCompanies(dealId),
        getDealContacts(dealId)
      ]);
      
      await createTicketAssociations(ticketId, dealId, lineItemId, companyIds, contactIds);
      
      console.log(`[ticketService] ✓ Ticket automático creado: ${ticketId}`);
      console.log(`[ticketService] Vendedor: ${dp.hubspot_owner_id || 'N/A'}`);
      
      if (duplicatesMarked > 0) {
        console.log(`[ticketService] 🧹 ${duplicatesMarked} duplicado(s) marcados`);
      }
    } catch (err) {
      console.error('[ticketService] Error creando asociaciones:', err?.message);
      throw err;
    }
  } else {
    console.log(`[ticketService] ✓ Ticket automático existente: ${ticketId}`);
    if (duplicatesMarked > 0) {
      console.log(`[ticketService] 🧹 ${duplicatesMarked} duplicado(s) marcados`);
    }
  }
  
  return { ticketId, created, duplicatesMarked };
}
































































/*

export function getMissingPropertyNameFromHubSpotError(e) {
  const body = e?.body || e?.response?.body;
  const ctx = body?.errors?.[0]?.context?.propertyName?.[0];
  if (ctx) return ctx;

  const msg = body?.message || "";
  const m = msg.match(/Property \"(.+?)\" does not exist/);
  return m?.[1] || null;
}

export async function safeCreateTicket(hubspotClient, payload) {
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

export async function safeUpdateTicket(hubspotClient, ticketId, payload) {
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
/*
export async function findTicketByKey(ticketKey) {
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
/*
/**
 * Obtiene los IDs de empresas asociadas al deal.
 */
/*
export async function getDealCompanies(dealId) {
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
/*
export async function getDealContacts(dealId) {
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
/*
export async function createTicketAssociations(ticketId, dealId, lineItemId, companyIds, contactIds) {
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
 * Actualiza un ticket existente con datos adicionales.
 */
/*
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
