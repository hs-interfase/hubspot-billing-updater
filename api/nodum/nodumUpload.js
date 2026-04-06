// api/nodum/nodumUpload.js
//
// POST /nodum/upload
// Recibe un archivo .xlsx de facturas Nodum, busca el ticket correspondiente
// en HubSpot por empresa + monto + moneda + fecha aproximada, y registra
// numero_de_factura, fecha_real_de_facturacion, fecha_vencimiento_factura y dolar.
//
// Resultado: lista de matches y no-matches guardada en PostgreSQL + devuelta en respuesta.

import { Router } from 'express'
import multer from 'multer'
import * as XLSX from 'xlsx'
import pool from '../../src/db.js'
import { hubspotClient } from '../../src/hubspotClient.js'
import logger from '../../lib/logger.js'

const router = Router()
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } })

// ── Constantes ────────────────────────────────────────────────────────────────

// Tolerancia de matching por fecha: intenta exacto primero, luego ±1, ±2, ... hasta MAX_DATE_DELTA días
const MAX_DATE_DELTA = 5

// Monedas Nodum → of_moneda en HubSpot
const MONEDA_MAP = {
  1: 'UYU',
  2: 'USD',
}

// Propiedades de ticket que necesitamos para el matching
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

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Convierte una fecha JS o string a YYYY-MM-DD en zona UTC.
 */
function toYMD(val) {
  if (!val) return null
  const d = val instanceof Date ? val : new Date(val)
  if (isNaN(d)) return null
  return d.toISOString().slice(0, 10)
}

/**
 * Suma o resta días a un string YYYY-MM-DD.
 */
function addDays(ymd, delta) {
  const d = new Date(ymd + 'T12:00:00Z')
  d.setUTCDate(d.getUTCDate() + delta)
  return d.toISOString().slice(0, 10)
}

/**
 * Busca tickets en HubSpot por nombre de empresa y moneda.
 * Devuelve todos los candidatos para luego filtrar por monto y fecha.
 */
async function buscarTicketsCandidatos({ nombreEmpresa, monedaHS }) {
  // Buscamos por nombre_empresa y moneda — filtramos monto/fecha en memoria
  // para no complicar con operadores numéricos en la Search API
  try {
    const resp = await hubspotClient.crm.tickets.searchApi.doSearch({
      filterGroups: [
        {
          filters: [
            { propertyName: 'nombre_empresa', operator: 'EQ', value: nombreEmpresa },
            { propertyName: 'of_moneda', operator: 'EQ', value: monedaHS },
          ],
        },
      ],
      properties: TICKET_PROPS,
      limit: 100,
    })
    return resp.results || []
  } catch (err) {
    logger.warn({ fn: 'buscarTicketsCandidatos', nombreEmpresa, monedaHS, err }, 'Error buscando tickets')
    return []
  }
}

/**
 * Intenta hacer match de una factura contra una lista de tickets candidatos.
 * Estrategia: primero filtra por monto exacto (±0.01), luego busca el candidato
 * cuya fecha esté más cerca de FechaValor, priorizando delta=0, luego ±1, ±2, etc.
 * Devuelve { ticket, deltaDias, yaFacturado } o null si no hay match.
 */
function encontrarMatch(factura, candidatos) {
  const montoFactura = parseFloat(factura.ImporteMovimientoMonedaOriginal)
  const fechaBase = toYMD(factura.FechaValor)
  if (!fechaBase) return null

  // Pre-filtrar por monto
  const porMonto = candidatos.filter(t => {
    const montoTicket = parseFloat(t.properties?.total_real_a_facturar || '0')
    return Math.abs(montoTicket - montoFactura) <= 0.01
  })

  if (!porMonto.length) return null

  // Buscar por fecha con tolerancia creciente: 0, -1, +1, -2, +2, ...
  const deltas = [0]
  for (let d = 1; d <= MAX_DATE_DELTA; d++) {
    deltas.push(-d)
    deltas.push(d)
  }

  for (const delta of deltas) {
    const fechaTarget = delta === 0 ? fechaBase : addDays(fechaBase, delta)

    for (const ticket of porMonto) {
      const tp = ticket.properties || {}
      const fechaTicket = toYMD(tp.of_fecha_de_facturacion)
      if (fechaTicket !== fechaTarget) continue

      const yaFacturado = !!(tp.numero_de_factura && tp.numero_de_factura.trim().length > 0)
      return { ticket, deltaDias: delta, yaFacturado }
    }
  }

  return null
}

/**
 * Convierte fecha JS/string a timestamp HubSpot (ms UTC a medianoche).
 */
function toHubSpotDate(val) {
  if (!val) return null
  const ymd = toYMD(val)
  if (!ymd) return null
  return String(new Date(ymd + 'T00:00:00.000Z').getTime())
}

/**
 * Actualiza el ticket en HubSpot con los datos de la factura Nodum.
 */
async function registrarEnTicket(ticketId, factura, tcTrad) {
  const props = {
    numero_de_factura: String(factura.NroDocumento),
    fecha_real_de_facturacion: toHubSpotDate(factura.FechaValor),
    fecha_vencimiento_factura: toHubSpotDate(factura.FechaVencimiento),
  }

  // Solo guardamos dolar si viene un tc_trad válido
  if (tcTrad && Number.isFinite(tcTrad) && tcTrad > 0) {
    props.dolar = String(tcTrad)
  }

  await hubspotClient.crm.tickets.basicApi.update(String(ticketId), { properties: props })
}

// ── Tabla de log en PostgreSQL ─────────────────────────────────────────────────

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
  const matches      = resultados.filter(r => r.resultado === 'match').length
  const no_matches   = resultados.filter(r => r.resultado === 'no_match').length
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
    const sheetName = wb.SheetNames[0]
    filas = XLSX.utils.sheet_to_json(wb.Sheets[sheetName])
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
    const nroDocumento   = fila.NroDocumento
    const razonSocial    = (fila.RazonSocial || '').trim()
    const codMoneda      = fila.cod_moneda
    const monedaHS       = MONEDA_MAP[codMoneda] || null
    const importe        = parseFloat(fila.ImporteMovimientoMonedaOriginal)
    const tcTrad         = parseFloat(fila.tc_trad)
    const fechaValorYMD  = toYMD(fila.FechaValor)

    // Validación mínima de la fila
    if (!nroDocumento || !razonSocial || !monedaHS || isNaN(importe) || !fechaValorYMD) {
      resultados.push({
        NroDocumento: nroDocumento,
        RazonSocial: razonSocial,
        resultado: 'error',
        motivo: 'Fila con datos incompletos o inválidos',
      })
      continue
    }

    // Buscar tickets candidatos en HubSpot
    const candidatos = await buscarTicketsCandidatos({ nombreEmpresa: razonSocial, monedaHS })

    const match = encontrarMatch(fila, candidatos)

    if (!match) {
      resultados.push({
        NroDocumento: nroDocumento,
        RazonSocial: razonSocial,
        importe,
        moneda: monedaHS,
        fechaValor: fechaValorYMD,
        resultado: 'no_match',
        motivo: `Sin ticket para empresa="${razonSocial}" monto=${importe} moneda=${monedaHS} fecha≈${fechaValorYMD}`,
      })
      continue
    }

    const { ticket, deltaDias, yaFacturado } = match
    const ticketId = String(ticket.id)

    if (yaFacturado) {
      resultados.push({
        NroDocumento: nroDocumento,
        RazonSocial: razonSocial,
        importe,
        moneda: monedaHS,
        fechaValor: fechaValorYMD,
        ticketId,
        resultado: 'ya_facturado',
        motivo: `Ticket ${ticketId} ya tiene numero_de_factura registrado`,
      })
      continue
    }

    // Registrar en HubSpot
    try {
      await registrarEnTicket(ticketId, fila, isNaN(tcTrad) ? null : tcTrad)

      resultados.push({
        NroDocumento: nroDocumento,
        RazonSocial: razonSocial,
        importe,
        moneda: monedaHS,
        fechaValor: fechaValorYMD,
        fechaVencimiento: toYMD(fila.FechaVencimiento),
        tcTrad: isNaN(tcTrad) ? null : tcTrad,
        ticketId,
        deltaDias,
        resultado: 'match',
      })

      logger.info({ fn, NroDocumento: nroDocumento, ticketId, deltaDias }, 'Match registrado')
    } catch (err) {
      logger.error({ fn, NroDocumento: nroDocumento, ticketId, err }, 'Error actualizando ticket')
      resultados.push({
        NroDocumento: nroDocumento,
        RazonSocial: razonSocial,
        importe,
        moneda: monedaHS,
        fechaValor: fechaValorYMD,
        ticketId,
        resultado: 'error',
        motivo: `Error actualizando ticket ${ticketId}: ${err.message}`,
      })
    }
  }

  // Guardar log en PostgreSQL
  try {
    await guardarLog({ filename: req.file.originalname, resultados })
  } catch (err) {
    logger.warn({ fn, err }, 'Error guardando log en DB — continuando igual')
  }

  // Resumen
  const resumen = {
    total:        resultados.length,
    matches:      resultados.filter(r => r.resultado === 'match').length,
    no_matches:   resultados.filter(r => r.resultado === 'no_match').length,
    ya_facturados: resultados.filter(r => r.resultado === 'ya_facturado').length,
    errores:      resultados.filter(r => r.resultado === 'error').length,
  }

  logger.info({ fn, filename: req.file.originalname, resumen }, 'Procesamiento Nodum completado')

  return res.json({
    resumen,
    resultados,
    // Lista filtrada para acción manual
    para_revision: resultados.filter(r => r.resultado === 'no_match' || r.resultado === 'error'),
  })
})

export default router