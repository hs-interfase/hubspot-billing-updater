// src/jobs/cronExchangeRates.js
//
// Cron independiente: corre una vez por noche, antes del cron de facturación.
//
// Escribe en cada ticket activo los multiplicadores que usa la propiedad
// calculada de HubSpot para convertir cualquier monto a USD:
//
//   fx_uyu_usd  — 1 UYU en USD  (ej: 0.0253)   → total_usd = total_uyu * fx_uyu_usd
//   fx_pyg_usd  — 1 PYG en USD  (ej: 0.000154)  → total_usd = total_pyg * fx_pyg_usd
//   fx_eur_usd  — 1 EUR en USD  (ej: 1.0821)    → total_usd = total_eur * fx_eur_usd
//
// Fórmula HubSpot que consume estas propiedades:
//   if(of_moneda == "UYU", total * fx_uyu_usd,
//     if(of_moneda == "PYG", total * fx_pyg_usd,
//       if(of_moneda == "EUR", total * fx_eur_usd,
//         total)))   <- USD ya está en USD, pasa directo
//
// --- Fuentes ------------------------------------------------------------------
//   UYU + EUR -> BCU (Banco Central Uruguay) — SOAP público, sin auth
//     https://cotizaciones.bcu.gub.uy/wscotizaciones/servlet/awsbcucotizaciones
//     Códigos: USD=2225, EUR=1111
//     Respuesta real: <datoscotizaciones.dato> con <Moneda> y <TCV>
//
//   PYG -> BCP (Banco Central Paraguay) — tabla HTML pública, sin auth
//     https://www.bcp.gov.py/webapps/web/cotizacion/monedas
//     Columna "G/ME" fila USD = guaraníes por 1 USD.
// -----------------------------------------------------------------------------
/*
import axios from 'axios';
import {
  TICKET_PIPELINE,
  TICKET_STAGES,
  AUTOMATED_TICKET_PIPELINE,
  BILLING_AUTOMATED_CANCELLED,
  isDryRun,
} from '../config/constants.js';
import { hubspotClient } from '../hubspotClient.js';
import logger from '../../lib/logger.js';

// --- Constantes ---------------------------------------------------------------

const BCU_SOAP_URL =
  'https://cotizaciones.bcu.gub.uy/wscotizaciones/servlet/awsbcucotizaciones';

const BCU_CODES = { USD: 2225, EUR: 1111 };

const BCP_MONEDAS_URL =
  'https://www.bcp.gov.py/webapps/web/cotizacion/monedas';

const EXCLUDED_STAGES = new Set([
  TICKET_STAGES.INVOICED,
  TICKET_STAGES.CANCELLED,
  BILLING_AUTOMATED_CANCELLED,
]);

const BATCH_SIZE         = 100;
const UPDATE_CONCURRENCY = 10;
const MAX_RETRO_DAYS     = 3; // reintentar hasta 3 días atrás si no hay cotización (feriados)

// --- BCU — UYU y EUR ----------------------------------------------------------

function buildBcuEnvelope(fechaYMD) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope
  xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:cot="Cotiza">
  <soapenv:Header/>
  <soapenv:Body>
    <cot:wsbcucotizaciones.Execute>
      <cot:Entrada>
        <cot:Moneda>
          <cot:item>${BCU_CODES.USD}</cot:item>
          <cot:item>${BCU_CODES.EUR}</cot:item>
        </cot:Moneda>
        <cot:FechaDesde>${fechaYMD}</cot:FechaDesde>
        <cot:FechaHasta>${fechaYMD}</cot:FechaHasta>
        <cot:Grupo>0</cot:Grupo>
      </cot:Entrada>
    </cot:wsbcucotizaciones.Execute>
  </soapenv:Body>
</soapenv:Envelope>`;
}

///
 // Extrae el precio de venta (TCV) en UYU para un código de moneda del XML del BCU.
 // El BCU responde con bloques <datoscotizaciones.dato> que contienen <Moneda> y <TCV>.
 ///
function extractVentaBcu(xml, codigoMoneda) {
  const datoRe = /<datoscotizaciones\.dato[^>]*>([\s\S]*?)<\/datoscotizaciones\.dato>/g;
  let m;
  while ((m = datoRe.exec(xml)) !== null) {
    const block = m[1];
    const cod = block.match(/<Moneda>(\d+)<\/Moneda>/);
    if (!cod || parseInt(cod[1], 10) !== codigoMoneda) continue;
    const venta = block.match(/<TCV>([\d.]+)<\/TCV>/);
    if (!venta) continue;
    const n = parseFloat(venta[1]);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  return null;
}

///
 // Llama al BCU y retorna UYU por 1 USD y UYU por 1 EUR (precio de venta).
 // Reintenta hasta MAX_RETRO_DAYS días atrás si no hay cotización (feriados/fines de semana).
 //
 // @returns {Promise<{ usdEnUyu: number, eurEnUyu: number, fechaUsada: string }>}
 ///
async function fetchBcuRates() {
  for (let d = 0; d <= MAX_RETRO_DAYS; d++) {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() - d);
    const fechaYMD = date.toISOString().slice(0, 10);

    let xml;
    try {
      const resp = await axios.post(BCU_SOAP_URL, buildBcuEnvelope(fechaYMD), {
        headers: { 'Content-Type': 'text/xml; charset=UTF-8', 'SOAPAction': '' },
        timeout: 15_000,
      });
      xml = resp.data;
    } catch (err) {
      logger.warn({ module: 'cronExchangeRates', fn: 'fetchBcuRates', fechaYMD, err: err.message },
        '[rates] BCU request failed, retrying earlier date');
      continue;
    }

    // status=1 indica cotizaciones disponibles; status=0 = sin datos para esa fecha
    if (!xml.includes('<status>1</status>')) {
      logger.warn({ module: 'cronExchangeRates', fn: 'fetchBcuRates', fechaYMD },
        '[rates] BCU sin cotizaciones para esta fecha, probando día anterior');
      continue;
    }

    const usdEnUyu = extractVentaBcu(xml, BCU_CODES.USD);
    const eurEnUyu = extractVentaBcu(xml, BCU_CODES.EUR);

    if (!usdEnUyu || !eurEnUyu) {
      logger.warn({ module: 'cronExchangeRates', fn: 'fetchBcuRates', fechaYMD, usdEnUyu, eurEnUyu },
        '[rates] BCU: status=1 pero no se extrajeron valores, probando día anterior');
      continue;
    }

    logger.info({ module: 'cronExchangeRates', fechaYMD, usdEnUyu, eurEnUyu },
      '[rates] BCU: cotizaciones obtenidas');
    return { usdEnUyu, eurEnUyu, fechaUsada: fechaYMD };
  }
  throw new Error('[cronExchangeRates] BCU: sin cotizaciones en los últimos 3 días hábiles');
}

// --- BCP — PYG ----------------------------------------------------------------

///
 // Scrapea la tabla del BCP y retorna cuántos guaraníes vale 1 USD.
 // Columnas: MONEDA | código | ME/USD | G/ME
 // Fila USD: G/ME = guaraníes por 1 USD -> índice 3.
 //
 // @returns {Promise<number>} PYG por 1 USD
 ///
async function fetchBcpPygPerUsd() {
  let html;
  try {
    const resp = await axios.get(BCP_MONEDAS_URL, {
      timeout: 15_000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; billing-cron/1.0)' },
    });
    html = resp.data;
  } catch (err) {
    throw new Error(`[cronExchangeRates] BCP: request failed — ${err.message}`);
  }

  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;

  while ((rowMatch = rowRe.exec(html)) !== null) {
    const row = rowMatch[1];
    if (!/USD/i.test(row) && !/DÓLAR\s+ESTADOUNIDENSE/i.test(row)) continue;

    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)]
      .map(c => c[1].replace(/<[^>]+>/g, '').trim());

    const raw = cells[3];
    if (!raw) continue;

    const normalized = raw.replace(/\./g, '').replace(',', '.');
    const value = parseFloat(normalized);
    if (Number.isFinite(value) && value > 100) {
      logger.info({ module: 'cronExchangeRates', pygPerUsd: value },
        '[rates] BCP: PYG/USD obtenido');
      return value;
    }
  }

  throw new Error('[cronExchangeRates] BCP: no se pudo extraer cotización PYG/USD de la tabla');
}

// --- Composición final de multiplicadores ------------------------------------

///
 // Obtiene los tres multiplicadores para la fórmula de HubSpot.
 //
 //   BCU da: usdEnUyu = UYU por 1 USD  (ej: 40.64)
 //   BCU da: eurEnUyu = UYU por 1 EUR  (ej: 46.47)
 //   BCP da: pygPerUsd = PYG por 1 USD (ej: 6499.04)
 //
 //   fx_uyu_usd = 1 / usdEnUyu            -> ej: 0.02461
 //   fx_eur_usd = eurEnUyu / usdEnUyu     -> ej: 1.1436
 //   fx_pyg_usd = 1 / pygPerUsd           -> ej: 0.00015387
 //
 // Si BCP falla, fx_pyg_usd queda null y se omite del update sin bloquear el cron.
 ///
async function fetchMultipliers() {
  const [bcuResult, bcpResult] = await Promise.allSettled([
    fetchBcuRates(),
    fetchBcpPygPerUsd(),
  ]);

  if (bcuResult.status === 'rejected') throw bcuResult.reason;

  const { usdEnUyu, eurEnUyu } = bcuResult.value;

  const fx_uyu_usd = round(1 / usdEnUyu, 8);
  const fx_eur_usd = round(eurEnUyu / usdEnUyu, 6);

  let fx_pyg_usd = null;
  if (bcpResult.status === 'fulfilled') {
    fx_pyg_usd = round(1 / bcpResult.value, 8);
  } else {
    logger.warn({ module: 'cronExchangeRates', err: bcpResult.reason?.message },
      '[rates] BCP fallo — tickets PYG no se actualizaran hoy');
  }

  return { fx_uyu_usd, fx_eur_usd, fx_pyg_usd };
}

// --- Helpers -----------------------------------------------------------------

function round(n, decimals) {
  const factor = Math.pow(10, decimals);
  return Math.round(n * factor) / factor;
}

function validateMultiplier(value, name) {
  if (value === null) return null;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`[cronExchangeRates] Multiplicador inválido para ${name}: ${value}`);
  }
  return value;
}

// --- HubSpot — búsqueda de tickets activos -----------------------------------

async function fetchActiveTicketsForPipeline(pipelineId) {
  const tickets = [];
  let after;

  do {
    const resp = await hubspotClient.crm.tickets.searchApi.doSearch({
      filterGroups: [
        { filters: [{ propertyName: 'hs_pipeline', operator: 'EQ', value: String(pipelineId) }] },
      ],
      properties: ['hs_pipeline_stage'],
      limit: BATCH_SIZE,
      ...(after ? { after } : {}),
    });

    for (const t of resp?.results || []) {
      if (!EXCLUDED_STAGES.has(String(t?.properties?.hs_pipeline_stage || ''))) {
        tickets.push(t);
      }
    }

    after = resp?.paging?.next?.after || null;
  } while (after);

  return tickets;
}

// --- HubSpot — batch update --------------------------------------------------

async function updateTicketsWithMultipliers(tickets, multipliers) {
  let ok = 0;
  let failed = 0;

  for (let i = 0; i < tickets.length; i += UPDATE_CONCURRENCY) {
    const chunk = tickets.slice(i, i + UPDATE_CONCURRENCY);

    await Promise.all(chunk.map(async (ticket) => {
      try {
        const props = {};
        if (multipliers.fx_uyu_usd !== null) props.fx_uyu_usd = String(multipliers.fx_uyu_usd);
        if (multipliers.fx_eur_usd !== null) props.fx_eur_usd = String(multipliers.fx_eur_usd);
        if (multipliers.fx_pyg_usd !== null) props.fx_pyg_usd = String(multipliers.fx_pyg_usd);

        if (!Object.keys(props).length) return;

        await hubspotClient.crm.tickets.basicApi.update(String(ticket.id), { properties: props });
        ok++;
      } catch (err) {
        failed++;
        logger.warn({ module: 'cronExchangeRates', ticketId: ticket.id, status: err?.response?.status },
          '[rates] Error actualizando ticket');
      }
    }));
  }

  return { ok, failed };
}

// --- Entry point -------------------------------------------------------------

///
 // Ejecuta el cron de tasas de cambio.
 // Llamar ANTES de cronDealsBatch en el scheduler nocturno.
 //
 // @returns {Promise<{ success: boolean, multipliers: object, ticketsUpdated: number, ticketsFailed: number }>}
 ///
export async function runExchangeRatesCron() {
  logger.info({ module: 'cronExchangeRates' }, '[rates] Iniciando cron de tasas de cambio');

  // 1) Obtener multiplicadores de fuentes externas
  let raw;
  try {
    raw = await fetchMultipliers();
  } catch (err) {
    logger.error({ module: 'cronExchangeRates', err }, '[rates] No se pudieron obtener tasas');
    return { success: false, error: err.message };
  }

  // 2) Validar
  let multipliers;
  try {
    multipliers = {
      fx_uyu_usd: validateMultiplier(raw.fx_uyu_usd, 'fx_uyu_usd'),
      fx_eur_usd: validateMultiplier(raw.fx_eur_usd, 'fx_eur_usd'),
      fx_pyg_usd: validateMultiplier(raw.fx_pyg_usd, 'fx_pyg_usd'),
    };
  } catch (err) {
    logger.error({ module: 'cronExchangeRates', err }, '[rates] Multiplicadores inválidos');
    return { success: false, error: err.message };
  }

  logger.info({ module: 'cronExchangeRates', multipliers }, '[rates] Multiplicadores listos');

  if (isDryRun()) {
    logger.info({ module: 'cronExchangeRates', multipliers }, '[rates] DRY_RUN: sin actualizaciones');
    return { success: true, multipliers, ticketsUpdated: 0, ticketsFailed: 0 };
  }

  // 3) Tickets activos en ambos pipelines
  let tickets = [];
  try {
    const [manual, automated] = await Promise.all([
      fetchActiveTicketsForPipeline(TICKET_PIPELINE),
      fetchActiveTicketsForPipeline(AUTOMATED_TICKET_PIPELINE),
    ]);
    tickets = [...manual, ...automated];
  } catch (err) {
    logger.error({ module: 'cronExchangeRates', err }, '[rates] Error buscando tickets');
    return { success: false, error: err.message };
  }

  logger.info({ module: 'cronExchangeRates', total: tickets.length }, '[rates] Tickets activos encontrados');

  if (!tickets.length) {
    return { success: true, multipliers, ticketsUpdated: 0, ticketsFailed: 0 };
  }

  // 4) Actualizar
  const { ok, failed } = await updateTicketsWithMultipliers(tickets, multipliers);

  logger.info({ module: 'cronExchangeRates', multipliers, ticketsUpdated: ok, ticketsFailed: failed },
    '[rates] Cron de tasas completado');

  return { success: true, multipliers, ticketsUpdated: ok, ticketsFailed: failed };
}
*/























/*


// testExchangeRates.js
// Uso: node testExchangeRates.js
// Verifica que las fuentes BCU y BCP responden y calcula los multiplicadores.

import axios from 'axios';

const BCU_SOAP_URL = 'https://cotizaciones.bcu.gub.uy/wscotizaciones/servlet/awsbcucotizaciones';
const BCU_CODES = { USD: 2225, EUR: 1111 };
const BCP_MONEDAS_URL = 'https://www.bcp.gov.py/webapps/web/cotizacion/monedas';
const MAX_RETRO_DAYS = 3;

function round(n, decimals) {
  const factor = Math.pow(10, decimals);
  return Math.round(n * factor) / factor;
}

function buildBcuEnvelope(fechaYMD) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope
  xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:cot="Cotiza">
  <soapenv:Header/>
  <soapenv:Body>
    <cot:wsbcucotizaciones.Execute>
      <cot:Entrada>
        <cot:Moneda>
          <cot:item>${BCU_CODES.USD}</cot:item>
          <cot:item>${BCU_CODES.EUR}</cot:item>
        </cot:Moneda>
        <cot:FechaDesde>${fechaYMD}</cot:FechaDesde>
        <cot:FechaHasta>${fechaYMD}</cot:FechaHasta>
        <cot:Grupo>0</cot:Grupo>
      </cot:Entrada>
    </cot:wsbcucotizaciones.Execute>
  </soapenv:Body>
</soapenv:Envelope>`;
}

function extractVentaBcu(xml, codigoMoneda) {
  // El BCU devuelve bloques <datoscotizaciones.dato> con <Moneda> y <TCV>
  const datoRe = /<datoscotizaciones\.dato[^>]*>([\s\S]*?)<\/datoscotizaciones\.dato>/g;
  let m;
  while ((m = datoRe.exec(xml)) !== null) {
    const block = m[1];
    const cod = block.match(/<Moneda>(\d+)<\/Moneda>/);
    if (!cod || parseInt(cod[1], 10) !== codigoMoneda) continue;
    const venta = block.match(/<TCV>([\d.]+)<\/TCV>/);
    if (!venta) continue;
    const n = parseFloat(venta[1]);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  return null;
}

async function fetchBcuRates() {
  for (let d = 0; d <= MAX_RETRO_DAYS; d++) {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() - d);
    const fechaYMD = date.toISOString().slice(0, 10);
    console.log(`  [BCU] Probando fecha: ${fechaYMD}`);

    let xml;
    try {
      const resp = await axios.post(BCU_SOAP_URL, buildBcuEnvelope(fechaYMD), {
        headers: { 'Content-Type': 'text/xml; charset=UTF-8', 'SOAPAction': '' },
        timeout: 15_000,
      });
      xml = resp.data;
    } catch (err) {
      console.warn("  [BCU] Request fallo:", err.message);
      console.warn("  [BCU] code:", err?.code);
      console.warn("  [BCU] status:", err?.response?.status);
      console.warn("  [BCU] response:", String(err?.response?.data || "").slice(0, 500));
      continue;
    }

    // Verificar status antes de parsear (status=1 = OK, status=0 = sin datos)
    if (!xml.includes('<status>1</status>')) {
      console.warn(`  [BCU] Sin cotizaciones para ${fechaYMD} (status != 1), probando anterior...`);
      continue;
    }

    const usdEnUyu = extractVentaBcu(xml, BCU_CODES.USD);
    const eurEnUyu = extractVentaBcu(xml, BCU_CODES.EUR);

    if (!usdEnUyu || !eurEnUyu) {
      console.warn(`  [BCU] Sin cotizaciones para ${fechaYMD}, probando día anterior...`);
      continue;
    }

    return { usdEnUyu, eurEnUyu, fechaUsada: fechaYMD };
  }
  throw new Error('BCU: sin cotizaciones en los últimos 3 días');
}

async function fetchBcpPygPerUsd() {
  console.log(`  [BCP] Consultando ${BCP_MONEDAS_URL}`);
  const resp = await axios.get(BCP_MONEDAS_URL, {
    timeout: 15_000,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; billing-cron/1.0)' },
  });

  const html = resp.data;
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;

  while ((rowMatch = rowRe.exec(html)) !== null) {
    const row = rowMatch[1];
    if (!/USD/i.test(row) && !/DÓLAR\s+ESTADOUNIDENSE/i.test(row)) continue;

    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)]
      .map(c => c[1].replace(/<[^>]+>/g, '').trim());

    const raw = cells[3];
    if (!raw) continue;

    const normalized = raw.replace(/\./g, '').replace(',', '.');
    const value = parseFloat(normalized);
    if (Number.isFinite(value) && value > 100) return value;
  }

  throw new Error('BCP: no se pudo extraer cotización PYG/USD');
}

async function main() {
  console.log('\n═══════════════════════════════════════');
  console.log('  TEST TASAS DE CAMBIO');
  console.log('═══════════════════════════════════════\n');

  // --- BCU ---
  console.log('▶ BCU (Uruguay) — USD y EUR:');
  let bcuData = null;
  try {
    bcuData = await fetchBcuRates();
    console.log(`  ✅ Fecha usada   : ${bcuData.fechaUsada}`);
    console.log(`  ✅ USD en UYU    : ${bcuData.usdEnUyu} (1 USD = ${bcuData.usdEnUyu} UYU)`);
    console.log(`  ✅ EUR en UYU    : ${bcuData.eurEnUyu} (1 EUR = ${bcuData.eurEnUyu} UYU)`);
  } catch (err) {
    console.error(`  ❌ ${err.message}`);
  }

  // --- BCP ---
  console.log('\n▶ BCP (Paraguay) — PYG:');
  let pygPerUsd = null;
  try {
    pygPerUsd = await fetchBcpPygPerUsd();
    console.log(`  ✅ PYG por 1 USD : ${pygPerUsd}`);
  } catch (err) {
    console.error(`  ❌ ${err.message}`);
  }

  // --- Multiplicadores calculados ---
  console.log('\n▶ Multiplicadores para propiedad calculada HubSpot:');
  if (bcuData) {
    const fx_uyu_usd = round(1 / bcuData.usdEnUyu, 8);
    const fx_eur_usd = round(bcuData.eurEnUyu / bcuData.usdEnUyu, 6);
    console.log(`  fx_uyu_usd = ${fx_uyu_usd}  (1 UYU = ${fx_uyu_usd} USD)`);
    console.log(`  fx_eur_usd = ${fx_eur_usd}  (1 EUR = ${fx_eur_usd} USD)`);
  } else {
    console.log('  fx_uyu_usd = ❌ no disponible');
    console.log('  fx_eur_usd = ❌ no disponible');
  }

  if (pygPerUsd) {
    const fx_pyg_usd = round(1 / pygPerUsd, 8);
    console.log(`  fx_pyg_usd = ${fx_pyg_usd}  (1 PYG = ${fx_pyg_usd} USD)`);
  } else {
    console.log('  fx_pyg_usd = ❌ no disponible');
  }

  console.log('\n═══════════════════════════════════════\n');
}

main().catch(err => {
  console.error('\n❌ Error inesperado:', err.message);
  process.exit(1);
});

*/