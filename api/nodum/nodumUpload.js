// api/nodum/nodumUpload.js
//
// POST /nodum/upload
// Recibe un archivo .xlsx de facturas Nodum, busca el ticket correspondiente
// en HubSpot por empresa + monto + moneda + fecha aproximada, y registra
// numero_de_factura, fecha_real_de_facturacion, fecha_vencimiento_factura y dolar.
//
// Estrategia de resolución de empresa (en orden de prioridad):
//   1. NroCliente del xlsx → buscar Company por codigo_cliente_comercial → companyHsId
//   2. Si no → RazonSocial → buscar Company por name → companyHsId
//   Con el companyHsId → traer tickets asociados filtrados por PROMOTED_STAGES + moneda
//   Sobre esos tickets → matching por monto (±0.01) y fecha (±MAX_DATE_DELTA días)

import { Router } from 'express'
import multer from 'multer'
import * as XLSX from 'xlsx'
import pool from '../../src/db.js'
import { hubspotClient } from '../../src/hubspotClient.js'
import logger from '../../lib/logger.js'
import { PROMOTED_STAGES } from '../../src/config/constants.js'

const router = Router()
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } })

// ── Constantes ────────────────────────────────────────────────────────────────

const MAX_DATE_DELTA = 5

const MONEDA_MAP = {
  1: 'UYU',
  2: 'USD',
}

const TICKET_PROPS = [
  'hs_object_id',
  'subject',
  'of_deal_id',
  'of_moneda',
  'total_real_a_facturar',
  'of_fecha_de_facturacion',
  'numero_de_factura',
  'of_estado',
  'hs_pipeline_stage',
  'nombre_empresa',
]

// ── Helpers de fecha ──────────────────────────────────────────────────────────

function toYMD(val) {
  if (!val) return null
  const d = val instanceof Date ? val : new Date(val)
  if (isNaN(d)) return null
  return d.toISOString().slice(0, 10)
}

function addDays(ymd, delta) {
  const d = new Date(ymd + 'T12:00:00Z')
  d.setUTCDate(d.getUTCDate() + delta)
  return d.toISOString().slice(0, 10)
}

function toHubSpotDate(val) {
  if (!val) return null
  const ymd = toYMD(val)
  if (!ymd) return null
  return String(new Date(ymd + 'T00:00:00.000Z').getTime())
}

// ── Resolución de empresa ─────────────────────────────────────────────────────

/**
 * Busca una Company en HubSpot por codigo_cliente_comercial (NroCliente de Nodum).
 * Devuelve { companyHsId, companyName, metodo: 'codigo_cliente_comercial' } o null.
 */
async function resolverEmpresaPorCodigo(nroCliente) {
  if (!nroCliente) return null
  try {
    const resp = await hubspotClient.crm.companies.searchApi.doSearch({
      filterGroups: [{
        filters: [{
          propertyName: 'codigo_cliente_comercial',
          operator: 'EQ',
          value: String(nroCliente),
        }],
      }],
      properties: ['name', 'codigo_cliente_comercial'],
      limit: 1,
    })
    const company = resp.results?.[0]
    if (!company) return null
    return {
      companyHsId: company.id,
      companyName: company.properties.name,
      metodo: 'codigo_cliente_comercial',
    }
  } catch (err) {
    logger.warn({ fn: 'resolverEmpresaPorCodigo', nroCliente, err }, 'Error buscando company por código')
    return null
  }
}

/**
 * Busca una Company en HubSpot por nombre exacto (RazonSocial).
 * Devuelve { companyHsId, companyName, metodo: 'nombre' } o null.
 */
async function resolverEmpresaPorNombre(razonSocial) {
  if (!razonSocial) return null
  try {
    const resp = await hubspotClient.crm.companies.searchApi.doSearch({
      filterGroups: [{
        filters: [{
          propertyName: 'name',
          operator: 'EQ',
          value: razonSocial,
        }],
      }],
      properties: ['name'],
      limit: 1,
    })
    const company = resp.results?.[0]
    if (!company) return null
    return {
      companyHsId: company.id,
      companyName: company.properties.name,
      metodo: 'nombre',
    }
  } catch (err) {
    logger.warn({ fn: 'resolverEmpresaPorNombre', razonSocial, err }, 'Error buscando company por nombre')
    return null
  }
}

// ── Búsqueda de tickets candidatos ───────────────────────────────────────────

/**
 * Trae todos los tickets asociados a una company que estén en PROMOTED_STAGES
 * y coincidan con la moneda.
 * Estrategia: Associations API para IDs → batch read de propiedades → filtro en memoria.
 */
async function buscarTicketsPorCompany({ companyHsId, monedaHS }) {
  try {
    // 1. Traer IDs de tickets asociados a la company
    const ticketIds = []
    let after = undefined

    do {
      const resp = await hubspotClient.crm.associations.v4.basicApi.getPage(
        'companies', companyHsId, 'tickets', after, 100
      )
      for (const r of (resp.results || [])) {
        ticketIds.push(String(r.toObjectId))
      }
      after = resp.paging?.next?.after
    } while (after)

    if (!ticketIds.length) return []

    // 2. Batch read de propiedades de esos tickets
    const tickets = []
    const chunks = []
    for (let i = 0; i < ticketIds.length; i += 100) {
      chunks.push(ticketIds.slice(i, i + 100))
    }

    for (const chunk of chunks) {
      const resp = await hubspotClient.crm.tickets.batchApi.read({
        inputs: chunk.map(id => ({ id })),
        properties: TICKET_PROPS,
      })
      tickets.push(...(resp.results || []))
    }

    // 3. Filtrar en memoria por stage promovido + moneda
    return tickets.filter(t => {
      const tp = t.properties || {}
      return PROMOTED_STAGES.has(tp.hs_pipeline_stage) && tp.of_moneda === monedaHS
    })
  } catch (err) {
    logger.warn({ fn: 'buscarTicketsPorCompany', companyHsId, monedaHS, err }, 'Error buscando tickets por company')
    return []
  }
}

// ── Matching ──────────────────────────────────────────────────────────────────

/**
 * Filtra candidatos por monto (±0.01) y fecha (tolerancia creciente ±MAX_DATE_DELTA).
 * Devuelve { ticket, deltaDias, yaFacturado } o null.
 */
function encontrarMatch(factura, candidatos) {
  const montoFactura = parseFloat(factura.ImporteMovimientoMonedaOriginal)
  const fechaBase = toYMD(factura.FechaValor)
  if (!fechaBase) return null

  const porMonto = candidatos.filter(t => {
    const montoTicket = parseFloat(t.properties?.total_real_a_facturar || '0')
    return Math.abs(montoTicket - montoFactura) <= 0.01
  })

  if (!porMonto.length) return null

  const deltas = [0]
  for (let d = 1; d <= MAX_DATE_DELTA; d++) {
    deltas.push(-d, d)
  }

  for (const delta of deltas) {
    const fechaTarget = delta === 0 ? fechaBase : addDays(fechaBase, delta)
    for (const ticket of porMonto) {
      const tp = ticket.properties || {}
      const fechaTicket = toYMD(tp.of_fecha_de_facturacion)
      if (fechaTicket !== fechaTarget) continue
      const yaFacturado = !!(tp.numero_de_factura?.trim().length > 0)
      return { ticket, deltaDias: delta, yaFacturado }
    }
  }

  return null
}

// ── Actualización de ticket ───────────────────────────────────────────────────

async function registrarEnTicket(ticketId, factura, tcTrad) {
  const props = {
    numero_de_factura: String(factura.NroDocumento),
    fecha_real_de_facturacion: toHubSpotDate(factura.FechaValor),
    fecha_vencimiento_factura: toHubSpotDate(factura.FechaVencimiento),
  }
  if (tcTrad && Number.isFinite(tcTrad) && tcTrad > 0) {
    props.dolar = String(tcTrad)
  }
  await hubspotClient.crm.tickets.basicApi.update(String(ticketId), { properties: props })
}

// ── Tabla de log en PostgreSQL ────────────────────────────────────────────────

export async function initNodumUploadsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS nodum_upload_logs (
      id              SERIAL PRIMARY KEY,
      uploaded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      filename        TEXT,
      total_facturas  INT NOT NULL DEFAULT 0,
      matches         INT NOT NULL DEFAULT 0,
      no_matches      INT NOT NULL DEFAULT 0,
      ya_facturados   INT NOT NULL DEFAULT 0,
      detalle         JSONB NOT NULL DEFAULT '[]'
    )
  `)
  logger.info('[NodumUpload] Tabla nodum_upload_logs lista.')
}

async function guardarLog({ filename, resultados }) {
  const matches       = resultados.filter(r => r.resultado === 'match').length
  const no_matches    = resultados.filter(r => r.resultado === 'no_match').length
  const ya_facturados = resultados.filter(r => r.resultado === 'ya_facturado').length
  await pool.query(
    `INSERT INTO nodum_upload_logs (filename, total_facturas, matches, no_matches, ya_facturados, detalle)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [filename, resultados.length, matches, no_matches, ya_facturados, JSON.stringify(resultados)]
  )
}

// ── Handler principal ─────────────────────────────────────────────────────────

router.post('/upload', upload.single('archivo'), async (req, res) => {
  const fn = 'POST /nodum/upload'

  if (!req.file) {
    return res.status(400).json({ error: 'Se requiere un archivo .xlsx en el campo "archivo".' })
  }

  let filas
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true })
    filas = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]])
  } catch (err) {
    logger.warn({ fn, err }, 'Error leyendo xlsx')
    return res.status(400).json({ error: 'No se pudo leer el archivo. Asegurate que sea un .xlsx válido.' })
  }

  if (!filas.length) {
    return res.status(400).json({ error: 'El archivo no contiene filas.' })
  }

  logger.info({ fn, filename: req.file.originalname, filas: filas.length }, 'Procesando archivo Nodum')

  const resultados = []

  for (const fila of filas) {
    const nroDocumento  = fila.NroDocumento
    const nroCliente    = fila.NroCliente ? String(Math.round(fila.NroCliente)) : null
    const razonSocial   = (fila.RazonSocial || '').trim()
    const codMoneda     = fila.cod_moneda
    const monedaHS      = MONEDA_MAP[codMoneda] || null
    const importe       = parseFloat(fila.ImporteMovimientoMonedaOriginal)
    const tcTrad        = parseFloat(fila.tc_trad)
    const fechaValorYMD = toYMD(fila.FechaValor)

    if (!nroDocumento || !razonSocial || !monedaHS || isNaN(importe) || !fechaValorYMD) {
      resultados.push({
        NroDocumento: nroDocumento,
        RazonSocial: razonSocial,
        resultado: 'error',
        motivo: 'Fila con datos incompletos o inválidos',
      })
      continue
    }

    // 1. Resolver company — prioridad: codigo_cliente_comercial → nombre
    let empresa = await resolverEmpresaPorCodigo(nroCliente)
    if (!empresa) {
      empresa = await resolverEmpresaPorNombre(razonSocial)
    }

    if (!empresa) {
      resultados.push({
        NroDocumento: nroDocumento,
        RazonSocial: razonSocial,
        nroCliente,
        importe,
        moneda: monedaHS,
        fechaValor: fechaValorYMD,
        resultado: 'no_match',
        motivo: `Company no encontrada para NroCliente=${nroCliente} / RazonSocial="${razonSocial}"`,
      })
      continue
    }

    // 2. Buscar tickets candidatos asociados a la company
    const candidatos = await buscarTicketsPorCompany({ companyHsId: empresa.companyHsId, monedaHS })

    const match = encontrarMatch(fila, candidatos)

    if (!match) {
      resultados.push({
        NroDocumento: nroDocumento,
        RazonSocial: razonSocial,
        nroCliente,
        companyHsId: empresa.companyHsId,
        companyName: empresa.companyName,
        metodoEmpresa: empresa.metodo,
        importe,
        moneda: monedaHS,
        fechaValor: fechaValorYMD,
        resultado: 'no_match',
        motivo: `Sin ticket para company=${empresa.companyHsId} monto=${importe} moneda=${monedaHS} fecha≈${fechaValorYMD}`,
      })
      continue
    }

    const { ticket, deltaDias, yaFacturado } = match
    const ticketId = String(ticket.id)

    if (yaFacturado) {
      resultados.push({
        NroDocumento: nroDocumento,
        RazonSocial: razonSocial,
        nroCliente,
        companyHsId: empresa.companyHsId,
        companyName: empresa.companyName,
        metodoEmpresa: empresa.metodo,
        importe,
        moneda: monedaHS,
        fechaValor: fechaValorYMD,
        ticketId,
        resultado: 'ya_facturado',
        motivo: `Ticket ${ticketId} ya tiene numero_de_factura registrado`,
      })
      continue
    }

    try {
      await registrarEnTicket(ticketId, fila, isNaN(tcTrad) ? null : tcTrad)
      resultados.push({
        NroDocumento: nroDocumento,
        RazonSocial: razonSocial,
        nroCliente,
        companyHsId: empresa.companyHsId,
        companyName: empresa.companyName,
        metodoEmpresa: empresa.metodo,
        importe,
        moneda: monedaHS,
        fechaValor: fechaValorYMD,
        fechaVencimiento: toYMD(fila.FechaVencimiento),
        tcTrad: isNaN(tcTrad) ? null : tcTrad,
        ticketId,
        deltaDias,
        resultado: 'match',
      })
      logger.info({ fn, NroDocumento: nroDocumento, ticketId, deltaDias, metodoEmpresa: empresa.metodo }, 'Match registrado')
    } catch (err) {
      logger.error({ fn, NroDocumento: nroDocumento, ticketId, err }, 'Error actualizando ticket')
      resultados.push({
        NroDocumento: nroDocumento,
        RazonSocial: razonSocial,
        nroCliente,
        companyHsId: empresa.companyHsId,
        companyName: empresa.companyName,
        metodoEmpresa: empresa.metodo,
        importe,
        moneda: monedaHS,
        fechaValor: fechaValorYMD,
        ticketId,
        resultado: 'error',
        motivo: `Error actualizando ticket ${ticketId}: ${err.message}`,
      })
    }
  }

  try {
    await guardarLog({ filename: req.file.originalname, resultados })
  } catch (err) {
    logger.warn({ fn, err }, 'Error guardando log en DB — continuando igual')
  }

  const resumen = {
    total:         resultados.length,
    matches:       resultados.filter(r => r.resultado === 'match').length,
    no_matches:    resultados.filter(r => r.resultado === 'no_match').length,
    ya_facturados: resultados.filter(r => r.resultado === 'ya_facturado').length,
    errores:       resultados.filter(r => r.resultado === 'error').length,
  }

  logger.info({ fn, filename: req.file.originalname, resumen }, 'Procesamiento Nodum completado')

  return res.json({
    resumen,
    resultados,
    para_revision: resultados.filter(r => r.resultado === 'no_match' || r.resultado === 'error'),
  })
})

export default router