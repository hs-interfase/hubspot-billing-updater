import logger from '../../lib/logger.js';
import { hubspotClient } from '../hubspotClient.js';

const PAGE_SIZE = 100;
const MAX_PAGES = 20; // tope de seguridad: 2000 facturas por line_item_key

/**
 * Cuenta las facturas ACTIVAS (etapa != Cancelada) de un plan (line_item_key),
 * deduplicando por of_invoice_key para no contar dos veces un mismo período
 * refacturado (la refacturación crea una factura nueva con la MISMA key).
 *
 * - Pagina el search (limit 100 por página, hasta MAX_PAGES).
 * - Facturas SIN of_invoice_key (legacy/manuales; el motor siempre la setea al
 *   crear — ver invoiceService) cuentan individualmente: conservador, suman
 *   al tope del plan.
 * - En error devuelve null = "desconocido". El caller decide: phase3
 *   (sweepAutoBacklog) hace fail-closed y NO emite en esa pasada.
 *
 * @param {string} lik line_item_key del plan
 * @param {Object} [opts]
 * @param {Object} [opts.client] Cliente HubSpot inyectable (tests). Default: singleton.
 * @returns {Promise<number|null>} cantidad de períodos activos, o null si no se pudo contar
 */
export async function countActivePlanInvoices(lik, { client = hubspotClient } = {}) {
  try {
    const activas = [];
    let after;
    let page = 0;

    do {
      const resp = await client.crm.objects.searchApi.doSearch('invoices', {
        filterGroups: [{
          filters: [{ propertyName: 'line_item_key', operator: 'EQ', value: lik }]
        }],
        properties: ['etapa_de_la_factura', 'of_invoice_key'],
        limit: PAGE_SIZE,
        ...(after ? { after } : {}),
      });

      const results = resp?.results ?? [];
      for (const inv of results) {
        const etapa = (inv.properties?.etapa_de_la_factura || '').trim().toLowerCase();
        if (etapa !== 'cancelada') activas.push(inv);
      }

      after = resp?.paging?.next?.after ?? null;
      page++;
    } while (after && page < MAX_PAGES);

    if (after) {
      logger.warn({ module: 'invoiceUtils', fn: 'countActivePlanInvoices', lik, pages: page },
        'Tope de páginas alcanzado contando facturas del plan; el conteo puede quedar corto');
    }

    // Dedupe por of_invoice_key: refacturaciones del mismo período comparten key.
    const seenKeys = new Set();
    let count = 0;
    for (const inv of activas) {
      const key = (inv.properties?.of_invoice_key || '').trim();
      if (!key) {
        count++; // sin key → cuenta individual (no hay forma de agrupar)
      } else if (!seenKeys.has(key)) {
        seenKeys.add(key);
        count++;
      }
    }

    return count;
  } catch (err) {
    logger.warn({ module: 'invoiceUtils', fn: 'countActivePlanInvoices', lik, err },
      'Error contando facturas activas — devolviendo null (desconocido; el caller decide)');
    return null; // "desconocido": phase3/sweepAutoBacklog lo trata fail-closed
  }
}

/**
 * Verifica si ya existe una invoice activa para una key exacta (dealId::LIK::fecha).
 * Guard contra race condition: dos ejecuciones concurrentes de phase3 que ambas
 * pasan el guard de of_invoice_id antes de que la primera termine de escribirlo.
 *
 * @param {string} invoiceKey - key canónica (buildInvoiceKey output)
 * @returns {Promise<boolean>} true si ya existe invoice activa para esa key
 */
export async function invoiceExistsForKey(invoiceKey) {
  try {
    const resp = await hubspotClient.crm.objects.searchApi.doSearch('invoices', {
      filterGroups: [{
        filters: [{ propertyName: 'of_invoice_key', operator: 'EQ', value: invoiceKey }]
      }],
      properties: ['etapa_de_la_factura'],
      limit: 10,
    });

    const results = resp?.results ?? [];
    const hasActive = results.some(inv => {
      const etapa = (inv.properties?.etapa_de_la_factura || '').trim().toLowerCase();
      return etapa !== 'cancelada';
    });

    return hasActive;
  } catch (err) {
    logger.warn(
      { module: 'invoiceUtils', fn: 'invoiceExistsForKey', invoiceKey, err },
      'Error buscando invoice por key, fail open'
    );
    return false; // fail open: si no podemos verificar, dejamos pasar (createInvoiceFromTicket tiene su propio guard)
  }
}
