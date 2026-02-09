// src/services/ticketService.js

import { createInvoiceFromTicket } from '../invoiceService.js';
import { hubspotClient } from '../../hubspotClient.js';
import { 
  TICKET_PIPELINE, 
  TICKET_STAGES, 
  AUTOMATED_TICKET_PIPELINE,     
  AUTOMATED_TICKET_INITIAL_STAGE, 
  isDryRun 
} from '../../config/constants.js';
import { createTicketSnapshots } from '../snapshotService.js';
import { getTodayYMD, getTomorrowYMD, toYMDInBillingTZ, toHubSpotDateOnly } from '../../utils/dateUtils.js';
import { parseBool } from '../../utils/parsers.js';
import { buildTicketKeyFromLineItemKey } from '../../utils/ticketKey.js';


export async function countCanonicalTicketsForLineItemKey({ dealId, lineItemKey }) {
  const prefix = `${dealId}::LIK:${lineItemKey}::`;

  const res = await hubspotClient.crm.tickets.searchApi.doSearch({
    filterGroups: [
      {
        filters: [
          { propertyName: 'of_ticket_key', operator: 'CONTAINS_TOKEN', value: prefix },
        ],
      },
    ],
    properties: ['of_ticket_key', 'of_estado'],
    limit: 200,
  });

  const tickets = res?.results || [];

  // contamos SOLO los que NO son duplicados UI
  const real = tickets.filter((t) => {
    const p = t.properties || {};
    const estado = (p.of_estado || '').toString().toUpperCase();
    if (estado === 'DUPLICADO_UI') return false;
    if (estado === 'DEPRECATED') return false;
    return true;
  });

  // únicos por key por seguridad
  const uniq = new Set(real.map((t) => (t.properties?.of_ticket_key || '').toString()));
  return uniq.size;
}

// --- Helper para sincronizar line item tras ticket canónico ---
async function syncLineItemAfterCanonicalTicket({ dealId, lineItemId, ticketId, billDateYMD }) {
  // 1) Leer ticket (props mínimos)
  let ticket;
  try {
    ticket = await hubspotClient.crm.tickets.basicApi.getById(String(ticketId), [
      'fecha_resolucion_esperada',
      'of_deal_id',
      'of_line_item_ids',
      'of_ticket_key',
    ]);
  } catch (e) {
    console.warn('[syncLineItemAfterCanonicalTicket] No se pudo leer ticket:', e?.message);
    return;
  }

  const tp = ticket?.properties || {};

  // ✅ Tomamos la fecha "canónica" (evita UTC -1 día)
  const ticketDateYMD = billDateYMD || toYMDInBillingTZ(tp.fecha_resolucion_esperada);
  if (!ticketDateYMD) return;

  // 2) Anti-clon (soft)
  if (tp.of_deal_id && String(tp.of_deal_id) !== String(dealId)) return;
  if (tp.of_line_item_ids) {
    const ids = String(tp.of_line_item_ids).split(',').map(x => x.trim()).filter(Boolean);
    if (!ids.includes(String(lineItemId))) return;
  }
  if (!tp.of_ticket_key) return;

  // 3) Leer line item (solo lo necesario)
  let lineItem;
  try {
    lineItem = await hubspotClient.crm.lineItems.basicApi.getById(String(lineItemId), [
      'billing_next_date',
      'last_ticketed_date',
      'billing_last_billed_date',
      'billing_anchor_date',
      'hs_recurring_billing_start_date',
      'recurringbillingfrequency',
      'hs_recurring_billing_frequency',
      'hs_recurring_billing_number_of_payments',
      'number_of_payments',
      'fecha_inicio_de_facturacion',
    ]);
  } catch (e) {
    console.warn('[syncLineItemAfterCanonicalTicket] No se pudo leer line item:', e?.message);
    return;
  }

  const lp = lineItem?.properties || {};
 const currentLastTicketedYMD = (lp.last_ticketed_date || '').slice(0, 10);
  const currentNextYMD = (lp.billing_next_date || '').slice(0, 10);



  // 4) last_ticketed_date = max(...)
  let newLastTicketedYMD = currentLastTicketedYMD;
  if (!currentLastTicketedYMD || ticketDateYMD > currentLastTicketedYMD) {
    newLastTicketedYMD = ticketDateYMD;
  }
  // 4.b) HARD STOP por número de pagos (si ya emitimos todos, no hay "next")
  const totalPaymentsRaw =
    lp.hs_recurring_billing_number_of_payments ?? lp.number_of_payments;

  const totalPayments = totalPaymentsRaw ? Number(totalPaymentsRaw) : 0;

  if (totalPayments > 0) {
const key = String(tp.of_ticket_key || '');
const lineItemKey = extractLineItemKeyFromTicketKey(key);

if (!lineItemKey) {
  // si no hay LIK, no podemos contar bien (en tests podés decidir fallback o return)
  console.warn('[syncLineItemAfterCanonicalTicket] ticketKey sin LIK:', key);
  return;
}

const issued = await countCanonicalTicketsForLineItemKey({ dealId, lineItemKey });

if (issued >= totalPayments) {
  const updates = {};

  if (newLastTicketedYMD !== currentLastTicketedYMD) {
    updates.last_ticketed_date = newLastTicketedYMD;
  }

  // Si ya está completo, no mostramos más próximas fechas
  if (currentNextYMD !== '') {
    updates.billing_next_date = '';
  }

  // 🔴 NUEVO: marcar fechas completas
  updates.fechas_completas = 'true';

  if (Object.keys(updates).length) {
    await hubspotClient.crm.lineItems.basicApi.update(
      String(lineItemId),
      { properties: updates }
    );

    console.log(
      `[syncLineItemAfterCanonicalTicket] LineItem ${lineItemId} COMPLETADO (${issued}/${totalPayments})`,
      updates
    );
  }

  return; // 👈 clave: salimos para no recalcular next
}

  }

// 5) billing_next_date
// Recalcular si next está vacío o si next <= last_ticketed (no representa “próxima sin ticket”).
// Si next ya está adelantado (> ticketDate), no tocar.
let newNextYMD = currentNextYMD;

if (!currentNextYMD || currentNextYMD <= newLastTicketedYMD) {
  if (currentNextYMD && currentNextYMD > ticketDateYMD) {
    // no tocar
  } else {
  const { getNextBillingDateForLineItem } = await import('../../billingEngine.js');
  const { toYMDInBillingTZ, parseLocalDate } = await import('../../utils/dateUtils.js');

  // Unificación: usar la fecha YMD como base, igual que phase 1
  const base = parseLocalDate(ticketDateYMD); // 00:00 en zona local
  const fakeLineItem = { properties: { ...lp } };
  const nextDateObj = getNextBillingDateForLineItem(fakeLineItem, base);
  newNextYMD = nextDateObj ? toYMDInBillingTZ(nextDateObj) : '';
  }
}

  // 6) Update solo si cambió algo
  const updates = {};
  if (newLastTicketedYMD !== currentLastTicketedYMD) updates.last_ticketed_date = newLastTicketedYMD;
  if (newNextYMD !== currentNextYMD) updates.billing_next_date = newNextYMD; // '' => null

  if (!Object.keys(updates).length) return;

  try {
    await hubspotClient.crm.lineItems.basicApi.update(String(lineItemId), { properties: updates });
    console.log(`[syncLineItemAfterCanonicalTicket] LineItem ${lineItemId} actualizado:`, updates);
  } catch (e) {
    console.warn('[syncLineItemAfterCanonicalTicket] No se pudo actualizar line item:', e?.message);
  }
}

// Helper para resetear triggers en el Line Item (MVP anti-loops)
export async function resetTriggersFromLineItem(lineItemId) {
  const propsToReset = {
    facturar_ahora: 'false',
    actualizar: 'false', // <- agregamos esto
  };

  try {
    await hubspotClient.crm.lineItems.basicApi.update(String(lineItemId), {
      properties: propsToReset,
    });

    console.log(
      `[TRIGGERS] ✓ reseteados en LineItem ${lineItemId}: ${Object.keys(propsToReset).join(', ')}`
    );
  } catch (err) {
    const msg = `[TRIGGERS] ❌ NO se pudo resetear triggers en LineItem ${lineItemId}. ` +
      `Queda riesgo de loop. Error: ${err?.message || err}`;

    // Intento guardar el mensaje para que "se sepa qué falló"
    try {
      await hubspotClient.crm.lineItems.basicApi.update(String(lineItemId), {
        properties: { billing_error: msg },
      });
    } catch (_) {
      // si también falla, al menos queda en logs
    }

    // Cortar ejecución (no seguir como si nada)
    throw new Error(msg);
  }
}

export async function createAutoBillingTicket(deal, lineItem, billingDate) {
  const dealId = String(deal?.id || deal?.properties?.hs_object_id);
  const lineItemId = String(lineItem?.id || lineItem?.properties?.hs_object_id);
  const dp = deal?.properties || {};
  const lp = lineItem?.properties || {};

const lineItemKey = lp.line_item_key || null;
console.log('[ticketService][AUTO] 🔍 lineItemKey:', lineItemKey, '(real lineItemId:', lineItemId, ')');
  console.log('[ticketService][AUTO] 🔍 billingDate:', billingDate);

  let ticketId = null;
  let created = false;
  let duplicatesMarked = 0;

try {
  const result = await ensureTicketCanonical({
    dealId,
    lineItemKey: lineItem?.properties?.line_item_key, 
    billDateYMD: billingDate,
    lineItemId,

    buildTicketPayload: async ({ dealId, lineItemKey, billDateYMD, expectedKey }) => {
      const expectedDate = billDateYMD;
      const orderedDate = billDateYMD;
      const snapshots = await createTicketSnapshots(deal, lineItem, expectedDate, orderedDate);

      const dealName = deal?.properties?.dealname || 'Deal';
      const productName = lineItem?.properties?.name || 'Producto';
      const rubro = snapshots.of_rubro || null;

      const vendedorId = dp.hubspot_owner_id ? String(dp.hubspot_owner_id) : null;

      const ticketProps = {
        subject: `${dealName} | ${productName} | ${rubro} | ${billDateYMD}`,
        hs_pipeline: AUTOMATED_TICKET_PIPELINE,
        hs_pipeline_stage: AUTOMATED_TICKET_INITIAL_STAGE,
        of_deal_id: dealId,
        of_line_item_ids: lineItemId, 
        of_line_item_key: lineItemKey, 
        of_ticket_key: expectedKey, 
        observaciones_ventas: lineItem?.properties?.mensaje_para_responsable || '',
        ...snapshots,
      };

      console.log('[ticketPayload]', {
        expectedKey,
        billDateYMD,
        expectedDate,
      });

      if (vendedorId) ticketProps.of_propietario_secundario = vendedorId;

      return { properties: ticketProps };
    },
  });

  ticketId = result.ticketId;
  created = result.created;
  duplicatesMarked = result.duplicatesMarked;

  if (!ticketId) {
    console.warn('[ticketService][AUTO] ⚠️ No ticketId devuelto. Se omite facturación.');
    return { ticketId, created, duplicatesMarked };
  }

  if (created) {
    const [companyIds, contactIds] = await Promise.all([
      getDealCompanies(dealId),
      getDealContacts(dealId),
    ]);
    await createTicketAssociations(ticketId, dealId, lineItemId, companyIds, contactIds);
    console.log(`[ticketService][AUTO] ✓ Ticket creado: ${ticketId}`);
    console.log(`[ticketService][AUTO] Vendedor (deal hubspot_owner_id): ${dp.hubspot_owner_id || 'N/A'}`);
  }

  // === Lógica mínima de emisión de factura ===
  // Solo emitir si: (a) el ticket es nuevo, o (b) ya existe, está en pipeline automático y no tiene factura
  let ticketObj = null;
  try {
    ticketObj = await hubspotClient.crm.tickets.basicApi.getById(String(ticketId), [
      'of_invoice_id',
      'of_invoice_key',
      'hs_pipeline',
      'of_ticket_key',
      'fecha_resolucion_esperada',
    ]);
  } catch (e) {
    console.warn('[ticketService][AUTO] ⚠️ No se pudo obtener ticket para chequeo de factura:', e?.message);
  }

  const hasInvoice = ticketObj?.properties?.of_invoice_id;
  const isAutoPipeline = ticketObj?.properties?.hs_pipeline === AUTOMATED_TICKET_PIPELINE;

  if (created) {
    // Nuevo ticket: emitir siempre
    await createInvoiceFromTicket(ticketObj, 'AUTO_LINEITEM');
    console.log(`[ticketService][AUTO] ✓ Factura emitida desde ticket NUEVO ${ticketId}`);
  } else if (isAutoPipeline && !hasInvoice) {
    // Ticket existente, pipeline correcto y sin factura
    await createInvoiceFromTicket(ticketObj, 'AUTO_LINEITEM');
    console.log(`[ticketService][AUTO] ✓ Factura emitida desde ticket EXISTENTE (sin factura previa) ${ticketId}`);
  } else {
    // No emitir
    if (!isAutoPipeline) {
      console.log(
        `[ticketService][AUTO] ⊘ Ticket ya existía pero NO está en pipeline automático, no se emite factura: ${ticketId}`
      );
    } else if (hasInvoice) {
      console.log(`[ticketService][AUTO] ⊘ Ticket ya existía y YA tiene factura, no se emite factura: ${ticketId}`);
    } else {
      console.log(`[ticketService][AUTO] ⊘ Ticket ya existía, no se emite factura: ${ticketId}`);
    }
  }

  if (duplicatesMarked > 0) {
    console.log(`[ticketService][AUTO] 🧹 ${duplicatesMarked} duplicado(s) marcados`);
  }

  return { ticketId, created, duplicatesMarked };
} catch (err) {
  console.error('[ticketService][AUTO] ❌ Error en createAutoBillingTicket:', err?.message);
  throw err;
} finally {
  // ✅ Siempre resetear triggers (best-effort)
  await resetTriggersFromLineItem(lineItemId);
}
}

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

function extractLineItemKeyFromTicketKey(ticketKey) {
  if (!ticketKey) return null;
  const parts = String(ticketKey).split('::');
  if (parts.length !== 3) return null;

  const mid = parts[1]; // "LIK:<lineItemKey>"
  if (!mid.startsWith('LIK:')) return null;

  const lik = mid.slice(4);
  return lik || null;
}

async function findCanonicalAndDuplicates({
  dealId,
  expectedKey,
  billDateYMD,
  lineItemId,
  lineItemKey,
}) {
  const tickets = await getTicketsForDeal(dealId);

  const norm = (s) => (s == null ? '' : String(s)).trim();
  const tkey = (t) => norm(t?.properties?.of_ticket_key);

  // 1) PRIMARY: match exact expectedKey (LIK)
  const byExpectedKey = tickets.filter(t => tkey(t) === expectedKey);

  let canonical = null;
  let duplicates = [];

  if (byExpectedKey.length) {
    canonical = byExpectedKey
      .slice()
      .sort((a, b) => getTicketCreatedMs(a) - getTicketCreatedMs(b))[0];

    duplicates = byExpectedKey.filter(t => String(t.id) !== String(canonical.id));
  } else {
    // 2) FALLBACK legacy: LI:<lineItemId>::<date>
    // OJO: esto asume que tus tickets viejos usaban este formato exacto.
    const legacyKey = buildLegacyTicketKeyFromLineItemId(dealId, lineItemId, billDateYMD);
    const byLegacyKey = tickets.filter(t => tkey(t) === legacyKey);

    if (byLegacyKey.length) {
      canonical = byLegacyKey
        .slice()
        .sort((a, b) => getTicketCreatedMs(a) - getTicketCreatedMs(b))[0];

      duplicates = byLegacyKey.filter(t => String(t.id) !== String(canonical.id));

      // 🔁 Importante: si encontraste legacy canonical, NO marques como duplicates
      // tickets de otras fechas aunque tengan mismo LIK. Mantenerlo bien conservador.
    }
  }

  // 3) Debug: mismos LIK con otra key (solo log)
  if (lineItemKey) {
    const withSameLIK = tickets.filter(t =>
      norm(t?.properties?.of_line_item_key) === norm(lineItemKey) &&
      tkey(t) !== expectedKey
    );

    if (withSameLIK.length) {
      console.log(
        `[dedup][DEBUG] Tickets con mismo of_line_item_key pero distinta of_ticket_key:`,
        withSameLIK.map(t => t.id)
      );
    }
  }

  return { canonical, duplicates };
}


function getTicketCreatedMs(t) {
  const p = t.properties || {};
  const raw = p.createdate || p.hs_createdate || p.hs_created_at;
  const ms = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(ms) ? ms : Number.MAX_SAFE_INTEGER;
}

export async function archiveClonedTicketsByKey({ expectedKey, dealId, dryRun = false }) {
  // Buscar todos los tickets del deal y filtrar por of_ticket_key exacto
  const tickets = await getTicketsForDeal(dealId);
  const byKey = tickets.filter(t => (t.properties?.of_ticket_key || '').trim() === expectedKey);

  if (byKey.length <= 1) return { kept: byKey[0]?.id || null, archived: [] };

  // Ordenar por createdate asc y archivar todos menos el primero
  byKey.sort((a, b) => getTicketCreatedMs(a) - getTicketCreatedMs(b));

  const kept = String(byKey[0].id);
  const clones = byKey.slice(1).map(t => String(t.id));

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
  lineItemKey,
  billDateYMD,
  lineItemId,
  buildTicketPayload,
  maxPayments, // (si no se usa todavía, ok dejarlo)
}) {
  if (!lineItemId) {
    throw new Error('ensureTicketCanonical: lineItemId es requerido (asociaciones/updates)');
  }
  if (!lineItemKey) {
    throw new Error('ensureTicketCanonical: lineItemKey es requerido (identidad estable)');
  }

const expectedKey = buildTicketKeyFromLineItemKey(dealId, lineItemKey, billDateYMD);

  if (process.env.DBG_TICKET_KEY === 'true') {
    console.log('[DBG_TICKET_KEY][ticketService] build', {
      dealId,
      lineItemKey,
      lineItemId,
      billDateYMD,
      expectedKey,
    });
  }

  await archiveClonedTicketsByKey({ expectedKey, dealId, dryRun: isDryRun() });

  // 1) Buscar canonical + duplicates
  const { canonical, duplicates } = await findCanonicalAndDuplicates({
    dealId,
    expectedKey,
    billDateYMD,
    lineItemId,
    lineItemKey, // (aunque hoy no lo use, pasalo para que puedas migrar el finder)
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

    try {
      await syncLineItemAfterCanonicalTicket({
        dealId,
        lineItemId,
        ticketId: canonical.id,
        billDateYMD,
      });
    } catch (e) {
      console.warn(
        '[ensureTicketCanonical] syncLineItemAfterCanonicalTicket (canonical) error:',
        e?.message
      );
    }

    return {
      ticketId: canonical.id,
      created: false,
      ticketKey: expectedKey,
      duplicatesMarked: duplicates.length,
    };
  }

  // 3) Si no existe, crear ticket canónico
  console.log(`   🆕 Creando ticket canónico...`);

  if (isDryRun()) {
    console.log(`   DRY_RUN: no se crea ticket ${expectedKey}`);
    return { ticketId: null, created: false, ticketKey: expectedKey, duplicatesMarked: 0 };
  }

  const payload = await buildTicketPayload({
    dealId,
    lineItemKey,
    billDateYMD,
    expectedKey,
  });

  const created = await safeCreateTicket(hubspotClient, payload);
  const newId = String(created.id || created.result?.id);

  console.log(`   ✓ Ticket canónico creado: ${newId}`);

  // 4) Luego de crear, volver a buscar y marcar duplicados UI
  const post = await findCanonicalAndDuplicates({
    dealId,
    expectedKey,
    billDateYMD,
    lineItemId,
    lineItemKey,
  });

  if (post.duplicates.length) {
    console.log(`   🧹 Después de crear, encontrados ${post.duplicates.length} duplicado(s) UI, marcando...`);
    await markDuplicateTickets({
      canonicalTicketId: newId,
      duplicates: post.duplicates,
      reason: `Se creó ticket canónico ${expectedKey}`,
    });
  }

  try {
    await syncLineItemAfterCanonicalTicket({
      dealId,
      lineItemId,
      ticketId: newId,
      billDateYMD,
    });
  } catch (e) {
    console.warn(
      '[ensureTicketCanonical] syncLineItemAfterCanonicalTicket (created) error:',
      e?.message
    );
  }

  return {
    ticketId: newId,
    created: true,
    ticketKey: expectedKey,
    duplicatesMarked: post.duplicates.length,
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
  // Guard: skip if empty
  if (!properties || Object.keys(properties).length === 0) {
    console.log(`[ticketService] ⊘ SKIP_EMPTY_UPDATE: No properties to update for ticket ${ticketId}`);
    return;
  }

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
