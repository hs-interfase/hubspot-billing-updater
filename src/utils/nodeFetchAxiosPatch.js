// src/utils/nodeFetchAxiosPatch.js
// Reemplaza el transporte node-fetch@2 del SDK de HubSpot por axios.
//
// Por qué: node-fetch@2 no logra leer respuestas de api.hubapi.com desde la
// red de Railway (ERR_STREAM_PREMATURE_CLOSE). Verificado A/B el 1-jul-2026
// dentro del contenedor de testing: axios 8/8 OK, node-fetch 0/8. Afecta a
// varios endpoints (associations getPage, searchApi.doSearch, batchApi.read).
//
// Cómo: se reemplaza module.exports del paquete node-fetch en el cache de
// require ANTES de que el SDK lo cargue, así todos los sub-clientes codegen
// y apiRequest() usan axios sin tocar node_modules. Por eso este módulo debe
// importarse ANTES de '@hubspot/api-client' (ver orden de imports en
// hubspotClient.js).
//
// Kill-switch sin deploy: HS_FETCH_VIA_AXIOS=false restaura node-fetch.

import { createRequire } from 'node:module';
import axios from 'axios';
import logger from '../../lib/logger.js';

const require = createRequire(import.meta.url);

const ENABLED = String(process.env.HS_FETCH_VIA_AXIOS ?? 'true').toLowerCase() !== 'false';
const TIMEOUT_MS = Number(process.env.HS_HTTP_TIMEOUT_MS || 60_000);

function buildHeaders(axiosHeaders) {
  // Normalizar a un objeto plano nombre-en-minúscula -> string
  const plain = {};
  for (const [k, v] of Object.entries(axiosHeaders || {})) {
    plain[String(k).toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
  }
  return {
    get: (name) => plain[String(name).toLowerCase()] ?? null,
    has: (name) => String(name).toLowerCase() in plain,
    forEach: (cb) => { for (const [k, v] of Object.entries(plain)) cb(v, k); },
    raw: () => Object.fromEntries(Object.entries(plain).map(([k, v]) => [k, [v]])),
    entries: () => Object.entries(plain)[Symbol.iterator](),
    keys: () => Object.keys(plain)[Symbol.iterator](),
    values: () => Object.values(plain)[Symbol.iterator](),
  };
}

async function fetchViaAxios(url, opts = {}) {
  const res = await axios.request({
    url: String(url),
    method: opts.method || 'GET',
    data: opts.body,
    headers: opts.headers,
    httpAgent: opts.agent,
    httpsAgent: opts.agent,
    timeout: TIMEOUT_MS,
    responseType: 'arraybuffer',   // preserva binario; text()/json() derivan
    validateStatus: () => true,    // fetch no rechaza por status HTTP
    maxRedirects: 5,
    transformResponse: [(d) => d], // sin parseo automático del body
  });

  const buf = Buffer.isBuffer(res.data) ? res.data : Buffer.from(res.data ?? []);

  return {
    status: res.status,
    ok: res.status >= 200 && res.status < 300,
    statusText: res.statusText || '',
    url: String(url),
    redirected: false,
    size: buf.length,
    headers: buildHeaders(res.headers),
    text: async () => buf.toString('utf8'),
    json: async () => JSON.parse(buf.toString('utf8')),
    buffer: async () => buf,
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  };
}

if (ENABLED) {
  // Resolver y cargar la MISMA copia de node-fetch que usa el SDK
  const sdkEntry = require.resolve('@hubspot/api-client');
  const nfPath = require.resolve('node-fetch', { paths: [sdkEntry] });
  const original = require(nfPath);

  // Conservar Headers/Request/Response/etc. del export original
  Object.assign(fetchViaAxios, original);
  fetchViaAxios.default = fetchViaAxios;

  require.cache[nfPath].exports = fetchViaAxios;

  logger.info(
    { nfPath, timeoutMs: TIMEOUT_MS },
    '[nodeFetchAxiosPatch] SDK HubSpot con transporte axios (kill-switch: HS_FETCH_VIA_AXIOS=false)'
  );
} else {
  logger.warn('[nodeFetchAxiosPatch] DESACTIVADO por HS_FETCH_VIA_AXIOS=false → SDK usa node-fetch original');
}
