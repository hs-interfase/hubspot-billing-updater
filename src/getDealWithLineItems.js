// src/hubspotClient.js
import Hubspot from '@hubspot/api-client';
import 'dotenv/config';

const hubspotClient = new Hubspot.Client({
  accessToken: process.env.HUBSPOT_PRIVATE_TOKEN,
});

// Lee un deal + sus line items asociados
export async function getDealWithLineItems(dealId) {
  // 1) Traer el deal con asociaciones a line_items
  const deal = await hubspotClient.crm.deals.basicApi.getById(
    dealId,
    ['dealname', 'dealstage', 'amount', 'closedate'],
    ['line_items'] // asociaciones
  );

  const assocLineItems = deal.associations?.line_items || [];
  const lineItemIds = assocLineItems.map((a) => a.id);

  if (lineItemIds.length === 0) {
    return { deal, lineItems: [] };
  }

  // 2) Leer los line items en batch
  const lineItemProperties = [
    'name',
    'price',
    'quantity',
    // aca luego agregamos tus propiedades custom:
    // 'frecuencia_de_facturacion',
    // 'fecha_inicio_de_facturacion',
    // 'contrato_a',
  ];

  const batchInput = {
    inputs: lineItemIds.map((id) => ({ id })),
    properties: lineItemProperties,
  };

  const batch = await hubspotClient.crm.lineItems.batchApi.read(batchInput);
  const lineItems = batch.results || [];

  return { deal, lineItems };
}
