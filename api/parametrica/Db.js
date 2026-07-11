// api/parametrica/Db.js
//
// Tablas del ajuste de precio por paramétrica (/parametrica).
// parametrica_batches: una corrida (preview → applying → applied/partial/...).
// parametrica_items:   snapshot por line item con price_viejo/price_nuevo —
//                      la reversa restaura price_viejo tal cual (el % inverso
//                      no es reversible por el redondeo).
// Las columnas tipo_ajuste / scope / base_calculo quedan fijas en el MVP
// (masivo iJServ sobre monto actual) y soportan los ajustes selectivos futuros.
import pool from '../../src/db.js'
import logger from '../../lib/logger.js'

export async function initParametricaTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS parametrica_batches (
      id            SERIAL PRIMARY KEY,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      tipo_ajuste   TEXT NOT NULL DEFAULT 'masivo_porcentaje',
      scope         TEXT NOT NULL DEFAULT 'all',
      base_calculo  TEXT NOT NULL DEFAULT 'monto_actual',
      producto_id   TEXT NOT NULL,
      porcentaje    NUMERIC(9,4) NOT NULL,
      usuario       TEXT NOT NULL DEFAULT 'admin',
      estado        TEXT NOT NULL DEFAULT 'preview',
      dry_run       BOOLEAN NOT NULL DEFAULT FALSE,
      applied_at    TIMESTAMPTZ,
      reverted_at   TIMESTAMPTZ
    )
  `)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS parametrica_items (
      id            SERIAL PRIMARY KEY,
      batch_id      INTEGER NOT NULL REFERENCES parametrica_batches(id) ON DELETE CASCADE,
      line_item_id  TEXT NOT NULL,
      deal_id       TEXT,
      deal_name     TEXT,
      empresa       TEXT,
      area          TEXT,
      servicio      TEXT,
      moneda        TEXT,
      price_viejo   NUMERIC(14,2) NOT NULL,
      price_nuevo   NUMERIC(14,2) NOT NULL,
      estado        TEXT NOT NULL DEFAULT 'pending',
      error         TEXT,
      applied_at    TIMESTAMPTZ,
      reverted_at   TIMESTAMPTZ,
      UNIQUE (batch_id, line_item_id)
    )
  `)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_parametrica_items_li
      ON parametrica_items (line_item_id)
  `)
  logger.info({ module: 'parametrica/Db' }, 'Tablas parametrica_batches / parametrica_items listas.')
}

export default pool
