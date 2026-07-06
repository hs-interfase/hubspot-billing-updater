// src/services/fxService.js
// Cotización del dólar contra la moneda del negocio: cuántas unidades de esa moneda vale 1 USD
// (misma semántica que la columna "Dolar" de Nodum y que la prop `dolar` del ticket).
//
// Fuentes, en orden:
//   1) Override por env: DOLAR_UYU / DOLAR_PYG / DOLAR_EUR / DOLAR_<CUR> (numérico).
//      Para contingencia o pruebas sin red.
//   2) UYU → BCU (cotización oficial, SOAP awsultimocierre, Dólar USA billete cód. 2225).
//      ⚠️ Se toma el PROMEDIO compra/venta; confirmar con Paola si corresponde venta (TCV).
//      ⚠️ 2026-07-02: el BCU devuelve 403 (WAF) desde el entorno local; se deja el intento
//      por si Railway sí puede, y si no cae al punto 3. Revisar fuente oficial con Paola.
//   3) Resto (PYG / EUR / ...) → open.er-api.com (referencia diaria, sin API key).
//      El BCP oficial para PYG queda pendiente de definición (misma reunión que el resto de la épica).
//
// Cache en memoria por moneda (TTL 6 h): el dólar del negocio se fija en eventos puntuales
// (creación / cierre-ganado), no necesita más frescura y evita pegarle al BCU en cada deal.

import axios from 'axios';
import logger from '../../lib/logger.js';

const TTL_MS = 6 * 60 * 60 * 1000;
const cache = new Map(); // CUR -> { value, ts, source }

const BCU_URL = 'https://cotizaciones.bcu.gub.uy/wscotizacionesv2/servicio/awsultimocierre';
const BCU_MONEDA_DOLAR = 2225; // DLS. USA BILLETE

async function fetchDolarBcu() {
  const body =
    '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" ' +
    'xmlns:cot="Cotiza"><soapenv:Header/><soapenv:Body>' +
    '<cot:wsultimocierre.Execute/></soapenv:Body></soapenv:Envelope>';
  const { data } = await axios.post(BCU_URL, body, {
    headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: 'Cotiza' },
    timeout: 15000,
  });
  const xml = String(data);
  // Bloque de la moneda 2225: ...<Moneda>2225</Moneda>...<TCC>x</TCC><TCV>y</TCV>...
  const bloque = xml
    .split(/<\/?wsultimocierreout\.?Linea>|<\/?Cotizacionesoutlinea>/i)
    .find((b) => new RegExp(`<Moneda>\\s*${BCU_MONEDA_DOLAR}\\s*</Moneda>`).test(b))
    || xml;
  const tcc = Number((bloque.match(/<TCC>([\d.,]+)<\/TCC>/i) || [])[1]?.replace(',', '.'));
  const tcv = Number((bloque.match(/<TCV>([\d.,]+)<\/TCV>/i) || [])[1]?.replace(',', '.'));
  if (!(tcc > 0) && !(tcv > 0)) throw new Error('BCU: sin TCC/TCV parseables en la respuesta');
  if (tcc > 0 && tcv > 0) return +((tcc + tcv) / 2).toFixed(4);
  return tcc > 0 ? tcc : tcv;
}

async function fetchDolarErApi(currencyCode) {
  const { data } = await axios.get('https://open.er-api.com/v6/latest/USD', { timeout: 15000 });
  const rate = Number(data?.rates?.[currencyCode]);
  if (!(rate > 0)) throw new Error(`er-api: sin tasa para ${currencyCode}`);
  return +rate.toFixed(4);
}

/**
 * Devuelve la cotización 1 USD → `currencyCode` (número > 0) o null si no se pudo obtener.
 * USD → 1 siempre.
 */
export async function getDolar(currencyCode) {
  const cur = String(currencyCode || 'USD').toUpperCase();
  if (cur === 'USD') return 1;

  const envOverride = Number(process.env[`DOLAR_${cur}`]);
  if (envOverride > 0) return envOverride;

  const hit = cache.get(cur);
  if (hit && Date.now() - hit.ts < TTL_MS) return hit.value;

  const intentos = cur === 'UYU'
    ? [['BCU', fetchDolarBcu], ['er-api', () => fetchDolarErApi(cur)]]
    : [['er-api', () => fetchDolarErApi(cur)]];

  for (const [source, fn] of intentos) {
    try {
      const value = await fn();
      cache.set(cur, { value, ts: Date.now(), source });
      logger.info({ module: 'fxService', fn: 'getDolar', currencyCode: cur, value, source }, `[FX] dólar ${cur} = ${value} (${source})`);
      return value;
    } catch (err) {
      logger.warn({ module: 'fxService', fn: 'getDolar', currencyCode: cur, source, err: err?.message }, `[FX] fuente ${source} falló para ${cur}`);
    }
  }
  // Cache vencida es mejor que nada (se avisa).
  if (hit) {
    logger.warn({ module: 'fxService', fn: 'getDolar', currencyCode: cur, value: hit.value }, '[FX] usando cache vencida');
    return hit.value;
  }
  logger.error({ module: 'fxService', fn: 'getDolar', currencyCode: cur }, '[FX] sin cotización disponible');
  return null;
}
