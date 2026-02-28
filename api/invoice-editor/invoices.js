// api/invoice-editor/invoices.js
import { Router } from 'express'
import { createReadStream } from 'fs'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { hubspotClient } from '../../src/hubspotClient.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const router = Router()

// Cargar config de campos
const configPath = path.join(__dirname, 'invoiceFields.config.json')
const fieldsConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'))

const ALL_FIELD_NAMES    = fieldsConfig.map(f => f.internalName)
const WRITABLE_FIELD_NAMES = fieldsConfig.filter(f => !f.readOnly).map(f => f.internalName)

// ── Audit logger (reutiliza la carpeta logs/ del proyecto) ──
const LOGS_DIR = path.join(__dirname, '../../logs')
function writeAuditLog(entry) {
  try {
    const logFile = path.join(LOGS_DIR, 'invoice-editor-audit.json')
    let logs = []
    if (fs.existsSync(logFile)) {
      try { logs = JSON.parse(fs.readFileSync(logFile, 'utf-8')) } catch { logs = [] }
    }
    logs.unshift(entry)
    if (logs.length > 1000) logs = logs.slice(0, 1000)
    fs.writeFileSync(logFile, JSON.stringify(logs, null, 2), 'utf-8')
  } catch (err) {
    console.error('[InvoiceEditor][Audit] Error escribiendo log:', err.message)
  }
}

// ─────────────────────────────────────────────
// GET /invoice-editor/api/config
// Devuelve la config de campos al frontend
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
    // Usamos el SDK de HubSpot que ya tiene el proyecto
    const response = await hubspotClient.apiRequest({
      method: 'GET',
      path: `/crm/v3/objects/invoices/${id}`,
      qs: { properties: ALL_FIELD_NAMES.join(',') },
    })

    const data = await response.json()

    if (response.status === 404) {
      return res.status(404).json({ error: `No se encontró la factura con ID ${id}.` })
    }

    return res.json({
      id: data.id,
      updatedAt: data.updatedAt,
      properties: data.properties,
    })

  } catch (err) {
    const status = err.statusCode || err.response?.status
    if (status === 404) {
      return res.status(404).json({ error: `No se encontró la factura con ID ${id}.` })
    }
    console.error('[InvoiceEditor][GET]', err.message)
    return res.status(500).json({
      error: 'Error al comunicarse con HubSpot.',
      detail: err.message,
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
    const response = await hubspotClient.apiRequest({
      method: 'PATCH',
      path: `/crm/v3/objects/invoices/${id}`,
      body: { properties: filteredProperties },
    })

    if (response.status === 404) {
      return res.status(404).json({ error: `No se encontró la factura con ID ${id}.` })
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
    const status = err.statusCode || err.response?.status
    if (status === 404) {
      return res.status(404).json({ error: `No se encontró la factura con ID ${id}.` })
    }
    console.error('[InvoiceEditor][PATCH]', err.message)
    return res.status(500).json({
      error: 'Error al actualizar la factura en HubSpot.',
      detail: err.message,
    })
  }
})

export default router
