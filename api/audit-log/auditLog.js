// api/audit-log/auditLog.js
// Registro de auditoría de UN registro de HubSpot (deal, ticket, line item o
// factura): todos los cambios de propiedades que HubSpot tiene versionados,
// con fecha/hora (Montevideo), valor anterior, valor nuevo, origen y usuario.
//
// READ-ONLY: solo hace GET contra HubSpot. Mismo criterio que el script CLI
// scripts/audit-log/registro_auditoria.mjs (mantener ambos alineados).
//
// GET /audit-log/api
//   objeto  deal | ticket | lineitem | factura   (obligatorio)
//   id      id del registro en HubSpot           (obligatorio)
//   desde   YYYY-MM-DD  (opcional, inclusive, hora Montevideo)
//   hasta   YYYY-MM-DD  (opcional, inclusive, hora Montevideo)
//   todo    1|true      (opcional: incluye props ruidosas y cambios calculados)
//
// Respuesta: { objeto, id, nombre, total, cambios: [{fecha, hora, prop, label,
//              anterior, nuevo, origen, usuario}] }  (más reciente primero)

import { Router } from 'express'
import { axiosHubSpot } from '../../src/hubspotClient.js'
import logger from '../../lib/logger.js'

const router = Router()
const HS = 'https://api.hubapi.com'
const authHeaders = () => ({ headers: { Authorization: `Bearer ${process.env.HUBSPOT_PRIVATE_TOKEN}` } })

const OBJETOS = {
  deal:     { api: 'deals',      es: 'negocio' },
  ticket:   { api: 'tickets',    es: 'ticket' },
  lineitem: { api: 'line_items', es: 'line item' },
  factura:  { api: 'invoices',   es: 'factura' },
}

// props de sistema ruidosas (se omiten salvo todo=1)
const RUIDO = [
  /^hs_time_in_/, /^hs_date_entered_/, /^hs_date_exited_/,
  /^hs_v2_date_entered_/, /^hs_v2_date_exited_/, /^hs_v2_cumulative_time_in_/, /^hs_v2_latest_time_in_/,
  /^hs_analytics_/, /^hs_predictive/, /^hs_deal_score/,
  /^hs_lastmodifieddate$/, /^hs_updated_by_user_id$/, /^hs_user_ids_of_all_/,
  /^hs_notes_last_/, /^notes_last_/, /^hs_lastactivitydate$/, /^hs_latest_/,
]
const esRuido = (name) => RUIDO.some((re) => re.test(name))

// cambios que hace HubSpot solo (recálculos): se omiten salvo todo=1
const ORIGEN_SISTEMA = new Set(['CALCULATED', 'INTERNAL_PROCESSING'])

const ORIGEN_ES = {
  CRM_UI: 'Usuario (UI)', INTEGRATION: 'Integración/API', API: 'API', IMPORT: 'Import',
  AUTOMATION_PLATFORM: 'Workflow', WORKFLOWS: 'Workflow', CALCULATED: 'Calculada (sistema)',
  MIGRATION: 'Migración HubSpot', FORM: 'Formulario', EMAIL: 'Email', MOBILE_IOS: 'App móvil',
  MOBILE_ANDROID: 'App móvil', ASSOCIATIONS: 'Asociaciones (sistema)', BATCH_UPDATE: 'Actualización masiva',
  INTERNAL_PROCESSING: 'HubSpot (sistema)',
}

// ── fecha/hora en Montevideo ──
const fmtFecha = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Montevideo', year: 'numeric', month: '2-digit', day: '2-digit' })
const fmtHora = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Montevideo', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
const fechaMvd = (iso) => fmtFecha.format(new Date(iso)) // YYYY-MM-DD
const horaMvd = (iso) => fmtHora.format(new Date(iso))   // HH:mm:ss

// ── caches en memoria (la lista de props y los usuarios cambian poco) ──
const CACHE_MS = 10 * 60 * 1000
const propsCache = new Map() // objApi -> { at, lista: [{name,label}] }
let usuariosCache = null     // { at, map: Map(userId -> nombre) }

async function getProps(objApi) {
  const hit = propsCache.get(objApi)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.lista
  const { data } = await axiosHubSpot.get(`${HS}/crm/v3/properties/${objApi}`, authHeaders())
  const lista = (data.results || []).map((p) => ({ name: p.name, label: p.label || p.name }))
  propsCache.set(objApi, { at: Date.now(), lista })
  return lista
}

async function getUsuarios() {
  if (usuariosCache && Date.now() - usuariosCache.at < CACHE_MS) return usuariosCache.map
  const map = new Map()
  let after
  do {
    const { data } = await axiosHubSpot.get(`${HS}/crm/v3/owners/?limit=500${after ? `&after=${after}` : ''}`, authHeaders())
    for (const o of data.results || []) {
      const nom = [o.firstName, o.lastName].filter(Boolean).join(' ') || o.email || `owner ${o.id}`
      if (o.userId != null) map.set(String(o.userId), nom)
    }
    after = data.paging?.next?.after
  } while (after)
  usuariosCache = { at: Date.now(), map }
  return map
}

function quienYComo(v, usuarios) {
  const origen = ORIGEN_ES[v.sourceType] || v.sourceType || ''
  const uid = v.updatedByUserId != null ? String(v.updatedByUserId)
    : (v.sourceType === 'CRM_UI' && /^\d+$/.test(String(v.sourceId || ''))) ? String(v.sourceId) : null
  let usuario = uid ? (usuarios.get(uid) || `usuario ${uid}`) : ''
  if (!usuario && v.sourceType === 'INTEGRATION' && v.sourceId) usuario = `app ${v.sourceId}`
  return { origen, usuario }
}

router.get('/', async (req, res) => {
  const def = OBJETOS[String(req.query.objeto || '').toLowerCase()]
  const id = String(req.query.id || '').trim()
  const desde = req.query.desde || null
  const hasta = req.query.hasta || null
  const incluirTodo = ['1', 'true'].includes(String(req.query.todo || '').toLowerCase())

  if (!def) return res.status(400).json({ error: 'Parámetro "objeto" inválido: usar deal, ticket, lineitem o factura.' })
  if (!/^\d+$/.test(id)) return res.status(400).json({ error: 'Parámetro "id" inválido: debe ser el ID numérico del registro.' })
  for (const d of [desde, hasta]) {
    if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) return res.status(400).json({ error: `Fecha inválida "${d}" (formato YYYY-MM-DD).` })
  }

  try {
    const todasProps = await getProps(def.api)
    const labelDe = new Map(todasProps.map((p) => [p.name, p.label]))
    const propsAuditar = todasProps.map((p) => p.name).filter((n) => incluirTodo || !esRuido(n))

    // historial por chunks de 50 props para no pasar el largo de URL
    const historia = new Map() // propName -> versions[]
    for (let i = 0; i < propsAuditar.length; i += 50) {
      const chunk = propsAuditar.slice(i, i + 50)
      const { data } = await axiosHubSpot.get(
        `${HS}/crm/v3/objects/${def.api}/${id}?propertiesWithHistory=${chunk.join(',')}&archived=false`,
        authHeaders()
      )
      for (const [name, versions] of Object.entries(data.propertiesWithHistory || {})) {
        if (Array.isArray(versions) && versions.length) historia.set(name, versions)
      }
    }

    // nombre del registro = última versión de su prop de nombre (la API no
    // devuelve el valor actual de props custom cuando se pide propertiesWithHistory)
    const ultimo = (p) => (historia.get(p) || [])
      .reduce((a, v) => (!a || new Date(v.timestamp) > new Date(a.timestamp) ? v : a), null)?.value
    const nombre = ['dealname', 'subject', 'name', 'hs_title', 'hs_number', 'hs_invoice_number']
      .map(ultimo).find(Boolean) || '(sin nombre)'

    const usuarios = await getUsuarios()

    const cambios = [] // {ts, fecha, hora, prop, label, anterior, nuevo, origen, usuario}
    for (const [name, versions] of historia) {
      const asc = [...versions].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))
      for (let i = 0; i < asc.length; i++) {
        const v = asc[i]
        if (!incluirTodo && ORIGEN_SISTEMA.has(v.sourceType)) continue
        const fecha = fechaMvd(v.timestamp)
        if (desde && fecha < desde) continue
        if (hasta && fecha > hasta) continue
        const { origen, usuario } = quienYComo(v, usuarios)
        cambios.push({
          ts: new Date(v.timestamp).getTime(),
          fecha, hora: horaMvd(v.timestamp),
          prop: name, label: labelDe.get(name) || name,
          anterior: i > 0 ? String(asc[i - 1].value ?? '') : '',
          nuevo: String(v.value ?? ''),
          origen, usuario,
        })
      }
    }
    cambios.sort((a, b) => b.ts - a.ts || a.prop.localeCompare(b.prop)) // más reciente primero

    res.json({ objeto: def.es, id, nombre, total: cambios.length, cambios })
  } catch (err) {
    if (err.response?.status === 404) {
      return res.status(404).json({ error: `No existe ${def.es} con ID ${id} en este portal.` })
    }
    logger.error({ err: err.message, objeto: req.query.objeto, id }, '[audit-log] error consultando historial')
    res.status(500).json({ error: 'Error consultando el historial en HubSpot.' })
  }
})

export default router
