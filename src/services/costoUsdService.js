// src/services/costoUsdService.js
// ÉPICA costo/margen en USD (2026-07-02) — flag COSTO_USD_ENABLED (OFF por default).
//
// Circuito:
//  - DEAL prop `dolar` (cotización 1 USD → moneda del negocio): se asigna cuando falta
//    (negocio recién creado) y se RE-asigna UNA vez al llegar a cierre-ganado o más allá
//    (marker `dolar_cierre_asignado` evita pisarla en cada corrida; la migración lo deja
//    en 'true' en los negocios ya ganados para que el TC histórico no se toque).
//  - LI prop `dolar` (TC aplicado a ESA línea): el motor la copia del deal cuando el LI no
//    la tiene, y la RE-copia a todos los LIs solo en el evento en que el dólar del deal
//    cambió (cierre-ganado). Los LIs migrados traen el Dolar de SU OF (más exacto) y no
//    se tocan porque el deal migrado ya viene con el marker en true.
//  - LI prop `costo_total_usd` (editable, fuente de verdad: Interfase carga costos SIEMPRE
//    en USD): el motor deriva hs_cost_of_goods_sold = costo_total_usd × dolar(LI) ÷ quantity
//    (COGS nativo es UNITARIO; HubSpot calcula hs_margin=(price−cogs)×qty solo).
//  - `monto_usd` y `margen_usd` son PROPIEDADES DE CÁLCULO de HubSpot (price×qty÷dolar y
//    eso −costo_total_usd): READ-ONLY — este servicio NO las escribe (400 si se intenta).
//
// El valor convertido queda FIJO: solo cambia si editan costo_total_usd o si cambia el
// dolar aplicado (creación / cierre-ganado) — no sigue la cotización del día.
// Se engancha en runPhase1 ANTES del mirroring (el espejo UY lee costo_total_usd
// como fuente del price; definición 2026-07-07: costo_total_usd = fuente de verdad,
// hs_cost_of_goods_sold = derivada en moneda del deal, solo para hs_margin nativo).

import { hubspotClient } from '../hubspotClient.js';
import { parseBool, parseNumber } from '../utils/parsers.js';
import { BILLING_ACTIVE_DEAL_STAGES } from '../config/constants.js';
import { getDolar } from './fxService.js';
import logger from '../../lib/logger.js';

export function costoUsdEnabled() {
  return parseBool(process.env.COSTO_USD_ENABLED);
}

// tolerancia de re-escritura: 1 centésimo o 0,1% (evita churn por redondeo)
const difiere = (actual, esperado) =>
  !(Number.isFinite(actual)) || Math.abs(actual - esperado) > Math.max(0.01, Math.abs(esperado) * 0.001);

/**
 * Asegura la prop `dolar` del deal. Devuelve { dolar, updated }.
 * No escribe si ya está asignada y el evento cierre-ganado ya fue procesado.
 */
export async function ensureDealDolar(deal) {
  const dp = deal?.properties || {};
  const cur = String(dp.deal_currency_code || 'USD').toUpperCase();
  const actual = parseNumber(dp.dolar, 0);
  const enGanado = BILLING_ACTIVE_DEAL_STAGES.has(String(dp.dealstage || ''));
  const cierreYaAsignado = parseBool(dp.dolar_cierre_asignado);

  const necesitaInicial = !(actual > 0);
  const necesitaCierre = enGanado && !cierreYaAsignado;

  // `tc_pesos` (30-jul, pedido Paola 21-jul): TC INFORMATIVO a pesos — UYU, o PYG si el
  // país operativo es Paraguay — SIEMPRE, aunque el negocio esté en USD. Se congela en
  // los MISMOS momentos que `dolar` (alta y cierre-ganado) para que el reporte muestre
  // el TC vigente al día que corresponda y no el de hoy.
  // 🔴 NO es divisor y NO reemplaza a `dolar`: `monto_usd` = price×qty ÷ `dolar` y
  // hs_cost_of_goods_sold = costo_total_usd × `dolar`. En un negocio USD `dolar` vale 1
  // y DEBE seguir valiendo 1 — escribirle acá el TC a pesos rompería ambos cálculos.
  // ⚠️ Se escribe SÓLO en esos dos momentos, nunca "para rellenar el que falta": completar
  // un negocio viejo con la cotización de HOY estamparía un valor de hoy haciéndolo pasar
  // por congelado. Los negocios previos quedan vacíos a propósito — el reporte ya cae al
  // TC del día sin afirmar que sea el histórico. Poblarlos es un backfill aparte, que debe
  // leer `exchange_rates` por la fecha de congelamiento.
  const monedaPesos = String(dp.pais_operativo || '').trim().toLowerCase() === 'paraguay' ? 'PYG' : 'UYU';

  if (!necesitaInicial && !necesitaCierre) return { dolar: actual, updated: false };

  const properties = {};

  if (necesitaInicial || necesitaCierre) {
    const nuevo = await getDolar(cur);
    if (nuevo > 0) {
      properties.dolar = String(nuevo);
      if (enGanado) properties.dolar_cierre_asignado = 'true';
    } else {
      logger.warn({ module: 'costoUsdService', fn: 'ensureDealDolar', dealId: deal?.id, cur },
        '[COSTO_USD] sin cotización — se mantiene el dólar actual (o queda vacío)');
    }
  }

  // Se congela junto con el dólar, en el mismo evento (alta o cierre-ganado).
  {
    const tcPesos = await getDolar(monedaPesos);
    if (tcPesos > 0) properties.tc_pesos = String(tcPesos);
    else logger.warn({ module: 'costoUsdService', fn: 'ensureDealDolar', dealId: deal?.id, monedaPesos },
      '[COSTO_USD] sin cotización a pesos — tc_pesos queda como estaba');
  }

  if (!Object.keys(properties).length) {
    return { dolar: actual > 0 ? actual : null, updated: false };
  }

  await hubspotClient.crm.deals.basicApi.update(String(deal.id), { properties });
  deal.properties = { ...dp, ...properties };
  const dolarFinal = properties.dolar != null ? Number(properties.dolar) : actual;
  logger.info({ module: 'costoUsdService', fn: 'ensureDealDolar', dealId: deal?.id, cur, dolar: dolarFinal, tcPesos: properties.tc_pesos, monedaPesos, evento: necesitaCierre ? 'cierre_ganado' : 'inicial' },
    `[COSTO_USD] dólar del negocio ${necesitaCierre ? 're-asignado al cierre' : 'asignado'}: ${dolarFinal} (${cur})${properties.tc_pesos ? ` · tc_pesos=${properties.tc_pesos} (${monedaPesos})` : ''}`);
  return { dolar: dolarFinal > 0 ? dolarFinal : null, updated: true };
}

/**
 * Propaga el dolar a los LIs que no lo tienen (y a TODOS si el dolar del deal recién
 * cambió) y deriva hs_cost_of_goods_sold desde costo_total_usd × dolar(LI) ÷ qty.
 * Escribe solo lo que difiere (tolerancia). Muta li.properties en memoria para que
 * snapshot/mirroring de la misma corrida vean el valor nuevo.
 * NO escribe monto_usd/margen_usd: son props de cálculo (HubSpot las deriva solo).
 */
export async function syncCostoUsdLineItems({ dealId, deal, lineItems, writeBuffer = null }) {
  if (!costoUsdEnabled()) return { skipped: true, reason: 'flag off' };
  if (!Array.isArray(lineItems) || !lineItems.length) return { skipped: true, reason: 'sin line items' };

  const { dolar: dealDolar, updated: dolarCambio } = await ensureDealDolar(deal);

  let updated = 0;
  for (const li of lineItems) {
    const lp = li.properties || {};
    const qty = parseNumber(lp.quantity, 1) || 1;
    const updates = {};

    // dolar del LI: completar si falta; re-copiar a todos solo si el del deal recién cambió.
    let liDolar = parseNumber(lp.dolar, 0);
    if (dealDolar > 0 && (dolarCambio || !(liDolar > 0)) && difiere(liDolar, dealDolar)) {
      updates.dolar = String(dealDolar);
      liDolar = dealDolar;
    }

    // Definición 2026-07-07: cogs se deriva para TODOS los LIs, incluidos los espejados
    // (uy='true'). Antes se salteaban porque dealMirroring usaba cogs como price del
    // mirror; ahora el mirror lee costo_total_usd directo, así que cogs puede (y debe)
    // ir en la moneda del deal para que hs_margin del PY salga bien.
    if (liDolar > 0) {
      const costoUsd = parseNumber(lp.costo_total_usd, NaN);
      if (Number.isFinite(costoUsd)) {
        const cogs = +((costoUsd * liDolar) / qty).toFixed(6);
        if (difiere(parseNumber(lp.hs_cost_of_goods_sold, NaN), cogs)) {
          updates.hs_cost_of_goods_sold = String(cogs);
        }
      }
    }

    if (!Object.keys(updates).length) continue;
    try {
      if (writeBuffer) await writeBuffer.queueUpdate(li.id, updates, { label: 'costoUsd' });
      else await hubspotClient.crm.lineItems.basicApi.update(String(li.id), { properties: updates });
      li.properties = { ...lp, ...updates };
      updated++;
    } catch (err) {
      logger.error({ module: 'costoUsdService', fn: 'syncCostoUsdLineItems', dealId, lineItemId: li.id, err },
        '[COSTO_USD] fallo escribiendo conversión en LI');
    }
  }

  if (updated) {
    logger.info({ module: 'costoUsdService', fn: 'syncCostoUsdLineItems', dealId, dealDolar, updated },
      `[COSTO_USD] ${updated} LI(s) actualizados (dolar/cogs)`);
  }
  return { skipped: false, dolar: dealDolar, updated };
}
