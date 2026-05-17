// api/invoice-editor/Db.js
import pool from '../../src/db.js'
import logger from '../../lib/logger.js'
 
export async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS invoice_audit_logs (
      id          SERIAL PRIMARY KEY,
      timestamp   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      invoice_id  TEXT        NOT NULL,
      "user"      TEXT        NOT NULL DEFAULT 'admin',
      changes     JSONB       NOT NULL
    )
  `)
  logger.info({ module: 'invoice-editor/Db' }, 'Tabla invoice_audit_logs lista.')
}
 
export default pool
 