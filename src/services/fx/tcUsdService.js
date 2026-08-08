// src/services/fx/tcUsdService.js
//
// TC USD — el tipo de cambio INFORMATIVO del negocio.
//
// QUÉ ES (decisión usuaria 6-ago-2026, refina la del 30-jul):
//   El valor del dólar del PAÍS OPERATIVO (UYU vía BCU, o PYG vía BCP si el país
//   operativo es Paraguay) congelado a una fecha, y visible en cards, vistas e
//   informes — SIEMPRE, aunque el negocio esté en USD.
//
// 🔴 LO QUE NO ES: no es divisor y no reemplaza a `dolar`.
//   `monto_usd` = price×quantity ÷ `dolar`  y  hs_cost_of_goods_sold = costo_total_usd × `dolar`.
//   En un negocio en USD `dolar` vale 1 y DEBE seguir valiendo 1. Ese es el punto
//   entero de que sean dos propiedades: `dolar` calcula, TC USD muestra.
//
// ⚠️ NO CONFUNDIR CON `tc_pesos`. `tc_pesos` es LEGACY: tiene valores sellados con
//   las reglas viejas (sólo 2 momentos, y el PYG sin pasar por el BCP). Se deja
//   quieta, con lo que ya tenga. Lo nuevo va todo a `tc_usd` (decisión usuaria
//   7-ago-2026) para que no quede una columna donde no se sepa con qué criterio
//   se llenó cada fila. Usar siempre la constante TC_USD_PROP, nunca el literal.
//
// POR QUÉ LEE LA TABLA Y NO getDolar():
//   `getDolar()` (fxService.js) devuelve la cotización de HOY y, para PYG, NO
//   consulta el BCP — va a HubSpot y después a er-api. La tabla `exchange_rates`
//   sí tiene BCU (uyu_usd) y BCP (pyg_usd) fecha por fecha, cargadas a diario por
//   cronExchangeRates. Para un TC congelado "al día que corresponda" la única
//   fuente correcta es la tabla.

import pool from '../../db.js'
import logger from '../../../lib/logger.js'

/** Propiedad de deal. Label visible: «TC USD». Creada 7-ago-2026 en ambos portales. */
export const TC_USD_PROP = 'tc_usd'

/** La vieja. Legacy: se sigue escribiendo para no romper el export, pero no crece. */
export const TC_PESOS_PROP_LEGACY = 'tc_pesos'

/**
 * Moneda del país operativo. Paraguay → PYG (BCP); todo lo demás → UYU (BCU).
 * Misma regla que costoUsdService.ensureDealDolar, a propósito.
 */
export function monedaDePais(paisOperativo) {
  return String(paisOperativo || '').trim().toLowerCase() === 'paraguay' ? 'PYG' : 'UYU'
}

// Whitelist moneda→columna. Es lo que hace segura la interpolación en el SQL de
// abajo: el valor nunca viene del caller, sale de este mapa cerrado.
const COLUMNA_POR_MONEDA = { UYU: 'uyu_usd', PYG: 'pyg_usd' }

/**
 * Cotización vigente AL `ymd` o, si ese día no hubo publicación, la más reciente
 * anterior.
 *
 * Esto no es un detalle: el 1 de enero es feriado en los dos países y NUNCA tiene
 * cotización propia. El "TC al 1 de enero" es, en los hechos, el cierre del 31 de
 * diciembre — que es exactamente lo que devuelve este LIMIT 1 hacia atrás.
 *
 * @param {string} ymd     Fecha tope, 'YYYY-MM-DD'.
 * @param {'UYU'|'PYG'} moneda
 * @returns {Promise<{rate:number, date:string, moneda:string}|null>}
 */
export async function getTcOnOrBefore(ymd, moneda, { db = pool } = {}) {
  const col = COLUMNA_POR_MONEDA[moneda]
  if (!col) throw new Error(`[tcUsd] moneda no soportada: ${moneda}`)

  const res = await db.query(
    `SELECT to_char(date, 'YYYY-MM-DD') AS ymd, ${col} AS rate
       FROM exchange_rates
      WHERE date <= $1
        AND ${col} IS NOT NULL
      ORDER BY date DESC
      LIMIT 1`,
    [ymd]
  )

  const row = res.rows[0]
  const rate = Number(row?.rate)
  if (!row || !(rate > 0)) {
    logger.warn({ module: 'tcUsdService', fn: 'getTcOnOrBefore', ymd, moneda },
      '[TC_USD] sin cotización en exchange_rates para esa fecha o anterior')
    return null
  }

  return { rate, date: row.ymd, moneda }
}

/**
 * Resuelve el TC USD que le corresponde a un negocio para una fecha dada.
 * @param {object} dealProperties  propiedades del deal (necesita `pais_operativo`)
 */
export async function resolveTcUsdParaDeal(dealProperties, ymd, opts = {}) {
  const moneda = monedaDePais(dealProperties?.pais_operativo)
  return getTcOnOrBefore(ymd, moneda, opts)
}

/**
 * LA REGLA (usuaria, 8-ago-2026). `tc_usd` vale LO MISMO que `dolar`, salvo cuando
 * la moneda del negocio es USD: ahí `dolar` vale 1 (lo necesitan los cálculos) y
 * `tc_usd` muestra la cotización real — BCU si el país operativo es Uruguay, BCP
 * si es Paraguay.
 *
 * Copiar `dolar` en vez de re-consultar la cotización NO es un atajo: es lo que
 * garantiza que en las vistas los dos números coincidan exactamente. Si acá se
 * volviera a pedir la cotización del día, un negocio en UYU mostraría un `dolar`
 * congelado al alta y un `tc_usd` de hoy, y parecerían un error de datos.
 *
 * @returns {Promise<{rate:number, fuente:string, date?:string}|null>}
 */
export async function resolveTcUsd({ dolar, currency, paisOperativo, ymd }, opts = {}) {
  const cur = String(currency || 'USD').toUpperCase()

  if (cur !== 'USD') {
    const d = Number(dolar)
    return d > 0 ? { rate: d, fuente: 'dolar' } : null
  }

  const moneda = monedaDePais(paisOperativo)
  const tc = await getTcOnOrBefore(ymd, moneda, opts)
  if (!tc) return null
  return { rate: tc.rate, fuente: moneda === 'PYG' ? 'BCP' : 'BCU', date: tc.date }
}
