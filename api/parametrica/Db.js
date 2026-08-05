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
  // Columnas del snapshot ampliado (selección por fila, 4-ago-2026): quedan en
  // el item para que el CSV del historial muestre lo mismo que la pantalla,
  // aunque después cambien en HubSpot. ADD COLUMN IF NOT EXISTS = idempotente.
  for (const col of [
    'entidad_facturadora TEXT',
    'cliente_factura     TEXT',
    'codigo_empresa      TEXT',
    'numero_contrato     TEXT',
    'descripcion         TEXT',
    'rubro               TEXT',
    'producto            TEXT',
    'cantidad            NUMERIC(14,4)',
    // Ajuste retroactivo de pago único (4-ago-2026): qué se calculó por fila y
    // qué line item se creó, para poder deshacerlo en la reversa.
    'periodos_retro      INTEGER',
    'importe_retro       NUMERIC(14,2)',
    'precio_retro        NUMERIC(14,2)',
    'fecha_retro         TEXT',
    'li_retro_id         TEXT',
    'retro_estado        TEXT',
    'retro_error         TEXT',
    // Facturas que ya salieron con el precio ajustado, contadas AL REVERTIR:
    // revertir el precio no deshace una factura emitida, eso va por nota de
    // crédito. Alimenta el listado de reversas con facturas emitidas.
    'facturas_post_ajuste INTEGER',
  ]) {
    await pool.query(`ALTER TABLE parametrica_items ADD COLUMN IF NOT EXISTS ${col}`)
  }

  for (const col of [
    // Mes del ajuste (YYYY-MM). Vacío = rige desde hoy y no hay retroactivo,
    // que es el comportamiento histórico.
    'mes_ajuste     TEXT',
    // Respaldo del cálculo: de dónde salió el porcentaje. El motor no calcula
    // la fórmula (Pn = Po(0,86×IPC + 0,14×dólar)); se ingresa el % ya resuelto,
    // así que esto es el papel de trabajo ante el cliente o una auditoría.
    'fuente_indice  TEXT',
    'valores_indice TEXT',
    'periodo_indice TEXT',
    'nota           TEXT',
  ]) {
    await pool.query(`ALTER TABLE parametrica_batches ADD COLUMN IF NOT EXISTS ${col}`)
  }

  // Selecciones guardadas: el "prearmado" de line items, para no perder una
  // lista de 40 contratos si se recarga la pantalla o se retoma otro día.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS parametrica_selecciones (
      id            SERIAL PRIMARY KEY,
      nombre        TEXT NOT NULL,
      usuario       TEXT NOT NULL DEFAULT 'admin',
      line_item_ids TEXT[] NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (nombre)
    )
  `)

  logger.info({ module: 'parametrica/Db' }, 'Tablas parametrica_batches / parametrica_items listas.')
}

export default pool
