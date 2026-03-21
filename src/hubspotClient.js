// src/hubspotClient.js
import Hubspot from "@hubspot/api-client";
import axios from 'axios';
import "dotenv/config";
import logger from '../lib/logger.js';
import { withRetry, isRetryable, calcDelay } from './utils/withRetry.js';

// ─────────────────────────────────────────────────────────────
// HubSpot SDK — Proxy con retry automático
// ─────────────────────────────────────────────────────────────
// El Proxy es recursivo: envuelve cualquier método a cualquier
// profundidad (crm.tickets.basicApi.update, etc.) con withRetry,
// sin necesidad de tocar cada call site.
// ─────────────────────────────────────────────────────────────

const rawHubspotClient = new Hubspot.Client({
  accessToken: process.env.HUBSPOT_PRIVATE_TOKEN,
});

function makeRetryProxy(target, path = '') {
  return new Proxy(target, {
    get(obj, prop) {
      // No interceptar símbolos (Symbol.iterator, Symbol.toPrimitive, etc.)
      if (typeof prop === 'symbol') return Reflect.get(obj, prop);

      const val = Reflect.get(obj, prop);

      if (typeof val === 'function') {
        const fullPath = path ? `${path}.${prop}` : String(prop);
        // Devolvemos una función síncrona que retorna la Promise de withRetry.
        // Mantiene el this original con .apply(obj, args).
        return (...args) => withRetry(
          () => val.apply(obj, args),
          { sdkPath: fullPath }
        );
      }

      if (val !== null && typeof val === 'object') {
        return makeRetryProxy(val, path ? `${path}.${prop}` : String(prop));
      }

      return val;
    },
  });
}

export const hubspotClient = makeRetryProxy(rawHubspotClient);

// ─────────────────────────────────────────────────────────────
// Axios compartida para llamadas directas (invoiceService, etc.)
// ─────────────────────────────────────────────────────────────
// Usar SIEMPRE esta instancia en lugar de `axios` desnudo para
// que las llamadas directas a la API de HubSpot también tengan retry.
// ─────────────────────────────────────────────────────────────

export const axiosHubSpot = axios.create();

axiosHubSpot.interceptors.response.use(
  res => res,
  async err => {
    const config = err.config;
    if (!config) throw err;

    const status = err.response?.status;
    if (!isRetryable(status)) throw err;

    config.__retryCount = (config.__retryCount || 0) + 1;
    if (config.__retryCount > 4) throw err; // maxRetries

    const retryAfter = err.response?.headers?.['retry-after'] ?? null;
    const delay = calcDelay(config.__retryCount - 1, retryAfter);

    logger.warn(
      { status, attempt: config.__retryCount, delayMs: delay, url: config.url },
      `[axiosHubSpot] HTTP ${status} → reintentando en ${delay}ms (${config.__retryCount}/4)`
    );

    await new Promise(r => setTimeout(r, delay));
    return axiosHubSpot(config);
  }
);

// ─────────────────────────────────────────────────────────────

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
    "forecast_signature",
    "fecha_vencimiento_contrato",
    "facturas_restantes",

    // --- fechas ---
    "fecha_inicio_de_facturacion",
    "billing_next_date",
    "last_billing_period",
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
    "last_billing_period",
    "last_ticketed_date",

    // --- delays en fechas ---
    "hs_billing_start_delay_type",
    "hs_billing_start_delay_days",
    "hs_billing_start_delay_months",

    // --- cupo (solo flag) ---
    "parte_del_cupo",

    // --- control / mensajes ---
    'hs_lastmodifieddate',
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