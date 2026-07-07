// src/utils/hubspotAssociations.js
//
// Helper para obtener TODAS las asociaciones de un objeto HubSpot,
// paginando automáticamente para superar el límite de 100 por página.

const PAGE_SIZE = 100;
const MAX_PAGES = 20; // tope de seguridad: 2000 asociaciones máximo

/**
 * Devuelve todos los IDs asociados entre dos tipos de objetos HubSpot.
 * Pagina automáticamente si hay más de PAGE_SIZE resultados.
 *
 * @param {Object} hubspotClient
 * @param {'deals'|'line_items'|'tickets'|'contacts'|'companies'} fromType
 * @param {string} fromId
 * @param {'deals'|'line_items'|'tickets'|'contacts'|'companies'} toType
 * @param {Object} [opts]
 * @param {(fn: () => Promise<any>) => Promise<any>} [opts.wrap] Envoltorio opcional
 *   para cada llamada (p. ej. withRetry). Por defecto ejecuta la llamada tal cual.
 * @returns {Promise<string[]>} Array de IDs (strings) del objeto destino
 */
export async function getAllAssociatedIds(hubspotClient, fromType, fromId, toType, { wrap = (fn) => fn() } = {}) {
  const ids = [];
  let after;
  let page = 0;

  do {
    const resp = await wrap(() => hubspotClient.crm.associations.v4.basicApi.getPage(
      fromType,
      String(fromId),
      toType,
      PAGE_SIZE,
      after,
    ));

    for (const r of (resp.results || [])) {
      ids.push(String(r.toObjectId));
    }

    after = resp.paging?.next?.after ?? null;
    page++;
  } while (after && page < MAX_PAGES);

  return ids;
}

/**
 * Lee tickets en batch troceando los IDs en chunks <= 100 (límite de la
 * batchApi.read de HubSpot). Sin esto, un deal con más de 100 tickets asociados
 * (p. ej. un ganado grande con todo su cronograma forecast asociado) provoca un
 * HTTP 400 en el batch read.
 *
 * @param {Object} hubspotClient
 * @param {string[]} ticketIds
 * @param {string[]} properties Propiedades a traer por ticket
 * @param {Object} [opts]
 * @param {number} [opts.chunkSize=100] Tamaño máximo de chunk
 * @param {(fn: () => Promise<any>) => Promise<any>} [opts.wrap] Envoltorio opcional
 *   por chunk (p. ej. withRetry). Por defecto ejecuta la llamada tal cual.
 * @returns {Promise<Array>} Resultados concatenados de todos los chunks
 */
export async function readTicketsInChunks(hubspotClient, ticketIds, properties, { chunkSize = PAGE_SIZE, wrap = (fn) => fn() } = {}) {
  if (!ticketIds || ticketIds.length === 0) return [];

  const out = [];
  for (let i = 0; i < ticketIds.length; i += chunkSize) {
    const chunk = ticketIds.slice(i, i + chunkSize);
    const resp = await wrap(() => hubspotClient.crm.tickets.batchApi.read({
      inputs: chunk.map((id) => ({ id })),
      properties,
    }));
    for (const r of (resp?.results || [])) out.push(r);
  }
  return out;
}
