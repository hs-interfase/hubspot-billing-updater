// api/invoice-editor/invoices.js
import { Router } from 'express'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import axios from 'axios'
import pool from './Db.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const router = Router()

// ── HubSpot HTTP client ──
function hs() {
  return axios.create({
    baseURL: 'https://api.hubapi.com',
    headers: { Authorization: `Bearer ${process.env.HUBSPOT_PRIVATE_TOKEN}` },
    timeout: 10000,
  })
}

// Cargar config de campos
const configPath = path.join(__dirname, 'invoiceFields.config.json')
const fieldsConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'))

const ALL_FIELD_NAMES      = fieldsConfig.map(f => f.internalName)
const WRITABLE_FIELD_NAMES = fieldsConfig.filter(f => !f.readOnly).map(f => f.internalName)

// ── Audit logger ──
async function writeAuditLog(entry) {
  try {
    await pool.query(
      `INSERT INTO invoice_audit_logs (timestamp, invoice_id, "user", changes)
       VALUES ($1, $2, $3, $4)`,
      [entry.timestamp, entry.invoiceId, entry.user, JSON.stringify(entry.changes)]
    )
  } catch (err) {
    console.error('[InvoiceEditor][Audit] Error escribiendo log en DB:', err.message)
  }
}

// ── Helper: propagar etapa al ticket asociado ──
async function syncTicketInvoiceStatus(ticketId, etapa, invoiceId) {
  console.log('[InvoiceEditor] syncTicketInvoiceStatus called', { invoiceId, ticketId, etapa })

  if (!ticketId) {
    console.warn('[InvoiceEditor] syncTicketInvoiceStatus: ticketId vacío, skip')
    return
  }

  // ✅ propiedad correcta, sin borrar of_invoice_id/of_invoice_key
  const props = { of_invoice_status: etapa }

  try {
    await hs().patch(`/crm/v3/objects/tickets/${ticketId}`, { properties: props })
    console.info(`[InvoiceEditor] Ticket ${ticketId} actualizado → of_invoice_status=${etapa}`)
  } catch (err) {
    console.error(
      `[InvoiceEditor] Error actualizando ticket ${ticketId} desde invoice ${invoiceId}:`,
      err.response?.data || err.message
    )
  }
}

// ─────────────────────────────────────────────
// GET /invoice-editor/api/config
// ─────────────────────────────────────────────
router.get('/config', (req, res) => {
  res.json(fieldsConfig)
})

// ─────────────────────────────────────────────
// GET /invoice-editor/api/:id
// ─────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  const { id } = req.params

  if (!id || !/^\d+$/.test(id)) {
    return res.status(400).json({ error: 'El Invoice ID debe ser un número.' })
  }

  try {
    const { data } = await hs().get(`/crm/v3/objects/invoices/${id}`, {
      params: { properties: ALL_FIELD_NAMES.join(',') },
    })

    return res.json({
      id: data.id,
      updatedAt: data.updatedAt,
      properties: data.properties,
    })

  } catch (err) {
    if (err.response?.status === 404) {
      return res.status(404).json({ error: `No se encontró la factura con ID ${id}.` })
    }
    console.error('[InvoiceEditor][GET]', err.response?.data || err.message)
    return res.status(500).json({
      error: 'Error al comunicarse con HubSpot.',
      detail: err.response?.data?.message || err.message,
    })
  }
})

// ─────────────────────────────────────────────
// PATCH /invoice-editor/api/:id
// ─────────────────────────────────────────────
router.patch('/:id', async (req, res) => {
  const { id } = req.params
  const { properties, changes } = req.body

  if (!id || !/^\d+$/.test(id)) {
    return res.status(400).json({ error: 'El Invoice ID debe ser un número.' })
  }

  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) {
    return res.status(400).json({ error: 'Se requiere un objeto "properties" en el body.' })
  }

  // Filtrar por whitelist
  const filteredProperties = {}
  const rejectedFields = []

  for (const [key, value] of Object.entries(properties)) {
    if (WRITABLE_FIELD_NAMES.includes(key)) {
      filteredProperties[key] = value === '' ? null : value
    } else {
      rejectedFields.push(key)
    }
  }

  if (rejectedFields.length > 0) {
    console.warn(`[InvoiceEditor][PATCH] Campos rechazados: ${rejectedFields.join(', ')}`)
  }

  if (Object.keys(filteredProperties).length === 0) {
    return res.status(400).json({ error: 'No hay campos válidos para actualizar.' })
  }

  try {
    await hs().patch(`/crm/v3/objects/invoices/${id}`, {
      properties: filteredProperties,
    })

    // Propagar etapa al ticket si cambió
    if (filteredProperties.etapa_de_la_factura) {
      const { data: invoiceData } = await hs().get(`/crm/v3/objects/invoices/${id}`, {
        params: { properties: 'ticket_id' },
      })
      const ticketId = invoiceData.properties?.ticket_id
      await syncTicketInvoiceStatus(ticketId, filteredProperties.etapa_de_la_factura, id)
    }

    writeAuditLog({
      timestamp: new Date().toISOString(),
      invoiceId: id,
      user: req.headers['x-app-user'] || 'admin',
      changes: changes || filteredProperties,
      ...(rejectedFields.length > 0 && { rejectedFields }),
    })

    return res.json({
      success: true,
      invoiceId: id,
      updated: filteredProperties,
      ...(rejectedFields.length > 0 && { rejected: rejectedFields }),
    })

  } catch (err) {
    if (err.response?.status === 404) {
      return res.status(404).json({ error: `No se encontró la factura con ID ${id}.` })
    }
    console.error('[InvoiceEditor][PATCH]', err.response?.data || err.message)
    return res.status(500).json({
      error: 'Error al actualizar la factura en HubSpot.',
      detail: err.response?.data?.message || err.message,
    })
  }
})

// ─────────────────────────────────────────────
// POST /invoice-editor/api/:id/cancelar
// ─────────────────────────────────────────────
router.post('/:id/cancelar', async (req, res) => {
  const { id } = req.params
  const user = req.headers['x-app-user'] || 'admin'

  if (!id || !/^\d+$/.test(id)) {
    return res.status(400).json({ error: 'El Invoice ID debe ser un número.' })
  }

  try {
    // 1) Leer invoice para obtener ticket_id y etapa actual
    const { data: invoice } = await hs().get(`/crm/v3/objects/invoices/${id}`, {
      params: { properties: 'etapa_de_la_factura,ticket_id' },
    })

    const etapaActual = invoice.properties?.etapa_de_la_factura
    const ticketId    = invoice.properties?.ticket_id

    console.log('[InvoiceEditor][CANCELAR] invoice leída', { id, etapaActual, ticketId })

    if (etapaActual === 'Cancelada') {
      return res.status(400).json({ error: 'La factura ya está cancelada.' })
    }

    // 2) Actualizar invoice en HubSpot
    await hs().patch(`/crm/v3/objects/invoices/${id}`, {
      properties: { etapa_de_la_factura: 'Cancelada' },
    })

    // 3) Propagar al ticket
    await syncTicketInvoiceStatus(ticketId, 'Cancelada', id)

    // 4) Audit log
    writeAuditLog({
      timestamp: new Date().toISOString(),
      invoiceId: id,
      user,
      changes: {
        etapa_de_la_factura: { from: etapaActual, to: 'Cancelada' },
        ...(ticketId && { ticketActualizado: ticketId }),
      },
    })

    return res.json({
      success: true,
      invoiceId: id,
      ticketId: ticketId || null,
      etapaAnterior: etapaActual,
    })

  } catch (err) {
    if (err.response?.status === 404) {
      return res.status(404).json({ error: `No se encontró la factura con ID ${id}.` })
    }
    console.error('[InvoiceEditor][CANCELAR]', err.response?.data || err.message)
    return res.status(500).json({
      error: 'Error al cancelar la factura.',
      detail: err.response?.data?.message || err.message,
    })
  }
})

export default router