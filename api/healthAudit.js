import { Router } from 'express'
import pool, { getCronStateWithTimestamp } from '../src/db.js'
import logger from '../lib/logger.js'
import { hubspotClient } from '../src/hubspotClient.js'
import { TICKET_PIPELINE, TICKET_STAGES, EXCHANGE_RATE_STALE_DAYS } from '../src/config/constants.js'
import { findStuckAutoEmissions } from '../src/services/monitoring/zeroEmission.js'
import { parseBool } from '../src/utils/parsers.js'
import { checkWebhookQueue } from '../src/webhookQueue.js'

const router = Router()

// Umbral en horas para considerar el cron "stale"
const WEEKDAY_STALE_HOURS = 28
const WEEKEND_STALE_HOURS = 28

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
// Verificar si el último scan weekday fue completo
const weekdayScanDate = await getCronStateWithTimestamp('weekday_scan_complete_date');
const todayYMD = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Montevideo' });
const dayOfWeekLocal = new Date().toLocaleDateString('en-US', { timeZone: 'America/Montevideo', weekday: 'short' });
const isWeekday = !['Sat', 'Sun'].includes(dayOfWeekLocal);

if (isWeekday && weekdayScanDate?.value !== todayYMD) {
  result.weekday.scanComplete = false;
  result.weekday.scanCompleteDate = weekdayScanDate?.value || null;
  if (result.weekday.status === 'ok') result.weekday.status = 'warn';
  result.weekday.message = (result.weekday.message || '') + ' Scan did not complete today.';
} else if (isWeekday) {
  result.weekday.scanComplete = true;
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

// ── Check 5: Zero-emission ──────────────────────────────
// Detecta "el cron corrió pero no emitió lo que debía".
// En el pipeline AUTO, Phase 3 promueve a BILLING_AUTOMATED_READY y emite la
// factura en el MISMO paso. Por eso un ticket auto en READY SIN of_invoice_id
// significa que la emisión falló silenciosamente.
// Solo evaluamos si el scan weekday ya completó hoy: si no, el cron todavía
// está corriendo y un ticket transitorio en READY-sin-factura es esperable.
async function checkZeroEmission() {
  const weekdayScanDate = await getCronStateWithTimestamp('weekday_scan_complete_date')
  const todayYMD = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Montevideo' })
  const scanCompletedToday = weekdayScanDate?.value === todayYMD

  const result = { status: 'ok', scanCompletedToday }

  // Si el scan no completó hoy, diferimos el chequeo (no es zero-emission, es cron en curso / fin de semana).
  if (!scanCompletedToday) {
    result.message = 'Scan weekday no completó hoy todavía — chequeo de emisiones diferido'
    return result
  }

  try {
    const stuck = await findStuckAutoEmissions()
    result.pendingEmissions = stuck.length
    if (stuck.length > 0) {
      result.status = 'error'
      result.message = `${stuck.length} ticket(s) AUTO en READY sin factura tras completar el scan — emisión pendiente/fallida`
      result.sample = stuck.slice(0, 5).map(s => ({
        ticketId: s.ticketId,
        dealId: s.dealId,
        lineItemKey: s.lineItemKey,
        ticketKey: s.ticketKey,
        billingError: s.billingError,
      }))
    }
  } catch (err) {
    logger.warn({ err: err?.message }, '[healthAudit] Error en checkZeroEmission')
    result.status = 'warn'
    result.pendingEmissions = null
    result.searchError = err?.message
  }

  return result
}

// ── Check 6: Frescura de tipos de cambio (CHECK-4) ──────
// Las tasas (BCU/BCP) se usan en el reporte de exportación para convertir a USD.
// Si la última tasa guardada es más vieja que EXCHANGE_RATE_STALE_DAYS, el reporte
// estaría usando cotizaciones obsoletas → warn.
async function checkExchangeRates() {
  const result = { status: 'ok', staleAfterDays: EXCHANGE_RATE_STALE_DAYS }

  try {
    const { rows } = await pool.query(
      `SELECT date, (CURRENT_DATE - date) AS age_days
         FROM exchange_rates
        ORDER BY date DESC
        LIMIT 1`
    )

    if (!rows.length) {
      result.status = 'error'
      result.lastDate = null
      result.message = 'Tabla exchange_rates vacía — no hay tipos de cambio cargados'
      return result
    }

    const ageDays = Number(rows[0].age_days)
    result.lastDate = rows[0].date
    result.ageDays = ageDays

    if (ageDays > EXCHANGE_RATE_STALE_DAYS) {
      result.status = 'warn'
      result.message = `Último tipo de cambio tiene ${ageDays} día(s) (umbral: ${EXCHANGE_RATE_STALE_DAYS}) — posiblemente obsoleto`
    }
  } catch (err) {
    logger.warn({ err: err?.message }, '[healthAudit] Error en checkExchangeRates')
    result.status = 'warn'
    result.queryError = err?.message
  }

  return result
}

// ── Endpoint ────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
const [cronLiveness, failedDeals, avisos, webhookQueue, zeroEmission, exchangeRates] = await Promise.all([
  checkCronLiveness(),
  checkFailedDeals(),
  checkAvisos(),
  checkWebhookQueue(),
  checkZeroEmission(),
  checkExchangeRates(),
])

const checks = { cronLiveness, failedDeals, avisos, webhookQueue, zeroEmission, exchangeRates }
const status = worstStatus(cronLiveness.status, failedDeals.status, avisos.status, webhookQueue.status, zeroEmission.status, exchangeRates.status)

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