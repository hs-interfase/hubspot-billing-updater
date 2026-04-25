// src/db.js
import pg from 'pg'
import logger from '../lib/logger.js'

const { Pool } = pg

// rejectUnauthorized: false es necesario para Railway (TLS interno con cert self-signed).
// Si migrás a una DB externa con cert válido, cambiar a rejectUnauthorized: true.
const pool = new Pool({
connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
})

export async function initCronStateTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cron_state (
      key        TEXT        PRIMARY KEY,
      value      TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)
  logger.info('[DB] Tabla cron_state lista.')
}

export async function getCronState(key) {
  const res = await pool.query(
    `SELECT value FROM cron_state WHERE key = $1`,
    [key]
  )
  return res.rows[0]?.value ?? null
}

export async function setCronState(key, value) {
  await pool.query(
    `INSERT INTO cron_state (key, value, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE
       SET value      = EXCLUDED.value,
           updated_at = now()`,
    [key, value === null ? null : String(value)]
  )
}
export async function initExchangeRatesTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS exchange_rates (
      date        DATE        PRIMARY KEY,
      uyu_usd     NUMERIC(12, 8) NOT NULL,
      eur_usd     NUMERIC(12, 6) NOT NULL,
      pyg_usd     NUMERIC(12, 8),
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  logger.info('[DB] Tabla exchange_rates lista.')
}


// ─── Tabla cron_failures ─────────────────────────────────────────────────────

export async function initCronFailuresTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cron_failures (
      id          SERIAL       PRIMARY KEY,
      job_name    TEXT         NOT NULL,
      deal_id     TEXT,
      error_msg   TEXT,
      context     JSONB,
      created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
    )
  `)
  // Índice para acelerar la consulta "últimos 7 días por job"
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_cron_failures_job_created
      ON cron_failures (job_name, created_at DESC)
  `)
  logger.info('[DB] Tabla cron_failures lista.')
}

/**
 * Registra un deal fallido en PostgreSQL.
 *
 * @param {Object} params
 * @param {string} params.jobName   - Nombre del cron (ej: 'cronDealsBatch')
 * @param {string} params.dealId
 * @param {string} params.errorMsg
 * @param {Object} [params.context] - Datos extra: mode, where, stack, etc.
 */
export async function insertCronFailure({ jobName, dealId, errorMsg, context = {} }) {
  try {
    await pool.query(
      `INSERT INTO cron_failures (job_name, deal_id, error_msg, context)
       VALUES ($1, $2, $3, $4)`,
      [jobName, dealId ? String(dealId) : null, String(errorMsg), JSON.stringify(context)]
    )
  } catch (err) {
    // No romper el cron si falla la escritura en DB
    logger.error({ err: err?.message, jobName, dealId }, '[DB] insertCronFailure falló')
  }
}

export async function getCronStateWithTimestamp(key) {
  const res = await pool.query(
    `SELECT value, updated_at FROM cron_state WHERE key = $1`,
    [key]
  )
  if (!res.rows[0]) return null
  return { value: res.rows[0].value, updatedAt: res.rows[0].updated_at }
}

/**
 * Consulta deals fallidos en los últimos N días.
 *
 * @param {string} jobName
 * @param {number} [days=7]
 * @returns {Promise<Array>}
 *
 * Ejemplo:
 *   const failures = await getCronFailures('cronDealsBatch', 7)
 */
export async function getCronFailures(jobName, days = 7) {
  const res = await pool.query(
    `SELECT id, deal_id, error_msg, context, created_at
       FROM cron_failures
      WHERE job_name = $1
        AND created_at >= now() - ($2 || ' days')::interval
      ORDER BY created_at DESC`,
    [jobName, String(days)]
  )
  return res.rows
}

export default pool