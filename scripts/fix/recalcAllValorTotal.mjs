// scripts/fix/recalcAllValorTotal.mjs
//
// Recalcula `valor_total` en TODOS los deals del portal usando la lógica
// corregida (busca tickets por of_deal_id ∪ asociaciones).
//
// SOLO escribe la propiedad valor_total. NO corre fases, NO crea tickets,
// NO emite facturas. Reutilizable para re-sincronizar cuando haga falta.
//
// Uso:
//   node ./scripts/fix/recalcAllValorTotal.mjs            (aplica cambios)
//   node ./scripts/fix/recalcAllValorTotal.mjs --dry      (solo muestra, no escribe)
//   node ./scripts/fix/recalcAllValorTotal.mjs --deal <ID>  (un solo deal)

import 'dotenv/config';
import { hubspotClient } from '../../src/hubspotClient.js';
import { recalcValorTotal } from '../../src/services/deal/recalcValorTotal.js';

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry');
const dealFlagIdx = argv.indexOf('--deal');
const ONLY_DEAL = dealFlagIdx >= 0 ? argv[dealFlagIdx + 1] : null;

const fmt = (n) =>
  Number(n).toLocaleString('es-UY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function getAllDealIds() {
  const out = [];
  let after;
  do {
    // OJO: el 5º arg de getPage es `associations` (array), no `archived`.
    // Pasar `false` ahí rompe el serializer ("data is not iterable").
    const resp = await hubspotClient.crm.deals.basicApi.getPage(100, after, ['dealname']);
    out.push(...(resp.results || []).map((d) => String(d.id)));
    after = resp.paging?.next?.after;
  } while (after);
  return out;
}

async function main() {
  console.log(`\n=== recalcAllValorTotal ${DRY ? '(DRY-RUN)' : '(APLICA CAMBIOS)'} ===`);

  const ids = ONLY_DEAL ? [String(ONLY_DEAL)] : await getAllDealIds();
  console.log(`Deals a procesar: ${ids.length}\n`);

  let changed = 0;
  let errores = 0;
  const cambios = [];

  for (let i = 0; i < ids.length; i++) {
    const dealId = ids[i];
    try {
      // En dry: calculamos sin escribir; igual reportamos delta vs el valor actual.
      const { total, ticketCount } = await recalcValorTotal({ dealId, applyUpdate: !DRY });

      if (DRY) {
        const cur = await hubspotClient.crm.deals.basicApi.getById(String(dealId), ['valor_total']);
        const prev = Number.parseFloat(cur?.properties?.valor_total);
        const difiere = !(Number.isFinite(prev) && prev === total);
        if (difiere) {
          changed++;
          cambios.push({ dealId, prev: Number.isFinite(prev) ? prev : null, total, ticketCount });
          console.log(`[${i + 1}/${ids.length}] ${dealId}  ${Number.isFinite(prev) ? fmt(prev) : '(vacío)'} → ${fmt(total)}  (${ticketCount} tickets)`);
        }
      } else {
        // recalcValorTotal ya escribe solo si cambió; lo detectamos por su log,
        // pero para el resumen recomputamos el delta de forma barata aquí no es
        // necesario: contamos como "procesado" y mostramos el total.
        console.log(`[${i + 1}/${ids.length}] ${dealId}  → ${fmt(total)}  (${ticketCount} tickets)`);
        cambios.push({ dealId, total, ticketCount });
        changed++;
      }
    } catch (err) {
      errores++;
      console.error(`[${i + 1}/${ids.length}] ${dealId}  ERROR: ${err?.message || err}`);
    }
  }

  console.log('\n=== RESUMEN ===');
  console.log(`Deals procesados : ${ids.length}`);
  if (DRY) console.log(`Con diferencia   : ${changed}`);
  console.log(`Errores          : ${errores}`);
  console.log(DRY ? 'DRY-RUN: no se escribió nada.' : 'valor_total actualizado donde correspondía.');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Error fatal:', err?.message || err);
    process.exit(1);
  });
