// scripts/audit/backfillEntidadFacturadora.mjs
//
// BACKFILL de la ENTIDAD FACTURADORA (emisora) en line items existentes.
// Regla (usuaria 23-jul, la misma del motor): país operativo del DEAL = Paraguay →
// 'ISA PY' · Uruguay → producto con área de desempate iSCert · Mixto/otro → no tocar.
// Usa resolverEntidadFacturadora (fuente única, src/services/billing/).
//
// DRY-RUN POR DEFECTO: recorre todos los deals con line items y reporta cuántos LIs
// quedarían con cada valor, cuántos sin resolver (y por qué), las discrepancias
// área-vs-producto (iSCert) y el detalle de los espejos UY con producto PY.
// SOLO ESCRIBE con --execute (o ESCRIBIR=true), y solo LIs con el select VACÍO.
//
// Uso (PowerShell, desde la raíz del repo):
//   node scripts/audit/backfillEntidadFacturadora.mjs                  → dry-run (portal del .env)
//   node scripts/audit/backfillEntidadFacturadora.mjs --execute        → escribe
//   $env:DOTENV_CONFIG_PATH=".env.real"; node scripts/audit/backfillEntidadFacturadora.mjs
//                                                                      → dry-run contra PROD

import 'dotenv/config';
import { Client } from '@hubspot/api-client';
import { resolverEntidadFacturadora } from '../../src/services/billing/resolverEntidadFacturadora.js';

const TOKEN = process.env.HUBSPOT_PRIVATE_TOKEN;
if (!TOKEN) { console.error('Falta HUBSPOT_PRIVATE_TOKEN'); process.exit(1); }
const hubspot = new Client({ accessToken: TOKEN });

const EXECUTE = process.argv.includes('--execute') || String(process.env.ESCRIBIR || '').toLowerCase() === 'true';
console.log(`=== Backfill entidad facturadora — ${EXECUTE ? '⚠️ MODO ESCRITURA' : 'DRY-RUN (no escribe nada)'} ===`);
console.log(`Portal: HUBSPOT_ENV=${process.env.HUBSPOT_ENV || '(prod)'}\n`);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const safe = (v) => (v ?? '').toString().trim();

// 1) Todos los deals con su país (paginado)
async function fetchAllDeals() {
  const deals = [];
  let after;
  while (true) {
    await sleep(120);
    const resp = await hubspot.crm.deals.searchApi.doSearch({
      properties: ['dealname', 'pais_operativo', 'es_mirror_de_py'],
      limit: 100,
      ...(after ? { after } : {}),
    });
    deals.push(...(resp?.results || []));
    after = resp?.paging?.next?.after;
    if (!after || !(resp?.results || []).length) break;
  }
  return deals;
}

async function fetchLineItems(dealId) {
  await sleep(120);
  let liIds = [];
  try {
    const resp = await hubspot.crm.associations.v4.basicApi.getPage('deals', String(dealId), 'line_items', 100);
    liIds = (resp.results || []).map(r => String(r.toObjectId));
  } catch { return []; }
  if (!liIds.length) return [];
  const items = [];
  for (let i = 0; i < liIds.length; i += 100) {
    await sleep(120);
    const resp = await hubspot.crm.lineItems.batchApi.read({
      inputs: liIds.slice(i, i + 100).map(id => ({ id })),
      properties: ['name', 'empresa_que_factura', 'area', 'hs_product_id'],
    });
    items.push(...(resp?.results || []));
  }
  return items;
}

const porValor = {};          // valor resuelto → count
const porMetodo = {};         // metodo → count
const yaCargadas = [];        // LIs con el select ya poblado (no se tocan)
const sinResolver = [];       // detalle de irresolubles
const discrepancias = [];     // area_gana_a_producto (iSCert cruzado)
const espejosUY = [];         // deals UY espejo con producto PY (para revisión de la usuaria)
const aEscribir = [];         // inputs del batch update

const deals = await fetchAllDeals();
console.log(`Deals: ${deals.length}`);

for (let i = 0; i < deals.length; i++) {
  const deal = deals[i];
  const dp = deal.properties || {};
  if ((i + 1) % 20 === 0) console.log(`  ...${i + 1}/${deals.length}`);
  const lis = await fetchLineItems(deal.id);

  for (const li of lis) {
    const lp = li.properties || {};
    if (safe(lp.empresa_que_factura)) {
      yaCargadas.push({ liId: li.id, valor: lp.empresa_que_factura });
      continue;
    }
    const { valor, metodo } = resolverEntidadFacturadora({
      paisOperativo: dp.pais_operativo,
      productId: lp.hs_product_id,
      area: lp.area,
    });
    porMetodo[metodo] = (porMetodo[metodo] || 0) + 1;

    if (!valor) {
      sinResolver.push({ deal: `${dp.dealname} [${deal.id}]`, pais: dp.pais_operativo || '(vacío)', li: `${lp.name} [${li.id}]`, motivo: metodo });
      continue;
    }
    porValor[valor] = (porValor[valor] || 0) + 1;
    if (metodo === 'area_gana_a_producto') {
      discrepancias.push({ deal: `${dp.dealname} [${deal.id}]`, li: `${lp.name} [${li.id}]`, area: lp.area, productId: lp.hs_product_id, resuelto: valor });
    }
    // Deal UY (espejo o no) al que el PRODUCTO le da ISA PY → caso a revisar por la usuaria.
    if (safe(dp.pais_operativo) === 'Uruguay' && valor === 'ISA PY') {
      espejosUY.push({ deal: `${dp.dealname} [${deal.id}]`, esMirror: safe(dp.es_mirror_de_py) === 'true' ? 'SI' : 'NO', li: `${lp.name} [${li.id}]`, resuelto: valor, metodo });
    }
    aEscribir.push({ id: String(li.id), properties: { empresa_que_factura: valor } });
  }
}

console.log('\n== RESUMEN ==');
console.log('Quedarían con cada valor:', porValor);
console.log('Por método:', porMetodo);
console.log(`Ya cargadas (no se tocan): ${yaCargadas.length}`);
console.log(`Sin resolver: ${sinResolver.length}`);
if (sinResolver.length) console.table(sinResolver.slice(0, 30));
console.log(`Discrepancias área-vs-producto (gana el área): ${discrepancias.length}`);
if (discrepancias.length) console.table(discrepancias);
console.log(`⚠️ Deals UY cuyo producto resuelve ISA PY (espejos — REVISAR con la usuaria): ${espejosUY.length}`);
if (espejosUY.length) console.table(espejosUY);

if (!EXECUTE) {
  console.log(`\nDRY-RUN: se habrían escrito ${aEscribir.length} line items. Correr con --execute para aplicar.`);
  process.exit(0);
}

console.log(`\n⚠️ Escribiendo ${aEscribir.length} line items...`);
for (let i = 0; i < aEscribir.length; i += 100) {
  await sleep(150);
  await hubspot.crm.lineItems.batchApi.update({ inputs: aEscribir.slice(i, i + 100) });
  console.log(`  ${Math.min(i + 100, aEscribir.length)}/${aEscribir.length}`);
}
console.log('✅ Backfill aplicado. La propagación a tickets NO emitidos la hace el re-snapshot');
console.log('   del forecast / el sync quirúrgico del motor; los emitidos quedan congelados.');
