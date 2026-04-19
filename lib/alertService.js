// lib/alertService.js
//
// Servicio de notificaciones para el sistema de billing.
// Dos canales:
//   1. Email via Resend API → alertas críticas y resumen de corrida
//   2. HTTP ping a BetterStack Heartbeat → señal de "cron terminó OK"
//
// Uso:
//   import { sendAlert, sendSummary, pingHeartbeat } from './alertService.js'
//
//   await sendAlert('critical', 'Deal 123 falló 2 veces', { dealId: '123', error: '...' })
//   await sendSummary({ processed: 10, ok: 9, failed: 1, ... })
//   await pingHeartbeat()   ← llamar SOLO cuando el cron termina exitosamente

import logger from './logger.js'

// ── Config desde env ─────────────────────────────────────────────────────────
const RESEND_API_KEY   = process.env.RESEND_API_KEY
const ALERT_FROM       = process.env.ALERT_FROM_EMAIL   || 'hs.interfase.engine@gmail.com'
const ALERT_TO         = process.env.ALERT_TO_EMAIL     || 'promichfsd@gmail.com'
const HEARTBEAT_URL    = process.env.BETTERSTACK_HEARTBEAT_URL
const APP_ENV          = process.env.RAILWAY_ENVIRONMENT || process.env.NODE_ENV || 'local'

// ── Guard: si no hay Resend key, loguear y no explotar ───────────────────────
function resendConfigured() {
  return Boolean(RESEND_API_KEY)
}

// ── Envío de email via Resend API ────────────────────────────────────────────
async function sendEmail({ subject, html }) {
  if (!resendConfigured()) {
    logger.warn({ subject }, '[alertService] RESEND_API_KEY no configurado — email omitido')
    return
  }

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: `Billing Alerts <onboarding@resend.dev>`,  // dominio de prueba Resend; cambiar si verificás dominio propio
        to: [ALERT_TO],
        subject,
        html,
      }),
    })

    if (!res.ok) {
      const body = await res.text()
      logger.error({ status: res.status, body, subject }, '[alertService] Resend error')
    } else {
      logger.info({ subject, to: ALERT_TO }, '[alertService] Email enviado')
    }
  } catch (err) {
    // Nunca romper el cron por falla de alertas
    logger.error({ err: err?.message, subject }, '[alertService] fetch a Resend falló')
  }
}

// ── Helpers de formato HTML ──────────────────────────────────────────────────
function levelBadge(level) {
  const map = {
    critical: { bg: '#dc2626', label: '🔴 CRÍTICO' },
    warning:  { bg: '#d97706', label: '🟡 ADVERTENCIA' },
    info:     { bg: '#2563eb', label: '🔵 INFO' },
  }
  const { bg, label } = map[level] || map.info
  return `<span style="background:${bg};color:#fff;padding:2px 8px;border-radius:4px;font-weight:bold">${label}</span>`
}

function metaTable(data) {
  const rows = Object.entries(data)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `
      <tr>
        <td style="padding:4px 12px 4px 0;color:#6b7280;font-size:13px">${k}</td>
        <td style="padding:4px 0;font-size:13px;font-family:monospace">${String(v)}</td>
      </tr>`)
    .join('')
  return `<table style="border-collapse:collapse;margin-top:12px">${rows}</table>`
}

function htmlWrapper(title, body) {
  return `
    <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px">
      <h2 style="margin:0 0 16px">${title}</h2>
      ${body}
      <hr style="margin:24px 0;border:none;border-top:1px solid #e5e7eb">
      <p style="color:#9ca3af;font-size:12px">
        hubspot-billing-updater · ${APP_ENV} · ${new Date().toISOString()}
      </p>
    </div>`
}

// ── API pública ──────────────────────────────────────────────────────────────

/**
 * Alerta crítica o de advertencia.
 *
 * @param {'critical'|'warning'|'info'} level
 * @param {string} title  - Asunto del mail y título del body
 * @param {Object} meta   - Datos adicionales (dealId, error, ticketId, etc.)
 */
export async function sendAlert(level, title, meta = {}) {
  const subject = `[BILLING ${level.toUpperCase()}] ${title} — ${APP_ENV}`

  const html = htmlWrapper(
    `${levelBadge(level)} ${title}`,
    `<p style="color:#374151">Se detectó una condición que requiere atención.</p>
     ${metaTable(meta)}`
  )

  await sendEmail({ subject, html })
}

/**
 * Resumen al finalizar un cron.
 * Siempre se envía. Si failed > 0, el asunto indica advertencia.
 *
 * @param {Object} stats
 * @param {string} stats.jobName        - Nombre del cron (ej: 'cronDealsBatch')
 * @param {string} stats.mode           - 'weekday' | 'weekend'
 * @param {number} stats.processed
 * @param {number} stats.ok
 * @param {number} stats.failed
 * @param {number} stats.skippedMirror
 * @param {number} stats.skippedNoLI
 * @param {number} stats.elapsedMs
 * @param {Array}  stats.failedDeals    - [{ dealId, error }]
 */
export async function sendSummary(stats) {
  const {
    jobName = 'cron',
    mode = '',
    processed = 0,
    ok = 0,
    failed = 0,
    skippedMirror = 0,
    skippedNoLI = 0,
    elapsedMs = 0,
    failedDeals = [],
  } = stats

  const statusLabel = failed > 0 ? '⚠️ CON ERRORES' : '✅ OK'
  const subject = `[BILLING RESUMEN] ${jobName} ${statusLabel} — ${mode} — ${APP_ENV}`

  const elapsedMin = (elapsedMs / 60000).toFixed(1)

  let failedSection = ''
  if (failedDeals.length > 0) {
    const rows = failedDeals
      .map(({ dealId, error }) =>
        `<tr>
          <td style="padding:4px 8px;font-family:monospace;font-size:12px">${dealId}</td>
          <td style="padding:4px 8px;font-size:12px;color:#dc2626">${error}</td>
        </tr>`)
      .join('')
    failedSection = `
      <h3 style="margin:20px 0 8px;color:#dc2626">Deals fallidos</h3>
      <table style="border-collapse:collapse;width:100%;border:1px solid #fca5a5;border-radius:4px">
        <thead>
          <tr style="background:#fee2e2">
            <th style="padding:6px 8px;text-align:left;font-size:12px">Deal ID</th>
            <th style="padding:6px 8px;text-align:left;font-size:12px">Error</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>`
  }

  const html = htmlWrapper(
    `Resumen de corrida — ${jobName}`,
    `${metaTable({ mode, processed, ok, failed, skippedMirror, skippedNoLI, duración: `${elapsedMin} min` })}
     ${failedSection}`
  )

  await sendEmail({ subject, html })
}

/**
 * Ping al heartbeat de BetterStack.
 * Llamar SOLO cuando el cron termina sin crash (en el finally, después de cron_done).
 * Si no llega este ping, BetterStack alerta.
 */
export async function pingHeartbeat() {
  if (!HEARTBEAT_URL) {
    logger.debug('[alertService] BETTERSTACK_HEARTBEAT_URL no configurado — heartbeat omitido')
    return
  }

  try {
    const res = await fetch(HEARTBEAT_URL, { method: 'GET' })
    if (!res.ok) {
      logger.warn({ status: res.status }, '[alertService] Heartbeat ping retornó error')
    } else {
      logger.info('[alertService] Heartbeat ping OK')
    }
  } catch (err) {
    logger.error({ err: err?.message }, '[alertService] Heartbeat ping falló (fetch)')
  }
}