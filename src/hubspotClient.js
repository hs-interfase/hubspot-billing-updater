// src/hubspotClient.js
import Hubspot from "@hubspot/api-client";
import "dotenv/config";

export const hubspotClient = new Hubspot.Client({
  accessToken: process.env.HUBSPOT_PRIVATE_TOKEN,
});

async function getAssocIdsV4(fromType, fromId, toType, limit = 100) {
  const out = [];
  let after;
  do {
    const resp = await hubspotClient.crm.associations.v4.basicApi.getPage(
      fromType,
      String(fromId),
      toType,
      limit,
      after
    );
    for (const r of resp.results || []) out.push(String(r.toObjectId));
    after = resp.paging?.next?.after;
  } while (after);
  return out;
}

// Fetch a deal and all of its line items.
// If a deal has no line items this returns an empty array.
export async function getDealWithLineItems(dealId) {
  if (!dealId) throw new Error("getDealWithLineItems requiere dealId");

  const dealProperties = [
    "dealname",
    "dealstage",
    "amount",
    "price",
    "closedate",
    "hubspot_owner_id",
    "pais_operativo",
    "deal_currency_code",
    "nota",

    // ====== FACTURACIÓN (deal - info/pantallazo) ======
    "facturacion_activa",
    "facturacion_frecuencia_de_facturacion",
    "facturacion_proxima_fecha",
    "facturacion_ultima_fecha",

    // Mirrors / duplicación
    "es_mirror_de_py",
    "deal_uy_mirror_id",
    "cliente_beneficiario",

    // Pausa (normalizo a 1 sola key; dejo "pausa" y saco "Pausa")
    "pausa",

    // ====== CUPO (deal) ======
    "cupo_activo",
    "tipo_de_cupo", // "Por horas" | "Por Monto"
    "cupo_total",
    "cupo_total_horas",
    "cupo_total_monto",
    "cupo_umbral",
    "cupo_consumido",
    "cupo_restante",
    "cupo_estado",

    // Responsable (deal)
    "responsable_asignado",
  ];

  const deal = await hubspotClient.crm.deals.basicApi.getById(
    String(dealId),
    dealProperties
  );

  const lineItemIds = await getAssocIdsV4("deals", dealId, "line_items");
  if (!lineItemIds.length) return { deal, lineItems: [] };

  const lineItemProperties = [
    "name",
    "servicio",
    "price",
    "costo",
    "quantity",
    "frecuencia_de_facturacion",
    "facturacion_frecuencia_de_facturacion",
    "fecha_inicio_de_facturacion",
    "contrato_a",
    "termino_a",
    "terceros",
    "nota",
    "total_de_pagos",
    "pagos_emitidos",
    "pagos_restantes",
    "renovacion_automatica",
    "hs_recurring_billing_period",
    "uy",
    "pais_operativo",

    // Campos nativos de facturación recurrente
    "hs_cost_of_goods_sold",
    "recurringbillingfrequency",
    "hs_recurring_billing_frequency",
    "hs_recurring_billing_start_date",
    "hs_recurring_billing_terms",
    "hs_recurring_billing_number_of_payments",

    // ====== CUPO (line item) ======
    "parte_del_cupo", // boolean: este line item consume del cupo del negocio

    // ====== FACTURACIÓN V2 (line item) ======
    "facturacion_activa", // bool: entra en el flujo
    "facturacion_automatica", // bool: si true => emite factura sin ticket
    "facturar_ahora", // bool: disparador manual (si lo usás en line item)
    "responsable_asignado", // opcional: si lo usan por línea
    "horas_reales_usadas", // opcional: si alguna vez registran horas reales a nivel LI

    // Snapshots (para tickets / auditoría)
    "precio_hora_snapshot",
    "horas_previstas_snapshot",
    "monto_original_snapshot",

    // Invoice tracking (si lo usás)
    "of_invoice_id",
    "of_invoice_key",
    "of_invoice_status",
  ];

  // Incluir fechas extras hasta 24
  for (let i = 2; i <= 24; i++) {
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
