import logger from '../../lib/logger.js';
import { hubspotClient } from '../hubspotClient.js';

export async function countActivePlanInvoices(lik) {
  try {
    const resp = await hubspotClient.crm.objects.searchApi.doSearch('invoices', {
      filterGroups: [{
        filters: [{ propertyName: 'line_item_key', operator: 'EQ', value: lik }]
      }],
      properties: ['etapa_de_la_factura'],
      limit: 100,
    });

    const results = resp?.results ?? [];
    return results.filter(inv => {
      const etapa = (inv.properties?.etapa_de_la_factura || '').trim().toLowerCase();
      return etapa !== 'cancelada';
    }).length;
  } catch (err) {
    logger.warn({ module: 'urgentBillingService', fn: 'countActivePlanInvoices', lik, err },
      'Error contando facturas activas, fail open');
    return null; // fail open: no bloqueamos si no podemos contar
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