// api/invoice-editor/invoices.js
import { Router } from 'express'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import axios from 'axios'
import pool from './Db.js'
import { syncInvoiceToTicket, buildTicketPropsFromInvoice } from './syncInvoiceToTicket.js'
import { propagateInvoiceStateToTicket } from '../../src/propagacion/invoice.js'

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
    // Incluir hs_due_date además de los campos del config
    const propsToFetch = [...new Set([...ALL_FIELD_NAMES, 'hs_due_date'])].join(',')

    const { data } = await hs().get(`/crm/v3/objects/invoices/${id}`, {
      params: { properties: propsToFetch },
    })

    const properties = { ...data.properties }
    const ticketId = properties.ticket_id

    // Fallback al ticket si campos clave están vacíos
    const FALLBACK_FIELDS = ['pais_operativo', 'iva', 'exonera_irae', 'unidad_de_negocio', 'monto_a_facturar']
    const needsFallback = ticketId && FALLBACK_FIELDS.some(f => !properties[f])

    if (needsFallback) {
      try {
        const { data: ticketData } = await hs().get(`/crm/v3/objects/tickets/${ticketId}`, {
          params: { properties: 'of_pais_operativo,of_iva,of_exonera_irae,total_real_a_facturar,of_line_item_ids' },
        })
        const tp = ticketData.properties || {}
      
        if (!properties.pais_operativo && tp.of_pais_operativo)
          properties.pais_operativo = tp.of_pais_operativo
      
        if (!properties.iva && tp.of_iva != null)
          properties.iva = (tp.of_iva === 'true' || tp.of_iva === true) ? 'true' : 'false'
      
        if (!properties.exonera_irae && tp.of_exonera_irae != null)
          properties.exonera_irae = (tp.of_exonera_irae === 'true' || tp.of_exonera_irae === true) ? 'Si' : 'No'
      
        if (!properties.monto_a_facturar && tp.total_real_a_facturar)
          properties.monto_a_facturar = tp.total_real_a_facturar
      
        // unidad_de_negocio viene del line item, no del ticket
        if (!properties.unidad_de_negocio && tp.of_line_item_ids) {
          const lineItemId = tp.of_line_item_ids.split(',')[0].trim()
          try {
            const { data: liData } = await hs().get(`/crm/v3/objects/line_items/${lineItemId}`, {
              params: { properties: 'unidad_de_negocio' },
            })
            if (liData.properties?.unidad_de_negocio)
              properties.unidad_de_negocio = liData.properties.unidad_de_negocio
          } catch (liErr) {
            console.warn('[InvoiceEditor][GET] Error leyendo line item para unidad_de_negocio:', liErr.message)
          }
        }
      
      } catch (fallbackErr) {
        console.warn('[InvoiceEditor][GET] Error en fallback desde ticket:', fallbackErr.message)
      }
    }

    return res.json({
      id: data.id,
      updatedAt: data.updatedAt,
      properties,
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

  // Si se setea id_factura_nodum y no viene etapa explícita → auto Emitida
  if (
    filteredProperties.id_factura_nodum &&
    filteredProperties.id_factura_nodum !== null &&
    !filteredProperties.etapa_de_la_factura
  ) {
    filteredProperties.etapa_de_la_factura = 'Emitida'
  }

  // Si se cancela y no viene fecha_de_cancelacion → inyectar fecha del día
  if (
    filteredProperties.etapa_de_la_factura === 'Cancelada' &&
    !filteredProperties.fecha_de_cancelacion
  ) {
    try {
      const { data: invoiceActual } = await hs().get(`/crm/v3/objects/invoices/${id}`, {
        params: { properties: 'fecha_de_cancelacion' },
      })
      if (!invoiceActual.properties?.fecha_de_cancelacion) {
        const hoy = new Date()
        hoy.setUTCHours(0, 0, 0, 0)
        filteredProperties.fecha_de_cancelacion = String(hoy.getTime())
      }
    } catch (err) {
      console.warn('[InvoiceEditor][PATCH] No se pudo verificar fecha_de_cancelacion:', err.message)
      const hoy = new Date()
      hoy.setUTCHours(0, 0, 0, 0)
      filteredProperties.fecha_de_cancelacion = String(hoy.getTime())
    }
  }

  try {
    await hs().patch(`/crm/v3/objects/invoices/${id}`, {
      properties: filteredProperties,
    })

    // Sync campos factura → ticket (si hay algo mapeable)
    const hasMappableFields = Object.keys(buildTicketPropsFromInvoice(filteredProperties)).length > 0
    if (hasMappableFields) {
      try {
        const { data: invoiceData } = await hs().get(`/crm/v3/objects/invoices/${id}`, {
          params: { properties: 'ticket_id' },
        })
        const ticketId = invoiceData.properties?.ticket_id
        await syncInvoiceToTicket(ticketId, filteredProperties, id, hs)
      } catch (syncErr) {
        console.error('[InvoiceEditor][PATCH] Error en syncInvoiceToTicket:', syncErr?.message)
      }
    }

    const shouldPropagate =
      filteredProperties.etapa_de_la_factura ||
      (filteredProperties.id_factura_nodum && filteredProperties.id_factura_nodum !== null)

    if (shouldPropagate) {
      try {
        await propagateInvoiceStateToTicket(id)
      } catch (propagateErr) {
        console.error('[InvoiceEditor][PATCH] Error en propagación invoice→ticket:', propagateErr?.message)
      }
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
    const { data: invoice } = await hs().get(`/crm/v3/objects/invoices/${id}`, {
      params: { properties: 'etapa_de_la_factura,ticket_id,fecha_de_cancelacion' },
    })

    const etapaActual  = invoice.properties?.etapa_de_la_factura
    const ticketId     = invoice.properties?.ticket_id
    const fechaExiste  = invoice.properties?.fecha_de_cancelacion

    if (etapaActual === 'Cancelada') {
      return res.status(400).json({ error: 'La factura ya está cancelada.' })
    }

    const propsToUpdate = { etapa_de_la_factura: 'Cancelada' }
    if (!fechaExiste) {
      const hoy = new Date()
      hoy.setUTCHours(0, 0, 0, 0)
      propsToUpdate.fecha_de_cancelacion = String(hoy.getTime())
    }

    await hs().patch(`/crm/v3/objects/invoices/${id}`, { properties: propsToUpdate })

    try {
      await propagateInvoiceStateToTicket(id)
    } catch (propagateErr) {
      console.error('[InvoiceEditor][CANCELAR] Error en propagación invoice→ticket:', propagateErr?.message)
    }

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