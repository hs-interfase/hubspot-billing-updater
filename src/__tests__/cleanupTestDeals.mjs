#!/usr/bin/env node
/**
 * cleanupTestDeals.mjs
 * 
 * Borra TODOS los registros derivados del seed de prueba:
 *   invoices → tickets → line items → deals (+ mirrors)
 * 
 * Uso:
 *   node cleanupTestDeals.mjs                  # usa test-seed-manifest.json
 *   node cleanupTestDeals.mjs --prefix "[TEST-SEED]"  # busca por prefijo
 *   node cleanupTestDeals.mjs --dry             # solo muestra qué borraría
 */

import 'dotenv/config';
import { hubspotClient } from '../hubspotClient.js';
import fs from 'fs';

// ─── Config ────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry');
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
      return safeArchive(objectType, objectId, label); // retry
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
    for (const t of (resp.results || [])) {
      ids.push(t.id);
    }

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
        dealId: d.id,
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

// ─── Main cleanup ──────────────────────────────────────────────────────────────

async function cleanupDeal(dealId, dealName) {
  console.log(`\n🧹 Limpiando: ${dealName || dealId}`);

  // 1) Buscar tickets por of_deal_id
  const ticketIds = await searchTicketsByDealId(dealId);
  console.log(`  📎 Tickets encontrados: ${ticketIds.length}`);

  // 2) Para cada ticket, buscar invoices asociadas
  const invoiceIds = new Set();
  for (const ticketId of ticketIds) {
    const invIds = await getAssociatedIds('tickets', ticketId, 'invoices');
    invIds.forEach(id => invoiceIds.add(id));
  }

  // También buscar invoices directamente del deal
  const dealInvoiceIds = await getAssociatedIds('deals', dealId, 'invoices');
  dealInvoiceIds.forEach(id => invoiceIds.add(id));

  console.log(`  📎 Invoices encontradas: ${invoiceIds.size}`);

  // 3) Buscar line items del deal
  const lineItemIds = await getAssociatedIds('deals', dealId, 'line_items');
  console.log(`  📎 Line Items encontrados: ${lineItemIds.length}`);

  // 4) BORRAR en orden: invoices → tickets → line items → deal
  console.log('  🗑️  Borrando invoices...');
  for (const invId of invoiceIds) {
    await safeArchive('invoices', invId);
    await sleep(150);
  }

  console.log('  🗑️  Borrando tickets...');
  for (const tId of ticketIds) {
    await safeArchive('tickets', tId);
    await sleep(150);
  }

  console.log('  🗑️  Borrando line items...');
  for (const liId of lineItemIds) {
    await safeArchive('lineItems', liId);
    await sleep(150);
  }

  console.log('  🗑️  Borrando deal...');
  await safeArchive('deals', dealId, `(${dealName})`);
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  CLEANUP TEST DEALS ${DRY_RUN ? '(DRY RUN)' : '(REAL DELETE)'}`);
  console.log('═══════════════════════════════════════════════════════════');

  let dealEntries = [];

  // Estrategia 1: manifest file
  if (!prefixArg && fs.existsSync('test-seed-manifest.json')) {
    console.log('\n📄 Usando test-seed-manifest.json');
    const manifest = JSON.parse(fs.readFileSync('test-seed-manifest.json', 'utf8'));

    for (const d of manifest.deals) {
      dealEntries.push({ dealId: d.dealId, dealname: d.dealName, mirrorId: null });
    }

    // También buscar por prefijo para atrapar mirrors
    const prefix = manifest.prefix || '[TEST-SEED]';
    const fromSearch = await searchDealsByPrefix(prefix);
    for (const s of fromSearch) {
      if (!dealEntries.some(e => e.dealId === s.dealId)) {
        dealEntries.push(s);
      }
    }
  }
  // Estrategia 2: buscar por prefijo
  else {
    const prefix = prefixArg || '[TEST-SEED]';
    console.log(`\n🔍 Buscando deals con prefijo: "${prefix}"`);
    dealEntries = await searchDealsByPrefix(prefix);
  }

  if (dealEntries.length === 0) {
    console.log('\n✅ No se encontraron deals de test para limpiar.');
    return;
  }

  console.log(`\n📋 Deals a limpiar: ${dealEntries.length}`);
  for (const d of dealEntries) {
    console.log(`   - ${d.dealId}: ${d.dealname}`);
  }

  // Recolectar mirror IDs que no estén ya en la lista
  const mirrorIds = [];
  for (const d of dealEntries) {
    if (d.mirrorId && !dealEntries.some(e => e.dealId === d.mirrorId)) {
      mirrorIds.push(d.mirrorId);
    }
  }

  // Limpiar deals principales
  for (const d of dealEntries) {
    await cleanupDeal(d.dealId, d.dealname);
    await sleep(500);
  }

  // Limpiar mirrors huérfanos
  for (const mirrorId of mirrorIds) {
    await cleanupDeal(mirrorId, `(mirror de test)`);
    await sleep(500);
  }

  // Borrar manifest
  if (!DRY_RUN && fs.existsSync('test-seed-manifest.json')) {
    fs.unlinkSync('test-seed-manifest.json');
    console.log('\n🗑️  Manifest borrado');
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
