// api/invoice-editor/db.js
import pg from 'pg'

const { Pool } = pg

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Railway requiere SSL
})

// Crea la tabla si no existe al iniciar
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
  console.log('[InvoiceEditor][DB] Tabla invoice_audit_logs lista.')
}

export default pool