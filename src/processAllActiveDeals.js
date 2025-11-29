// src/processAllActiveDeals.js
import { hubspotClient } from './hubspotClient.js';
import { processDeal } from './processDeal.js';

/**
 * Procesa todos los negocios que tengan facturacion_activa = true.
 * Llama a processDeal(dealId) para cada uno.
 */
export async function processAllActiveDeals() {
  const searchRequest = {
    filterGroups: [
      {
        filters: [
          {
            propertyName: 'facturacion_activa',
            operator: 'EQ',
            value: 'true',
          },
        ],
      },
    ],
    properties: ['dealname', 'dealstage'],
    limit: 100,
  };

  const res = await hubspotClient.crm.deals.searchApi.doSearch(searchRequest);
  for (const d of res.results || []) {
    await processDeal(d.id);
  }
}
