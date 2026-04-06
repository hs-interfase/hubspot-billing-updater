// src/jobs/cronExchangeRates.js
//
// Cron independiente — corre a las 6am UTC todos los días.
// Obtiene tasas BCU (UYU, EUR) y BCP (PYG) y las persiste en la tabla
// exchange_rates de Postgres. No toca HubSpot.
//
// Railway: comando = node src/jobs/cronExchangeRates.js
//          schedule = 0 6 * * *

import axios from 'axios'
import { pathToFileURL } from 'node:url'
import pool, { initExchangeRatesTable } from '../db.js'
import logger from '../../lib/logger.js'

// --- Constantes ---------------------------------------------------------------

const BCU_SOAP_URL = 'https://cotizaciones.bcu.gub.uy/wscotizaciones/servlet/awsbcucotizaciones'
const BCU_CODES    = { USD: 2225, EUR: 1111 }
const BCP_URL      = 'https://www.bcp.gov.py/webapps/web/cotizacion/monedas'
const MAX_RETRO    = 3

// --- Helpers ------------------------------------------------------------------

function round(n, decimals) {
  const f = Math.pow(10, decimals)
  return Math.round(n * f) / f
}

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
</soapenv:Envelope>`
}

function extractVentaBcu(xml, codigoMoneda) {
  const re = /<datoscotizaciones\.dato[^>]*>([\s\S]*?)<\/datoscotizaciones\.dato>/g
  let m
  while ((m = re.exec(xml)) !== null) {
    const block = m[1]
    const cod = block.match(/<Moneda>(\d+)<\/Moneda>/)
    if (!cod || parseInt(cod[1], 10) !== codigoMoneda) continue
    const venta = block.match(/<TCV>([\d.]+)<\/TCV>/)
    if (!venta) continue
    const n = parseFloat(venta[1])
    return Number.isFinite(n) && n > 0 ? n : null
  }
  return null
}

async function fetchBcuRates() {
  for (let d = 0; d <= MAX_RETRO; d++) {
    const date = new Date()
    date.setUTCDate(date.getUTCDate() - d)
    const fechaYMD = date.toISOString().slice(0, 10)

    let xml
    try {
      const resp = await axios.post(BCU_SOAP_URL, buildBcuEnvelope(fechaYMD), {
        headers: { 'Content-Type': 'text/xml; charset=UTF-8', SOAPAction: '' },
        timeout: 15_000,
      })
      xml = resp.data
    } catch (err) {
      logger.warn({ fechaYMD, err: err.message }, '[rates] BCU request falló, probando día anterior')
      continue
    }

    if (!xml.includes('<status>1</status>')) {
      logger.warn({ fechaYMD }, '[rates] BCU sin cotizaciones para esta fecha')
      continue
    }

    const usdEnUyu = extractVentaBcu(xml, BCU_CODES.USD)
    const eurEnUyu = extractVentaBcu(xml, BCU_CODES.EUR)

    if (!usdEnUyu || !eurEnUyu) {
      logger.warn({ fechaYMD }, '[rates] BCU: status=1 pero sin valores extraíbles')
      continue
    }

    logger.info({ fechaYMD, usdEnUyu, eurEnUyu }, '[rates] BCU OK')
    return { usdEnUyu, eurEnUyu, fechaUsada: fechaYMD }
  }
  throw new Error('[cronExchangeRates] BCU: sin cotizaciones en los últimos 3 días hábiles')
}

// --- BCP — PYG ----------------------------------------------------------------

async function fetchBcpPygPerUsd() {
  const resp = await axios.get(BCP_URL, {
    timeout: 15_000,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; billing-cron/1.0)' },
  })

  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi
  let m
  while ((m = rowRe.exec(resp.data)) !== null) {
    const row = m[1]
    if (!/USD/i.test(row) && !/DÓLAR\s+ESTADOUNIDENSE/i.test(row)) continue

    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)]
      .map(c => c[1].replace(/<[^>]+>/g, '').trim())

    const raw = cells[3]
    if (!raw) continue

    const value = parseFloat(raw.replace(/\./g, '').replace(',', '.'))
    if (Number.isFinite(value) && value > 100) {
      logger.info({ pygPerUsd: value }, '[rates] BCP OK')
      return value
    }
  }
  throw new Error('[cronExchangeRates] BCP: no se pudo extraer PYG/USD')
}

// --- Upsert en Postgres -------------------------------------------------------

async function upsertExchangeRates(date, { uyu_usd, eur_usd, pyg_usd }) {
  await pool.query(
    `INSERT INTO exchange_rates (date, uyu_usd, eur_usd, pyg_usd)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (date) DO UPDATE
       SET uyu_usd = EXCLUDED.uyu_usd,
           eur_usd = EXCLUDED.eur_usd,
           pyg_usd = EXCLUDED.pyg_usd`,
    [date, uyu_usd, eur_usd, pyg_usd]
  )
  logger.info({ date, uyu_usd, eur_usd, pyg_usd }, '[rates] Tasas guardadas en DB')
}

// --- Entry point --------------------------------------------------------------

export async function runExchangeRatesCron() {
  logger.info('[rates] Iniciando cron de tasas de cambio')

  // 1) Fetch fuentes (en paralelo, BCP no bloquea si falla)
  const [bcuResult, bcpResult] = await Promise.allSettled([
    fetchBcuRates(),
    fetchBcpPygPerUsd(),
  ])

  if (bcuResult.status === 'rejected') {
    logger.error({ err: bcuResult.reason?.message }, '[rates] BCU falló — abortando')
    return { success: false, error: bcuResult.reason?.message }
  }

  const { usdEnUyu, eurEnUyu, fechaUsada } = bcuResult.value
const uyu_usd = round(usdEnUyu, 3)
const eur_usd = round(usdEnUyu / eurEnUyu, 3)

  let pyg_usd = null
  if (bcpResult.status === 'fulfilled') {
    pyg_usd = round(bcpResult.value, 3)
  } else {
    logger.warn({ err: bcpResult.reason?.message }, '[rates] BCP falló — pyg_usd quedará null')
  }

  // 2) Guardar en DB
  try {
    await upsertExchangeRates(fechaUsada, { uyu_usd, eur_usd, pyg_usd })
  } catch (err) {
    logger.error({ err: err.message }, '[rates] Error guardando en DB')
    return { success: false, error: err.message }
  }

  logger.info({ fechaUsada, uyu_usd, eur_usd, pyg_usd }, '[rates] Cron completado OK')
  return { success: true, date: fechaUsada, uyu_usd, eur_usd, pyg_usd }
}

// --- CLI (Railway lo invoca directamente) -------------------------------------

const isDirectRun =
  typeof process.argv[1] === 'string' &&
  import.meta.url === pathToFileURL(process.argv[1]).href

if (isDirectRun) {
  await initExchangeRatesTable()
  const result = await runExchangeRatesCron()
  if (!result.success) process.exitCode = 1
}