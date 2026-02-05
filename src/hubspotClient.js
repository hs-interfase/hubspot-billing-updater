// src/hubspotClient.js
import Hubspot from "@hubspot/api-client";
import "dotenv/config";

export const hubspotClient = new Hubspot.Client({
  accessToken: process.env.HUBSPOT_PRIVATE_TOKEN,
});

/**
 * Obtiene IDs asociados usando Associations v4 (paginado)
 */
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
    for (const r of resp.results || []) {
      out.push(String(r.toObjectId));
    }
    after = resp.paging?.next?.after;
  } while (after);

  return out;
}

/**
 * Trae un Deal con sus Line Items asociados
 * SOLO con las propiedades explícitas (fuente de verdad)
 */
export async function getDealWithLineItems(dealId) {
  if (!dealId) throw new Error("getDealWithLineItems requiere dealId");

  // ============================================================
  // DEAL PROPERTIES
  // ============================================================
  const dealProperties = [
    // --- estándar ---
    "dealname",
    "dealstage",
    "deal_currency_code",
    "hubspot_owner_id",
    "createdate",
    "hs_lastmodifieddate",

    // --- país / negocio ---
    "pais_operativo",
    "unidad_de_negocio",
    "cliente_beneficiario",

    // --- cupo ---
    "tipo_de_cupo",
    "cupo_activo",
    "cupo_total",
    "cupo_total_monto",
    "cupo_consumido",
    "cupo_restante",
    "cupo_umbral",
    "cupo_ultima_actualizacion",

    // --- facturación ---
    "facturacion_activa",
    "facturacion_frecuencia_de_facturacion",
    "facturacion_proxima_fecha",
    "facturacion_ultima_fecha",
    "facturacion_mensaje_proximo_aviso",

    // --- cancelación ---
    "closed_lost_reason",

    // --- mirrors ---
    "deal_py_origen_id",
    "deal_uy_mirror_id",
    "es_mirror_de_py",
  ];

  const deal = await hubspotClient.crm.deals.basicApi.getById(
    String(dealId),
    dealProperties
  );

  // ============================================================
  // LINE ITEMS
  // ============================================================
  const lineItemIds = await getAssocIdsV4("deals", dealId, "line_items");
  if (!lineItemIds.length) {
    return { deal, lineItems: [] };
  }

  const lineItemProperties = [
    // --- estándar / pricing ---
    "name",
    "description",
    "price",
    "hs_cost_of_goods_sold",
    "quantity",
    "amount",
    "discount",
    "hs_discount_percentage",
    "hs_tax_rate_group_id",
    "hs_post_tax_amount",
    "hubspot_owner_id",
    "createdate",

    // --- facturación ---
    "facturacion_activa",
    "facturacion_automatica",
    "facturar_ahora",
    "irregular",
    "pausa",
    "motivo_de_pausa",
    "cantidad_de_facturaciones_urgentes",
    "facturado_urgente",

    // --- fechas ---
    "fecha_inicio_de_facturacion",
    "billing_next_date",
    "billing_last_billed_date",
    "last_ticketed_date",
    "fecha_irregular_puntual",
    "billing_anchor_date",
    'fechas_completas',

    // --- recurring ---
    "recurringbillingfrequency",
    "hs_recurring_billing_start_date",
    "hs_recurring_billing_number_of_payments",
    "hs_recurring_billing_terms",
    'billing_anchor_date',
    'fecha_irregular_puntual',
    'billing_next_date',
    "billing_last_billed_date",
    "last_ticketed_date",

    // --- delays en fechas ---
    "hs_billing_start_delay_type",
    "hs_billing_start_delay_days",
    "hs_billing_start_delay_months",  

    // --- cupo (solo flag) ---
    "parte_del_cupo",

    // --- control / mensajes ---
    "mensaje_para_responsable",
    "nota",
    "servicio",
    "subrubro",
    "reventa",
    "billing_error",

    // --- referencias ---
    "invoice_id",
    "invoice_key",
    "id_deal_origen",
    "line_item_key",
    "pais_operativo",
    "responsable_asignado",
    "unidad_de_negocio",
    "uy",
  ];

  // fechas dinámicas fecha_2 ... fecha_24
  for (let i = 2; i <= 24; i++) {
    lineItemProperties.push(`fecha_${i}`);
  }

  const batchInput = {
    inputs: lineItemIds.map((id) => ({ id })),
    properties: lineItemProperties,
  };

  const batch = await hubspotClient.crm.lineItems.batchApi.read(
    batchInput,
    false
  );

  const lineItems = batch.results || [];

  return { deal, lineItems };
}
