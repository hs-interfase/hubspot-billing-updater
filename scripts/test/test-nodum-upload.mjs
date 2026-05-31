// test-nodum-upload.mjs
//
// Test del endpoint POST /nodum/upload
//
// Uso:
//   node test-nodum-upload.mjs                     → tests de lógica interna (sin red)
//   node test-nodum-upload.mjs --endpoint           → llama al endpoint Railway con el xlsx de ejemplo
//   node test-nodum-upload.mjs --endpoint --local   → llama a localhost:8080 en lugar de Railway
//
// El archivo xlsx de ejemplo debe estar en: ejemplo_de_facturas_de_nodum.xlsx

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import FormData from 'form-data'
import fetch from 'node-fetch'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const RAILWAY_URL = 'https://webhooks-production-6c1b.up.railway.app'
const LOCAL_URL   = 'http://localhost:8080'

const args        = process.argv.slice(2)
const RUN_ENDPOINT = args.includes('--endpoint')
const USE_LOCAL    = args.includes('--local')
const BASE_URL     = USE_LOCAL ? LOCAL_URL : RAILWAY_URL

// ── Colores para consola ──────────────────────────────────────────────────────

const OK   = '\x1b[32m✓\x1b[0m'
const FAIL = '\x1b[31m✗\x1b[0m'
const INFO = '\x1b[36m→\x1b[0m'
const WARN = '\x1b[33m!\x1b[0m'

let passed = 0
let failed = 0

function assert(condicion, descripcion, detalle = '') {
  if (condicion) {
    console.log(`  ${OK} ${descripcion}`)
    passed++
  } else {
    console.log(`  ${FAIL} ${descripcion}${detalle ? ` — ${detalle}` : ''}`)
    failed++
  }
}

// ── Helpers internos (copiados del módulo para testeo aislado) ────────────────

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

const MONEDA_MAP = { 1: 'UYU', 2: 'USD' }
const MAX_DATE_DELTA = 5

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

function toHubSpotDate(val) {
  if (!val) return null
  const ymd = toYMD(val)
  if (!ymd) return null
  return String(new Date(ymd + 'T00:00:00.000Z').getTime())
}

// ── Tests de lógica interna ───────────────────────────────────────────────────

function testLogicaInterna() {
  console.log('\n\x1b[1m── Tests de lógica interna ──\x1b[0m\n')

  // --- toYMD ---
  console.log('toYMD:')
  assert(toYMD(new Date('2025-08-01T00:00:00Z')) === '2025-08-01', 'Convierte Date a YYYY-MM-DD')
  assert(toYMD('2025-08-01') === '2025-08-01', 'Convierte string a YYYY-MM-DD')
  assert(toYMD(null) === null, 'Null devuelve null')
  assert(toYMD('no-es-fecha') === null, 'String inválido devuelve null')

  // --- addDays ---
  console.log('\naddDays:')
  assert(addDays('2025-08-01', 1)  === '2025-08-02', '+1 día')
  assert(addDays('2025-08-01', -1) === '2025-07-31', '-1 día (cruza mes)')
  assert(addDays('2025-08-31', 1)  === '2025-09-01', '+1 día (cruza mes)')
  assert(addDays('2025-12-31', 1)  === '2026-01-01', '+1 día (cruza año)')

  // --- MONEDA_MAP ---
  console.log('\nMONEDA_MAP:')
  assert(MONEDA_MAP[1] === 'UYU', 'cod_moneda 1 → UYU')
  assert(MONEDA_MAP[2] === 'USD', 'cod_moneda 2 → USD')
  assert(MONEDA_MAP[99] === undefined, 'cod_moneda desconocido → undefined')

  // --- toHubSpotDate ---
  console.log('\ntoHubSpotDate:')
  const ts = toHubSpotDate('2025-08-01')
  assert(ts === '1754006400000', 'Convierte YYYY-MM-DD a timestamp HubSpot correcto')
  assert(toHubSpotDate(null) === null, 'Null devuelve null')

  // --- encontrarMatch ---
  console.log('\nencontrarMatch:')

  const facturaBase = {
    ImporteMovimientoMonedaOriginal: 20744,
    FechaValor: new Date('2025-08-01T00:00:00Z'),
  }

  const ticketExacto = {
    id: 'T001',
    properties: {
      total_real_a_facturar: '20744',
      of_fecha_de_facturacion: '2025-08-01',
      numero_de_factura: '',
      of_moneda: 'UYU',
    },
  }

  // Match exacto
  const r1 = encontrarMatch(facturaBase, [ticketExacto])
  assert(r1 !== null, 'Encuentra match exacto')
  assert(r1?.deltaDias === 0, 'Delta es 0 para match exacto')
  assert(r1?.yaFacturado === false, 'yaFacturado=false cuando numero_de_factura está vacío')

  // Ya facturado
  const ticketYaFacturado = {
    id: 'T002',
    properties: {
      ...ticketExacto.properties,
      numero_de_factura: '6119',
    },
  }
  const r2 = encontrarMatch(facturaBase, [ticketYaFacturado])
  assert(r2?.yaFacturado === true, 'Detecta ticket ya facturado')

  // Sin match por monto
  const ticketMontoDiferente = {
    id: 'T003',
    properties: {
      total_real_a_facturar: '99999',
      of_fecha_de_facturacion: '2025-08-01',
      numero_de_factura: '',
    },
  }
  assert(encontrarMatch(facturaBase, [ticketMontoDiferente]) === null, 'Sin match cuando monto difiere')

  // Match con tolerancia de fecha
  const ticketFecha2 = {
    id: 'T004',
    properties: {
      total_real_a_facturar: '20744',
      of_fecha_de_facturacion: '2025-08-03',  // +2 días
      numero_de_factura: '',
    },
  }
  const r3 = encontrarMatch(facturaBase, [ticketFecha2])
  assert(r3 !== null, 'Encuentra match con tolerancia +2 días')
  assert(r3?.deltaDias === 2, 'Delta reportado correctamente como 2')

  // Fuera de tolerancia
  const ticketFechaLejos = {
    id: 'T005',
    properties: {
      total_real_a_facturar: '20744',
      of_fecha_de_facturacion: '2025-08-10', // +9 días, fuera del rango
      numero_de_factura: '',
    },
  }
  assert(encontrarMatch(facturaBase, [ticketFechaLejos]) === null, 'Sin match cuando fecha excede tolerancia')

  // Prioriza fecha exacta sobre tolerancia
  const ticketExacto2 = { id: 'T006', properties: { ...ticketExacto.properties } }
  const ticketConTolerancia = { id: 'T007', properties: { ...ticketFecha2.properties } }
  const r4 = encontrarMatch(facturaBase, [ticketConTolerancia, ticketExacto2])
  assert(r4?.ticket.id === 'T006', 'Prioriza match exacto aunque candidato con tolerancia aparece primero')

  // Lista vacía
  assert(encontrarMatch(facturaBase, []) === null, 'Devuelve null con lista vacía')

  // FechaValor inválida
  assert(encontrarMatch({ ...facturaBase, FechaValor: null }, [ticketExacto]) === null, 'Devuelve null si FechaValor es null')
}

// ── Test de endpoint real ─────────────────────────────────────────────────────

async function testEndpoint() {
  console.log(`\n\x1b[1m── Test de endpoint (${USE_LOCAL ? 'local' : 'Railway'}) ──\x1b[0m\n`)

  // 1. Buscar el xlsx de ejemplo
  const candidatos = [
    path.join(__dirname, 'ejemplo_de_facturas_de_nodum.xlsx'),
    path.join(process.cwd(), 'ejemplo_de_facturas_de_nodum.xlsx'),
  ]
  const xlsxPath = candidatos.find(p => fs.existsSync(p))

  if (!xlsxPath) {
    console.log(`  ${WARN} No se encontró ejemplo_de_facturas_de_nodum.xlsx`)
    console.log(`  ${INFO} Buscado en:`)
    candidatos.forEach(p => console.log(`     ${p}`))
    console.log(`  ${INFO} Copiá el archivo xlsx de ejemplo a la misma carpeta que este script.`)
    return
  }

  console.log(`  ${INFO} Usando archivo: ${xlsxPath}`)

  // 2. Health check
  console.log(`\nHealth check:`)
  try {
    const health = await fetch(`${BASE_URL}/health`, { timeout: 8000 })
    assert(health.ok, `Servidor responde en ${BASE_URL}`, `status: ${health.status}`)
  } catch (err) {
    console.log(`  ${FAIL} No se pudo conectar al servidor — ${err.message}`)
    console.log(`  ${INFO} ¿Está corriendo el servidor? Probá con --local si estás en local.`)
    return
  }

  // 3. POST sin archivo → debe devolver 400
  console.log(`\nValidación de input:`)
  try {
    const r = await fetch(`${BASE_URL}/nodum/upload`, { method: 'POST', timeout: 10000 })
    assert(r.status === 400, 'Sin archivo devuelve 400')
    const body = await r.json()
    assert(typeof body.error === 'string', 'Body de error tiene campo "error"')
  } catch (err) {
    console.log(`  ${FAIL} Error en test sin archivo — ${err.message}`)
  }

  // 4. POST con el xlsx real
  console.log(`\nProcesamiento del xlsx de ejemplo:`)
  try {
    const form = new FormData()
    form.append('archivo', fs.createReadStream(xlsxPath), {
      filename: 'ejemplo_de_facturas_de_nodum.xlsx',
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    })

    const r = await fetch(`${BASE_URL}/nodum/upload`, {
      method: 'POST',
      body: form,
      headers: form.getHeaders(),
      timeout: 30000,
    })

    assert(r.ok, `Respuesta exitosa (status ${r.status})`)

    const body = await r.json()

    assert(typeof body.resumen === 'object', 'Respuesta tiene campo "resumen"')
    assert(typeof body.resumen.total === 'number', `resumen.total es número (${body.resumen.total})`)
    assert(Array.isArray(body.resultados), 'Respuesta tiene array "resultados"')
    assert(Array.isArray(body.para_revision), 'Respuesta tiene array "para_revision"')

    // El xlsx de ejemplo tiene 3 filas
    assert(body.resumen.total === 3, `Procesó 3 filas (recibió ${body.resumen.total})`)

    // Verificar que cada resultado tiene los campos esperados
    const camposEsperados = ['NroDocumento', 'RazonSocial', 'resultado']
    const todosTienenCampos = body.resultados.every(r =>
      camposEsperados.every(c => c in r)
    )
    assert(todosTienenCampos, 'Todos los resultados tienen NroDocumento, RazonSocial y resultado')

    // Verificar valores válidos de "resultado"
    const valoresValidos = ['match', 'no_match', 'ya_facturado', 'error']
    const todosValidos = body.resultados.every(r => valoresValidos.includes(r.resultado))
    assert(todosValidos, 'Todos los resultados tienen valor válido en campo "resultado"')

    // Verificar coherencia del resumen
    const sumaCheck = body.resumen.matches + body.resumen.no_matches +
                      body.resumen.ya_facturados + body.resumen.errores
    assert(sumaCheck === body.resumen.total, `Suma del resumen es coherente (${sumaCheck} = ${body.resumen.total})`)

    // Detalle de resultado
    console.log(`\n  ${INFO} Resultado del procesamiento:`)
    console.log(`     Matches:       ${body.resumen.matches}`)
    console.log(`     No matches:    ${body.resumen.no_matches}`)
    console.log(`     Ya facturados: ${body.resumen.ya_facturados}`)
    console.log(`     Errores:       ${body.resumen.errores}`)

    if (body.resumen.matches > 0) {
      const matchEjemplo = body.resultados.find(r => r.resultado === 'match')
      console.log(`\n  ${INFO} Ejemplo de match:`)
      console.log(`     NroDocumento:  ${matchEjemplo.NroDocumento}`)
      console.log(`     Empresa:       ${matchEjemplo.RazonSocial}`)
      console.log(`     TicketId:      ${matchEjemplo.ticketId}`)
      console.log(`     Delta días:    ${matchEjemplo.deltaDias}`)
    }

    if (body.para_revision.length > 0) {
      console.log(`\n  ${WARN} Para revisión manual (${body.para_revision.length}):`)
      body.para_revision.forEach(r => {
        console.log(`     [${r.resultado.toUpperCase()}] ${r.RazonSocial} | $${r.importe} ${r.moneda} | ${r.fechaValor}`)
        console.log(`       ${r.motivo}`)
      })
    }

  } catch (err) {
    console.log(`  ${FAIL} Error en POST /nodum/upload — ${err.message}`)
    if (err.type === 'request-timeout') {
      console.log(`  ${INFO} El servidor tardó más de 30s — puede ser normal si hay muchos tickets en HubSpot`)
    }
  }
}

// ── Resumen final ─────────────────────────────────────────────────────────────

function resumenFinal() {
  const total = passed + failed
  console.log(`\n${'─'.repeat(50)}`)
  console.log(`Tests de lógica: ${passed}/${total} pasaron`)
  if (failed > 0) {
    console.log(`\x1b[31m${failed} test(s) fallaron\x1b[0m`)
    process.exitCode = 1
  } else {
    console.log('\x1b[32mTodos los tests de lógica pasaron ✓\x1b[0m')
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log('\x1b[1m\nTest: Nodum Upload\x1b[0m')
console.log(`Modo: ${RUN_ENDPOINT ? (USE_LOCAL ? 'local' : 'Railway') : 'solo lógica interna'}`)

testLogicaInterna()

if (RUN_ENDPOINT) {
  await testEndpoint()
}

resumenFinal()

if (!RUN_ENDPOINT) {
  console.log(`\n${INFO} Para testear el endpoint en Railway: node test-nodum-upload.mjs --endpoint`)
  console.log(`${INFO} Para testear en local:               node test-nodum-upload.mjs --endpoint --local`)
}
