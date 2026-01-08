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
    // ====== PROPIEDADES ESTÁNDAR HUBSPOT ======
    "amount",
    "amount_in_home_currency",
    "closedate",
    "closed_lost_reason",
    "createdate",
    "days_to_close",
    "deal_currency_code",
    "dealname",
    "dealstage",
    "hs_all_owner_ids",
    "hs_createdate",
    "hs_lastmodifieddate",
    "hs_object_id",
    "hs_pipeline",
    "hs_pipeline_stage",
    "hubspot_owner_id",
    "num_associated_contacts",

    // ====== CUPO ======
    "cupo_activo",
    "cupo_consumido",
    "cupo_estado",
    "cupo_saldo_restante",
    "cupo_total_horas",
    "cupo_total_monto",
    "cupo_ultima_actualizacion",
    "cupo_umbral",
    "tipo_de_cupo",

    // ====== FACTURACIÓN ======
    "facturacion_activa",
    "facturacion_frecuencia_de_facturacion",
    "facturacion_mensaje_proximo_aviso",
    "facturacion_proxima_fecha",
    "facturacion_ultima_fecha",

    // ====== MIRRORS / DUPLICACIÓN ======
    "deal_py_origen_id",
    "deal_uy_mirror_id",
    "es_mirror_de_py",

    // ====== OTROS ======
    "pais_operativo",
    "pm_asignado_cupo",
  ];

  const deal = await hubspotClient.crm.deals.basicApi.getById(
    String(dealId),
    dealProperties
  );

  const lineItemIds = await getAssocIdsV4("deals", dealId, "line_items");
  if (!lineItemIds.length) return { deal, lineItems: [] };

  const lineItemProperties = [
    // ====== PROPIEDADES ESTÁNDAR HUBSPOT ======
    "amount",
    "createdate",
    "description",
    "discount",
    "hs_cost_of_goods_sold",
    "hs_createdate",
    "hs_lastmodifieddate",
    "hs_object_id",
    "hs_product_id",
    "hs_recurring_billing_start_date",
    "hs_recurring_billing_number_of_payments",
    "hs_recurring_billing_period",
    "hs_post_tax_amount",
    "hubspot_owner_id",
    "name",
    "price",
    "quantity",
    "recurringbillingfrequency",
    "recurringbillinginterval",
    "recurringbillingstartdate",
    "number_of_payments",
    "tax_rate",
    "term",

    // ====== FACTURACIÓN ======
    "avisos_emitidos_facturacion",
    "avisos_restantes_facturacion",
    "fecha_inicio_de_facturacion",
    "fecha_proxima_facturacion",
    "total_avisos_facturacion",
    "facturacion_automatica",
    "irregular",
    "facturar_ahora",
    "proximo_aviso_fecha",

    // ====== INICIO DE FACTURACIÓN DIFERIDO ======
  // Estos campos se completan automáticamente cuando se selecciona un inicio
  // diferido de facturación (días o meses).  Los usamos para normalizar la
  // fecha de inicio a una fecha concreta antes de calcular calendarios.
  "hs_billing_start_delay_days",
  "hs_billing_start_delay_months",
  "hs_billing_start_delay_type",

    // ====== CUPO ======
    "parte_del_cupo",
    "saldo_cupo_horas",
    "saldo_cupo_monto",

    // ====== OTROS ======
    "id_deal_origen",
    "motivo_pausa",
    "nota",
    "pais_operativo",
    "reventa",
    "servicio", // rubro
    "unidad_de_negocio",
    "uy",

     // ====== FACTURACIÓN - REFERENCIAS ======
    "invoice_id",
    "invoice_key", 
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