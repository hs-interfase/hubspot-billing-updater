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
      'facturacion_activa',
      'facturacion_frecuencia_de_facturacion',
      'facturacion_proxima_fecha',
      'facturacion_ultima_fecha',
    ],
    undefined,
    undefined,
    false
  );

  const lineItemIds = await getAssocIdsV4('deals', dealId, 'line_items');
  if (!lineItemIds.length) return { deal, lineItems: [] };

  // Incluir todas las propiedades necesarias, incluidas fecha_2 a fecha_48
  const lineItemProperties = [
    'name',
    'servicio',
    'price',
    'quantity',
    'frecuencia_de_facturacion',
    'facturacion_frecuencia_de_facturacion',
    'fecha_inicio_de_facturacion',
    'contrato_a',
    'termino_a',
    'terceros',
    'nota',
    'total_de_pagos',
    'pagos_emitidos',
    'pagos_restantes',
    'renovacion_automatica',
    'hs_recurring_billing_period',
  ];

  // añade dinámicamente fecha_2 ... fecha_48
  for (let i = 2; i <= 48; i++) {
    lineItemProperties.push(`fecha_${i}`);
  }

  const batchInput = {
    inputs: lineItemIds.map((id) => ({ id: String(id) })),
    properties: lineItemProperties,
  };
  const batch = await hubspotClient.crm.lineItems.batchApi.read(batchInput, false);
  const lineItems = batch.results || [];

  return { deal, lineItems };
}
