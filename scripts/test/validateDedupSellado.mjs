// scripts/test/validateDedupSellado.mjs
//
// Validación en SANDBOX (511) del fix #10b: dedupeSealedMirrorLineItems.
// Crea un deal espejo de prueba con DOS líneas idénticas (mismo of_line_item_py_origen_id,
// sin facturación), corre el dedup y verifica que quede UNA sola, que el deal NO se borre,
// y que una segunda corrida sea idempotente. Limpia todo al final.
//
// SOLO corre si HUBSPOT_ENV=sandbox. Correr con:
//   node scripts/test/validateDedupSellado.mjs
//
// (No toca producción. No usa DB. Escribe objetos de prueba temporales en 511.)

import 'dotenv/config';
import { hubspotClient } from '../../src/hubspotClient.js';
import { dedupeSealedMirrorLineItems } from '../../src/dealMirroring.js';

const ENV = (process.env.HUBSPOT_ENV || '').trim().toLowerCase();
if (ENV !== 'sandbox') {
  console.error(`✖ ABORT: HUBSPOT_ENV="${ENV}" (esperado "sandbox"). No corro escrituras fuera de sandbox.`);
  process.exit(1);
}

const TAG = 'TEST_DEDUP_10B';
const ORIGEN = `PY_LI_${TAG}_ORIGEN`; // misma etiqueta de origen en las 2 líneas = duplicado exacto

const created = { dealId: null, liIds: [] };
let pass = true;
const check = (cond, label) => {
  console.log(`${cond ? '✓' : '✖'} ${label}`);
  if (!cond) pass = false;
};

async function assocLiIds(dealId) {
  const page = await hubspotClient.crm.associations.v4.basicApi.getPage('deals', String(dealId), 'line_items', 100);
  return (page.results || []).map((r) => String(r.toObjectId));
}

async function main() {
  console.log(`\n=== Validación #10b dedup sellado — portal SANDBOX (${ENV}) ===\n`);

  // 1) Deal espejo de prueba (sellado)
  const deal = await hubspotClient.crm.deals.basicApi.create({
    properties: {
      dealname: `${TAG} — deal espejo de prueba (borrar)`,
      mig_espejo_independiente: 'true',
      pais_operativo: 'Uruguay',
    },
  });
  created.dealId = deal.id;
  console.log(`Deal espejo creado: ${deal.id}`);

  // 2) DOS líneas idénticas (mismo of_line_item_py_origen_id, sin facturación)
  for (let i = 1; i <= 2; i++) {
    const li = await hubspotClient.crm.lineItems.basicApi.create({
      properties: {
        name: `${TAG} — producto duplicado copia ${i}`,
        price: '0',
        quantity: '1',
        of_line_item_py_origen_id: ORIGEN,
        uy: 'true',
        pais_operativo: 'Uruguay',
        line_item_key: `${TAG}_LIK_${i}`, // distinto por copia; no hay tickets → no facturado
      },
    });
    created.liIds.push(li.id);
    // Asociación LI→deal HUBSPOT_DEFINED (typeId 20). Se usa .create explícito porque
    // createDefault tira "Cannot parse content" (204 sin content-type) y NO crea la asociación.
    await hubspotClient.crm.associations.v4.basicApi.create(
      'line_items', String(li.id), 'deals', String(deal.id),
      [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 20 }]
    );
    console.log(`Línea ${i} creada y asociada: ${li.id}`);
  }

  // 3) Estado inicial: 2 líneas asociadas
  const before = await assocLiIds(deal.id);
  check(before.length === 2, `Estado inicial: 2 líneas asociadas (obtenido ${before.length})`);

  // 4) Primera corrida del dedup
  const r1 = await dedupeSealedMirrorLineItems(deal.id);
  check(r1.dedupedCount === 1, `1ª corrida: desasoció exactamente 1 duplicado (dedupedCount=${r1.dedupedCount})`);

  const after1 = await assocLiIds(deal.id);
  check(after1.length === 1, `Tras dedup: queda 1 línea asociada (obtenido ${after1.length})`);

  // 5) El deal NO se borró
  const dealStill = await hubspotClient.crm.deals.basicApi.getById(String(deal.id), ['dealname']).then(() => true).catch(() => false);
  check(dealStill, 'El deal espejo NO se borró');

  // 6) Segunda corrida: idempotente (0 dedupes, sigue 1 línea)
  const r2 = await dedupeSealedMirrorLineItems(deal.id);
  check(r2.dedupedCount === 0, `2ª corrida idempotente: 0 dedupes (dedupedCount=${r2.dedupedCount})`);
  const after2 = await assocLiIds(deal.id);
  check(after2.length === 1, `Idempotente: sigue 1 línea asociada (obtenido ${after2.length})`);

  console.log(`\n=== RESULTADO: ${pass ? '✅ PASS' : '❌ FAIL'} ===\n`);
}

async function cleanup() {
  console.log('\n--- Limpieza de objetos de prueba ---');
  for (const liId of created.liIds) {
    try { await hubspotClient.crm.lineItems.basicApi.archive(String(liId)); console.log(`LI archivada: ${liId}`); }
    catch (e) { console.log(`(LI ${liId} ya no existe / no se pudo archivar: ${e?.message})`); }
  }
  if (created.dealId) {
    try { await hubspotClient.crm.deals.basicApi.archive(String(created.dealId)); console.log(`Deal archivado: ${created.dealId}`); }
    catch (e) { console.log(`(Deal ${created.dealId} no se pudo archivar: ${e?.message})`); }
  }
}

try {
  await main();
} catch (err) {
  console.error('✖ ERROR en la validación:', err?.message || err);
  pass = false;
} finally {
  await cleanup();
}
process.exit(pass ? 0 : 1);
