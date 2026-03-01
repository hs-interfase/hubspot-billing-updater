// api/invoice-editor/audit.js
import { Router } from 'express'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const router = Router()

const LOG_FILE = path.join(__dirname, '../../logs/invoice-editor-audit.json')

// ─────────────────────────────────────────────
// GET /invoice-editor/api/audit
// Query params:
//   page     (default 1)
//   limit    (default 20, max 100)
//   invoiceId
//   dateFrom (ISO date, ej: 2026-01-01)
//   dateTo   (ISO date, ej: 2026-02-28)
// ─────────────────────────────────────────────
router.get('/', (req, res) => {
  let logs = []

  try {
    if (fs.existsSync(LOG_FILE)) {
      logs = JSON.parse(fs.readFileSync(LOG_FILE, 'utf-8'))
    }
  } catch {
    return res.status(500).json({ error: 'Error al leer el archivo de auditoría.' })
  }

  // ── Filtros ──
  const { invoiceId, dateFrom, dateTo } = req.query

  if (invoiceId) {
    logs = logs.filter(e => e.invoiceId === invoiceId.trim())
  }

  if (dateFrom) {
    const from = new Date(dateFrom)
    from.setUTCHours(0, 0, 0, 0)
    logs = logs.filter(e => new Date(e.timestamp) >= from)
  }

  if (dateTo) {
    const to = new Date(dateTo)
    to.setUTCHours(23, 59, 59, 999)
    logs = logs.filter(e => new Date(e.timestamp) <= to)
  }

  // ── Paginación ──
  const total = logs.length
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 100)
  const page  = Math.max(parseInt(req.query.page) || 1, 1)
  const pages = Math.ceil(total / limit) || 1
  const safePage = Math.min(page, pages)
  const start = (safePage - 1) * limit
  const data  = logs.slice(start, start + limit)

  res.json({ total, page: safePage, limit, pages, data })
})

export default router