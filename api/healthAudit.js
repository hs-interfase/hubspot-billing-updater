// src/routes/healthAudit.js
import { Router } from 'express'
import pool, { getCronStateWithTimestamp } from '../src/db.js'
import logger from '../../lib/logger.js'
import { hubspotClient } from '../hubspotClient.js'
import { TICKET_PIPELINE, TICKET_STAGES } from '../config/constants.js'
import { parseBool } from '../utils/parsers.js'


const router = Router()

// Umbral en horas para considerar el cron "stale"
const WEEKDAY_STALE_HOURS = 27
const WEEKEND_STALE_HOURS = 27

// Deals con N+ fallos en los últimos DAYS días = problema recurrente
const FAILURE_THRESHOLD = 3
const FAILURE_LOOKBACK_DAYS = 7

function hoursAgo(date) {
  return (Date.now() - new Date(date).getTime()) / (1000 * 60 * 60)
}

function worstStatus(...statuses) {
  if (statuses.includes('error')) return 'error'
  if (statuses.includes('warn')) return 'warn'
  return 'ok'
}

// ── Check 1: Cron Liveness ──────────────────────────────
async function checkCronLiveness() {
  const weekday = await getCronStateWithTimestamp('weekday_last_run')
  const weekend = await getCronStateWithTimestamp('weekend_last_run')

  const now = new Date()
  const dayOfWeek = now.getUTCDay() // 0=Sun, 6=Sat

  const result = { status: 'ok', weekday: null, weekend: null }

  // Weekday check (relevante L-V)
  if (!weekday) {
    // Si nunca corrió y estamos en día de semana, warn
    if (dayOfWeek >= 1 && dayOfWeek <= 5) {
      result.weekday = { status: 'warn', message: 'No weekday run recorded yet', lastRun: null }
    } else {
      result.weekday = { status: 'ok', message: 'No weekday run recorded (weekend, expected)', lastRun: null }
    }
  } else {
    const age = hoursAgo(weekday.updatedAt)
    const stale = age > WEEKDAY_STALE_HOURS
    result.weekday = {
      status: stale ? 'error' : 'ok',
      lastRun: weekday.updatedAt,
      hoursAgo: Math.round(age * 10) / 10,
      ...(stale && { message: `Last weekday run was ${Math.round(age)}h ago (threshold: ${WEEKDAY_STALE_HOURS}h)` }),
    }
  }

  // Weekend check (relevante sáb-dom)
  if (!weekend) {
    if (dayOfWeek === 0 || dayOfWeek === 6) {
      result.weekend = { status: 'warn', message: 'No weekend run recorded yet', lastRun: null }
    } else {
      result.weekend = { status: 'ok', message: 'No weekend run recorded (weekday, expected)', lastRun: null }
    }
  } else {
    const age = hoursAgo(weekend.updatedAt)
    const stale = age > WEEKEND_STALE_HOURS
    result.weekend = {
      status: stale && (dayOfWeek === 0 || dayOfWeek === 6) ? 'error' : 'ok',
      lastRun: weekend.updatedAt,
      hoursAgo: Math.round(age * 10) / 10,
      ...(stale && (dayOfWeek === 0 || dayOfWeek === 6) && {
        message: `Last weekend run was ${Math.round(age)}h ago (threshold: ${WEEKEND_STALE_HOURS}h)`,
      }),
    }
  }

  result.status = worstStatus(result.weekday?.status, result.weekend?.status)
  return result
}

// ── Check 2: Failed Deals Persistentes ──────────────────
async function checkFailedDeals() {
  const res = await pool.query(
    `SELECT deal_id, COUNT(*)::int AS fail_count,
            MAX(created_at) AS last_failure,
            array_agg(DISTINCT error_msg) AS errors
       FROM cron_failures
      WHERE created_at >= now() - ($1 || ' days')::interval
      GROUP BY deal_id
     HAVING COUNT(*) >= $2
      ORDER BY fail_count DESC
      LIMIT 20`,
    [String(FAILURE_LOOKBACK_DAYS), FAILURE_THRESHOLD]
  )

  const deals = res.rows.map(r => ({
    dealId: r.deal_id,
    failCount: r.fail_count,
    lastFailure: r.last_failure,
    errors: r.errors.slice(0, 3), // max 3 mensajes distintos
  }))

  return {
    status: deals.length > 0 ? 'warn' : 'ok',
    count: deals.length,
    threshold: `${FAILURE_THRESHOLD}+ failures in ${FAILURE_LOOKBACK_DAYS} days`,
    ...(deals.length > 0 && { deals }),
  }
}

// ── Check 3: Avisos administrativos ─────────────────────
async function checkAvisos() {
  const result = { status: 'ok', facturacion: {}, mantsoft: {} }

  // Hora actual en Montevideo
  const nowHour = parseInt(
    new Date().toLocaleString('en-US', { timeZone: 'America/Montevideo', hour: 'numeric', hour12: false })
  )
  const inFacturacionWindow = nowHour >= 8 && nowHour <= 18

  // ── 3a: cronMensajeFacturacion ──
  const facState = await getCronStateWithTimestamp('mensaje_facturacion_last_run')
  const facAge = facState?.updatedAt
    ? (Date.now() - new Date(facState.updatedAt).getTime()) / 3_600_000
    : null

  result.facturacion.lastRun = facState?.updatedAt || null
  result.facturacion.hoursAgo = facAge !== null ? Math.round(facAge * 10) / 10 : null

  if (inFacturacionWindow && (facAge === null || facAge > 2)) {
    result.facturacion.status = 'warn'
  } else {
    result.facturacion.status = 'ok'
  }

  // Tickets READY sin aviso
  try {
    const readyRes = await hubspotClient.crm.tickets.searchApi.doSearch({
      filterGroups: [{
        filters: [
          { propertyName: 'hs_pipeline', operator: 'EQ', value: String(TICKET_PIPELINE) },
          { propertyName: 'hs_pipeline_stage', operator: 'EQ', value: String(TICKET_STAGES.READY) },
        ],
      }],
      properties: ['hs_object_id', 'of_deal_id', 'ticket_emitio_aviso_a_admin', 'subject'],
      limit: 100,
    })
    const pendientes = (readyRes?.results || []).filter(t =>
      !parseBool(t?.properties?.ticket_emitio_aviso_a_admin)
    )
    result.facturacion.pendientes = pendientes.length
    if (pendientes.length > 0 && inFacturacionWindow) {
      result.facturacion.status = 'warn'
    }
  } catch (err) {
    logger.warn({ err: err?.message }, '[healthAudit] Error buscando tickets READY pendientes')
    result.facturacion.pendientes = null
    result.facturacion.searchError = err?.message
  }

  // ── 3b: cronMensajeMantsoft ──
  const manState = await getCronStateWithTimestamp('mensaje_mantsoft_last_run')
  const manAge = manState?.updatedAt
    ? (Date.now() - new Date(manState.updatedAt).getTime()) / 3_600_000
    : null

  result.mantsoft.lastRun = manState?.updatedAt || null
  result.mantsoft.hoursAgo = manAge !== null ? Math.round(manAge * 10) / 10 : null

  // Corre 1x/día a las 07:10 — si pasó las 08:00 y no corrió hoy → warn
  const todayMVD = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Montevideo' })
  const mansoftRanToday = manState?.updatedAt &&
    new Date(manState.updatedAt).toLocaleDateString('en-CA', { timeZone: 'America/Montevideo' }) === todayMVD

  if (nowHour >= 8 && !mansoftRanToday) {
    result.mantsoft.status = 'warn'
  } else {
    result.mantsoft.status = 'ok'
  }

  // LIs mansoft_pendiente sin procesar
  try {
    const manRes = await hubspotClient.crm.lineItems.searchApi.doSearch({
      filterGroups: [{
        filters: [
          { propertyName: 'mansoft_pendiente', operator: 'EQ', value: 'true' },
          { propertyName: 'facturacion_automatica', operator: 'EQ', value: 'true' },
        ],
      }],
      properties: ['hs_object_id', 'name', 'mansoft_pendiente'],
      limit: 10,
    })
    const pendientes = (manRes?.results || []).filter(li =>
      parseBool(li?.properties?.mansoft_pendiente)
    )
    result.mantsoft.pendientes = pendientes.length
    if (pendientes.length > 0 && nowHour >= 8) {
      result.mantsoft.status = 'warn'
    }
  } catch (err) {
    logger.warn({ err: err?.message }, '[healthAudit] Error buscando LIs mantsoft pendientes')
    result.mantsoft.pendientes = null
    result.mantsoft.searchError = err?.message
  }

  result.status = worstStatus(result.facturacion.status, result.mantsoft.status)
  return result
}

// ── Endpoint ────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const [cronLiveness, failedDeals, avisos] = await Promise.all([
      checkCronLiveness(),
      checkFailedDeals(),
      checkAvisos(),
    ])

    const checks = { cronLiveness, failedDeals, avisos }
    const status = worstStatus(cronLiveness.status, failedDeals.status, avisos.status)

    const statusCode = status === 'error' ? 503 : 200

    res.status(statusCode).json({
      status,
      checkedAt: new Date().toISOString(),
      checks,
    })
  } catch (err) {
    logger.error({ err: err?.message, stack: err?.stack }, '[healthAudit] check failed')
    res.status(500).json({
      status: 'error',
      checkedAt: new Date().toISOString(),
      error: err?.message || 'Internal error',
    })
  }
})

export default router