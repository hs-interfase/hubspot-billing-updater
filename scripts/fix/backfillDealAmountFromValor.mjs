// scripts/fix/backfillDealAmountFromValor.mjs
//
// BACKFILL del `amount` nativo del deal = "Valor Total (moneda del negocio)"
// (valor_total_moneda_original / totalLocal), para que el encabezado del deal
// muestre el total anualizado y no el valor de un período.
//
// Recorre TODOS los negocios que ya tienen valor calculado
// (valor_total_moneda_original presente) y, por cada uno, llama a recalcValorTotal.
// Con applyUpdate=true, recalcValorTotal reescribe el valor (idempotente) y —solo
// si WRITE_DEAL_AMOUNT_FROM_VALOR=true— también el `amount`. El guard interno por
// comparación evita reescrituras y loops.
//
// SEGURIDAD:
//   - Por defecto corre en DRY (no escribe): reporta cuántos deals cambiarían y ejemplos.
//   - Escribe SOLO con --apply.
//   - Con --apply exige también WRITE_DEAL_AMOUNT_FROM_VALOR=true (si no, el amount NO
//     se toca y el script avisa).
//
// Uso:
//   node ./scripts/fix/backfillDealAmountFromValor.mjs                 (DRY, todos)
//   node ./scripts/fix/backfillDealAmountFromValor.mjs --limit 20      (DRY, primeros 20)
//   WRITE_DEAL_AMOUNT_FROM_VALOR=true \
//     node ./scripts/fix/backfillDealAmountFromValor.mjs --apply       (ESCRIBE)
//
// Requiere las mismas env vars que el motor (HUBSPOT token/portal, etc.).

import 'dotenv/config';
import { hubspotClient } from '../../src/hubspotClient.js';
import { recalcValorTotal } from '../../src/services/deal/recalcValorTotal.js';

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const LIMIT = (() => {
  const i = argv.indexOf('--limit');
  return i >= 0 ? Number(argv[i + 1]) || Infinity : Infinity;
})();
const SLEEP_MS = (() => {
  const i = argv.indexOf('--sleep');
  return i >= 0 ? Number(argv[i + 1]) || 120 : 120;
})();
// --deal <id>: procesar SOLO ese deal (para probar el fix en uno antes del backfill masivo).
const ONLY_DEAL = (() => {
  const i = argv.indexOf('--deal');
  return i >= 0 ? String(argv[i + 1] || '').trim() : null;
})();
const FLAG_ON =
  String(process.env.WRITE_DEAL_AMOUNT_FROM_VALOR || '').toLowerCase() === 'true';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (v) => (v == null || v === '' ? NaN : Number.parseFloat(v));
const fmt = (v) =>
  v == null || Number.isNaN(v)
    ? '—'
    : v.toLocaleString('es-UY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Enumera deals con valor local calculado. Si ONLY_DEAL está seteado, solo ese. */
async function* iterDeals() {
  if (ONLY_DEAL) {
    const d = await hubspotClient.crm.deals.basicApi.getById(ONLY_DEAL, [
      'dealname', 'amount', 'valor_total_moneda_original', 'deal_currency_code',
    ]);
    yield d;
    return;
  }
  let after;
  do {
    const res = await hubspotClient.crm.deals.searchApi.doSearch({
      filterGroups: [
        { filters: [{ propertyName: 'valor_total_moneda_original', operator: 'HAS_PROPERTY' }] },
      ],
      properties: ['dealname', 'amount', 'valor_total_moneda_original', 'deal_currency_code'],
      sorts: [{ propertyName: 'hs_object_id', direction: 'ASCENDING' }],
      limit: 100,
      after,
    });
    for (const d of res.results || []) yield d;
    after = res.paging?.next?.after;
  } while (after);
}

console.log(
  `Portal: ${process.env.HUBSPOT_ENV || '(sin HUBSPOT_ENV)'}  ·  ` +
    `modo: ${APPLY ? 'APPLY (escribe)' : 'DRY (solo reporta)'}  ·  ` +
    `flag WRITE_DEAL_AMOUNT_FROM_VALOR=${FLAG_ON}`
);
if (APPLY && !FLAG_ON) {
  console.log(
    '\n⚠️  --apply SIN WRITE_DEAL_AMOUNT_FROM_VALOR=true: recalcValorTotal NO tocará el amount.\n' +
      '   Corré con:  WRITE_DEAL_AMOUNT_FROM_VALOR=true node ./scripts/fix/backfillDealAmountFromValor.mjs --apply\n'
  );
}

let vistos = 0;
let cambiarian = 0; // amount actual ≠ total local
let escritos = 0;
const ejemplos = [];

for await (const d of iterDeals()) {
  if (vistos >= LIMIT) break;
  vistos++;
  const id = String(d.id);
  const dp = d.properties || {};
  const amountActual = num(dp.amount);
  const totalLocal = num(dp.valor_total_moneda_original);

  const difiere = Number.isFinite(totalLocal) && amountActual !== totalLocal;
  if (difiere) {
    cambiarian++;
    if (ejemplos.length < 15) {
      ejemplos.push(
        `  ${id.padEnd(12)} ${(dp.deal_currency_code || '?').padStart(3)}  ` +
          `amount ${fmt(amountActual).padStart(16)}  →  ${fmt(totalLocal).padStart(16)}   ${dp.dealname || ''}`
      );
    }
  }

  if (APPLY) {
    try {
      // recalcValorTotal escribe valor (idempotente) y —si el flag está ON— el amount.
      const r = await recalcValorTotal({ dealId: id });
      if (r.changed) escritos++;
    } catch (err) {
      console.error(`  ❌ ${id}: ${err?.message || err}`);
    }
    if (SLEEP_MS) await sleep(SLEEP_MS);
  }

  if (vistos % 50 === 0) console.log(`  … ${vistos} procesados`);
}

console.log('\n' + '='.repeat(70));
console.log(`Deals revisados            : ${vistos}`);
console.log(`Con amount ≠ total local   : ${cambiarian}`);
if (APPLY) console.log(`Deals actualizados (changed): ${escritos}`);
if (ejemplos.length) {
  console.log(`\nEjemplos (amount actual → total local):`);
  console.log(ejemplos.join('\n'));
}
if (!APPLY) {
  console.log(
    `\nDRY: no se escribió nada. Para aplicar:\n` +
      `  WRITE_DEAL_AMOUNT_FROM_VALOR=true node ./scripts/fix/backfillDealAmountFromValor.mjs --apply`
  );
}
process.exit(0);
