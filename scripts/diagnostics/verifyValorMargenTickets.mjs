// scripts/diagnostics/verifyValorMargenTickets.mjs
//
// Verificación END-TO-END del cálculo de VALOR / COSTO / MARGEN (regla usuaria
// 2026-07-21: plan fijo/pago único desde TICKETS + auto-renew como run-rate anual
// desde el LINE ITEM) contra HubSpot REAL.
//
// 100% READ-ONLY: llama a recalcValorTotal con applyUpdate=false. No escribe NADA.
//
// Imprime, para cada negocio: ticket por ticket (cuál entra, cuál no y POR QUÉ),
// los totales calculados, y la comparación contra lo que hoy tiene el deal en HubSpot
// (para ver cuánto se mueve el número con la regla nueva).
//
// Uso:
//   node ./scripts/diagnostics/verifyValorMargenTickets.mjs <DEAL_ID> [<DEAL_ID> ...]
//   node ./scripts/diagnostics/verifyValorMargenTickets.mjs --auto [N]   (busca N deals con tickets)

import 'dotenv/config';
import { hubspotClient } from '../../src/hubspotClient.js';
import {
  recalcValorTotal,
  getDealTickets,
  getDealLineItems,
  ticketsDelCalculo,
  valorLocalDesdeTickets,
  costoUsdDesdeTickets,
  valorAutoRenewDesdeLineItems,
} from '../../src/services/deal/recalcValorTotal.js';

const argv = process.argv.slice(2);
const AUTO = argv.includes('--auto');

const n = (v) => (v == null || v === '' ? null : Number.parseFloat(v));
const fmt = (v) =>
  v == null || Number.isNaN(v) ? '—' : v.toLocaleString('es-UY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Busca deals que tengan tickets, para no depender de IDs hardcodeados. */
async function buscarDeals(limite) {
  const res = await hubspotClient.crm.deals.searchApi.doSearch({
    filterGroups: [{ filters: [{ propertyName: 'valor_total', operator: 'HAS_PROPERTY' }] }],
    properties: ['dealname', 'valor_total', 'margen_total_usd', 'es_mirror_de_py'],
    sorts: [{ propertyName: 'hs_lastmodifieddate', direction: 'DESCENDING' }],
    limit: limite,
  });
  return (res.results || []).map((d) => String(d.id));
}

async function verificar(dealId) {
  const deal = await hubspotClient.crm.deals.basicApi.getById(String(dealId), [
    'dealname', 'dealstage', 'dolar', 'deal_currency_code', 'es_mirror_de_py',
    'valor_total', 'valor_total_moneda_original', 'margen_total_usd',
  ]);
  const dp = deal.properties || {};
  const esMirror = String(dp.es_mirror_de_py || '').toLowerCase() === 'true';

  console.log('\n' + '='.repeat(78));
  console.log(`NEGOCIO ${dealId} — ${dp.dealname || '(sin nombre)'}${esMirror ? '   [MIRROR]' : ''}`);
  console.log(`moneda=${dp.deal_currency_code || '?'}  dolar=${dp.dolar || '—'}  stage=${dp.dealstage || '?'}`);
  console.log('='.repeat(78));

  const todos = await getDealTickets(dealId);
  const { elegidos } = ticketsDelCalculo(todos);
  const setElegidos = new Set(elegidos.map((t) => String(t.id)));

  if (todos.length === 0) {
    console.log('  (sin tickets vivos)');
  } else {
    console.log(`\n  ${'TICKET'.padEnd(14)}${'TIPO'.padEnd(12)}${'FECHA'.padEnd(12)}${'SUBTOTAL'.padStart(14)}${'COSTO USD'.padStart(13)}  ¿ENTRA?`);
    console.log('  ' + '-'.repeat(74));
    for (const t of todos) {
      const tp = t.properties || {};
      const pagos = tp.of_cantidad_de_pagos;
      const auto = pagos == null || String(pagos).trim() === '';
      const dentro = setElegidos.has(String(t.id));
      const motivo = dentro ? 'sí' : 'no · auto-renew (va por el run-rate del LI)';
      console.log(
        `  ${String(t.id).padEnd(14)}${(auto ? 'auto-renew' : `fijo(${pagos})`).padEnd(12)}` +
        `${String(tp.fecha_resolucion_esperada || '—').padEnd(12)}` +
        `${fmt(n(tp.subtotal_real)).padStart(14)}${fmt(n(tp.of_costo_usd)).padStart(13)}  ${motivo}`
      );
    }
  }

  // Run-rate anual de los LIs auto-renew (regla 21-jul)
  const lis = await getDealLineItems(dealId);
  const ar = valorAutoRenewDesdeLineItems(lis);
  if (ar.cuenta > 0 || ar.sinMult > 0) {
    console.log(`\n  LIs auto-renew: ${ar.cuenta} → run-rate anual ${fmt(ar.totalLocal)} (moneda orig.) · costo USD ${fmt(ar.costoUsd)}`);
    if (ar.sinMult > 0) console.log(`  ⚠️  ${ar.sinMult} LI(s) auto-renew con frecuencia NO mapeable: no aportan`);
  }

  const valorLocal = Math.round((valorLocalDesdeTickets(elegidos) + ar.totalLocal) * 100) / 100;
  const costoUsd = Math.round((costoUsdDesdeTickets(elegidos) + ar.costoUsd) * 100) / 100;
  const dolar = n(dp.dolar);
  const valorUsd = dolar > 0 ? Math.round((valorLocal / dolar) * 100) / 100 : null;
  const margen = valorUsd == null ? null : Math.round((valorUsd - costoUsd) * 100) / 100;

  console.log('\n  ── CALCULADO (regla 21-jul: tickets + run-rate auto-renew) ──');
  console.log(`  tickets: ${elegidos.length} de ${todos.length} · LIs auto-renew: ${ar.cuenta}`);
  console.log(`  VALOR moneda original : ${fmt(valorLocal)}`);
  console.log(`  VALOR USD             : ${fmt(valorUsd)}`);
  console.log(`  COSTO USD             : ${fmt(costoUsd)}`);
  console.log(`  MARGEN USD            : ${fmt(margen)}`);

  console.log('\n  ── HOY EN HUBSPOT (regla anterior) ──');
  console.log(`  valor_total           : ${fmt(n(dp.valor_total))}`);
  console.log(`  valor_total_mon_orig  : ${fmt(n(dp.valor_total_moneda_original))}`);
  console.log(`  margen_total_usd      : ${fmt(n(dp.margen_total_usd))}`);

  const dif = valorUsd != null && n(dp.valor_total) != null ? valorUsd - n(dp.valor_total) : null;
  if (dif != null && Math.abs(dif) > 0.01) {
    console.log(`\n  ⚠️  DIFERENCIA en VALOR USD: ${fmt(dif)}  (nuevo − viejo)`);
  } else if (dif != null) {
    console.log('\n  ✅ VALOR USD coincide con el actual');
  }

  // Control de que la función completa devuelve lo mismo que el desglose (dry-run).
  const r = await recalcValorTotal({ dealId, applyUpdate: false });
  const coincide = r.totalLocal === valorLocal && r.costoUsd === costoUsd;
  console.log(`  ${coincide ? '✅' : '❌'} recalcValorTotal(dry) coincide con el desglose de arriba`);
  return { dealId, ok: coincide };
}

const ids = AUTO
  ? await buscarDeals(Number(argv[argv.indexOf('--auto') + 1]) || 5)
  : argv.filter((a) => /^\d+$/.test(a));

if (ids.length === 0) {
  console.error('Uso: node ./scripts/diagnostics/verifyValorMargenTickets.mjs <DEAL_ID>... | --auto [N]');
  process.exit(1);
}

console.log(`Portal: ${process.env.HUBSPOT_ENV || '(sin HUBSPOT_ENV)'}  ·  READ-ONLY`);
const res = [];
for (const id of ids) {
  try {
    res.push(await verificar(id));
  } catch (err) {
    console.error(`\n❌ ${id}: ${err?.message || err}`);
    res.push({ dealId: id, ok: false });
  }
}
console.log('\n' + '='.repeat(78));
console.log(`RESUMEN: ${res.filter((r) => r.ok).length}/${res.length} coherentes`);
process.exit(0);
