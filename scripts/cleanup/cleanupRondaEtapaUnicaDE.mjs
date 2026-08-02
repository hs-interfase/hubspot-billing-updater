#!/usr/bin/env node
/**
 * cleanupRondaEtapaUnicaDE.mjs
 *
 * Archiva TODO lo que creó la ronda D+E: los tickets de cada deal (los sembrados
 * y los que haya creado el motor), los line items, los deals ORIGINALES, los
 * deals ESPEJO que creó el motor, y la empresa. Lee ronda-de-manifest.json.
 *
 * Los espejos se toman de tres fuentes, porque perder uno deja basura viva en el
 * portal: el manifest (`mirrors`), la prop `deal_uy_mirror_id` de cada original,
 * y una búsqueda por nombre (el motor los llama «<original> - UY»).
 *
 * ⚠️ SOLO SANDBOX.
 *
 * Uso:
 *   node scripts/cleanup/cleanupRondaEtapaUnicaDE.mjs --dry
 *   node scripts/cleanup/cleanupRondaEtapaUnicaDE.mjs --go
 */

import 'dotenv/config';
import fs from 'fs';
import { hubspotClient } from '../../src/hubspotClient.js';

if (String(process.env.HUBSPOT_ENV || '').toLowerCase() !== 'sandbox') {
  console.error('❌ SOLO sandbox. Abortando.');
  process.exit(1);
}

const GO = process.argv.includes('--go');
const MANIFEST = 'ronda-de-manifest.json';
const TOKEN = 'RONDA-DE';

if (!fs.existsSync(MANIFEST)) { console.error(`❌ No existe ${MANIFEST}`); process.exit(1); }
const m = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));

async function idsAsociados(dealId, toType) {
  const out = [];
  let after;
  do {
    const r = await hubspotClient.crm.associations.v4.basicApi.getPage('deals', String(dealId), toType, 100, after);
    for (const x of (r.results || [])) out.push(String(x.toObjectId));
    after = r.paging?.next?.after;
  } while (after);
  return [...new Set(out)];
}

/**
 * Tickets del negocio por asociación Y por `of_deal_id`.
 *
 * 🔴 La asociación sola DEJA BASURA. En los deals espejo el motor crea tickets
 * que todavía no figuran asociados: en esta ronda la asociación devolvía 6 y la
 * búsqueda por `of_deal_id` 7. Limpiar sólo por asociación deja tickets vivos en
 * el portal después de dar la ronda por cerrada.
 */
async function ticketsDelDeal(dealId) {
  const ids = new Set(await idsAsociados(dealId, 'tickets'));
  try {
    const r = await hubspotClient.crm.tickets.searchApi.doSearch({
      filterGroups: [{ filters: [{ propertyName: 'of_deal_id', operator: 'EQ', value: String(dealId) }] }],
      properties: ['hs_object_id'], limit: 100,
    });
    for (const t of (r.results || [])) ids.add(String(t.id));
  } catch (err) { console.warn(`   ⚠️  búsqueda de tickets por of_deal_id falló: ${err.message}`); }
  return [...ids];
}

async function archivar(tipo, ids, api) {
  let n = 0;
  for (const id of ids) {
    if (!GO) { console.log(`   [DRY] archivaría ${tipo} ${id}`); n++; continue; }
    try { await api.archive(String(id)); n++; }
    catch (err) { console.warn(`   ⚠️  ${tipo} ${id}: ${err.message}`); }
  }
  return n;
}

async function main() {
  console.log(`\n═══ CLEANUP ronda D+E ${GO ? '' : '(DRY — usá --go para ejecutar)'} ═══`);
  const tot = { tickets: 0, lineItems: 0, deals: 0, companies: 0 };

  const dealIds = new Set(Object.values(m.deals || {}).map(d => String(d.id)));

  // 1) Espejos del manifest
  for (const [slug, esp] of Object.entries(m.mirrors || {})) {
    if (esp?.mirrorDealId) {
      console.log(`   + espejo del manifest (${slug}): ${esp.mirrorDealId}`);
      dealIds.add(String(esp.mirrorDealId));
    }
  }

  // 2) Espejos que el motor haya creado DESPUÉS del último --mirrors
  for (const d of Object.values(m.deals || {})) {
    try {
      const py = await hubspotClient.crm.deals.basicApi.getById(String(d.id), ['deal_uy_mirror_id']);
      const mid = String(py.properties?.deal_uy_mirror_id || '').trim();
      if (mid && !dealIds.has(mid)) { console.log(`   + espejo vía deal_uy_mirror_id: ${mid}`); dealIds.add(mid); }
    } catch { /* el deal puede no existir ya */ }
  }

  // 3) Red de seguridad por nombre
  try {
    const s = await hubspotClient.crm.deals.searchApi.doSearch({
      filterGroups: [{ filters: [{ propertyName: 'dealname', operator: 'CONTAINS_TOKEN', value: TOKEN }] }],
      properties: ['dealname'], limit: 100,
    });
    for (const d of (s.results || [])) {
      if (!dealIds.has(String(d.id))) {
        console.log(`   + deal extra encontrado por nombre: ${d.id} — ${d.properties.dealname}`);
        dealIds.add(String(d.id));
      }
    }
  } catch (err) { console.warn(`   ⚠️  búsqueda de deals extra falló: ${err.message}`); }

  for (const dealId of dealIds) {
    console.log(`\n▸ deal ${dealId}`);
    const tickets = await ticketsDelDeal(dealId);
    const lis     = await idsAsociados(dealId, 'line_items');
    console.log(`   ${tickets.length} ticket(s), ${lis.length} line item(s)`);
    tot.tickets   += await archivar('ticket', tickets, hubspotClient.crm.tickets.basicApi);
    tot.lineItems += await archivar('line_item', lis, hubspotClient.crm.lineItems.basicApi);
    tot.deals     += await archivar('deal', [dealId], hubspotClient.crm.deals.basicApi);
  }

  if (m.companyId) {
    console.log(`\n▸ empresa ${m.companyId}`);
    tot.companies += await archivar('company', [m.companyId], hubspotClient.crm.companies.basicApi);
  }

  console.log('\n═══ TOTAL ═══');
  console.log(`   tickets ${tot.tickets} · line items ${tot.lineItems} · deals ${tot.deals} · empresas ${tot.companies}`);

  if (GO) {
    for (const f of [MANIFEST, 'ronda-de-snapshots.json']) {
      if (fs.existsSync(f)) { fs.renameSync(f, f + '.bak'); console.log(`   ${f} → ${f}.bak`); }
    }
  }
}

main().catch(err => { console.error('❌', err.message); process.exit(1); });
