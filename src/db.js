// src/db.js
import pg from 'pg'
import logger from '../lib/logger.js'

const { Pool } = pg

// rejectUnauthorized: false es necesario para Railway (TLS interno con cert self-signed).
// Si migrás a una DB externa con cert válido, cambiar a rejectUnauthorized: true.
// DESPUÉS
function resolveDatabaseConnectionString() {
  const mode = String(process.env.DB_CONNECTION_MODE || '').trim().toLowerCase()

  const isRailwayRuntime = Boolean(
    process.env.RAILWAY_ENVIRONMENT ||
    process.env.RAILWAY_SERVICE_ID ||
    process.env.RAILWAY_PROJECT_ID
  )

  const privateUrl = process.env.DATABASE_URL
  const publicUrl = process.env.DATABASE_PUBLIC_URL

  if (mode && !['private', 'public', 'auto'].includes(mode)) {
    throw new Error(
      `[DB] DB_CONNECTION_MODE inválido: "${mode}". Usar: private, public o auto`
    )
  }

  if (mode === 'private') {
    if (!privateUrl) {
      throw new Error('[DB] DB_CONNECTION_MODE=private pero DATABASE_URL no está configurada')
    }

    return {
      connectionString: privateUrl,
      mode: 'private',
      isRailwayRuntime,
    }
  }

  if (mode === 'public') {
    if (!publicUrl) {
      throw new Error('[DB] DB_CONNECTION_MODE=public pero DATABASE_PUBLIC_URL no está configurada')
    }

    return {
      connectionString: publicUrl,
      mode: 'public',
      isRailwayRuntime,
    }
  }

  // AUTO:
  // - Dentro de Railway usa DATABASE_URL.
  // - Fuera de Railway prioriza DATABASE_PUBLIC_URL,
  //   porque DATABASE_URL puede existir pero apuntar a red privada Railway.
  if (isRailwayRuntime && privateUrl) {
    return {
      connectionString: privateUrl,
      mode: 'private-auto',
      isRailwayRuntime,
    }
  }

  if (!isRailwayRuntime && publicUrl) {
    return {
      connectionString: publicUrl,
      mode: 'public-auto',
      isRailwayRuntime,
    }
  }

  if (privateUrl) {
    return {
      connectionString: privateUrl,
      mode: 'private-fallback',
      isRailwayRuntime,
    }
  }

  if (publicUrl) {
    return {
      connectionString: publicUrl,
      mode: 'public-fallback',
      isRailwayRuntime,
    }
  }

  throw new Error('[DB] No hay DATABASE_URL ni DATABASE_PUBLIC_URL configurada')
}

const { connectionString, mode, isRailwayRuntime } = resolveDatabaseConnectionString()

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
})

logger.info(
  {
    dbConnectionMode: mode,
    isRailwayRuntime,
  },
  '[DB] Pool PostgreSQL inicializado'
)

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