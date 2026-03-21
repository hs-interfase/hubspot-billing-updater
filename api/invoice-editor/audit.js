// api/invoice-editor/audit.js
import { Router } from 'express'
import pool from './Db.js'

const router = Router()

// ─────────────────────────────────────────────
// GET /invoice-editor/api/audit
// Query params:
//   page      (default 1)
//   limit     (default 20, max 100)
//   invoiceId
//   dateFrom  (ISO date, ej: 2026-01-01)
//   dateTo    (ISO date, ej: 2026-02-28)
// ─────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { invoiceId, dateFrom, dateTo } = req.query
    const limit   = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 100)
    const page    = Math.max(parseInt(req.query.page) || 1, 1)
    const offset  = (page - 1) * limit

    // ── Construir WHERE dinámico ──
    const conditions = []
    const params     = []

    if (invoiceId) {
      params.push(invoiceId.trim())
      conditions.push(`invoice_id = $${params.length}`)
    }

    if (dateFrom) {
      params.push(new Date(dateFrom + 'T00:00:00.000Z'))
      conditions.push(`timestamp >= $${params.length}`)
    }

    if (dateTo) {
      params.push(new Date(dateTo + 'T23:59:59.999Z'))
      conditions.push(`timestamp <= $${params.length}`)
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

    // ── Total ──
    const countResult = await pool.query(
      `SELECT COUNT(*) FROM invoice_audit_logs ${where}`,
      params
    )
    const total = parseInt(countResult.rows[0].count)
    const pages = Math.ceil(total / limit) || 1
    const safePage = Math.min(page, pages)
    const safeOffset = (safePage - 1) * limit

    // ── Datos paginados ──
    const dataResult = await pool.query(
      `SELECT
         id,
         timestamp,
         invoice_id  AS "invoiceId",
         "user",
         changes
       FROM invoice_audit_logs
       ${where}
       ORDER BY timestamp DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, safeOffset]
    )

    res.json({
      total,
      page:  safePage,
      limit,
      pages,
      data: dataResult.rows,
    })

  } catch (err) {
    console.error('[InvoiceEditor][Audit] Error leyendo logs de DB:', err.message)
    res.status(500).json({ error: 'Error al leer el historial de auditoría.' })
  }
})

export default router