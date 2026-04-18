// src/db.js
import pg from 'pg'
import logger from '../lib/logger.js'

const { Pool } = pg

// rejectUnauthorized: false es necesario para Railway (TLS interno con cert self-signed).
// Si migrás a una DB externa con cert válido, cambiar a rejectUnauthorized: true.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
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

export default pool