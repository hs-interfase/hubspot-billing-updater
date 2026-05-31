#!/usr/bin/env node
/**
 * cleanupMirrorDeal.mjs
 *
 * Borra el deal PY de prueba + su mirror UY (si existe) + todos sus objetos:
 *   invoices → tickets → line items → deals
 *
 * Uso:
 *   node cleanupMirrorDeal.mjs              # usa mirror-seed-manifest.json
 *   node cleanupMirrorDeal.mjs --dry        # solo muestra qué borraría
 *   node cleanupMirrorDeal.mjs --prefix "[TEST-MIRROR]"  # busca por prefijo
 */

import 'dotenv/config';
import { hubspotClient } from './src/hubspotClient.js';
import fs from 'fs';

// ─── Config ────────────────────────────────────────────────────────────────────

const args      = process.argv.slice(2);
const DRY_RUN   = args.includes('--dry');
const prefixArg = args.find((_, i, a) => a[i - 1] === '--prefix') || null;

// ─── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function safeArchive(objectType, objectId, label = '') {
  if (DRY_RUN) {
    console.log(`    🔍 [DRY] Borraría ${objectType} ${objectId} ${label}`);
    return true;
  }
  try {
    await hubspotClient.crm[objectType].basicApi.archive(String(objectId));
    console.log(`    🗑️  Borrado ${objectType} ${objectId} ${label}`);
    return true;
  } catch (err) {
    const status = err?.statusCode || err?.code;
    if (status === 404) {
      console.log(`    ⚠️  ${objectType} ${objectId} no encontrado (ya borrado?)`);
      return true;
    }
    if (status === 429) {
      console.log(`    ⏳ Rate limit, esperando 10s...`);
      await sleep(10000);
      return safeArchive(objectType, objectId, label);
    }
    console.error(`    ❌ Error borrando ${objectType} ${objectId}: ${err.message}`);
    return false;
  }
}

async function getAssociatedIds(fromType, fromId, toType) {
  try {
    const resp = await hubspotClient.crm.associations.v4.basicApi.getPage(
      fromType, String(fromId), toType, 100
    );
    return (resp.results || []).map(r => String(r.toObjectId));
  } catch (err) {
    if (err?.statusCode === 404) return [];
    console.warn(`    ⚠️  Error leyendo associations ${fromType}/${fromId}→${toType}: ${err.message}`);
    return [];
  }
}

async function searchTicketsByDealId(dealId) {
  const ids = [];
  let after = undefined;

  while (true) {
    const body = {
      filterGroups: [{
        filters: [
          { propertyName: 'of_deal_id', operator: 'EQ', value: String(dealId) },
        ],
      }],
      properties: ['subject', 'of_ticket_key'],
      limit: 100,
      ...(after ? { after } : {}),
    };

    const resp = await hubspotClient.crm.tickets.searchApi.doSearch(body);
    for (const t of (resp.results || [])) ids.push(t.id);

    if (resp.paging?.next?.after) {
      after = resp.paging.next.after;
    } else {
      break;
    }
  }

  return ids;
}

async function searchDealsByPrefix(prefix) {
  const entries = [];
  let after = undefined;

  while (true) {
    const body = {
      filterGroups: [{
        filters: [
          { propertyName: 'dealname', operator: 'CONTAINS_TOKEN', value: prefix },
        ],
      }],
      properties: ['dealname', 'deal_uy_mirror_id'],
      limit: 100,
      ...(after ? { after } : {}),
    };

    const resp = await hubspotClient.crm.deals.searchApi.doSearch(body);
    for (const d of (resp.results || [])) {
      entries.push({
        dealId:   d.id,
        dealname: d.properties.dealname,
        mirrorId: d.properties.deal_uy_mirror_id || null,
      });
    }

    if (resp.paging?.next?.after) {
      after = resp.paging.next.after;
    } else {
      break;
    }
  }

  return entries;
}

// ─── Cleanup de un deal ────────────────────────────────────────────────────────

async function cleanupDeal(dealId, dealName) {
  console.log(`\n🧹 Limpiando: ${dealName || dealId}`);

  // 1) Tickets por of_deal_id
  const ticketIds = await searchTicketsByDealId(dealId);
  console.log(`  📎 Tickets encontrados: ${ticketIds.length}`);

  // 2) Invoices de tickets + del deal directamente
  const invoiceIds = new Set();
  for (const ticketId of ticketIds) {
    const ids = await getAssociatedIds('tickets', ticketId, 'invoices');
    ids.forEach(id => invoiceIds.add(id));
  }
  const dealInvoiceIds = await getAssociatedIds('deals', dealId, 'invoices');
  dealInvoiceIds.forEach(id => invoiceIds.add(id));
  console.log(`  📎 Invoices encontradas: ${invoiceIds.size}`);

  // 3) Line items del deal
  const lineItemIds = await getAssociatedIds('deals', dealId, 'line_items');
  console.log(`  📎 Line Items encontrados: ${lineItemIds.length}`);

  // 4) Borrar en orden: invoices → tickets → line items → deal
  console.log('  🗑️  Borrando invoices...');
  for (const id of invoiceIds) {
    await safeArchive('invoices', id);
    await sleep(150);
  }

  console.log('  🗑️  Borrando tickets...');
  for (const id of ticketIds) {
    await safeArchive('tickets', id);
    await sleep(150);
  }

  console.log('  🗑️  Borrando line items...');
  for (const id of lineItemIds) {
    await safeArchive('lineItems', id);
    await sleep(150);
  }

  console.log('  🗑️  Borrando deal...');
  await safeArchive('deals', dealId, `(${dealName})`);
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  CLEANUP MIRROR DEAL ${DRY_RUN ? '(DRY RUN)' : '(REAL DELETE)'}`);
  console.log('═══════════════════════════════════════════════════════════');

  // Recolectar deals a borrar
  let dealEntries = [];

  if (!prefixArg && fs.existsSync('mirror-seed-manifest.json')) {
    console.log('\n📄 Usando mirror-seed-manifest.json');
    const manifest = JSON.parse(fs.readFileSync('mirror-seed-manifest.json', 'utf8'));

    // Leer el deal PY para obtener deal_uy_mirror_id
    let mirrorId = null;
    try {
      const deal = await hubspotClient.crm.deals.basicApi.getById(
        String(manifest.pyDealId),
        ['dealname', 'deal_uy_mirror_id']
      );
      mirrorId = deal.properties.deal_uy_mirror_id || null;
      dealEntries.push({
        dealId:   manifest.pyDealId,
        dealname: deal.properties.dealname,
        mirrorId,
      });
    } catch (err) {
      console.warn(`  ⚠️  No se pudo leer deal PY ${manifest.pyDealId}: ${err.message}`);
      dealEntries.push({
        dealId:   manifest.pyDealId,
        dealname: 'Deal PY (manifest)',
        mirrorId: null,
      });
    }

    // También buscar por prefijo para atrapar cualquier deal extra
    const fromSearch = await searchDealsByPrefix(manifest.prefix || '[TEST-MIRROR]');
    for (const s of fromSearch) {
      if (!dealEntries.some(e => e.dealId === s.dealId)) {
        dealEntries.push(s);
      }
    }
  } else {
    const prefix = prefixArg || '[TEST-MIRROR]';
    console.log(`\n🔍 Buscando deals con prefijo: "${prefix}"`);
    dealEntries = await searchDealsByPrefix(prefix);
  }

  if (dealEntries.length === 0) {
    console.log('\n✅ No se encontraron deals de test para limpiar.');
    return;
  }

  // Recolectar mirror IDs que no estén ya en la lista
  const mirrorIdsToClean = [];
  for (const d of dealEntries) {
    if (d.mirrorId && !dealEntries.some(e => e.dealId === d.mirrorId)) {
      mirrorIdsToClean.push(d.mirrorId);
    }
  }

  console.log(`\n📋 Deals a limpiar: ${dealEntries.length + mirrorIdsToClean.length}`);
  for (const d of dealEntries) {
    console.log(`   PY  — ${d.dealId}: ${d.dealname}`);
    if (d.mirrorId) console.log(`   UY  — ${d.mirrorId}: (mirror)`);
  }

  // Borrar deals principales (PY)
  for (const d of dealEntries) {
    await cleanupDeal(d.dealId, d.dealname);
    await sleep(500);
  }

  // Borrar mirrors UY
  for (const mirrorId of mirrorIdsToClean) {
    await cleanupDeal(mirrorId, '(mirror UY)');
    await sleep(500);
  }

  // Borrar manifest
  if (!DRY_RUN && fs.existsSync('mirror-seed-manifest.json')) {
    fs.unlinkSync('mirror-seed-manifest.json');
    console.log('\n🗑️  mirror-seed-manifest.json borrado');
  }

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  ✅ Cleanup completado');
  console.log('═══════════════════════════════════════════════════════════');
}

main().catch(err => {
  console.error('❌ Error fatal:', err.message);
  if (err.response?.data) console.error(JSON.stringify(err.response.data, null, 2));
  process.exit(1);
});
