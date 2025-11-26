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
      'es_mirror_de_py',
      'deal_uy_mirror_id',
      'horas_bolsa_reportada_PM',
    'comentarios_pm',
    'cliente_beneficiario'
    ],
    undefined,
    undefined,
    false
  );

  const lineItemIds = await getAssocIdsV4('deals', dealId, 'line_items');
  if (!lineItemIds.length) return { deal, lineItems: [] };

  // 🔹 Incluir todas las propiedades necesarias (normales + bolsa)
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
    'uy',

    // 🔹 Campos de bolsa (tus internal names)
    'bolsa_de_horas',
    'tipo_de_bolsa',
    'cant__hs_bolsa',
    'precio', // precio total de la bolsa (si lo usás)
    'bolsa_valor_hora',
    'bolsa_modalidad_facturacion',
    'bolsa_horas_consumidas',
    'bolsa_horas_restantes',
    'bolsa_monto_consumido',
    'bolsa_monto_restante',
    'bolsa_estado',
    'bolsa_umbral_horas_alerta',
  ];

  // añade dinámicamente fecha_2 ... fecha_48
  for (let i = 2; i <= 48; i++) {
    lineItemProperties.push(`fecha_${i}`);
  }

  const batchInput = {
    inputs: lineItemIds.map((id) => ({ id: String(id) })),
    properties: lineItemProperties,
  };

  // (opcional, para ver una vez qué se está pidiendo)
  console.log('DEBUG lineItemProperties', lineItemProperties);

  const batch = await hubspotClient.crm.lineItems.batchApi.read(batchInput, false);
  const lineItems = batch.results || [];

  return { deal, lineItems };
}

