// src/services/deal/recalcValorTotal.js
//
// Calcula el campo VALOR del negocio (deal) a partir de sus LINE ITEMS, según la
// definición de Paola (correo 2026-07-02) — decisión Michelle 2026-07-10: se toma
// del LINE ITEM (no del ticket); cualquier ajuste se hace editando el LI, y los
// cambios de criterio van por control de cambios.
//
//   Caso 1 — contrato/proyecto con fin definido:
//       VALOR_li = precio_unitario × cantidad × (nº total de pagos del término)
//       (= Σ de todos los flujos del line item)
//
//   Caso 2 — auto-renovación (sin fecha de fin):
//       VALOR_li = precio_unitario × cantidad × multiplicador_anual
//       multiplicador_anual = periodicidad normalizada a base anual
//       (mensual ×12, trimestral ×4, semestral ×2, anual ×1, …)
//
//   VALOR_total_local = Σ VALOR_li  (en la moneda del negocio)
//
// Un mismo negocio puede mezclar LIs Caso 1 y Caso 2 → se clasifica POR LINE ITEM
// con el helper canónico `isAutoRenew` (src/services/billing/mode.js).
//
//   Caso MIRROR (intercompany, es_mirror_de_py=true):
//       VALOR = Σ costo_total_usd de los LIs (el costo en USD). NO se usa el price
//       (el mirror no lleva precio de venta) ni se fuerza a 0. Ver valorMirrorUsd()
//       para el porqué — no confundir con la facturación intercompany (esa sí es 0).
//       🔴 2026-07-15 — ESTO ESTÁ CUESTIONADO, NO LO TOMES COMO VERDAD. La premisa
//       "el mirror no lleva precio de venta" es FALSA para los mirrors migrados:
//       Paso B' les escribe el price REAL del twin UY. Resultado: hoy el VALOR del
//       mirror muestra su COSTO y no su INGRESO. Leer el ⚠️ de valorMirrorUsd()
//       abajo antes de tocar nada. Decisión pendiente de la usuaria.
//
// Moneda: se escriben propiedades del deal (Michelle 2026-07-10):
//   - `valor_total`                  → VALOR en USD  (principal, para reporting)
//   - `valor_total_moneda_original`  → VALOR en la moneda del negocio
//   - `margen_total_usd`             → MARGEN bruto en USD = valor_total − costo total
//     proyectado al mismo horizonte (2026-07-18). Mirror intercompany = 0. Ver
//     costoProyectadoUsd(). Override de nombre por env PROP_DEAL_MARGEN.
// La conversión usa el `dolar` del DEAL (1 USD → moneda del negocio), que setea
// `ensureDealDolar` en creación + cierre-ganado (y refresh anual futuro, cron 1-ene).
//
// Es un campo DINÁMICO: se recalcula al final de runPhasesForDeal, por lo que queda
// cubierto por los tres disparadores (runBilling, cronWeekendFull, webhook).
//
// PENDIENTE / control de cambios (ver PREGUNTAS_VALOR_reunion_lunes_2026-07-13.md):
//   - TC "mixto" del Caso 1 de Paola (facturado al TC del día + proyección al TC de
//     creación). Hoy se usa un único `dolar` del deal para todo el total. Aislado en
//     convertirAUsd() para cambiarlo sin tocar el resto.

import { hubspotClient, getDealWithLineItems } from '../../hubspotClient.js';
import { ensureDealDolar } from '../costoUsdService.js';
import { isAutoRenew } from '../billing/mode.js';
import { TICKET_STAGES, BILLING_AUTOMATED_CANCELLED } from '../../config/constants.js';
import logger from '../../../lib/logger.js';

const MOD = 'recalcValorTotal';

// Props destino (override por env para renombrar sin tocar código).
const PROP_DEAL_TOTAL_USD = process.env.PROP_DEAL_TOTAL || 'valor_total';
const PROP_DEAL_TOTAL_LOCAL =
  process.env.PROP_DEAL_TOTAL_LOCAL || 'valor_total_moneda_original';

// Margen bruto del negocio en USD (mismo horizonte que el VALOR).
const PROP_DEAL_MARGEN_USD = process.env.PROP_DEAL_MARGEN || 'margen_total_usd';

// Propiedad del TICKET que apunta al deal (usada solo por el diagnóstico legacy).
const PROP_TICKET_DEAL_ID = process.env.PROP_TICKET_DEAL_ID || 'of_deal_id';

// Stages de ticket cancelados (solo para el diagnóstico legacy getDealTicketIds).
const CANCELLED = new Set(
  [TICKET_STAGES.CANCELLED, BILLING_AUTOMATED_CANCELLED].filter(Boolean)
);

// Multiplicador anual por periodicidad (pagos por año). Cubre los internal values
// nativos de `recurringbillingfrequency` y los labels ES más comunes. Coherente con
// getIntervalFromFrequency de billingEngine.js (12 / meses; semanal/quincenal por días).
const ANNUAL_MULTIPLIER = {
  weekly: 52, semanal: 52,
  biweekly: 26, quincenal: 26,
  monthly: 12, mensual: 12,
  bimonthly: 6, bi_monthly: 6, every_two_months: 6, bimestral: 6,
  quarterly: 4, trimestral: 4,
  per_six_months: 2, semiannually: 2, semi_annually: 2, semestral: 2,
  annually: 1, annual: 1, anual: 1, yearly: 1,
  per_two_years: 0.5,
  per_three_years: 1 / 3,
  per_four_years: 0.25,
  per_five_years: 0.2,
};

/** Número finito o `dflt` (evita que '0' se convierta en el default). */
function num(v, dflt = 0) {
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : dflt;
}

const round2 = (n) => Math.round(n * 100) / 100;

/** Multiplicador anual de un LI auto-renew; default monthly=12 (+warn) si no matchea. */
function multiplicadorAnual(freqRaw, log) {
  const f = String(freqRaw ?? '').trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(ANNUAL_MULTIPLIER, f)) {
    return ANNUAL_MULTIPLIER[f];
  }
  log?.warn(
    { freq: freqRaw },
    'Periodicidad no reconocida en LI auto-renew; se asume mensual (×12)'
  );
  return 12;
}

/**
 * VALOR de un line item en la moneda del negocio, según Caso 1 / Caso 2.
 * @returns {number}
 */
export function valorLineItemLocal(li, log) {
  const p = li?.properties || {};
  const price = num(p.price, 0);
  const qty = num(p.quantity, 1);
  const base = price * qty; // flujo por período (precio unitario × cantidad)

  if (isAutoRenew(li)) {
    // Caso 2 — auto-renew: run-rate anual.
    const freq = p.recurringbillingfrequency || p.hs_recurring_billing_frequency;
    return base * multiplicadorAnual(freq, log);
  }

  // Caso 1 — fin definido / one-off: Σ de todos los flujos = base × nº de pagos.
  const term = num(p.hs_recurring_billing_number_of_payments ?? p.number_of_payments, 1);
  return base * term;
}

/**
 * Convierte el total en moneda local a USD usando el `dolar` del deal
 * (1 USD → moneda del negocio). Aislada a propósito: acá entra, si se define,
 * el TC mixto del Caso 1 de Paola (control de cambios).
 * @returns {number|null} USD, o null si no hay dólar utilizable.
 */
function convertirAUsd(totalLocal, dolar) {
  if (!(dolar > 0)) return null;
  return round2(totalLocal / dolar);
}

/**
 * Trae TODOS los IDs de tickets de un deal (of_deal_id ∪ asociaciones, dedup).
 * LEGACY: la usa scripts/diagnostics/diagValorTotal.mjs (auditoría ticket-por-ticket).
 * El cálculo de VALOR ya NO usa tickets; se conserva solo para el diagnóstico.
 */
export async function getDealTicketIds(dealId) {
  const ids = new Set();

  let after;
  do {
    const res = await hubspotClient.crm.tickets.searchApi.doSearch({
      filterGroups: [{ filters: [{ propertyName: PROP_TICKET_DEAL_ID, operator: 'EQ', value: String(dealId) }] }],
      properties: ['hs_object_id'],
      limit: 100,
      after,
    });
    for (const t of res.results || []) ids.add(String(t.id));
    after = res.paging?.next?.after;
  } while (after);

  let aAfter;
  do {
    const resp = await hubspotClient.crm.associations.v4.basicApi.getPage(
      'deals', String(dealId), 'tickets', 500, aAfter
    );
    for (const r of resp.results || []) ids.add(String(r.toObjectId));
    aAfter = resp.paging?.next?.after;
  } while (aAfter);

  return [...ids];
}

// Props del deal necesarias para convertir, clasificar (mirror) y comparar.
const DEAL_PROPS = [
  'dolar',
  'deal_currency_code',
  'dealstage',
  'dolar_cierre_asignado',
  'es_mirror_de_py',
  PROP_DEAL_TOTAL_USD,
  PROP_DEAL_TOTAL_LOCAL,
  PROP_DEAL_MARGEN_USD,
];

/**
 * VALOR en USD de un deal MIRROR (intercompany, es_mirror_de_py=true).
 *
 * ⚠️ NO CONFUNDIR (este error ya se cometió una vez, 2026-07-10):
 *   - La FACTURACIÓN intercompany del mirror sí es 0 para informes (of_facturacion_usd),
 *     para no duplicar el ingreso — la venta al cliente vive en el deal PY.
 *   - Pero el VALOR del negocio NO es 0: el mirror vale su COSTO. El mirror no lleva
 *     precio de venta (su `price` suele ser 0), así que su valor sale de
 *     `costo_total_usd` (fuente de verdad del costo, YA en USD; cogs es derivada).
 *
 * 🔴 ⚠️ 2026-07-15 — LEER ANTES DE TOCAR. Lo de arriba tiene DOS supuestos rotos y hoy
 * esta función devuelve el número equivocado. DECISIÓN PENDIENTE de la usuaria; se deja
 * como está a propósito hasta que decida (NO "arreglar" sin confirmar).
 *
 *   1) "el mirror no lleva precio de venta (su price suele ser 0)" → FALSO para los
 *      mirrors MIGRADOS: Paso B' (`migracion_pasoBprima_mirror.mjs`, twinPropsParaMirror)
 *      les escribe el price REAL del twin UY.
 *   2) "el mirror vale su COSTO" → la frase "costo intercompany" es AMBIGUA y ahí se
 *      coló el error: se pensó como *lo que PY le paga a UY* (= el ingreso del mirror,
 *      que vive en `price`), pero se implementó como *el costo propio de UY* (que es lo
 *      que trae `costo_total_usd` después de B'). Son cosas DISTINTAS.
 *
 * ⚠️ OJO — NO confundir este tema con el "Excel de MB de Pablo". Son DOS cosas:
 *   - Los ~21 mirrors con VALOR 0  → el costo del twin es 0 en el ORIGEN (Fact Est con
 *     Mbrt=Monto, el bug del Excel). Con la regla de HOY eso da 0, y el Excel SÍ lo
 *     arregla. Es un problema de DATO.
 *   - Esto de acá                  → el VALOR lee el campo equivocado. NINGÚN Excel lo
 *     arregla. Es un problema de REGLA. Eidas lo prueba: TIENE costo real (25.437) y
 *     aun así muestra 25.437 en vez de los 33.000 que factura.
 *
 * Evidencia (pruebas 51101688, 15-jul) — Eidas separa las dos hipótesis:
 *   `Eidas … - UY`        amount=33.000  valor_total=25.437  (LI: price=33.000, costo_total_usd=25.437)
 *   `EESS y FLOTA - UY`   amount= 3.500  valor_total=     0  (LI: price= 3.500, costo_total_usd=0)
 * El mirror Eidas está PERFECTO: ingreso 33.000 (= costo del PY, regla N-D8) + costo
 * propio 25.437 + margen 7.563. El único error es QUÉ CAMPO LEE EL VALOR.
 *
 * Nota: por la regla general (VALOR = Σ price×qty) el mirror ya caería solo en 33.000
 * → este caso especial podría sobrar. Y OJO: no está verificado si los mirrors que crea
 * el MOTOR (dealMirroring.js setea props.price, no se vio que escriba costo_total_usd en
 * el LI del mirror) sufren lo mismo → posible impacto en PROD.
 * Detalle: definitivos/TAREAS_PENDIENTES.md (🔴 VALOR) + BITACORA_trabajo.md (15-jul).
 *
 * @returns {number} Σ costo_total_usd de los LIs (USD).
 */
export function valorMirrorUsd(lis, log) {
  let usd = 0;
  let sinCosto = 0;
  for (const li of lis) {
    const c = num(li?.properties?.costo_total_usd, NaN);
    if (Number.isFinite(c)) usd += c;
    else sinCosto++;
  }
  if (sinCosto > 0) {
    log?.warn({ sinCosto, total: lis.length }, 'Mirror con LIs sin costo_total_usd cargado');
  }
  return round2(usd);
}

/**
 * Costo total del deal en USD, proyectado al MISMO horizonte que el VALOR:
 *   - normal  → Σ costo_total_usd × (nº de pagos | multiplicador anual)  (igual criterio
 *               de horizonte que valorLineItemLocal: Caso 1 × plazo, Caso 2 × anual)
 *   - mirror  → Σ costo_total_usd SIN proyectar (valorMirrorUsd tampoco proyecta) → así el
 *               margen del mirror da 0 (pass-through intercompany), sin depender de la
 *               decisión pendiente del VALOR del espejo.
 * `costo_total_usd` ausente = costo no cargado = 0 (criterio: margen = ingreso; ver
 * CHECKLIST_of_costo_usd_calc). Devuelve USD.
 */
function costoProyectadoUsd(lis, esMirror, log) {
  let usd = 0;
  for (const li of lis) {
    const p = li?.properties || {};
    const c = num(p.costo_total_usd, NaN);
    if (!Number.isFinite(c)) continue;
    if (esMirror) {
      usd += c;
    } else {
      const mult = isAutoRenew(li)
        ? multiplicadorAnual(p.recurringbillingfrequency || p.hs_recurring_billing_frequency, log)
        : num(p.hs_recurring_billing_number_of_payments ?? p.number_of_payments, 1);
      usd += c * mult;
    }
  }
  return round2(usd);
}

/**
 * Recalcula el VALOR del deal desde sus line items y escribe las dos props.
 *
 * @param {object}   params
 * @param {string}   params.dealId
 * @param {Array}    [params.lineItems]  - LIs ya cargados (hot path); si no, se traen.
 * @param {boolean}  [params.applyUpdate=true] - si false, solo calcula (no escribe).
 * @returns {Promise<{ total: number|null, totalUsd: number|null, totalLocal: number,
 *                     lineItemCount: number, changed: boolean }>}
 *          `total` = valor principal escrito en valor_total (USD).
 */
export async function recalcValorTotal({ dealId, lineItems = null, applyUpdate = true }) {
  const log = logger.child({ module: MOD, dealId });

  // 1) Line items (fuente del cálculo). Se usan los del caller (hot path) solo si
  // vienen con props completas; si están ausentes o sin `price`, se traen frescos
  // para no sub-reportar por props faltantes.
  let lis = Array.isArray(lineItems) ? lineItems : null;
  const sparse = lis && lis.length > 0 && lis[0]?.properties?.price === undefined;
  if (!lis || sparse) {
    const dwli = await getDealWithLineItems(dealId);
    lis = dwli.lineItems || [];
  }

  // 2) Props del deal (para el dólar, clasificar mirror y comparar antes de escribir).
  let dp = {};
  try {
    const cur = await hubspotClient.crm.deals.basicApi.getById(String(dealId), DEAL_PROPS);
    dp = cur?.properties || {};
  } catch (err) {
    log.warn({ err }, 'No se pudieron leer props del deal; se intentará igual');
  }

  // 3) Dólar del deal (1 USD → moneda local). Si falta y vamos a escribir, se
  // establece con ensureDealDolar. En modo dry (applyUpdate=false) NO se toca nada:
  // si no hay dólar, el VALOR en la moneda que falte queda sin calcular (null).
  let dolar = num(dp.dolar, 0);
  if (!(dolar > 0) && applyUpdate) {
    try {
      const r = await ensureDealDolar({ id: String(dealId), properties: dp });
      dolar = num(r?.dolar, 0);
    } catch (err) {
      log.warn({ err }, 'ensureDealDolar falló; VALOR quedará sin calcular en la moneda faltante');
    }
  }

  // 4) VALOR según el tipo de deal:
  //    - MIRROR (intercompany): su valor es el COSTO en USD (costo_total_usd). Ver
  //      valorMirrorUsd() para el porqué (no es el price, NO es 0). El local = USD×dolar.
  //    - Resto: desde el price del LI (fórmula Paola). El USD = local/dolar.
  const esMirror = String(dp.es_mirror_de_py || '').trim().toLowerCase() === 'true';
  let totalUsd;
  let totalLocal;
  if (esMirror) {
    totalUsd = valorMirrorUsd(lis, log);
    if (dolar > 0) totalLocal = round2(totalUsd * dolar);
    else if (String(dp.deal_currency_code || '').toUpperCase() === 'USD') totalLocal = totalUsd;
    else totalLocal = null; // sin dólar y moneda ≠ USD: no se puede expresar en local
  } else {
    totalLocal = 0;
    for (const li of lis) totalLocal += valorLineItemLocal(li, log);
    totalLocal = round2(totalLocal);
    totalUsd = convertirAUsd(totalLocal, dolar);
  }

  // 4b) Margen bruto del negocio en USD = VALOR USD − costo total proyectado (mismo
  //     horizonte que el VALOR). Null si el VALOR en USD no es calculable (sin dólar y
  //     moneda ≠ USD) → no se escribe.
  const costoUsd = costoProyectadoUsd(lis, esMirror, log);
  const margenUsd = totalUsd !== null ? round2(totalUsd - costoUsd) : null;

  // 5) Escribir solo lo que cambió (y solo valores calculables, nunca null).
  let changed = false;
  if (applyUpdate) {
    const properties = {};
    if (totalLocal !== null && num(dp[PROP_DEAL_TOTAL_LOCAL], NaN) !== totalLocal) {
      properties[PROP_DEAL_TOTAL_LOCAL] = String(totalLocal);
    }
    if (totalUsd !== null && num(dp[PROP_DEAL_TOTAL_USD], NaN) !== totalUsd) {
      properties[PROP_DEAL_TOTAL_USD] = String(totalUsd);
    }
    if (margenUsd !== null && num(dp[PROP_DEAL_MARGEN_USD], NaN) !== margenUsd) {
      properties[PROP_DEAL_MARGEN_USD] = String(margenUsd);
    }

    if (Object.keys(properties).length > 0) {
      await hubspotClient.crm.deals.basicApi.update(String(dealId), { properties });
      changed = true;
      log.info(
        { esMirror, totalUsd, totalLocal, margenUsd, dolar, lineItems: lis.length, wrote: Object.keys(properties) },
        'VALOR actualizado'
      );
    } else {
      log.debug({ esMirror, totalUsd, totalLocal, lineItems: lis.length }, 'VALOR sin cambios');
    }
  }

  return { total: totalUsd, totalUsd, totalLocal, margenUsd, esMirror, lineItemCount: lis.length, changed };
}
