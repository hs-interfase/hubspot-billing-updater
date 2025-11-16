// src/hubspotClient.js
import Hubspot from '@hubspot/api-client';
import 'dotenv/config';

export const hubspotClient = new Hubspot.Client({
  accessToken: process.env.HUBSPOT_PRIVATE_TOKEN,
});

async function getAssocIdsV4(fromType, fromId, toType, limit = 100) {
  const out = [];
  let after;

  do {
    const resp = await hubspotClient.crm.associations.v4.basicApi.getPage(
      fromType,
      fromId,
      toType,
      limit,
      after
    );

    for (const r of resp.results || []) {
      out.push(r.toObjectId);
    }

    after = resp.paging?.next?.after;
  } while (after);

  return out;
}

export async function getDealWithLineItems(dealId) {
  if (!dealId) throw new Error('getDealWithLineItems requiere dealId');

  const deal = await hubspotClient.crm.deals.basicApi.getById(
    dealId,
    [
      'dealname',
      'dealstage',
      'amount',
      'closedate',
      'hubspot_owner_id',
      'pais_operativo',
      'deal_currency_code', 
      'nota',
    ],
    undefined,
    undefined,
    false
  );

  const lineItemIds = await getAssocIdsV4('deals', dealId, 'line_items');

  if (!lineItemIds.length) {
    return { deal, lineItems: [] };
  }

  const lineItemProperties = [
    'name',
    'servicio',
    'price',
    'quantity',
    'frecuencia_de_facturacion',
    'fecha_inicio_de_facturacion', 
    'contrato_a',
    'termino_a',
    'terceros',
    'nota',
  ];

  const batchInput = {
    inputs: lineItemIds.map((id) => ({ id: String(id) })),
    properties: lineItemProperties,
  };

  const batch = await hubspotClient.crm.lineItems.batchApi.read(batchInput, false);
  const lineItems = batch.results || [];

  return { deal, lineItems };
}
