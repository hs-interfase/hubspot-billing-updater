#!/usr/bin/env node
/**
 * cleanupRondaEtapaUnicaBC.mjs
 *
 * Archiva TODO lo que creó seedRondaEtapaUnicaBC.mjs: los tickets de cada deal
 * (los sembrados y los que haya creado el motor), los line items, los deals y
 * la empresa. Lee ronda-bc-manifest.json.
 *
 * ⚠️ SOLO SANDBOX.
 *
 * Uso:
 *   node scripts/cleanup/cleanupRondaEtapaUnicaBC.mjs --dry
 *   node scripts/cleanup/cleanupRondaEtapaUnicaBC.mjs --go
 */

import 'dotenv/config';
import fs from 'fs';
import { hubspotClient } from '../../src/hubspotClient.js';

if (String(process.env.HUBSPOT_ENV || '').toLowerCase() !== 'sandbox') {
  console.error('❌ SOLO sandbox. Abortando.');
  process.exit(1);
}

const GO = process.argv.includes('--go');
const MANIFEST = 'ronda-bc-manifest.json';

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
  console.log(`\n═══ CLEANUP ronda B+C ${GO ? '' : '(DRY — usá --go para ejecutar)'} ═══`);
  let tot = { tickets: 0, lineItems: 0, deals: 0, companies: 0 };

  // Los deals espejo que haya creado el motor también se llevan por delante:
  // se detectan como deals asociados a los line items espejo, así que se buscan
  // por nombre además de por manifest.
  const dealIds = new Set(Object.values(m.deals).map(d => String(d.id)));

  try {
    const s = await hubspotClient.crm.deals.searchApi.doSearch({
      filterGroups: [{ filters: [{ propertyName: 'dealname', operator: 'CONTAINS_TOKEN', value: 'RONDA-BC' }] }],
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
    const tickets = await idsAsociados(dealId, 'tickets');
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

  console.log(`\n═══ TOTAL ═══`);
  console.log(`   tickets ${tot.tickets} · line items ${tot.lineItems} · deals ${tot.deals} · empresas ${tot.companies}`);

  if (GO) {
    for (const f of [MANIFEST, 'ronda-bc-snapshots.json']) {
      if (fs.existsSync(f)) { fs.renameSync(f, f + '.bak'); console.log(`   ${f} → ${f}.bak`); }
    }
  }
}

main().catch(err => { console.error('❌', err.message); process.exit(1); });
