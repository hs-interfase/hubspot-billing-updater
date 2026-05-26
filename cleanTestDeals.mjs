#!/usr/bin/env node
/**
 * cleanTestDeals.mjs
 *
 * Elimina deals de prueba y todo lo derivado:
 *   - Tickets asociados (por of_deal_id)
 *   - Invoices asociadas (por id_empresa = dealId)
 *   - Line items del deal (por asociación)
 *   - El deal mismo
 *
 * Uso:
 *   node cleanTestDeals.mjs                # dry run (solo reporta)
 *   node cleanTestDeals.mjs --execute      # borra todo
 */

import 'dotenv/config';
import { Client } from '@hubspot/api-client';

const TOKEN = process.env.HUBSPOT_PRIVATE_TOKEN;
if (!TOKEN) { console.error('❌ Falta HUBSPOT_PRIVATE_TOKEN'); process.exit(1); }

const hubspot = new Client({ accessToken: TOKEN });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const DRY_RUN = !process.argv.includes('--execute');

// ─── Deals a limpiar ──────────────────────────────────────────────────────────
const DEAL_IDS = ['60630536089', '60630526612'];

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function safeArchive(objectType, id, label) {
  try {
    if (objectType === 'tickets') {
      await hubspot.crm.tickets.basicApi.archive(String(id));
    } else if (objectType === 'line_items') {
      await hubspot.crm.lineItems.basicApi.archive(String(id));
    } else if (objectType === 'deals') {
      await hubspot.crm.deals.basicApi.archive(String(id));
    } else {
      // invoices, custom objects
      await hubspot.crm.objects.basicApi.archive(objectType, String(id));
    }
    return { ok: true };
  } catch (err) {
    const status = err?.response?.status ?? err?.statusCode ?? err?.code;
    if (status === 404) return { ok: true, alreadyGone: true };
    if (status === 429) {
      console.log(`      ⏳ Rate limit, esperando 10s...`);
      await sleep(10_000);
      return safeArchive(objectType, id, label);
    }
    return { ok: false, message: err.message };
  }
}

async function searchTicketsByDeal(dealId) {
  const results = [];
  let after;
  while (true) {
    const body = {
      filterGroups: [{ filters: [{ propertyName: 'of_deal_id', operator: 'EQ', value: dealId }] }],
      properties: ['of_deal_id', 'of_ticket_key', 'subject', 'hs_pipeline_stage', 'of_line_item_key'],
      limit: 100,
      ...(after ? { after } : {}),
    };
    const resp = await hubspot.crm.tickets.searchApi.doSearch(body);
    results.push(...(resp.results || []));
    if (resp.paging?.next?.after) {
      after = resp.paging.next.after;
      await sleep(150);
    } else break;
  }
  return results;
}

async function searchInvoicesByDeal(dealId) {
  const results = [];
  let after;
  while (true) {
    const body = {
      filterGroups: [{ filters: [{ propertyName: 'id_empresa', operator: 'EQ', value: dealId }] }],
      properties: ['id_empresa', 'of_invoice_key', 'etapa_de_la_factura', 'monto_a_facturar', 'line_item_key'],
      limit: 100,
      ...(after ? { after } : {}),
    };
    const resp = await hubspot.crm.objects.searchApi.doSearch('invoices', body);
    results.push(...(resp.results || []));
    if (resp.paging?.next?.after) {
      after = resp.paging.next.after;
      await sleep(150);
    } else break;
  }
  return results;
}

async function getLineItemsForDeal(dealId) {
  try {
    const resp = await hubspot.crm.deals.associationsApi.getAll(
      String(dealId), 'line_items'
    );
    const ids = (resp.results || []).map(a => a.toObjectId || a.id);
    return ids;
  } catch (err) {
    if (err?.response?.status === 404) return [];
    throw err;
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('═'.repeat(60));
  console.log('  🧹 CLEAN TEST DEALS');
  console.log(`  Modo: ${DRY_RUN ? '🔍 DRY RUN' : '🚀 EJECUCIÓN REAL'}`);
  console.log(`  Deals: ${DEAL_IDS.join(', ')}`);
  console.log('═'.repeat(60));

  const totals = { tickets: 0, invoices: 0, lineItems: 0, deals: 0, errors: 0 };

  for (const dealId of DEAL_IDS) {
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`  Deal ${dealId}`);
    console.log('─'.repeat(60));

    // 1. Tickets
    const tickets = await searchTicketsByDeal(dealId);
    console.log(`\n  🎫 Tickets encontrados: ${tickets.length}`);
    for (const t of tickets) {
      const p = t.properties || {};
      console.log(`     ID: ${t.id}  |  ${p.subject || '-'}  |  stage: ${p.hs_pipeline_stage || '-'}`);
      if (!DRY_RUN) {
        const r = await safeArchive('tickets', t.id);
        if (r.alreadyGone) console.log('        ⚪ Ya no existía');
        else if (r.ok)     { console.log('        🗑️  Eliminado'); totals.tickets++; }
        else               { console.log(`        ❌ ${r.message}`); totals.errors++; }
        await sleep(150);
      }
    }
    if (DRY_RUN && tickets.length > 0) totals.tickets += tickets.length;

    // 2. Invoices
    const invoices = await searchInvoicesByDeal(dealId);
    console.log(`\n  📄 Invoices encontradas: ${invoices.length}`);
    for (const inv of invoices) {
      const p = inv.properties || {};
      console.log(`     ID: ${inv.id}  |  etapa: ${p.etapa_de_la_factura || '-'}  |  monto: ${p.monto_a_facturar || '-'}  |  key: ${p.of_invoice_key || '-'}`);
      if (!DRY_RUN) {
        const r = await safeArchive('invoices', inv.id);
        if (r.alreadyGone) console.log('        ⚪ Ya no existía');
        else if (r.ok)     { console.log('        🗑️  Eliminado'); totals.invoices++; }
        else               { console.log(`        ❌ ${r.message}`); totals.errors++; }
        await sleep(150);
      }
    }
    if (DRY_RUN && invoices.length > 0) totals.invoices += invoices.length;

    // 3. Line Items
    const liIds = await getLineItemsForDeal(dealId);
    console.log(`\n  📦 Line Items encontrados: ${liIds.length}`);
    for (const liId of liIds) {
      console.log(`     ID: ${liId}`);
      if (!DRY_RUN) {
        const r = await safeArchive('line_items', liId);
        if (r.alreadyGone) console.log('        ⚪ Ya no existía');
        else if (r.ok)     { console.log('        🗑️  Eliminado'); totals.lineItems++; }
        else               { console.log(`        ❌ ${r.message}`); totals.errors++; }
        await sleep(150);
      }
    }
    if (DRY_RUN) totals.lineItems += liIds.length;

    // 4. Deal
    console.log(`\n  🏢 Deal ${dealId}`);
    if (!DRY_RUN) {
      const r = await safeArchive('deals', dealId);
      if (r.alreadyGone) console.log('     ⚪ Ya no existía');
      else if (r.ok)     { console.log('     🗑️  Eliminado'); totals.deals++; }
      else               { console.log(`     ❌ ${r.message}`); totals.errors++; }
    } else {
      totals.deals++;
    }
  }

  // Resumen
  console.log(`\n${'═'.repeat(60)}`);
  console.log('  RESUMEN');
  console.log(`  Tickets:    ${totals.tickets}`);
  console.log(`  Invoices:   ${totals.invoices}`);
  console.log(`  Line Items: ${totals.lineItems}`);
  console.log(`  Deals:      ${totals.deals}`);
  if (totals.errors > 0) console.log(`  Errores:    ${totals.errors}`);
  console.log(`  ${DRY_RUN ? '(dry run — nada borrado)' : '✅ Limpieza completada'}`);
  console.log('═'.repeat(60));
}

main().catch(err => {
  console.error(`\n❌ Error fatal: ${err.message}`);
  process.exit(1);
});
