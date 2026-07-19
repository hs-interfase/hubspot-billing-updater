// src/services/deal/recalcValorTotal.js
//
// Calcula el VALOR y el MARGEN del negocio (deal) a partir de sus TICKETS.
//
// ─────────────────────────────────────────────────────────────────────────────
//  REGLA VIGENTE — definición de la usuaria, 2026-07-19. LEER ANTES DE TOCAR.
// ─────────────────────────────────────────────────────────────────────────────
//
//   VALOR_local  = Σ subtotal_real de los tickets del negocio   (moneda del negocio)
//   VALOR_USD    = VALOR_local / dolar del NEGOCIO
//   COSTO_USD    = Σ of_costo_usd de ESOS MISMOS tickets
//   MARGEN_USD   = VALOR_USD − COSTO_USD
//
// EXCEPCIÓN AUTO-RENEW (usuaria 2026-07-19): un contrato de auto-renovación no tiene fin,
//   así que sumar todos sus tickets no significa nada. Para esos se toma **1 año**, y el año
//   es el CALENDARIO EN CURSO (1-ene → 31-dic). Elegido así para que empalme con el cron
//   del 1-ene: cada año el valor se recalcula solo y refleja el run-rate vigente, ya con la
//   paramétrica del año aplicada.
//     - ticket de plan fijo   → entra siempre
//     - ticket de auto-renew  → entra solo si su fecha cae en el año calendario en curso
//   Un mismo negocio puede mezclar ambos: la clasificación es POR TICKET.
//   Marcador de auto-renew en el ticket: `of_cantidad_de_pagos` vacío (auto-renew = tiene
//   frecuencia y NO tiene nº de pagos; ver isAutoRenew en services/billing/mode.js).
//
// POR QUÉ TICKETS Y NO LINE ITEMS (esto ya se implementó mal una vez, no repetirlo):
//   **El ticket tiene el valor REAL; el line item no necesariamente.** El LI es la
//   intención comercial; el ticket es lo que efectivamente se factura (y lo que el
//   responsable corrige antes de emitir). Por eso la fuente de verdad es el ticket.
//
//   ⚠️ El criterio de Paola ("se toma de line items", correo 2026-07-02) NO significaba
//   line items en el sentido técnico — Paola no es técnica. Lo que pedía es el valor del
//   negocio; la fuente correcta para eso son los tickets. NO volver a interpretarlo literal.
//
// ⚠️ LOS NEGOCIOS EN FORECAST **SÍ** TIENEN TICKETS. Están vinculados por la propiedad
//   `of_deal_id`, aunque NO estén asociados en el CRM (se asocian recién al cerrar
//   ganado, ver associateOnClosedWon). Por eso la búsqueda es POR PROPIEDAD (Search API)
//   y NO por asociaciones: leer por key NO asocia nada y el forecast queda intacto.
//   No "arreglar" esto pasándolo a asociaciones — rompería el forecast entero.
//
// SIMETRÍA VALOR ↔ COSTO (invariante): el costo se suma sobre EXACTAMENTE el mismo
//   conjunto de tickets que el valor. Un ticket que no entra en el VALOR tampoco entra
//   en el COSTO. Si algún día se filtra por algo, se filtra UNA sola vez (getDealTickets)
//   y ambos lados heredan el filtro. NO duplicar el criterio de filtrado.
//
// MIRROR (es_mirror_de_py=true): **sin caso especial** (decisión usuaria 2026-07-19).
//   Se calcula igual que cualquier negocio, desde sus propios tickets. Como el price del
//   espejo ES el costo del original (regla N-D8), el número sale bien solo. El viejo
//   `valorMirrorUsd()` (Σ costo_total_usd de los LIs) queda ELIMINADO — mostraba el costo
//   propio de UY en vez del ingreso intercompany.
//
// Tickets CANCELADOS quedan fuera del cálculo (ambos lados).
//
// Props que se escriben en el deal:
//   - `valor_total`                  → VALOR en USD (principal, para reporting)
//   - `valor_total_moneda_original`  → VALOR en la moneda del negocio
//   - `margen_total_usd`             → MARGEN bruto en USD
//   (los tres con override de nombre por env)
//
// Es un campo DINÁMICO: se recalcula al final de runPhasesForDeal, por lo que queda
// cubierto por los tres disparadores (runBilling, cronWeekendFull, webhook).
//
// PENDIENTE / control de cambios:
//   - TC "mixto" del Caso 1 de Paola (facturado al TC del día de cada factura + proyección
//     al TC de creación). Hoy se usa un único `dolar` del deal para todo el total, aislado
//     en convertirAUsd() para cambiarlo sin tocar el resto. Cada ticket ya trae su propio
//     `dolar` sellado si algún día se quiere TC por ticket.

import { hubspotClient } from '../../hubspotClient.js';
import { ensureDealDolar } from '../costoUsdService.js';
import { TICKET_STAGES, BILLING_AUTOMATED_CANCELLED } from '../../config/constants.js';
import logger from '../../../lib/logger.js';

const MOD = 'recalcValorTotal';

// Props destino (override por env para renombrar sin tocar código).
const PROP_DEAL_TOTAL_USD = process.env.PROP_DEAL_TOTAL || 'valor_total';
const PROP_DEAL_TOTAL_LOCAL =
  process.env.PROP_DEAL_TOTAL_LOCAL || 'valor_total_moneda_original';

// Margen bruto del negocio en USD (mismo horizonte que el VALOR).
const PROP_DEAL_MARGEN_USD = process.env.PROP_DEAL_MARGEN || 'margen_total_usd';

// Propiedad del TICKET que apunta al deal. Es el vínculo que usan los forecast
// (desasociados en el CRM) — la clave de todo el cálculo.
const PROP_TICKET_DEAL_ID = process.env.PROP_TICKET_DEAL_ID || 'of_deal_id';

// Stages de ticket cancelados: quedan FUERA del VALOR y del COSTO (getDealTickets).
const CANCELLED = new Set(
  [TICKET_STAGES.CANCELLED, BILLING_AUTOMATED_CANCELLED].filter(Boolean)
);

/** Número finito o `dflt` (evita que '0' se convierta en el default). */
function num(v, dflt = 0) {
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : dflt;
}

const round2 = (n) => Math.round(n * 100) / 100;

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

// Props del TICKET que necesita el cálculo.
const TICKET_PROPS = [
  'hs_object_id',
  'hs_pipeline_stage',
  'subtotal_real',        // neto en moneda del negocio (fuente del VALOR)
  'of_costo_usd',         // costo en USD del ticket (fuente del COSTO)
  'of_cantidad_de_pagos', // vacío ⇒ auto-renew (ver isAutoRenew)
  'fecha_resolucion_esperada',
];

/**
 * ¿El ticket viene de un line item AUTO-RENEW?
 * Auto-renew = tiene frecuencia y NO tiene nº de pagos (services/billing/mode.js).
 * En el snapshot del ticket eso se ve como `of_cantidad_de_pagos` vacío/null.
 */
function esTicketAutoRenew(tp) {
  const pagos = tp?.of_cantidad_de_pagos;
  return pagos == null || String(pagos).trim() === '';
}

/**
 * ¿La fecha del ticket cae en el año calendario en curso?
 * Sin fecha ⇒ NO se puede ubicar en el año → se excluye del auto-renew (y se avisa),
 * para no inflar el run-rate con tickets sin fecha.
 */
function enAnioEnCurso(tp, anio) {
  const f = tp?.fecha_resolucion_esperada;
  if (!f) return false;
  return String(f).slice(0, 4) === String(anio);
}

/**
 * Trae los TICKETS de un deal con las props del cálculo.
 *
 * ⚠️ Busca por la PROPIEDAD `of_deal_id` (Search API), NO por asociaciones: los tickets
 * de forecast existen pero están DESASOCIADOS a propósito (se asocian al ganar). Leer por
 * propiedad no asocia nada. NO cambiar a asociaciones — dejaría fuera todo el forecast.
 *
 * Excluye los tickets CANCELADOS. Este es el ÚNICO lugar donde se filtra: VALOR y COSTO
 * se calculan después sobre el mismo array, así que la simetría queda garantizada.
 */
export async function getDealTickets(dealId) {
  const out = [];
  let after;
  do {
    const res = await hubspotClient.crm.tickets.searchApi.doSearch({
      filterGroups: [{ filters: [{ propertyName: PROP_TICKET_DEAL_ID, operator: 'EQ', value: String(dealId) }] }],
      properties: TICKET_PROPS,
      limit: 100,
      after,
    });
    for (const t of res.results || []) {
      if (CANCELLED.has(String(t.properties?.hs_pipeline_stage))) continue;
      out.push(t);
    }
    after = res.paging?.next?.after;
  } while (after);
  return out;
}

/**
 * Selecciona los tickets que entran en el cálculo:
 *   - plan fijo  → todos
 *   - auto-renew → solo los del año calendario en curso (1 año de run-rate)
 * Devuelve el mismo array que después consumen VALOR y COSTO (simetría).
 */
export function ticketsDelCalculo(tickets, anio, log) {
  const elegidos = [];
  let autoRenewFuera = 0;
  let sinFecha = 0;
  for (const t of tickets) {
    const tp = t?.properties || {};
    if (!esTicketAutoRenew(tp)) {
      elegidos.push(t);
      continue;
    }
    if (enAnioEnCurso(tp, anio)) {
      elegidos.push(t);
    } else {
      autoRenewFuera++;
      if (!tp.fecha_resolucion_esperada) sinFecha++;
    }
  }
  if (sinFecha > 0) {
    log?.warn(
      { sinFecha, anio },
      'Tickets auto-renew SIN fecha de resolución esperada: quedan fuera del VALOR (no se pueden ubicar en el año)'
    );
  }
  return { elegidos, autoRenewFuera };
}

/**
 * Trae TODOS los IDs de tickets de un deal (of_deal_id ∪ asociaciones, dedup).
 * LEGACY: la usa scripts/diagnostics/diagValorTotal.mjs (auditoría ticket-por-ticket).
 * El cálculo productivo usa getDealTickets(); esto se conserva solo para el diagnóstico.
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
 * Suma el VALOR en la moneda del negocio sobre los tickets ya seleccionados.
 * Fuente: `subtotal_real` (NETO, sin IVA — ver _shared/montoTicket.mjs de la migración).
 * @returns {number}
 */
export function valorLocalDesdeTickets(tickets, log) {
  let total = 0;
  let sinMonto = 0;
  for (const t of tickets) {
    const v = num(t?.properties?.subtotal_real, NaN);
    if (Number.isFinite(v)) total += v;
    else sinMonto++;
  }
  if (sinMonto > 0) {
    log?.warn({ sinMonto, total: tickets.length }, 'Tickets sin subtotal_real: no suman al VALOR');
  }
  return round2(total);
}

/**
 * Suma el COSTO en USD sobre EXACTAMENTE los mismos tickets que el VALOR.
 * Fuente: `of_costo_usd` (copia directa de costo_total_usd del LI; el costo del LI es POR
 * PAGO — confirmado con el cliente 2026-07-17 — así que sumar por ticket es correcto).
 * Ticket sin costo cargado = 0 (criterio: el margen queda igual al ingreso; el dato falta,
 * no se inventa). Se avisa para poder detectarlo.
 * @returns {number} USD
 */
export function costoUsdDesdeTickets(tickets, log) {
  let usd = 0;
  let sinCosto = 0;
  for (const t of tickets) {
    const c = num(t?.properties?.of_costo_usd, NaN);
    if (Number.isFinite(c)) usd += c;
    else sinCosto++;
  }
  if (sinCosto > 0) {
    log?.warn({ sinCosto, total: tickets.length }, 'Tickets sin of_costo_usd: cuentan como costo 0 (margen inflado)');
  }
  return round2(usd);
}

/**
 * Recalcula el VALOR del deal desde sus line items y escribe las dos props.
 *
 * @param {object}   params
 * @param {string}   params.dealId
 * @param {boolean}  [params.applyUpdate=true] - si false, solo calcula (no escribe).
 * @returns {Promise<{ total: number|null, totalUsd: number|null, totalLocal: number,
 *                     lineItemCount: number, changed: boolean }>}
 *          `total` = valor principal escrito en valor_total (USD).
 */
export async function recalcValorTotal({ dealId, applyUpdate = true }) {
  const log = logger.child({ module: MOD, dealId });

  // 1) TICKETS del negocio (fuente del cálculo). Por PROPIEDAD of_deal_id, no por
  //    asociaciones: el forecast existe pero está desasociado a propósito.
  //    getDealTickets ya excluye los CANCELADOS.
  const todos = await getDealTickets(dealId);

  // 1b) Selección: plan fijo → todos; auto-renew → solo el año calendario en curso.
  //     Un solo filtro, del que VALOR y COSTO heredan (simetría garantizada).
  const anio = new Date().getUTCFullYear();
  const { elegidos, autoRenewFuera } = ticketsDelCalculo(todos, anio, log);

  // 2) Props del deal (dólar, mirror y comparación antes de escribir).
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

  // 4) VALOR — igual para TODOS los negocios, mirror incluido (sin caso especial).
  //    Lo intercompany se resuelve en los REPORTES, no acá.
  const esMirror = String(dp.es_mirror_de_py || '').trim().toLowerCase() === 'true';
  const totalLocal = valorLocalDesdeTickets(elegidos, log);
  const totalUsd = convertirAUsd(totalLocal, dolar);

  // 4b) MARGEN = VALOR USD − COSTO USD de LOS MISMOS tickets. Null si el VALOR en USD
  //     no es calculable (sin dólar) → no se escribe.
  const costoUsd = costoUsdDesdeTickets(elegidos, log);
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
        { esMirror, totalUsd, totalLocal, costoUsd, margenUsd, dolar,
          tickets: elegidos.length, ticketsTotal: todos.length, autoRenewFuera, anio,
          wrote: Object.keys(properties) },
        'VALOR actualizado'
      );
    } else {
      log.debug(
        { esMirror, totalUsd, totalLocal, margenUsd, tickets: elegidos.length },
        'VALOR sin cambios'
      );
    }
  }

  return { total: totalUsd, totalUsd, totalLocal, costoUsd, margenUsd, esMirror,
           ticketCount: elegidos.length, ticketCountTotal: todos.length, autoRenewFuera, changed };
}
