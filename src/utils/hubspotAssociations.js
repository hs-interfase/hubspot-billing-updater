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
 * @returns {Promise<string[]>} Array de IDs (strings) del objeto destino
 */
export async function getAllAssociatedIds(hubspotClient, fromType, fromId, toType) {
  const ids = [];
  let after;
  let page = 0;

  do {
    const resp = await hubspotClient.crm.associations.v4.basicApi.getPage(
      fromType,
      String(fromId),
      toType,
      PAGE_SIZE,
      after,
    );

    for (const r of (resp.results || [])) {
      ids.push(String(r.toObjectId));
    }

    after = resp.paging?.next?.after ?? null;
    page++;
  } while (after && page < MAX_PAGES);

  return ids;
}
