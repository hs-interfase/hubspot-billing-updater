// src/services/tickets/ticketCleanupService.js

import { hubspotClient } from "../../hubspotClient.js";
import { syncBillingState } from '../billing/syncBillingState.js';
import { isDryRun } from "../../config/constants.js";
import logger from "../../../lib/logger.js";
import { reportHubSpotError } from "../../utils/hubspotErrorCollector.js";

const CANCELLED_STAGE_ID = process.env.BILLING_TICKET_STAGE_CANCELLED;

/**
 * Helper anti-spam: reporta a HubSpot solo errores 4xx accionables (≠ 429).
 * 429 y 5xx son transitorios → solo logger.error, sin reporte.
 */
function reportIfActionable({ objectType, objectId, message, err }) {
  const status = err?.response?.status ?? err?.statusCode ?? null;
  if (status === null) {
    reportHubSpotError({ objectType, objectId, message });
    return;
  }
  if (status === 429 || status >= 500) return;
  if (status >= 400 && status < 500) {
    reportHubSpotError({ objectType, objectId, message });
  }
}

// Props que leemos (INCLUIR source_type para detectar CLONE_OBJECTS)
const READ_PROPS = [
  "createdate",
  "hs_pipeline_stage",
  "of_ticket_key",
  "of_invoice_key",
  "source_type", // OBLIGATORIO para detectar clones
  "hs_object_source",
  "hs_object_source_label",
];

/**
 * of_ticket_key esperado: "<dealId>::LI:<lineItemId>::<YYYY-MM-DD>"
 */
function parseTicketKey(ofTicketKey) {
  if (!ofTicketKey || typeof ofTicketKey !== "string") return null;
  const s = ofTicketKey.trim();
  const parts = s.split("::");
  if (parts.length < 3) return null;

  const dealId = parts[0];
  const liPart = parts[1]; // "LI:123"
  const billDate = parts[2];

  if (!liPart.startsWith("LI:")) return null;
  const lineItemId = liPart.replace("LI:", "").trim();

  return { dealId, lineItemId, billDate };
}

/**
 * Obtiene IDs de objetos asociados usando API v4
 */
async function getAssocIdsV4(fromType, fromId, toType, limit = 100) {
  const out = [];
  let after;
  do {
    const resp = await hubspotClient.crm.associations.v4.basicApi.getPage(
      fromType,
      String(fromId),
      toType,
      limit,
      after
    );
    for (const r of resp.results || []) out.push(String(r.toObjectId));
    after = resp.paging?.next?.after;
  } while (after);
  return out;
}

/**
 * Lee tickets en batch
 */
async function readTickets(ticketIds) {
  if (!ticketIds || ticketIds.length === 0) return [];

  const resp = await hubspotClient.crm.tickets.batchApi.read({
    inputs: ticketIds.map((id) => ({ id })),
    properties: READ_PROPS,
  });
  return resp?.results || [];
}

/**
 * Elige el ticket más viejo de una lista
 */
function pickOldest(list) {
  return [...list].sort((a, b) => {
    const da = new Date(a.properties?.createdate || 0).getTime();
    const db = new Date(b.properties?.createdate || 0).getTime();
    return da - db;
  })[0];
}

/**
 * Depreca un ticket sacándolo del circuito
 */
async function softDeprecateTicket(ticketId, reason) {
  const properties = {
    hs_pipeline_stage: String(CANCELLED_STAGE_ID),
    of_ticket_key: "", // <- lo saca del circuito SIEMPRE
    // Opcional (comentado):
    // of_invoice_key: "",
    // of_motivo_cancelacion: reason,
  };

  if (isDryRun()) {
    logger.info({ module: 'ticketCleanupService', fn: 'softDeprecateTicket', ticketId, reason }, `[cleanup] (dry-run) Deprecando ticket ${ticketId}. reason=${reason}`);
    return;
  }

  try {
    await hubspotClient.crm.tickets.basicApi.update(String(ticketId), { properties });
  } catch (err) {
    logger.error({ module: 'ticketCleanupService', fn: 'softDeprecateTicket', ticketId, reason, err }, 'ticket_update_failed: softDeprecateTicket');
    reportIfActionable({
      objectType: 'ticket',
      objectId: ticketId,
      message: `ticket_update_failed (softDeprecateTicket): ${err?.message || err}`,
      err,
    });
    return;
  }

  // Hook: Centraliza estado billing (cancelación)
  try {
    const ticket = await hubspotClient.crm.tickets.basicApi.getById(String(ticketId), ['of_ticket_key']);
    const key = ticket?.properties?.of_ticket_key;
    if (key) {
      const parsed = parseTicketKey(key);
      if (parsed?.dealId) {
        await syncBillingState({ hubspotClient, dealId: parsed.dealId, lineItemId: parsed.lineItemId, lineItemKey: undefined, dealIsCanceled: true });
      }
    }
  } catch (err) {
    logger.warn({ module: 'ticketCleanupService', fn: 'softDeprecateTicket', ticketId, err }, '[softDeprecateTicket] syncBillingState failed');
  }

  logger.info({ module: 'ticketCleanupService', fn: 'softDeprecateTicket', ticketId, reason }, `[cleanup] ✅ Deprecado ticket ${ticketId}. reason=${reason}`);
}

/**
 * Limpia tickets clonados y duplicados para un deal.
 *
 * Pasos:
 * A) Deprecar tickets con source_type="CLONE_OBJECTS"
 * B) Validar mismatch (si lineItemId de la key no está en lineItems del deal)
 * C) Deduplicar por of_ticket_key (mantener el más viejo)
 *
 * @param {Object} params
 * @param {string} params.dealId - ID del deal
 * @param {Array} params.lineItems - Line items del deal
 * @returns {Object} { scanned, clones, duplicates, deprecated, mismatches }
 */
export async function cleanupClonedTicketsForDeal({ dealId, lineItems }) {
  logger.info({ module: 'ticketCleanupService', fn: 'cleanupClonedTicketsForDeal', dealId }, '[cleanup] iniciando');

  // Set de line item IDs para validación de mismatch
  const liSet = new Set((lineItems || []).map(li => String(li.id || li.properties?.hs_object_id)));

  // Obtener tickets asociados al deal
  const ticketIds = await getAssocIdsV4("deals", dealId, "tickets");
  logger.info({ module: 'ticketCleanupService', fn: 'cleanupClonedTicketsForDeal', dealId, count: ticketIds.length }, `[cleanup] Encontrados ${ticketIds.length} tickets asociados al deal`);

  if (ticketIds.length === 0) {
    return { scanned: 0, clones: 0, duplicates: 0, deprecated: 0, mismatches: 0 };
  }

  // Leer tickets
  const tickets = await readTickets(ticketIds);
  logger.info({ module: 'ticketCleanupService', fn: 'cleanupClonedTicketsForDeal', dealId, count: tickets.length }, `[cleanup] Leídos ${tickets.length} tickets`);

  let clones = 0;
  let duplicates = 0;
  let deprecated = 0;
  let mismatches = 0;

  // Set para trackear IDs ya deprecados (evita contaminar pasos siguientes)
  const deprecatedIds = new Set();

  // ========== PASO A: Deprecar tickets clonados por UI ==========
  for (const t of tickets) {
    logger.info({
      module: 'ticketCleanupService',
      fn: 'cleanupClonedTicketsForDeal',
      ticketId: t.id,
      createdate: t.properties?.createdate,
      source_type: t.properties?.source_type,
      hs_object_source: t.properties?.hs_object_source,
      hs_object_source_label: t.properties?.hs_object_source_label,
    }, '[cleanup][SRC]');

    const sourceType = t.properties?.source_type;
    if (sourceType === "CLONE_OBJECTS") {
      clones++;
      const key = t.properties?.of_ticket_key || "(sin key)";
      await softDeprecateTicket(
        t.id,
        `CLONE_OBJECTS detected. Original key: ${key}`
      );
      deprecated++;
      deprecatedIds.add(String(t.id));
    }
  }

  // ========== PASO B: Validar mismatch (lineItemId no está en lineItems) ==========
  for (const t of tickets) {
    if (deprecatedIds.has(String(t.id))) continue;

    const key = t.properties?.of_ticket_key;
    const parsed = parseTicketKey(key);
    if (!parsed?.lineItemId) continue;

    const existsInDeal = liSet.has(String(parsed.lineItemId));
    if (!existsInDeal) {
      mismatches++;

      try {
        await hubspotClient.crm.lineItems.basicApi.update(String(parsed.lineItemId), {
          properties: { is_clone: 'true' },
        });

        logger.debug({
          module: 'ticketCleanupService',
          fn: 'cleanupClonedTicketsForDeal',
          lineItemId: parsed.lineItemId,
          ticketId: t.id,
          of_ticket_key: key,
        }, '[clone][mismatch] marked line item as clone');
      } catch (err) {
        logger.info({
          module: 'ticketCleanupService',
          fn: 'cleanupClonedTicketsForDeal',
          lineItemId: parsed.lineItemId,
          ticketId: t.id,
          err: err?.message,
        }, '[clone][mismatch] could not mark line item');
        reportIfActionable({
          objectType: 'line_item',
          objectId: parsed.lineItemId,
          message: `line_item_update_failed (mismatch mark is_clone): ${err?.message || err}`,
          err,
        });
        continue;
      }

      await softDeprecateTicket(
        t.id,
        `MISMATCH key LI:${parsed.lineItemId} no está en lineItems del deal`
      );
      deprecated++;
      deprecatedIds.add(String(t.id));
    }
  }

  // ========== PASO C: Deduplicar por of_ticket_key ==========
  const groups = new Map();
  for (const t of tickets) {
    // Saltar si ya fue deprecado
    if (deprecatedIds.has(String(t.id))) continue;

    const k = (t.properties?.of_ticket_key || "").trim();
    if (!k) continue; // Ignorar tickets sin key

    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  }

  for (const [k, list] of groups.entries()) {
    if (list.length <= 1) continue; // No hay duplicados

    duplicates++;
    const canonical = pickOldest(list);
    const losers = list.filter((x) => String(x.id) !== String(canonical.id));

    logger.info({
      module: 'ticketCleanupService',
      fn: 'cleanupClonedTicketsForDeal',
      key: k,
      canonicalId: canonical.id,
      loserIds: losers.map(l => l.id),
    }, `[cleanup] DUP canonical=${canonical.id} losers=${losers.map(l => l.id).join(", ")}`);

    for (const l of losers) {
      await softDeprecateTicket(
        l.id,
        `DUPLICATE of_ticket_key=${k} canonical=${canonical.id}`
      );
      deprecated++;
      deprecatedIds.add(String(l.id));
    }
  }

  // Resumen final
  logger.info({
    module: 'ticketCleanupService',
    fn: 'cleanupClonedTicketsForDeal',
    dealId,
    scanned: tickets.length,
    clones,
    duplicates,
    deprecated,
    mismatches,
  }, `[cleanup] ✅ Resumen: scanned=${tickets.length}, clones=${clones}, duplicates=${duplicates}, deprecated=${deprecated}, mismatches=${mismatches}`);

  return {
    scanned: tickets.length,
    clones,
    duplicates,
    deprecated,
    mismatches,
  };
}
