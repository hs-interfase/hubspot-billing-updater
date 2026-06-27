// src/db.js
import pg from 'pg'
import logger from '../lib/logger.js'
import crypto from 'node:crypto'

const { Pool } = pg
const DEAL_LOCK_TTL_MS = Number(process.env.DEAL_LOCK_TTL_MS || 15 * 60 * 1000)

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
// ─── Candado por deal (evita procesamiento concurrente del mismo deal) ───────
// Sin esto, dos procesos simultáneos sobre el mismo deal pueden duplicar
// tickets/facturas, porque la dedup por of_ticket_key depende de la Search API
// de HubSpot, que tarda 1-2s en indexar.

export async function initDealLocksTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS deal_locks (
      deal_id     TEXT PRIMARY KEY,
      lock_token  TEXT NOT NULL,
      owner_label TEXT,
      locked_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at  TIMESTAMPTZ NOT NULL
    )
  `)
  logger.info('[DB] Tabla deal_locks lista.')
}

/**
 * Intenta tomar el candado de un deal. NO espera: si otro proceso lo tiene
 * tomado y vigente, devuelve null al instante.
 * @returns {Promise<string|null>} token si lo tomó, null si está ocupado.
 */
export async function acquireDealLock(dealId, ownerLabel = null, ttlMs = DEAL_LOCK_TTL_MS) {
  const token = crypto.randomUUID()
  const sql = `
    INSERT INTO deal_locks (deal_id, lock_token, owner_label, locked_at, expires_at)
    VALUES ($1, $2, $3, now(), now() + ($4 * INTERVAL '1 millisecond'))
    ON CONFLICT (deal_id) DO UPDATE
      SET lock_token  = EXCLUDED.lock_token,
          owner_label = EXCLUDED.owner_label,
          locked_at   = now(),
          expires_at  = EXCLUDED.expires_at
    WHERE deal_locks.expires_at < now()
    RETURNING lock_token`
  const params = [String(dealId), token, ownerLabel, Number(ttlMs)]
  try {
    const res = await pool.query(sql, params)
    return res.rows[0]?.lock_token ?? null
  } catch (err) {
    if (err?.code === '42P01') {        // la tabla aún no existe → crearla y reintentar
      await initDealLocksTable()
      const res = await pool.query(sql, params)
      return res.rows[0]?.lock_token ?? null
    }
    throw err
  }
}

/**
 * Libera el candado SOLO si todavía es nuestro (mismo token). Si nuestro TTL
 * venció y otro lo tomó, este DELETE no borra el candado ajeno.
 */
export async function releaseDealLock(dealId, token) {
  if (!token) return
  try {
    await pool.query(
      `DELETE FROM deal_locks WHERE deal_id = $1 AND lock_token = $2`,
      [String(dealId), token]
    )
  } catch (err) {
    logger.warn({ err: err?.message, dealId }, '[DB] releaseDealLock falló')
  }
}

// ─────────────────────────────────────────────────────────────
// Rate limiter global — balde de fichas (token bucket) compartido
// ─────────────────────────────────────────────────────────────
// Una sola fila (id=1) en hs_rate_bucket representa el presupuesto de llamadas
// a HubSpot compartido por TODOS los procesos (worker de webhooks + los crons).
// Cada proceso saca 1 ficha antes de llamar a HubSpot; como el balde es único,
// el ritmo COMBINADO respeta el límite sin importar cuántos procesos corran.
//
// Parámetros derivados de env (nada hardcodeado):
//   refill_per_sec = HS_RATE_LIMIT_PER_10S/10 * HS_RATE_SAFETY
//   capacity       = refill_per_sec * HS_RATE_BURST_FRAC   (mín 1)
// En sandbox conviene HS_RATE_LIMIT_PER_10S=190; default 100 es conservador.
// ─────────────────────────────────────────────────────────────
const HS_RATE_LIMIT_PER_10S = Number(process.env.HS_RATE_LIMIT_PER_10S || 100)
const HS_RATE_SAFETY        = Number(process.env.HS_RATE_SAFETY || 0.8)
const HS_RATE_BURST_FRAC    = Number(process.env.HS_RATE_BURST_FRAC || 0.2)

const RATE_REFILL_PER_SEC = (HS_RATE_LIMIT_PER_10S / 10) * HS_RATE_SAFETY
const RATE_CAPACITY       = Math.max(1, RATE_REFILL_PER_SEC * HS_RATE_BURST_FRAC)

export async function initRateBucketTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS hs_rate_bucket (
      id             INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      tokens         DOUBLE PRECISION NOT NULL,
      capacity       DOUBLE PRECISION NOT NULL,
      refill_per_sec DOUBLE PRECISION NOT NULL,
      last_refill    TIMESTAMPTZ NOT NULL DEFAULT now(),
      observed_max   INT
    )
  `)
  // Siembra la única fila. Si ya existe NO pisa tokens/last_refill (estado vivo),
  // solo refresca capacity/refill por si cambió algún env entre arranques.
  await pool.query(
    `INSERT INTO hs_rate_bucket (id, tokens, capacity, refill_per_sec)
     VALUES (1, $1, $1, $2)
     ON CONFLICT (id) DO UPDATE
       SET capacity = EXCLUDED.capacity,
           refill_per_sec = EXCLUDED.refill_per_sec`,
    [RATE_CAPACITY, RATE_REFILL_PER_SEC]
  )
  logger.info(
    { capacity: RATE_CAPACITY, refillPerSec: RATE_REFILL_PER_SEC, limitPer10s: HS_RATE_LIMIT_PER_10S },
    '[DB] Tabla hs_rate_bucket lista.'
  )
}

// SQL atómica (validada con dry-run). FOR UPDATE serializa entre procesos:
// (1) rellena según el tiempo transcurrido, (2) si hay ficha la resta,
// (3) siempre devuelve el estado para que el caller sepa cuánto esperar.
const RATE_ACQUIRE_SQL = `
  WITH cur AS (
    SELECT tokens, capacity, refill_per_sec, last_refill
    FROM hs_rate_bucket WHERE id = 1 FOR UPDATE
  ),
  calc AS (
    SELECT LEAST(capacity,
                 tokens + EXTRACT(EPOCH FROM (now() - last_refill)) * refill_per_sec) AS avail,
           refill_per_sec
    FROM cur
  ),
  upd AS (
    UPDATE hs_rate_bucket b
       SET tokens = (SELECT avail FROM calc) - 1,
           last_refill = now()
     WHERE b.id = 1 AND (SELECT avail FROM calc) >= 1
    RETURNING 1
  )
  SELECT (SELECT count(*) FROM upd) = 1     AS granted,
         (SELECT avail FROM calc)            AS avail,
         (SELECT refill_per_sec FROM calc)   AS refill_per_sec`

/**
 * Intenta sacar 1 ficha del balde global. NO espera: devuelve el resultado al
 * instante. El caller decide si reintentar (ver acquireToken en hubspotClient).
 * @returns {Promise<{granted:boolean, avail:number, refillPerSec:number}>}
 */
export async function acquireRateToken() {
  try {
    const res = await pool.query(RATE_ACQUIRE_SQL)
    const row = res.rows[0]
    return {
      granted: row.granted,
      avail: Number(row.avail),
      refillPerSec: Number(row.refill_per_sec),
    }
  } catch (err) {
    if (err?.code === '42P01') {        // la tabla aún no existe → crearla y reintentar
      await initRateBucketTable()
      const res = await pool.query(RATE_ACQUIRE_SQL)
      const row = res.rows[0]
      return {
        granted: row.granted,
        avail: Number(row.avail),
        refillPerSec: Number(row.refill_per_sec),
      }
    }
    throw err
  }
}

export default pool