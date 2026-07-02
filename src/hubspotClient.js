// src/hubspotClient.js
// IMPORTANTE: el patch debe evaluarse ANTES de cargar el SDK (reemplaza el
// transporte node-fetch@2 por axios; ver src/utils/nodeFetchAxiosPatch.js).
import "./utils/nodeFetchAxiosPatch.js";
import Hubspot from "@hubspot/api-client";
import axios from 'axios';
import https from 'node:https';
import "dotenv/config";
import logger from '../lib/logger.js';
import { withRetry, isRetryable, calcDelay } from './utils/withRetry.js';
import { acquireRateToken } from './db.js';

// ─────────────────────────────────────────────────────────────
// HubSpot SDK — Proxy con retry automático
// ─────────────────────────────────────────────────────────────
// El Proxy es recursivo: envuelve cualquier método a cualquier
// profundidad (crm.tickets.basicApi.update, etc.) con withRetry,
// sin necesidad de tocar cada call site.
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// Interruptores de red (env vars) para mitigar el "Premature close"
// de Railway. AMBOS apagados por defecto → comportamiento IDÉNTICO a hoy.
//   HS_DISABLE_GZIP=true → pide la respuesta SIN comprimir (Accept-Encoding:
//     identity). Evita que un hipo de red rompa el stream gzip a mitad, que
//     es como node-fetch@2 tira ERR_STREAM_PREMATURE_CLOSE.
//   HS_NO_KEEPALIVE=true → socket nuevo por request (no reusa conexiones).
// Para revertir: borrar/poner en false la env var y reiniciar. Sin deploy.
// ─────────────────────────────────────────────────────────────
const HS_DISABLE_GZIP = String(process.env.HS_DISABLE_GZIP || '').toLowerCase() === 'true';
const HS_NO_KEEPALIVE = String(process.env.HS_NO_KEEPALIVE || '').toLowerCase() === 'true';

const hubspotClientOpts = {
  accessToken: process.env.HUBSPOT_PRIVATE_TOKEN,
};
if (HS_DISABLE_GZIP) {
  hubspotClientOpts.defaultHeaders = { 'Accept-Encoding': 'identity' };
}
if (HS_NO_KEEPALIVE) {
  hubspotClientOpts.httpAgent = new https.Agent({ keepAlive: false });
}

const rawHubspotClient = new Hubspot.Client(hubspotClientOpts);

if (HS_DISABLE_GZIP || HS_NO_KEEPALIVE) {
  logger.info(
    { HS_DISABLE_GZIP, HS_NO_KEEPALIVE },
    '[hubspotClient] interruptores de red activos (mitigación Premature close)'
  );
}

// ─────────────────────────────────────────────────────────────
// Rate limiter global — balde de fichas compartido (Postgres)
// ─────────────────────────────────────────────────────────────
// acquireToken() pide 1 ficha al balde compartido (tabla hs_rate_bucket, ver
// src/db.js). Como TODOS los procesos (worker de webhooks + crons) piden al
// mismo balde, el ritmo COMBINADO respeta el límite de HubSpot sin importar
// cuántos procesos corran a la vez. Tanto el SDK como axiosHubSpot pasan por acá.
//
// Si Postgres no responde, degradamos a un gate en memoria (~FALLBACK_RPS req/s)
// para no frenar la facturación por un hipo de la DB; withRetry cubre los 429
// que pudieran escaparse en ese modo degradado.
// ─────────────────────────────────────────────────────────────
const HS_RATE_FALLBACK_RPS = Number(process.env.HS_RATE_FALLBACK_RPS || 9);
const FALLBACK_INTERVAL_MS = Math.floor(1000 / HS_RATE_FALLBACK_RPS);
const RATE_MAX_WAIT_MS     = Number(process.env.HS_RATE_MAX_WAIT_MS || 30_000);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let lastFallbackAt = 0;
let lastFallbackWarnAt = 0;

// Gate en memoria: fallback si la DB no responde (comportamiento previo).
async function acquireTokenInMemory() {
  const now = Date.now();
  const wait = FALLBACK_INTERVAL_MS - (now - lastFallbackAt);
  if (wait > 0) await sleep(wait);
  lastFallbackAt = Date.now();
}

async function acquireToken() {
  const deadline = Date.now() + RATE_MAX_WAIT_MS;
  for (;;) {
    let r;
    try {
      r = await acquireRateToken();
    } catch (err) {
      // DB caída/lenta → degradar al gate en memoria, avisando (throttle 60s).
      const now = Date.now();
      if (now - lastFallbackWarnAt > 60_000) {
        lastFallbackWarnAt = now;
        logger.warn({ err: err?.message }, '[rateLimit] balde Postgres no responde → fallback a gate en memoria');
      }
      return acquireTokenInMemory();
    }

    if (r.granted) return;

    // No había ficha: esperar lo justo hasta que se rellene una.
    const rps = r.refillPerSec > 0 ? r.refillPerSec : HS_RATE_FALLBACK_RPS;
    let waitMs = Math.ceil(((1 - r.avail) / rps) * 1000);
    waitMs = Math.min(Math.max(waitMs, 5), 1000);   // entre 5ms y 1s por vuelta

    if (Date.now() + waitMs > deadline) {
      // Salvaguarda anti-bloqueo: no esperar para siempre (withRetry cubre un 429).
      logger.warn({ avail: r.avail }, '[rateLimit] espera de ficha excede el tope; continúo igual');
      return;
    }
    await sleep(waitMs);
  }
}

// ─────────────────────────────────────────────────────────────
// Ruta axios para endpoints que node-fetch@2 (el HTTP del SDK) rompe
// sistemáticamente en Railway con ERR_STREAM_PREMATURE_CLOSE.
// Misma firma y misma respuesta JSON que el SDK; solo cambia el transporte.
// El proxy las envuelve con el mismo acquireToken() + withRetry() que el resto.
// ─────────────────────────────────────────────────────────────
const axiosDirect = axios.create({
  baseURL: 'https://api.hubapi.com',
  timeout: Number(process.env.HS_HTTP_TIMEOUT_MS || 30_000),
});

// Firma idéntica a crm.associations.v4.basicApi.getPage del SDK.
async function assocGetPageViaAxios(objectType, objectId, toObjectType, after, limit) {
  const params = {};
  if (after !== undefined && after !== null) params.after = after;
  if (limit !== undefined && limit !== null) params.limit = limit;

  const { data } = await axiosDirect.get(
    `/crm/v4/objects/${encodeURIComponent(String(objectType))}/${encodeURIComponent(String(objectId))}/associations/${encodeURIComponent(String(toObjectType))}`,
    {
      params,
      headers: { Authorization: `Bearer ${process.env.HUBSPOT_PRIVATE_TOKEN}` },
    }
  );
  return data; // { results: [{ toObjectId, associationTypes }], paging? }
}

const AXIOS_SDK_ROUTES = {
  'crm.associations.v4.basicApi.getPage': assocGetPageViaAxios,
};

function makeRetryProxy(target, path = '') {
  return new Proxy(target, {
    get(obj, prop) {
      // No interceptar símbolos (Symbol.iterator, Symbol.toPrimitive, etc.)
      if (typeof prop === 'symbol') return Reflect.get(obj, prop);

      const val = Reflect.get(obj, prop);

      if (typeof val === 'function') {
        const fullPath = path ? `${path}.${prop}` : String(prop);
        const axiosRoute = AXIOS_SDK_ROUTES[fullPath];
        if (axiosRoute) {
          return (...args) => acquireToken().then(() => withRetry(
            () => axiosRoute(...args),
            { sdkPath: fullPath, transport: 'axios' }
          ));
        }
        // Devolvemos una función síncrona que retorna la Promise de withRetry.
        // Mantiene el this original con .apply(obj, args).
        return (...args) => acquireToken().then(() => withRetry(
          () => val.apply(obj, args),
          { sdkPath: fullPath }
        ));
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

axiosHubSpot.interceptors.request.use(async (config) => {
  await acquireToken();
  return config;
});

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
    "producto",
    "rubro",
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
    "mensaje_de_facturacion",
    'mansoft_ultimo_aviso',
    'mensaje_mansoft',

    // --- cancelación ---
    "closed_lost_reason",

    // --- mirrors ---
    "deal_py_origen_id",
    "deal_uy_mirror_id",
    "es_mirror_de_py",

    // --- migración ---
    "id_crm_origen",
    "id_cliente_nodum",

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
    "exonera_irae",
    "hs_post_tax_amount",
    "hubspot_owner_id",
    "createdate",
    'mansoft_pendiente',
    'mansoft_ultimo_snapshot',

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
    "hs_recurring_billing_period",
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
    "area",
    "reventa",
    "hs_product_id",
    "billing_error",

    // --- mirror --
    'of_line_item_py_origen_id',

    // ---Migración  ---
    "of_codigo_rubro",
    "momento_de_facturacion",
    "opera_trading",
    "mig_migracion_historica",

    // --- referencias --
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

// HubSpot limita batchApi.read a 100 inputs por request.
  // Troceamos en chunks de 100 y concatenamos resultados.
  const BATCH_LIMIT = 100;
  const lineItems = [];

  for (let i = 0; i < lineItemIds.length; i += BATCH_LIMIT) {
    const chunkIds = lineItemIds.slice(i, i + BATCH_LIMIT);
    const batch = await hubspotClient.crm.lineItems.batchApi.read(
      {
        inputs: chunkIds.map((id) => ({ id })),
        properties: lineItemProperties,
      },
      false
    );
    lineItems.push(...(batch.results || []));
  }

  return { deal, lineItems };
}