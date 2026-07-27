// api/invoice-editor/invoices.js
import { Router } from 'express'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import axios from 'axios'
import pool from './Db.js'
import logger from '../../lib/logger.js'
import { syncInvoiceToTicket, buildTicketPropsFromInvoice } from './syncInvoiceToTicket.js'
import { propagateInvoiceStateToTicket } from '../../src/propagacion/invoice.js'
import { tryAdvanceDealToEnEjecucion } from './advanceDealToEnEjecucion.js'
import { esTransicionEtapaPermitida, ETAPA_CANCELADA } from './stageTransitions.js'
import { acquireDealLock, releaseDealLock } from '../../src/db.js'
import { checkInvoiceRevertible, buildNodumBlockMessage } from '../../src/services/invoices/nodumGate.js'
import { cancelRevertFlowEnabled } from '../../src/config/cancelRevertFlags.js'

const MOD = 'invoice-editor/invoices'
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
    logger.error({ module: MOD, fn: 'writeAuditLog', err: err.message }, 'Error escribiendo audit log en DB')
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
  const fn = 'GET'

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
            logger.warn({ module: MOD, fn, invoiceId: id, lineItemId, err: liErr.message },
              'Error leyendo line item para unidad_de_negocio')
          }
        }

      } catch (fallbackErr) {
        logger.warn({ module: MOD, fn, invoiceId: id, err: fallbackErr.message },
          'Error en fallback desde ticket')
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
    logger.error({ module: MOD, fn, invoiceId: id, err: err.response?.data || err.message },
      'Error al leer factura')
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
  const fn = 'PATCH'

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
    logger.warn({ module: MOD, fn, invoiceId: id, rejectedFields },
      'Campos rechazados por whitelist')
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
    logger.info({ module: MOD, fn, invoiceId: id },
      'Auto-seteo etapa a Emitida por id_factura_nodum')
  }

  // Si se cancela y no viene fecha_de_cancelacion → inyectar fecha del día
  if (
    filteredProperties.etapa_de_la_factura === ETAPA_CANCELADA &&
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
      logger.warn({ module: MOD, fn, invoiceId: id, err: err.message },
        'No se pudo verificar fecha_de_cancelacion, inyectando fecha del día')
      const hoy = new Date()
      hoy.setUTCHours(0, 0, 0, 0)
      filteredProperties.fecha_de_cancelacion = String(hoy.getTime())
    }
  }

  // Guard de transición de etapa (hallazgo #4): Cancelada es terminal e
  // irreversible. Solo hace falta verificar cuando el body pide una etapa
  // distinta de Cancelada (X → Cancelada siempre está permitido hoy).
  const etapaSolicitada = filteredProperties.etapa_de_la_factura
  if (etapaSolicitada != null && etapaSolicitada !== ETAPA_CANCELADA) {
    let etapaActual
    try {
      const { data: invEtapa } = await hs().get(`/crm/v3/objects/invoices/${id}`, {
        params: { properties: 'etapa_de_la_factura' },
      })
      etapaActual = invEtapa.properties?.etapa_de_la_factura ?? null
    } catch (err) {
      if (err.response?.status === 404) {
        return res.status(404).json({ error: `No se encontró la factura con ID ${id}.` })
      }
      // Fail-closed: si no podemos verificar la etapa actual, no aplicamos un
      // cambio de etapa (podría estar reviviendo una Cancelada).
      logger.error({ module: MOD, fn, invoiceId: id, err: err.response?.data || err.message },
        'No se pudo leer la etapa actual para validar la transición')
      return res.status(500).json({
        error: 'No se pudo verificar la etapa actual de la factura. Reintentá en unos segundos.',
      })
    }

    if (etapaSolicitada !== etapaActual && !esTransicionEtapaPermitida(etapaActual, etapaSolicitada)) {
      logger.warn({ module: MOD, fn, invoiceId: id, etapaActual, etapaSolicitada },
        'Transición de etapa bloqueada (Cancelada es terminal)')
      writeAuditLog({
        timestamp: new Date().toISOString(),
        invoiceId: id,
        user: req.headers['x-app-user'] || 'admin',
        changes: {
          etapa_de_la_factura: {
            from: etapaActual,
            to: etapaSolicitada,
            rejected: true,
            reason: 'transicion_no_permitida_cancelada_terminal',
          },
        },
      })
      return res.status(409).json({
        error: 'La factura está Cancelada: es irreversible. Para facturar el período de nuevo usá la refacturación del ticket.',
      })
    }
  }

  try {
    // 1. Actualizar la factura en HubSpot
    await hs().patch(`/crm/v3/objects/invoices/${id}`, {
      properties: filteredProperties,
    })

    logger.info({ module: MOD, fn, invoiceId: id, fields: Object.keys(filteredProperties) },
      'Factura actualizada en HubSpot')

    // 2. Leer ticket_id si alguna operación post-save lo necesita
    const needsTicketId =
      Object.keys(buildTicketPropsFromInvoice(filteredProperties)).length > 0 ||
      !!(filteredProperties.id_factura_nodum)

    let ticketId = null

    if (needsTicketId) {
      try {
        const { data: invoiceData } = await hs().get(`/crm/v3/objects/invoices/${id}`, {
          params: { properties: 'ticket_id' },
        })
        ticketId = invoiceData.properties?.ticket_id
        logger.info({ module: MOD, fn, invoiceId: id, ticketId },
          'ticket_id resuelto desde factura')
      } catch (err) {
        logger.warn({ module: MOD, fn, invoiceId: id, err: err.message },
          'No se pudo leer ticket_id de la factura')
      }
    }

    // 3. Sync campos factura → ticket (id_factura_nodum, montos, etc.)
    if (Object.keys(buildTicketPropsFromInvoice(filteredProperties)).length > 0) {
      try {
        await syncInvoiceToTicket(ticketId, filteredProperties, id, hs)
      } catch (syncErr) {
        logger.error({ module: MOD, fn, invoiceId: id, ticketId, err: syncErr?.message },
          'Error en syncInvoiceToTicket')
      }
    }

    // 4. Propagar etapa al ticket si cambió etapa o se emitió primera factura Nodum
    const shouldPropagate =
      filteredProperties.etapa_de_la_factura ||
      (filteredProperties.id_factura_nodum && filteredProperties.id_factura_nodum !== null)

    if (shouldPropagate) {
      logger.info({ module: MOD, fn, invoiceId: id, etapa: filteredProperties.etapa_de_la_factura, hasNodum: !!filteredProperties.id_factura_nodum },
        'Iniciando propagación invoice→ticket')
      try {
        const propagateResult = await propagateInvoiceStateToTicket(id)
        logger.info({ module: MOD, fn, invoiceId: id, propagateResult },
          'Propagación invoice→ticket completada')
      } catch (propagateErr) {
        logger.error({ module: MOD, fn, invoiceId: id, err: propagateErr?.message },
          'Error en propagación invoice→ticket')
      }
    }

    // 5. Avanzar deal de Ganado → En Ejecución si se asoció primera factura Nodum
    // Fire-and-forget: no bloquea la respuesta al cliente
    if (filteredProperties.id_factura_nodum && filteredProperties.id_factura_nodum !== null) {
      logger.info({ module: MOD, fn, invoiceId: id, ticketId },
        'Iniciando tryAdvanceDealToEnEjecucion')
      tryAdvanceDealToEnEjecucion(ticketId).catch((err) => {
        logger.error({ module: MOD, fn, invoiceId: id, ticketId, err: err?.message },
          'tryAdvanceDealToEnEjecucion falló (fire-and-forget)')
      })
    }

    // 6. Audit log
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
    logger.error({ module: MOD, fn, invoiceId: id, err: err.response?.data || err.message },
      'Error al actualizar factura en HubSpot')
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
  const fn = 'cancelar'

  if (!id || !/^\d+$/.test(id)) {
    return res.status(400).json({ error: 'El Invoice ID debe ser un número.' })
  }

  // ── Flujo cancelar/revertir (llave CANCEL_REVERT_FLOW_ENABLED) ──
  // Body opcional: { motivo?, modo? } — modo ∈ {'cancelar','revertir'}.
  //   'revertir' (default) = semántica ACTUAL: el ticket vuelve a un stage
  //                          facturable, listo para refacturación.
  //   'cancelar'           = definitivo: ticket a etapa CANCELADO, período cerrado.
  // Con la llave APAGADA el modo se ignora (log) y el endpoint entero se
  // comporta exactamente como hoy (sin gate Nodum, sin lock, sin intent).
  const flowEnabled = cancelRevertFlowEnabled()
  const { motivo, modo } = req.body || {}
  let modoEfectivo = 'revertir'
  if (flowEnabled) {
    if (modo === 'cancelar' || modo === 'revertir') {
      modoEfectivo = modo
    } else if (modo != null) {
      return res.status(400).json({ error: "El campo 'modo' debe ser 'cancelar' o 'revertir'." })
    }
  } else if (modo != null) {
    logger.info({ module: MOD, fn, invoiceId: id, modo },
      'CANCEL_REVERT_FLOW_ENABLED off — modo ignorado, se aplica la semántica actual (revertir)')
  }

  let lockDealId = null
  let lockToken = null

  try {
    const { data: invoice } = await hs().get(`/crm/v3/objects/invoices/${id}`, {
      params: { properties: 'etapa_de_la_factura,ticket_id,fecha_de_cancelacion' },
    })

    const etapaActual  = invoice.properties?.etapa_de_la_factura
    const ticketId     = invoice.properties?.ticket_id
    const fechaExiste  = invoice.properties?.fecha_de_cancelacion

    // Coherente con stageTransitions: Cancelada es terminal; cancelar dos veces
    // no tiene sentido (y X → Cancelada siempre está permitido por la matriz).
    if (etapaActual === ETAPA_CANCELADA) {
      return res.status(400).json({ error: 'La factura ya está cancelada.' })
    }

    if (flowEnabled) {
      // ── Gate Nodum, ANTES de tocar la factura: una factura ya asentada en
      // Nodum no se cancela/revierte desde acá — corresponde nota de crédito.
      // Fail-closed: si la verificación falla, también se bloquea.
      const gate = await checkInvoiceRevertible(id)
      if (!gate.revertible) {
        const reason = gate.error ? 'nodum_gate_error' : 'nodum_asentada'
        logger.warn({ module: MOD, fn, invoiceId: id, nodumId: gate.nodumId, reason },
          'Cancelación bloqueada por gate Nodum')
        writeAuditLog({
          timestamp: new Date().toISOString(),
          invoiceId: id,
          user,
          changes: {
            etapa_de_la_factura: {
              from: etapaActual,
              to: ETAPA_CANCELADA,
              rejected: true,
              reason,
              modo: modoEfectivo,
              ...(gate.nodumId && { nodumId: gate.nodumId }),
            },
          },
        })
        return res.status(409).json({
          error: gate.error
            ? 'No se pudo verificar si la factura está asentada en Nodum. Reintentá en unos segundos.'
            : buildNodumBlockMessage(gate.nodumId),
        })
      }

      // ── Lock de deal: no pisarse con el motor (cron/fases). Derivación:
      // invoice.ticket_id → ticket.of_deal_id. Si no se puede derivar el deal,
      // se sigue SIN lock (warn) — no se bloquea la operación por eso.
      if (ticketId) {
        try {
          const { data: ticketData } = await hs().get(`/crm/v3/objects/tickets/${ticketId}`, {
            params: { properties: 'of_deal_id' },
          })
          lockDealId = (ticketData.properties?.of_deal_id || '').trim() || null
        } catch (ticketErr) {
          logger.warn({ module: MOD, fn, invoiceId: id, ticketId, err: ticketErr.message },
            'No se pudo leer of_deal_id del ticket para el lock (se sigue sin lock)')
        }
      }
      if (lockDealId) {
        lockToken = await acquireDealLock(lockDealId, 'invoice-editor-cancel')
        if (!lockToken) {
          logger.warn({ module: MOD, fn, invoiceId: id, dealId: lockDealId },
            'Deal lockeado por otro proceso: cancelación rechazada (423)')
          return res.status(423).json({ error: 'El motor está procesando este negocio. Reintentá en un minuto.' })
        }
      } else {
        logger.warn({ module: MOD, fn, invoiceId: id, ticketId },
          'No se pudo derivar dealId: la cancelación sigue SIN lock de deal')
      }
    }

    const propsToUpdate = { etapa_de_la_factura: ETAPA_CANCELADA }
    if (!fechaExiste) {
      const hoy = new Date()
      hoy.setUTCHours(0, 0, 0, 0)
      propsToUpdate.fecha_de_cancelacion = String(hoy.getTime())
    }

    await hs().patch(`/crm/v3/objects/invoices/${id}`, { properties: propsToUpdate })

    logger.info({ module: MOD, fn, invoiceId: id, ticketId, etapaAnterior: etapaActual, ...(flowEnabled && { modo: modoEfectivo }) },
      'Factura cancelada, propagando al ticket')

    try {
      if (flowEnabled) {
        await propagateInvoiceStateToTicket(id, {
          cancelIntent: modoEfectivo === 'cancelar' ? 'cancel' : 'revert',
        })
      } else {
        await propagateInvoiceStateToTicket(id)
      }
    } catch (propagateErr) {
      logger.error({ module: MOD, fn, invoiceId: id, err: propagateErr?.message },
        'Error en propagación invoice→ticket (cancelación)')
    }

    writeAuditLog({
      timestamp: new Date().toISOString(),
      invoiceId: id,
      user,
      changes: {
        etapa_de_la_factura: { from: etapaActual, to: 'Cancelada' },
        ...(flowEnabled && { modo: modoEfectivo }),
        ...(flowEnabled && motivo && { motivo }),
        ...(ticketId && { ticketActualizado: ticketId }),
      },
    })

    return res.json({
      success: true,
      invoiceId: id,
      ticketId: ticketId || null,
      etapaAnterior: etapaActual,
      ...(flowEnabled && { modo: modoEfectivo }),
    })

  } catch (err) {
    if (err.response?.status === 404) {
      return res.status(404).json({ error: `No se encontró la factura con ID ${id}.` })
    }
    logger.error({ module: MOD, fn, invoiceId: id, err: err.response?.data || err.message },
      'Error al cancelar factura')
    return res.status(500).json({
      error: 'Error al cancelar la factura.',
      detail: err.response?.data?.message || err.message,
    })
  } finally {
    // El lock se suelta SIEMPRE (releaseDealLock solo borra si el token es nuestro).
    if (lockToken) {
      await releaseDealLock(lockDealId, lockToken)
    }
  }
})

export default router