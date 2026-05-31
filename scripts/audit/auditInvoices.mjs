#!/usr/bin/env node
/**
 * auditInvoices.mjs
 *
 * Detecta invoices problemáticas en tres categorías:
 *
 *   1. DUPLICADAS — misma of_invoice_key, más de una invoice activa.
 *      Con --delete: elimina la(s) más nueva(s), deja la más vieja.
 *
 *   2. HUÉRFANAS DE DEAL — id_empresa no corresponde a ningún deal existente.
 *      Con --delete: elimina.
 *
 *   3. HUÉRFANAS DE LINE ITEM — line_item_key no corresponde a ningún line item existente.
 *      Con --delete: elimina.
 *
 * Uso:
 *   node auditInvoices.mjs           # solo detecta y reporta (safe)
 *   node auditInvoices.mjs --delete  # detecta y elimina todo
 */

import 'dotenv/config';
import { hubspotClient } from './src/hubspotClient.js';

const args = process.argv.slice(2);
const DELETE = args.includes('--delete');

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ─── HubSpot helpers ───────────────────────────────────────────────────────────

async function searchAllInvoices() {
  const results = [];
  let after;
  while (true) {
    const body = {
      filterGroups: [{ filters: [{ propertyName: 'of_invoice_key', operator: 'HAS_PROPERTY' }] }],
      properties: [
        'of_invoice_key',
        'line_item_key',
        'id_empresa',
        'etapa_de_la_factura',
        'createdate',
        'hs_createdate',
        'hs_invoice_date',
        'monto_a_facturar',
        'of_invoice_status',
        'modo_de_generacion_de_factura',
      ],
      limit: 100,
      ...(after ? { after } : {}),
    };
    const resp = await hubspotClient.crm.objects.searchApi.doSearch('invoices', body);
    results.push(...(resp.results || []));
    process.stdout.write(`\r   Invoices leídas: ${results.length}...`);
    if (resp.paging?.next?.after) {
      after = resp.paging.next.after;
      await sleep(150);
    } else break;
  }
  console.log();
  return results;
}

async function dealExists(dealId) {
  try {
    await hubspotClient.crm.deals.basicApi.getById(String(dealId), ['hs_object_id']);
    return true;
  } catch (err) {
    if (err?.response?.status === 404 || err?.statusCode === 404) return false;
    throw err;
  }
}

async function lineItemExistsForLik(lik) {
  const resp = await hubspotClient.crm.objects.searchApi.doSearch('line_items', {
    filterGroups: [{ filters: [{ propertyName: 'line_item_key', operator: 'EQ', value: lik }] }],
    properties: ['line_item_key'],
    limit: 1,
  });
  return (resp?.results?.length ?? 0) > 0;
}

async function safeDeleteInvoice(invoiceId, label) {
  try {
    await hubspotClient.crm.objects.basicApi.archive('invoices', String(invoiceId));
    return { ok: true };
  } catch (err) {
    const status = err?.response?.status ?? err?.statusCode ?? err?.code;
    if (status === 404) return { ok: true, alreadyGone: true };
    if (status === 429) {
      console.log(`      ⏳ Rate limit, esperando 10s... (${label})`);
      await sleep(10_000);
      return safeDeleteInvoice(invoiceId, label);
    }
    return { ok: false, message: err.message };
  }
}

function isActive(inv) {
  const etapa = (inv.properties?.etapa_de_la_factura || '').trim().toLowerCase();
  return etapa !== 'cancelada';
}

function fmtInvoice(inv) {
  const p = inv.properties || {};
  return [
    `   ID: ${inv.id}  |  etapa: ${p.etapa_de_la_factura || '-'}  |  monto: ${p.monto_a_facturar || '-'}`,
    `      of_invoice_key:  ${p.of_invoice_key || '-'}`,
    `      line_item_key:   ${p.line_item_key || '-'}`,
    `      id_empresa:      ${p.id_empresa || '-'}`,
    `      hs_createdate:   ${p.hs_createdate || p.createdate || '-'}`,
    `      modo_generacion: ${p.modo_de_generacion_de_factura || '-'}`,
  ].join('\n');
}

async function deleteList(invoices, reason) {
  let deleted = 0, alreadyGone = 0, errors = 0;
  for (const inv of invoices) {
    const result = await safeDeleteInvoice(inv.id, reason);
    if (result.alreadyGone) { console.log(`      ⚠️  Ya no existía`); alreadyGone++; }
    else if (result.ok)     { console.log(`      🗑️  Eliminada`);      deleted++;    await sleep(150); }
    else                    { console.error(`      ❌ Error: ${result.message}`); errors++; }
  }
  return { deleted, alreadyGone, errors };
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  AUDIT DE INVOICES');
  console.log(DELETE
    ? '  ⚠️  MODO: detectar y ELIMINAR'
    : '  ℹ️  MODO: solo reporte  (agregar --delete para eliminar)');
  console.log('═══════════════════════════════════════════════════════════\n');

  // ── 1. Leer todas las invoices ───────────────────────────────────────────────
  console.log('📥 Leyendo invoices...');
  const allInvoices = await searchAllInvoices();
  console.log(`   Total con of_invoice_key: ${allInvoices.length}\n`);

  // ── 2. DUPLICADAS ────────────────────────────────────────────────────────────
  console.log('🔍 Analizando duplicadas por of_invoice_key...');

  const byKey = new Map(); // key → [invoices]
  for (const inv of allInvoices) {
    const key = (inv.properties?.of_invoice_key || '').trim();
    if (!key) continue;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(inv);
  }

  const duplicateGroups = [];
  for (const [key, group] of byKey.entries()) {
    const active = group.filter(isActive);
    if (active.length > 1) duplicateGroups.push({ key, group: active });
  }

  console.log('\n══════════════════════════════════════════════════════════');
  console.log(`📑 DUPLICADAS (misma of_invoice_key, activas): ${duplicateGroups.length} grupos`);
  console.log('══════════════════════════════════════════════════════════');

  let dupStats = { deleted: 0, alreadyGone: 0, errors: 0 };

  if (duplicateGroups.length === 0) {
    console.log('   ✅ Sin duplicadas\n');
  } else {
    for (const { key, group } of duplicateGroups) {
      // Ordenar por createdate asc — la más vieja primero
      group.sort((a, b) => {
        const da = new Date(a.properties?.createdate || 0);
        const db = new Date(b.properties?.createdate || 0);
        return da - db;
      });

      const [keep, ...toDelete] = group;

      console.log(`\n   KEY: ${key}`);
      console.log(`   ✅ Conservar (más vieja):`);
      console.log(fmtInvoice(keep));
      console.log(`   ❌ Eliminar (${toDelete.length}):`);
      for (const inv of toDelete) {
        console.log(fmtInvoice(inv));
        if (DELETE) {
          const r = await deleteList([inv], 'duplicada');
          dupStats.deleted    += r.deleted;
          dupStats.alreadyGone += r.alreadyGone;
          dupStats.errors     += r.errors;
        }
      }
    }
    if (DELETE) {
      console.log(`\n   Resumen duplicadas: ${dupStats.deleted} eliminadas, ${dupStats.alreadyGone} ya no existían, ${dupStats.errors} errores`);
    }
  }

  // ── 3. HUÉRFANAS DE DEAL ─────────────────────────────────────────────────────
  console.log('\n🔍 Verificando deals...');

  const invoicesWithDeal = allInvoices.filter(inv => (inv.properties?.id_empresa || '').trim());
  const uniqueDealIds = [...new Set(invoicesWithDeal.map(inv => inv.properties.id_empresa.trim()))];

  console.log(`   Deals únicos a verificar: ${uniqueDealIds.length}`);

  const missingDealIds = new Set();
  let checkedDeals = 0;
  for (const dealId of uniqueDealIds) {
    const exists = await dealExists(dealId);
    if (!exists) missingDealIds.add(dealId);
    checkedDeals++;
    if (checkedDeals % 5 === 0 || checkedDeals === uniqueDealIds.length) {
      process.stdout.write(`\r   Verificados: ${checkedDeals}/${uniqueDealIds.length} — faltantes: ${missingDealIds.size}`);
    }
    await sleep(130);
  }
  console.log();

  const orphansByDeal = allInvoices.filter(inv => {
    const d = (inv.properties?.id_empresa || '').trim();
    return d && missingDealIds.has(d);
  });

  console.log('\n══════════════════════════════════════════════════════════');
  console.log(`🏢 HUÉRFANAS DE DEAL: ${orphansByDeal.length}`);
  console.log('══════════════════════════════════════════════════════════');

  let dealOrphanStats = { deleted: 0, alreadyGone: 0, errors: 0 };

  if (orphansByDeal.length === 0) {
    console.log('   ✅ Sin huérfanas de deal\n');
  } else {
    for (const inv of orphansByDeal) {
      console.log(`\n${fmtInvoice(inv)}`);
      if (DELETE) {
        const r = await deleteList([inv], 'huérfana-deal');
        dealOrphanStats.deleted     += r.deleted;
        dealOrphanStats.alreadyGone += r.alreadyGone;
        dealOrphanStats.errors      += r.errors;
      }
    }
    if (DELETE) {
      console.log(`\n   Resumen huérfanas de deal: ${dealOrphanStats.deleted} eliminadas, ${dealOrphanStats.alreadyGone} ya no existían, ${dealOrphanStats.errors} errores`);
    }
  }

  // ── 4. HUÉRFANAS DE LINE ITEM ────────────────────────────────────────────────
  console.log('\n🔍 Verificando line items...');

  const invoicesWithLik = allInvoices.filter(inv => (inv.properties?.line_item_key || '').trim());
  const uniqueLiks = [...new Set(invoicesWithLik.map(inv => inv.properties.line_item_key.trim()))];

  console.log(`   LIKs únicos a verificar: ${uniqueLiks.size ?? uniqueLiks.length}`);

  const missingLiks = new Set();
  let checkedLiks = 0;
  for (const lik of uniqueLiks) {
    const exists = await lineItemExistsForLik(lik);
    if (!exists) missingLiks.add(lik);
    checkedLiks++;
    if (checkedLiks % 5 === 0 || checkedLiks === uniqueLiks.length) {
      process.stdout.write(`\r   Verificados: ${checkedLiks}/${uniqueLiks.length} — huérfanos: ${missingLiks.size}`);
    }
    await sleep(130);
  }
  console.log();

  const orphansByLik = allInvoices.filter(inv => {
    const lik = (inv.properties?.line_item_key || '').trim();
    return lik && missingLiks.has(lik);
  });

  console.log('\n══════════════════════════════════════════════════════════');
  console.log(`📦 HUÉRFANAS DE LINE ITEM: ${orphansByLik.length}`);
  console.log('══════════════════════════════════════════════════════════');

  let likOrphanStats = { deleted: 0, alreadyGone: 0, errors: 0 };

  if (orphansByLik.length === 0) {
    console.log('   ✅ Sin huérfanas de line item\n');
  } else {
    for (const inv of orphansByLik) {
      console.log(`\n${fmtInvoice(inv)}`);
      if (DELETE) {
        const r = await deleteList([inv], 'huérfana-lik');
        likOrphanStats.deleted     += r.deleted;
        likOrphanStats.alreadyGone += r.alreadyGone;
        likOrphanStats.errors      += r.errors;
      }
    }
    if (DELETE) {
      console.log(`\n   Resumen huérfanas de line item: ${likOrphanStats.deleted} eliminadas, ${likOrphanStats.alreadyGone} ya no existían, ${likOrphanStats.errors} errores`);
    }
  }

  // ── 5. Resumen final ─────────────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  RESUMEN FINAL');
  console.log(`  Grupos duplicados:           ${duplicateGroups.length}`);
  console.log(`  Huérfanas de deal:           ${orphansByDeal.length}`);
  console.log(`  Huérfanas de line item:      ${orphansByLik.length}`);
  if (DELETE) {
    const totalDeleted = dupStats.deleted + dealOrphanStats.deleted + likOrphanStats.deleted;
    const totalErrors  = dupStats.errors  + dealOrphanStats.errors  + likOrphanStats.errors;
    console.log(`  Total eliminadas:            ${totalDeleted}`);
    console.log(`  Total errores:               ${totalErrors}`);
  }
  console.log('  ✅ Audit completado');
  console.log('═══════════════════════════════════════════════════════════');
}

main().catch(err => {
  console.error('\n❌ Error fatal:', err.message);
  if (err.response?.data) console.error(JSON.stringify(err.response.data, null, 2));
  process.exit(1);
});
