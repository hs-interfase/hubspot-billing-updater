// src/db-export.js
//
// Tabla export_snapshots — almacena el último xlsx + los 6 CSV generados
// por cronExportReporte. Una sola fila (id=1) que se sobreescribe cada día.

import pool from './db.js';
import logger from '../lib/logger.js';

export async function initExportSnapshotsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS export_snapshots (
      id           INT          PRIMARY KEY DEFAULT 1,
      filename     TEXT         NOT NULL,
      xlsx_data    BYTEA        NOT NULL,
      row_counts   JSONB        NOT NULL DEFAULT '{}',
      generated_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      CONSTRAINT single_row CHECK (id = 1)
    )
  `);
  // NUEVO: columna para los 6 CSV (una clave por hoja). Idempotente:
  // aplica solo si la tabla ya existía sin la columna.
  await pool.query(`
    ALTER TABLE export_snapshots
      ADD COLUMN IF NOT EXISTS csv_data JSONB NOT NULL DEFAULT '{}'
  `);
  logger.info('[DB] Tabla export_snapshots lista.');
}

/**
 * Guarda (o sobreescribe) el snapshot del reporte.
 *
 * @param {Object} params
 * @param {string} params.filename   - Ej: "reporte_consolidado_2026-04-30.xlsx"
 * @param {Buffer} params.xlsxBuffer - Buffer del archivo xlsx
 * @param {Object} params.rowCounts  - { pipeline, forecast, listo, facturado, ... }
 * @param {Object} [params.csvData]  - { forecast_debil, forecast_strech, ... } strings CSV
 */
export async function saveExportSnapshot({ filename, xlsxBuffer, rowCounts, csvData = {} }) {
  await pool.query(
    `INSERT INTO export_snapshots (id, filename, xlsx_data, row_counts, csv_data, generated_at)
     VALUES (1, $1, $2, $3, $4, NOW())
     ON CONFLICT (id) DO UPDATE
       SET filename     = EXCLUDED.filename,
           xlsx_data    = EXCLUDED.xlsx_data,
           row_counts   = EXCLUDED.row_counts,
           csv_data     = EXCLUDED.csv_data,
           generated_at = NOW()`,
    [filename, xlsxBuffer, JSON.stringify(rowCounts), JSON.stringify(csvData)]
  );
  logger.info({ filename, rowCounts }, '[export] Snapshot guardado en DB');
}

/**
 * Lee el último snapshot guardado.
 *
 * @returns {Promise<{ filename: string, xlsxData: Buffer, rowCounts: object, csvData: object, generatedAt: Date } | null>}
 */
export async function getLatestExportSnapshot() {
  const res = await pool.query(
    `SELECT filename, xlsx_data, row_counts, csv_data, generated_at FROM export_snapshots WHERE id = 1`
  );
  if (!res.rows[0]) return null;
  const r = res.rows[0];
  return {
    filename: r.filename,
    xlsxData: r.xlsx_data,
    rowCounts: r.row_counts,
    csvData: r.csv_data,   // NUEVO
    generatedAt: r.generated_at,
  };
}