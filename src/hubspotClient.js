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
      'price',
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
      'comentarios_pm',
      'cliente_beneficiario',
      // Añadimos la propiedad de pausa para controlar la facturación
      'pausa',
      'Pausa',
    ],
    undefined,
    undefined,
    false
  );

  const lineItemIds = await getAssocIdsV4('deals', dealId, 'line_items');
  if (!lineItemIds.length) return { deal, lineItems: [] };

  // Propiedades necesarias en cada line item (normales + bolsa)
  const lineItemProperties = [
    'name',
    'servicio',
    'price',
    'costo',
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
    // Propiedades nativas de facturación recurrente
    'hs_cost_of_goods_sold',
    'recurringbillingfrequency',
    'hs_recurring_billing_frequency',
    'hs_recurring_billing_start_date',
    'hs_recurring_billing_terms',
    'hs_recurring_billing_number_of_payments',
    // Campos de bolsa
    'cant__hs_bolsa',
    'aplica_cupo',
    'bolsa_precio_hora',
    'horas_bolsa',
    'precio_bolsa',
    'bolsa_horas_restantes',
    'bolsa_monto_restante',
    'bolsa_monto_consumido',
    'bolsa_horas_consumidas',
    'total_bolsa_horas',
    'total_bolsa_monto',
    'bolsa_umbral_horas_alerta',
    'pm_asignado_bolsa',
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
