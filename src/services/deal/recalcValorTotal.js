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
// EXCEPCIÓN AUTO-RENEW (usuaria 2026-07-21, transcript reunión + correo Paola 2026-07-02):
//   un contrato de auto-renovación no tiene fin, así que sumar tickets no significa nada.
//   Su valor es el RUN-RATE ANUAL calculado desde el LINE ITEM:
//
//     VALOR_ar = Σ price × quantity × multiplicador anual   (por cada LI auto-renew)
//     COSTO_ar = Σ costo_total_usd × multiplicador anual    (el costo del LI es POR PAGO)
//
//   Multiplicador anual = pagos que entran en UN año: mensual ×12 · trimestral ×4 ·
//   semestral ×2 · anual ×1 · bimestral ×6 · plurianual 12÷meses (cada 2 años = 0,5) ·
//   semanal/quincenal por días (365÷n). Ver multAnual(). Es la fórmula literal del correo
//   de Paola del 2-jul ("Σ de los precios unitario × cantidad × multiplicador, normalizado
//   a base anual"), confirmada por la usuaria el 21/22-jul. "Último precio" = el price
//   VIGENTE del LI (la paramétrica edita el price, así que siempre está al día).
//
//   Los TICKETS de un LI auto-renew quedan FUERA del cálculo (los reemplaza el run-rate;
//   sumarlos además sería doble conteo). Plan fijo y pago único siguen POR TICKETS.
//   Un mismo negocio puede mezclar ambos: la clasificación es POR LI / POR TICKET.
//   Marcador de auto-renew: tiene frecuencia y NO tiene nº de pagos (isAutoRenew en
//   services/billing/mode.js; a nivel ticket, esTicketAutoRenew acá).
//
// POR QUÉ EL PLAN FIJO VA POR TICKETS Y NO POR LINE ITEMS:
//   **El ticket tiene el valor REAL; el line item no necesariamente.** El LI es la
//   intención comercial; el ticket es lo que efectivamente se factura (y lo que el
//   responsable corrige antes de emitir). Para el AUTO-RENEW la regla es la inversa a
//   propósito: es una PROYECCIÓN, y la fuente de la proyección es el precio vigente del
//   LI (decisión usuaria 2026-07-21 — reemplaza la regla del 19-jul que tomaba los
//   tickets del año calendario en curso).
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
// cubierto por los tres disparadores (runBilling, cronWeekendFull, webhook). Además, el
// caso 'li_prop_sync' y la ruta 'valor_recalc' de la cola de webhooks lo recalculan al
// editar price/quantity/costo/frecuencia/nº de pagos del LI (regla "campo dinámico" de
// Paola: ante cualquier modificación debe actualizarse solo).
//
// PENDIENTE / control de cambios:
//   - TC "mixto" del Caso 1 de Paola (facturado al TC del día de cada factura + proyección
//     al TC de creación). Hoy se usa un único `dolar` del deal para todo el total, aislado
//     en convertirAUsd() para cambiarlo sin tocar el resto. Cada ticket ya trae su propio
//     `dolar` sellado si algún día se quiere TC por ticket.

import { hubspotClient } from '../../hubspotClient.js';
import { ensureDealDolar } from '../costoUsdService.js';
import { isAutoRenew } from '../billing/mode.js';
import { getIntervalFromFrequency } from '../../billingEngine.js';
import { TICKET_STAGES, BILLING_AUTOMATED_CANCELLED } from '../../config/constants.js';
import logger from '../../../lib/logger.js';

const MOD = 'recalcValorTotal';

// Props destino (override por env para renombrar sin tocar código).
const PROP_DEAL_TOTAL_USD = process.env.PROP_DEAL_TOTAL || 'valor_total';
const PROP_DEAL_TOTAL_LOCAL =
  process.env.PROP_DEAL_TOTAL_LOCAL || 'valor_total_moneda_original';

// Margen bruto del negocio en USD (mismo horizonte que el VALOR).
const PROP_DEAL_MARGEN_USD = process.env.PROP_DEAL_MARGEN || 'margen_total_usd';

// Flag (default OFF): si está en 'true', el motor escribe también el `amount`
// nativo del deal = total en la moneda del negocio, para que el encabezado
// ("Valor") muestre el total anualizado y no el de un período. Reversible: se
// apaga el env y el amount deja de tocarse. Requiere que la "Cantidad
// predeterminada del Negocio" esté en Registro manual (si no, HubSpot lo pisa).
const WRITE_DEAL_AMOUNT_FROM_VALOR =
  String(process.env.WRITE_DEAL_AMOUNT_FROM_VALOR || '').toLowerCase() === 'true';

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
  'of_cantidad_de_pagos',          // >0 ⇒ plan fijo
  'of_frecuencia_de_facturacion',  // 'Único' ⇒ one-off (NO auto-renew). Ver esTicketAutoRenew.
  'fecha_resolucion_esperada',
];

/**
 * ¿El ticket viene de un line item AUTO-RENEW?
 *
 * Replica `isAutoRenew` (services/billing/mode.js) a nivel TICKET:
 *     auto-renew = TIENE frecuencia  Y  NO tiene nº de pagos
 *
 * ⚠️ LAS DOS CONDICIONES SON NECESARIAS. Mirar solo el nº de pagos está MAL: un line
 * item de UNA SOLA VEZ (manual/one-off) tampoco tiene nº de pagos, y quedaría
 * clasificado como auto-renew → si su fecha cae fuera del año en curso se lo excluiría
 * del VALOR sin motivo. (Detectado con el caso de prueba de la usuaria, 2026-07-19:
 * 3 line items manuales al 2-ene-2028 desaparecían del total.)
 *
 * En el snapshot del ticket:
 *   - `of_frecuencia_de_facturacion` = 'Único' ⇒ NO tiene frecuencia ⇒ NO es auto-renew.
 *   - `of_cantidad_de_pagos` con valor > 0     ⇒ plan fijo         ⇒ NO es auto-renew.
 */
function esTicketAutoRenew(tp) {
  const frec = String(tp?.of_frecuencia_de_facturacion ?? '').trim().toLowerCase();
  const esUnico = frec === '' || frec === 'unico' || frec === 'único';
  if (esUnico) return false; // sin frecuencia ⇒ plan fijo (one-off)

  const pagos = Number.parseFloat(tp?.of_cantidad_de_pagos);
  return !(Number.isFinite(pagos) && pagos > 0);
}

/**
 * Multiplicador anual de una frecuencia de LI: cuántos pagos entran en UN año.
 * Deriva de getIntervalFromFrequency (misma tabla que usa la facturación, así los dos
 * caminos nunca divergen): meses > 0 → 12÷meses; si es por días → 365÷días.
 * @returns {number|null} null si la frecuencia no se puede mapear.
 */
export function multAnual(freqRaw) {
  const interval = getIntervalFromFrequency(freqRaw);
  if (!interval) return null;
  if (interval.months > 0) return 12 / interval.months;
  if (interval.days > 0) return 365 / interval.days;
  return null;
}

// Props del LINE ITEM que necesita el caso auto-renew.
const LI_PROPS = [
  'price',
  'quantity',
  'costo_total_usd',
  'recurringbillingfrequency',
  'hs_recurring_billing_frequency',
  'hs_recurring_billing_number_of_payments',
  'number_of_payments',
];

/**
 * VALOR y COSTO anualizados de los line items AUTO-RENEW del negocio.
 *   VALOR_local = Σ price × quantity × multAnual   (price está en la moneda del negocio)
 *   COSTO_USD   = Σ costo_total_usd × multAnual    (el costo del LI es POR PAGO, 17-jul)
 * quantity vacía cuenta como 1 (regla de María: cantidad 0/vacía con monto → 1 unidad).
 * LI auto-renew cuya frecuencia no se puede mapear → no aporta y se avisa (no se inventa).
 */
export function valorAutoRenewDesdeLineItems(lineItems, log) {
  let totalLocal = 0;
  let costoUsd = 0;
  let sinMult = 0;
  let cuenta = 0;
  for (const li of lineItems || []) {
    if (!isAutoRenew(li)) continue;
    const p = li?.properties || {};
    const m = multAnual(p.recurringbillingfrequency || p.hs_recurring_billing_frequency);
    if (m === null) {
      sinMult++;
      continue;
    }
    const qty = num(p.quantity, NaN);
    totalLocal += num(p.price, 0) * (Number.isFinite(qty) && qty > 0 ? qty : 1) * m;
    costoUsd += num(p.costo_total_usd, 0) * m;
    cuenta++;
  }
  if (sinMult > 0) {
    log?.warn(
      { sinMult },
      'LIs auto-renew con frecuencia no mapeable: NO aportan al VALOR (revisar la frecuencia del LI)'
    );
  }
  return { totalLocal: round2(totalLocal), costoUsd: round2(costoUsd), cuenta, sinMult };
}

/**
 * Trae los line items del deal con las props del caso auto-renew.
 * Solo se usa cuando el caller no los pasa (runPhasesForDeal ya los tiene cargados).
 */
export async function getDealLineItems(dealId) {
  const ids = [];
  let after;
  do {
    const resp = await hubspotClient.crm.associations.v4.basicApi.getPage(
      'deals', String(dealId), 'line_items', 500, after
    );
    for (const r of resp.results || []) ids.push(String(r.toObjectId));
    after = resp.paging?.next?.after;
  } while (after);
  if (!ids.length) return [];

  const out = [];
  for (let i = 0; i < ids.length; i += 100) {
    const batch = await hubspotClient.crm.lineItems.batchApi.read({
      inputs: ids.slice(i, i + 100).map((id) => ({ id })),
      properties: LI_PROPS,
    });
    out.push(...(batch.results || []));
  }
  return out;
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
 *   - plan fijo / pago único → todos
 *   - auto-renew → NINGUNO: su valor lo aporta el LINE ITEM (run-rate anual,
 *     valorAutoRenewDesdeLineItems). Sumar sus tickets además sería doble conteo.
 * Devuelve el mismo array que después consumen VALOR y COSTO (simetría).
 */
export function ticketsDelCalculo(tickets, log) {
  const elegidos = [];
  let autoRenewExcluidos = 0;
  for (const t of tickets) {
    const tp = t?.properties || {};
    if (esTicketAutoRenew(tp)) {
      autoRenewExcluidos++;
      continue;
    }
    elegidos.push(t);
  }
  return { elegidos, autoRenewExcluidos };
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
  'amount', // leer el amount actual para comparar (solo se escribe si WRITE_DEAL_AMOUNT_FROM_VALOR)
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
 * Recalcula el VALOR del deal y escribe las props.
 *
 * @param {object}   params
 * @param {string}   params.dealId
 * @param {boolean}  [params.applyUpdate=true] - si false, solo calcula (no escribe).
 * @param {Array}    [params.lineItems] - LIs del deal ya cargados (runPhasesForDeal los
 *                   tiene); si faltan, se traen con getDealLineItems.
 * @returns {Promise<{ total: number|null, totalUsd: number|null, totalLocal: number,
 *                     ticketCount: number, changed: boolean }>}
 *          `total` = valor principal escrito en valor_total (USD).
 */
export async function recalcValorTotal({ dealId, applyUpdate = true, lineItems = null }) {
  const log = logger.child({ module: MOD, dealId });

  // 1) TICKETS del negocio (fuente del plan fijo / pago único). Por PROPIEDAD of_deal_id,
  //    no por asociaciones: el forecast existe pero está desasociado a propósito.
  //    getDealTickets ya excluye los CANCELADOS.
  const todos = await getDealTickets(dealId);

  // 1b) Selección: plan fijo / pago único → tickets; auto-renew → fuera (los reemplaza
  //     el run-rate anual del LI). Un solo filtro, del que VALOR y COSTO heredan.
  const { elegidos, autoRenewExcluidos } = ticketsDelCalculo(todos, log);

  // 1c) Run-rate anual de los LIs auto-renew (VALOR local + COSTO USD, simétricos).
  const lis = Array.isArray(lineItems) ? lineItems : await getDealLineItems(dealId);
  const autoRenew = valorAutoRenewDesdeLineItems(lis, log);

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
  //    Tickets (plan fijo / pago único) + run-rate anual de los LIs auto-renew.
  const esMirror = String(dp.es_mirror_de_py || '').trim().toLowerCase() === 'true';
  const totalLocal = round2(valorLocalDesdeTickets(elegidos, log) + autoRenew.totalLocal);
  const totalUsd = convertirAUsd(totalLocal, dolar);

  // 4b) MARGEN = VALOR USD − COSTO USD del MISMO conjunto (tickets elegidos + LIs
  //     auto-renew anualizados). Null si el VALOR en USD no es calculable (sin dólar).
  const costoUsd = round2(costoUsdDesdeTickets(elegidos, log) + autoRenew.costoUsd);
  const margenUsd = totalUsd !== null ? round2(totalUsd - costoUsd) : null;

  // 5) Escribir solo lo que cambió (y solo valores calculables, nunca null).
  let changed = false;
  if (applyUpdate) {
    const properties = {};
    if (totalLocal !== null && num(dp[PROP_DEAL_TOTAL_LOCAL], NaN) !== totalLocal) {
      properties[PROP_DEAL_TOTAL_LOCAL] = String(totalLocal);
    }
    // amount nativo = mismo total en la moneda del negocio, para que el encabezado
    // del deal ("Valor") muestre el total anualizado y no el de un período. Gateado
    // por flag y guardado por comparación → no reescribe ni entra en loop de webhooks.
    if (
      WRITE_DEAL_AMOUNT_FROM_VALOR &&
      totalLocal !== null &&
      num(dp.amount, NaN) !== totalLocal
    ) {
      properties.amount = String(totalLocal);
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
          tickets: elegidos.length, ticketsTotal: todos.length, autoRenewExcluidos,
          liAutoRenew: autoRenew.cuenta, valorAutoRenewLocal: autoRenew.totalLocal,
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
           ticketCount: elegidos.length, ticketCountTotal: todos.length,
           autoRenewExcluidos, liAutoRenew: autoRenew.cuenta, changed };
}
