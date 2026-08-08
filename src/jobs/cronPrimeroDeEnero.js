// src/jobs/cronPrimeroDeEnero.js
//
// Cron ANUAL — corre el 1 de enero. Railway:
//   comando  = node src/jobs/cronPrimeroDeEnero.js
//   schedule = 0 7 1 1 *      (07:00 UTC del 1 de enero)
//
// ⚠️ EL ORDEN IMPORTA (decisión usuaria 6-ago-2026): el archivo de los tickets
//    auto-renew va ANTES de asignar el TC. Por eso los pasos son secuenciales y
//    el Paso 2 no arranca si el Paso 1 falló.
//
//   Paso 1 — ARCHIVO. Los tickets auto-renew del "año retrasado" (Y-2) se bajan
//            a Postgres. Al entrar a 2027 se archivan los de 2025. Los auto-renew
//            no tienen fin, así que sin esto los tickets vivos crecen para siempre.
//   Paso 2 — TC USD. A todos los negocios en «Cierre ganado» / «En Ejecución» se
//            les sella el valor del dólar del país operativo al 1 de enero.
//
// (Generar los tickets del año siguiente NO es un paso: phaseP ya mantiene 24
//  períodos rodantes por delante del piso. Ver el bloque entre los dos pasos.)
//
// SEGURIDAD: dry-run por defecto. Escribe sólo con ENERO_WRITE=true (o --write).
// El borrado del lado HubSpot va aparte, con su propia llave y apagado por default.

import { pathToFileURL } from 'node:url'
import { hubspotClient } from '../hubspotClient.js'
import { withRetry } from '../utils/withRetry.js'
import pool, {
  initExchangeRatesTable,
  initTicketsAutoRenewArchivoTable,
  archivarTicketAutoRenew,
  contarArchivadosDelAnio,
  initCronFailuresTable,
  insertCronFailure,
} from '../db.js'
import { TC_USD_PROP, resolveTcUsdParaDeal, monedaDePais } from '../services/fx/tcUsdService.js'
import {
  DEAL_STAGE_WON,
  DEAL_STAGE_EN_EJECUCION,
  TICKET_PIPELINE,
} from '../config/constants.js'
import { ymdToMidnightUTCMillis } from '../utils/dateUtils.js'
import logger from '../../lib/logger.js'
import { pingHeartbeat, sendSummary } from '../../lib/alertService.js'

// --- Llaves -------------------------------------------------------------------

const WRITE = String(process.env.ENERO_WRITE || '').toLowerCase() === 'true'
  || process.argv.includes('--write')

// 🔴 QUEDA APAGADA. Decisión usuaria 6-ago-2026: el cron SÓLO genera la copia;
//    el borrado en HubSpot lo hace ella a mano después de verificar el archivo.
//    La llave existe por si alguna vez se automatiza, pero no se prende sin pedido
//    explícito.
const BORRA_EN_HUBSPOT = String(process.env.ENERO_ARCHIVO_BORRA_HUBSPOT || '').toLowerCase() === 'true'

const PAGE_LIMIT = Number(process.env.ENERO_PAGE_LIMIT || 100)
const BATCH_LIMIT = 100   // tope de la batch API de HubSpot

// --- Helpers ------------------------------------------------------------------

const jobName = 'cronPrimeroDeEnero'

function parseArgAnio() {
  const arg = process.argv.find(a => a.startsWith('--anio='))
  if (!arg) return null
  const n = Number(arg.slice('--anio='.length))
  return Number.isInteger(n) && n > 2000 ? n : null
}

/**
 * Ventana de años. `anio` es el año al que ENTRAMOS (2027 en el ejemplo de la
 * usuaria). Quedan vivos [Y-1, Y, Y+1]; se archiva Y-2.
 */
export function resolverVentana(anio) {
  return {
    anioActual: anio,
    anioArchivo: anio - 2,      // 2027 → archiva 2025
    anioGenerar: anio + 1,      // 2027 → genera 2028
    fechaTc: `${anio}-01-01`,
  }
}

async function paginar(buscar, onPage) {
  let after
  let total = 0
  for (;;) {
    const resp = await withRetry(() => buscar(after))
    const results = resp?.results || []
    if (results.length) {
      await onPage(results)
      total += results.length
    }
    after = resp?.paging?.next?.after
    if (!after) break
  }
  return total
}

// ==============================================================================
// PASO 1 — Archivo de los tickets auto-renew del año retrasado
// ==============================================================================

// Un ticket es "auto-renew" si su LINE ITEM lo es: plan sin tope de cuotas
// (`hs_recurring_billing_number_of_payments` ausente o 0). Es el mismo criterio
// que phase3.sweepAutoBacklog — no inventar otro.
const cacheAutoRenew = new Map()   // lineItemId -> boolean

async function esLineItemAutoRenew(lineItemId) {
  if (cacheAutoRenew.has(lineItemId)) return cacheAutoRenew.get(lineItemId)
  const li = await withRetry(() =>
    hubspotClient.crm.lineItems.basicApi
      .getById(String(lineItemId), ['hs_recurring_billing_number_of_payments'])
  ).catch(() => null)
  const total = Number(li?.properties?.hs_recurring_billing_number_of_payments)
  const auto = !Number.isFinite(total) || total === 0
  cacheAutoRenew.set(lineItemId, auto)
  return auto
}

// 🔴 EL VÍNCULO TICKET→LINE ITEM ES `of_line_item_key`, NO LA ASOCIACIÓN.
//
// Verificado contra el portal el 8-ago-2026: NINGÚN ticket tiene asociación a
// line_items (0 de los muestreados de 2025 y de 2026), pero TODOS tienen
// `of_line_item_key` con el formato `dealId:lineItemId:hash`. Preguntar por la
// asociación devolvía lista vacía para todos ⇒ el paso 1 archivaba CERO tickets
// y el cron terminaba "sin errores". Un no-op silencioso, que es la peor forma
// de fallar para un cron que corre una vez al año.
//
// Es además el mismo criterio que usa phase3.sweepAutoBacklog, que matchea los
// tickets de un plan por `of_line_item_key` y nunca por asociación.
function lineItemDeTicket(ticket) {
  const key = String(ticket?.properties?.of_line_item_key || '').trim()
  if (!key) return null
  const partes = key.split(':')
  return partes.length >= 2 && partes[1] ? partes[1] : null
}

const TICKET_PROPS_ARCHIVO = [
  'of_ticket_key', 'of_line_item_key', 'of_deal_id', 'of_estado',
  'fecha_resolucion_esperada', 'hs_pipeline_stage', 'hs_pipeline',
  'subject', 'content', 'of_producto_nombres', 'of_descripcion_producto',
  'of_costo', 'of_costo_usd', 'of_margen', 'of_facturacion_usd', 'of_margen_usd',
  'subtotal_real', 'total_real_a_facturar', 'numero_de_factura', 'dolar',
  'of_pais_operativo', 'of_moneda', 'empresa_que_factura', 'nombre_empresa',
]

export async function archivarAnio(anio, { dryRun = !WRITE } = {}) {
  const desde = `${anio}-01-01`
  const hasta = `${anio}-12-31`
  // `sinLineItem` se cuenta aparte a propósito: si sube y `autoRenew` queda en 0,
  // el problema es el vínculo ticket→LI, no que no haya planes auto-renovables.
  const resumen = { anio, vistos: 0, sinLineItem: 0, autoRenew: 0, archivados: 0, borrados: 0, errores: 0 }

  logger.info({ module: jobName, anio, desde, hasta, dryRun }, '[ENERO] Paso 1 — archivo de auto-renew')

  // ⚠️ `fecha_resolucion_esperada` es una prop `date` de HubSpot: el Search API la
  // filtra por EPOCH-MS, no por 'YYYY-MM-DD' (ese formato devuelve HTTP 400 — el
  // mismo motivo por el que cronDealsBatch arma sus rangos con ymdToMsUTC).
  const filters = [
    {
      propertyName: 'fecha_resolucion_esperada',
      operator: 'BETWEEN',
      value: ymdToMidnightUTCMillis(desde),
      highValue: ymdToMidnightUTCMillis(hasta),
    },
  ]
  if (TICKET_PIPELINE) {
    filters.push({ propertyName: 'hs_pipeline', operator: 'EQ', value: String(TICKET_PIPELINE) })
  }

  await paginar(
    (after) => hubspotClient.crm.tickets.searchApi.doSearch({
      filterGroups: [{ filters }],
      properties: TICKET_PROPS_ARCHIVO,
      sorts: [{ propertyName: 'hs_object_id', direction: 'ASCENDING' }],
      limit: PAGE_LIMIT,
      after: after || undefined,
    }),
    async (tickets) => {
      for (const t of tickets) {
        resumen.vistos++
        try {
          const liId = lineItemDeTicket(t)
          if (!liId) { resumen.sinLineItem++; continue }
          if (!(await esLineItemAutoRenew(liId))) continue
          resumen.autoRenew++

          if (dryRun) continue

          await archivarTicketAutoRenew(t, { anio })
          resumen.archivados++

          if (BORRA_EN_HUBSPOT) {
            await withRetry(() => hubspotClient.crm.tickets.basicApi.archive(String(t.id)))
            await pool.query(
              `UPDATE tickets_auto_renew_archivo SET borrado_en_hubspot = true WHERE ticket_id = $1`,
              [String(t.id)]
            )
            resumen.borrados++
          }
        } catch (err) {
          resumen.errores++
          logger.error({ module: jobName, ticketId: t.id, err: err?.message }, '[ENERO] falló el archivo de un ticket')
          await insertCronFailure({ jobName, dealId: t.properties?.of_deal_id, errorMsg: err?.message, context: { paso: 'archivo', ticketId: t.id, anio } })
        }
      }
    }
  )

  logger.info({ module: jobName, ...resumen, dryRun }, '[ENERO] Paso 1 terminado')
  return resumen
}

// ==============================================================================
// (no hay paso de "generar los tickets del año siguiente" — NO HACE FALTA)
// ==============================================================================
//
// Verificado en el código el 7-ago-2026: para un LI auto-renew, phaseP arma el
// cronograma con `maxCount = hardMax = 24` (`phasep.js:520,538-539`), o sea
// mantiene **24 períodos rodantes por delante del piso**, y el piso lo marca lo
// ya notificado/emitido (`resolveFloorSourceYmd`). No existe ninguna frontera de
// año en el cálculo: el año Y+1 ya está generado mucho antes de llegar a él, y se
// re-extiende solo cada vez que el motor pasa por el deal.
//
// Por eso este cron NO genera tickets. Hacerlo sería una segunda fuente de verdad
// sobre el cronograma, compitiendo con phaseP.

// ==============================================================================
// PASO 2 — TC USD a los negocios ganados / en ejecución
// ==============================================================================
//
// 🔴 ESTE PASO NO TOCA `dolar`, A PROPÓSITO.
//
// `dolar` es el divisor de los cálculos: monto_usd = precio×cantidad ÷ dolar, y
// hs_cost_of_goods_sold = costo_total_usd × dolar. Es UN solo valor por negocio,
// congelado al alta y al cierre-ganado. Pisarlo cada 1 de enero no le pondría "el
// TC del año nuevo a lo nuevo": le cambiaría los montos en USD y el COGS a TODO
// el histórico del negocio, incluidas las facturas ya emitidas. Una sola
// propiedad no puede sostener un TC distinto por año.
//
// 🙋 PREGUNTA ABIERTA para la usuaria: si lo que se quiere es que las facturas de
//    cada año usen el TC de ese año, la solución NO es re-congelar `dolar` en el
//    negocio sino sellar el TC en cada TICKET al emitirlo (el ticket ya tiene su
//    propia prop `dolar`). Definir antes de tocar nada.

const DEAL_PROPS_TC = ['pais_operativo', 'deal_currency_code', 'dolar', TC_USD_PROP]

export async function asignarTcUsd(fechaTc, { dryRun = !WRITE } = {}) {
  const stages = [DEAL_STAGE_WON, DEAL_STAGE_EN_EJECUCION].filter(Boolean)
  const resumen = { fechaTc, stages, vistos: 0, actualizados: 0, sinCambio: 0, sinCotizacion: 0, errores: 0 }

  if (!stages.length) {
    logger.error({ module: jobName }, '[ENERO] Paso 3 abortado: no hay deal stages configurados (DEAL_STAGE_85 / DEAL_STAGE_95)')
    resumen.errores++
    return resumen
  }

  logger.info({ module: jobName, fechaTc, stages, dryRun }, '[ENERO] Paso 3 — TC USD')

  // Una sola lectura por moneda: el TC del 1 de enero es el mismo para todos los
  // negocios del mismo país. Nada de una query por deal.
  const tcPorMoneda = {}
  for (const moneda of ['UYU', 'PYG']) {
    tcPorMoneda[moneda] = await resolveTcUsdParaDeal({ pais_operativo: moneda === 'PYG' ? 'Paraguay' : 'Uruguay' }, fechaTc)
    logger.info({ module: jobName, moneda, tc: tcPorMoneda[moneda] }, '[ENERO] TC resuelto')
  }

  let pendientes = []

  const flush = async () => {
    if (!pendientes.length) return
    const inputs = pendientes.splice(0, pendientes.length)
    if (dryRun) { resumen.actualizados += inputs.length; return }
    try {
      await withRetry(() => hubspotClient.crm.deals.batchApi.update({ inputs }))
      resumen.actualizados += inputs.length
    } catch (err) {
      resumen.errores += inputs.length
      logger.error({ module: jobName, err: err?.message, n: inputs.length }, '[ENERO] batch update de TC USD falló')
      await insertCronFailure({ jobName, errorMsg: err?.message, context: { paso: 'tc_usd', ids: inputs.map(i => i.id) } })
    }
  }

  await paginar(
    (after) => hubspotClient.crm.deals.searchApi.doSearch({
      filterGroups: [{ filters: [{ propertyName: 'dealstage', operator: 'IN', values: stages }] }],
      properties: DEAL_PROPS_TC,
      sorts: [{ propertyName: 'hs_object_id', direction: 'ASCENDING' }],
      limit: PAGE_LIMIT,
      after: after || undefined,
    }),
    async (deals) => {
      for (const d of deals) {
        resumen.vistos++
        const moneda = monedaDePais(d.properties?.pais_operativo)
        const tc = tcPorMoneda[moneda]
        if (!tc) { resumen.sinCotizacion++; continue }

        const actual = Number(d.properties?.[TC_USD_PROP])
        if (Number.isFinite(actual) && Math.abs(actual - tc.rate) < 1e-6) {
          resumen.sinCambio++
          continue
        }

        pendientes.push({ id: String(d.id), properties: { [TC_USD_PROP]: String(tc.rate) } })
        if (pendientes.length >= BATCH_LIMIT) await flush()
      }
    }
  )
  await flush()

  logger.info({ module: jobName, ...resumen, dryRun }, '[ENERO] Paso 3 terminado')
  return resumen
}

// ==============================================================================
// Entry point
// ==============================================================================

export async function runPrimeroDeEneroCron({ anio = null, dryRun = !WRITE } = {}) {
  const anioActual = anio || new Date().getUTCFullYear()
  const v = resolverVentana(anioActual)

  logger.info({ module: jobName, ...v, dryRun, borraEnHubspot: BORRA_EN_HUBSPOT },
    `[ENERO] Iniciando cron anual${dryRun ? ' (DRY-RUN)' : ''}`)

  // Paso 1 — va PRIMERO. Si rompe, no seguimos: el orden es un requisito, no una
  // preferencia, y sellar el TC sobre un universo de tickets a medio archivar
  // dejaría el año en un estado difícil de auditar.
  const archivo = await archivarAnio(v.anioArchivo, { dryRun })
  if (archivo.errores > 0 && !dryRun) {
    logger.error({ module: jobName, archivo }, '[ENERO] Paso 1 con errores — NO se ejecuta el paso 2')
    return { success: false, paso: 'archivo', archivo }
  }

  const tc = await asignarTcUsd(v.fechaTc, { dryRun })

  const yaArchivados = await contarArchivadosDelAnio(v.anioArchivo).catch(() => null)

  const resultado = { success: tc.errores === 0, ventana: v, archivo, tc, yaArchivados, dryRun }
  logger.info({ module: jobName, ...resultado }, '[ENERO] Cron completado')
  return resultado
}

// --- CLI ----------------------------------------------------------------------

const isDirectRun =
  typeof process.argv[1] === 'string' &&
  import.meta.url === pathToFileURL(process.argv[1]).href

if (isDirectRun) {
  await initExchangeRatesTable()
  await initTicketsAutoRenewArchivoTable()
  await initCronFailuresTable()

  const t0 = Date.now()
  const result = await runPrimeroDeEneroCron({ anio: parseArgAnio() })

  await sendSummary({
    jobName,
    mode: `1-ene ${result.ventana?.anioActual}${result.dryRun ? ' · DRY-RUN' : ''}`,
    processed: (result.archivo?.vistos ?? 0) + (result.tc?.vistos ?? 0),
    ok: (result.archivo?.archivados ?? 0) + (result.tc?.actualizados ?? 0),
    failed: (result.archivo?.errores ?? 0) + (result.tc?.errores ?? 0),
    elapsedMs: Date.now() - t0,
  }).catch(() => {})
  await pingHeartbeat('enero').catch(() => {})

  if (!result.success) process.exitCode = 1
  await pool.end()
}
