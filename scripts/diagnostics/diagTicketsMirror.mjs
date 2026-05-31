#!/usr/bin/env node
/**
 * diagTicketsMirror.mjs
 * Diagnóstico de deals mirror UY: detecta mirrors sin tickets o con LIs incompletos.
 *
 * Uso:
 *   node diagTicketsMirror.mjs            # solo muestra mirrors con problemas
 *   node diagTicketsMirror.mjs --all      # muestra todos los mirrors
 *   node diagTicketsMirror.mjs --deal ID  # diagnostica un mirror específico
 */

import 'dotenv/config';
import { hubspotClient } from '../../src/hubspotClient.js';

// ── Config ──────────────────────────────────────────────────────────────────────

const SHOW_ALL = process.argv.includes('--all');
const SINGLE_DEAL_IDX = process.argv.indexOf('--deal');
const SINGLE_DEAL_ID = SINGLE_DEAL_IDX !== -1 ? process.argv[SINGLE_DEAL_IDX + 1] : null;

const DEAL_PROPS = [
  'dealname', 'dealstage', 'pais_operativo', 'es_mirror_de_py',
  'deal_py_origen_id', 'facturacion_activa', 'facturacion_automatica',
  'hs_object_id',
];

const LI_PROPS = [
  'name', 'line_item_key', 'facturacion_automatica', 'billing_next_date',
  'last_ticketed_date', 'of_line_item_py_origen_id', 'pausa',
  'hs_recurring_billing_start_date', 'fecha_inicio_de_facturacion',
  'billing_anchor_date', 'fechas_completas',
  'hs_recurring_billing_number_of_payments', 'recurringbillingfrequency',
  'price', 'quantity', 'createdate',
];

const BILLING_REQUIRED = ['line_item_key', 'billing_next_date', 'of_line_item_py_origen_id'];

// ── Helpers ─────────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getAssocIdsV4(fromType, fromId, toType) {
  const out = [];
  let after;
  do {
    const resp = await hubspotClient.crm.associations.v4.basicApi.getPage(
      fromType, String(fromId), toType, 100, after,
    );
    for (const r of (resp.results || [])) out.push(String(r.toObjectId));
    after = resp.paging?.next?.after;
  } while (after);
  return out;
}

async function searchTicketsByLik(lik) {
  const resp = await hubspotClient.crm.tickets.searchApi.doSearch({
    filterGroups: [{ filters: [{ propertyName: 'of_line_item_key', operator: 'EQ', value: lik }] }],
    properties: ['subject', 'hs_pipeline', 'hs_pipeline_stage', 'of_line_item_key', 'fecha_resolucion_esperada'],
    limit: 100,
  });
  return resp.results || [];
}

// ── Fetch all mirror deals (keyset pagination) ─────────────────────────────────

async function fetchAllMirrorDeals() {
  const deals = [];
  let lastId = null;

  while (true) {
    const filters = [
      { propertyName: 'es_mirror_de_py', operator: 'EQ', value: 'true' },
    ];
    if (lastId) {
      filters.push({ propertyName: 'hs_object_id', operator: 'GT', value: String(lastId) });
    }

    const resp = await hubspotClient.crm.deals.searchApi.doSearch({
      filterGroups: [{ filters }],
      properties: DEAL_PROPS,
      sorts: [{ propertyName: 'hs_object_id', direction: 'ASCENDING' }],
      limit: 100,
    });

    const batch = resp.results || [];
    if (batch.length === 0) break;

    deals.push(...batch);
    lastId = batch[batch.length - 1].id;
    await sleep(250);
  }

  return deals;
}

// ── Diagnose a single mirror deal ───────────────────────────────────────────────

async function diagnoseMirrorDeal(deal) {
  const dp = deal.properties || {};
  const dealId = String(deal.id);

  // 1) Obtener line items
  const liIds = await getAssocIdsV4('deals', dealId, 'line_items');
  let lineItems = [];
  if (liIds.length > 0) {
    const batchResp = await hubspotClient.crm.lineItems.batchApi.read({
      inputs: liIds.map(id => ({ id })),
      properties: LI_PROPS,
    });
    lineItems = batchResp.results || [];
  }

  // 2) Para cada LI con LIK, buscar tickets
  const liResults = [];
  for (const li of lineItems) {
    const lp = li.properties || {};
    const lik = (lp.line_item_key || '').trim();

    const missingProps = BILLING_REQUIRED.filter(p => !lp[p]?.trim());
    let tickets = [];
    if (lik) {
      tickets = await searchTicketsByLik(lik);
      await sleep(200);
    }

    const numPayments = Number(lp.hs_recurring_billing_number_of_payments) || 0;
    const isSinglePayment = numPayments === 1 || numPayments === 0;
    // No flaggear billing_next_date faltante si ya se facturó y es pago único
    const billingNextExempt = !lp.billing_next_date?.trim()
      && lp.last_ticketed_date?.trim()
      && isSinglePayment;

    const effectiveMissing = missingProps.filter(p => {
      if (p === 'billing_next_date' && billingNextExempt) return false;
      return true;
    });

    liResults.push({
      id: li.id,
      name: lp.name || '—',
      lik: lik || null,
      pausa: lp.pausa === 'true',
      fechas_completas: lp.fechas_completas === 'true',
      py_origen_id: lp.of_line_item_py_origen_id || null,
      billing_next_date: lp.billing_next_date || null,
      last_ticketed_date: lp.last_ticketed_date || null,
      anchor: lp.billing_anchor_date || null,
      numPayments,
      isSinglePayment,
      billingNextExempt,
      isLegacy: !lp.of_line_item_py_origen_id?.trim(),
      createdate: lp.createdate || null,
      ticketCount: tickets.length,
      tickets,
      missingProps: effectiveMissing,
    });
  }

  // 3) Determinar problemas
  const problems = [];
  const activeLIs = liResults.filter(li => !li.pausa && !li.fechas_completas);

  for (const li of activeLIs) {
    if (!li.lik) problems.push(`LI ${li.id} (${li.name}): sin line_item_key`);
    else if (li.ticketCount === 0) problems.push(`LI ${li.id} (${li.name}): 0 tickets para LIK ${li.lik}`);
    if (li.missingProps.length > 0) problems.push(`LI ${li.id} (${li.name}): faltan props [${li.missingProps.join(', ')}]`);
    if (li.isLegacy) problems.push(`LI ${li.id} (${li.name}): ⚠️  LEGACY — sin of_line_item_py_origen_id (creado ${li.createdate || '?'})`);
  }

  return {
    dealId,
    dealname: dp.dealname || '—',
    py_origen_id: dp.deal_py_origen_id || '—',
    facturacion_activa: dp.facturacion_activa || 'false',
    totalLIs: lineItems.length,
    activeLIs: activeLIs.length,
    liResults,
    problems,
    hasProblems: problems.length > 0,
  };
}

// ── Print ───────────────────────────────────────────────────────────────────────

function printDeal(result) {
  console.log(`\n─────────────────────────────────────────`);
  console.log(`📋 DEAL ${result.dealId}: ${result.dealname}`);
  console.log(`   PY origen:          ${result.py_origen_id}`);
  console.log(`   Facturación activa: ${result.facturacion_activa}`);
  console.log(`   Line items:         ${result.totalLIs} total, ${result.activeLIs} activos`);

  for (const li of result.liResults) {
    const flags = [];
    if (li.pausa) flags.push('⏸ PAUSA');
    if (li.fechas_completas) flags.push('✅ COMPLETO');
    if (li.isLegacy) flags.push('🏚️  LEGACY');
    if (li.billingNextExempt) flags.push('💤 PAGO ÚNICO YA FACTURADO');
    const flagStr = flags.length ? `  ${flags.join(' ')}` : '';

    console.log(`\n   📦 LI ${li.id}: ${li.name}${flagStr}`);
    console.log(`      LIK:              ${li.lik || '⚠️  SIN KEY'}`);
    console.log(`      py_origen_id:     ${li.py_origen_id || '⚠️  FALTA'}`);
    console.log(`      billing_next:     ${li.billing_next_date || '—'}`);
    console.log(`      last_ticketed:    ${li.last_ticketed_date || '—'}`);
    console.log(`      anchor:           ${li.anchor || '—'}`);
    console.log(`      pagos:            ${li.numPayments || 'único/sin definir'}`);
    console.log(`      creado:           ${li.createdate || '—'}`);
    console.log(`      tickets:          ${li.ticketCount}`);

    if (li.ticketCount > 0 && SHOW_ALL) {
      for (const t of li.tickets) {
        const tp = t.properties || {};
        console.log(`        🎫 ${t.id}: ${tp.subject || '—'}  |  fecha=${tp.fecha_resolucion_esperada || '—'}  |  stage=${tp.hs_pipeline_stage}`);
      }
    }
  }

  if (result.problems.length > 0) {
    console.log(`\n   ⚠️  PROBLEMAS:`);
    for (const p of result.problems) {
      console.log(`      • ${p}`);
    }
  }
}

// ── Main ────────────────────────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  DIAGNÓSTICO MIRRORS UY — TICKETS Y BILLING');
  console.log(`  Modo: ${SHOW_ALL ? 'TODOS' : 'SOLO PROBLEMAS'}${SINGLE_DEAL_ID ? ` (deal ${SINGLE_DEAL_ID})` : ''}`);
  console.log('═══════════════════════════════════════════════════════════');

  // Fetch deals
  let deals;
  if (SINGLE_DEAL_ID) {
    try {
      const d = await hubspotClient.crm.deals.basicApi.getById(SINGLE_DEAL_ID, DEAL_PROPS);
      deals = [d];
    } catch (err) {
      console.error(`\n❌ No se pudo leer deal ${SINGLE_DEAL_ID}: ${err.message}`);
      process.exit(1);
    }
  } else {
    console.log('\n🔍 Buscando deals mirror UY...');
    deals = await fetchAllMirrorDeals();
    console.log(`   Encontrados: ${deals.length} mirrors`);
  }

  // Diagnose each
  const results = [];
  for (let i = 0; i < deals.length; i++) {
    if (!SINGLE_DEAL_ID && i % 10 === 0 && i > 0) {
      console.log(`   ... procesando ${i}/${deals.length}`);
    }
    const result = await diagnoseMirrorDeal(deals[i]);
    results.push(result);
    await sleep(100);
  }

  // Print
  const withProblems = results.filter(r => r.hasProblems);
  const toPrint = SHOW_ALL ? results : withProblems;

  for (const r of toPrint) {
    printDeal(r);
  }

  // Summary
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  RESUMEN');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  Total mirrors:       ${results.length}`);
  console.log(`  Con problemas:       ${withProblems.length}`);
  console.log(`  Sin problemas:       ${results.length - withProblems.length}`);

  // Contar LIs legacy globalmente
  const allLegacyLIs = results.flatMap(r => r.liResults.filter(li => li.isLegacy && !li.pausa && !li.fechas_completas));
  if (allLegacyLIs.length > 0) {
    console.log(`\n  🏚️  LIs LEGACY (sin py_origen_id): ${allLegacyLIs.length}`);
    for (const li of allLegacyLIs) {
      const dealResult = results.find(r => r.liResults.includes(li));
      console.log(`    LI ${li.id} en deal ${dealResult?.dealId}: ${li.name.substring(0, 60)}... (creado ${li.createdate || '?'})`);
    }
  }

  if (withProblems.length > 0) {
    console.log(`\n  Deals con problemas:`);
    for (const r of withProblems) {
      console.log(`    ${r.dealId}: ${r.dealname} — ${r.problems.length} problema(s)`);
    }
  } else {
    console.log('\n  ✅ Todos los mirrors están OK');
  }

  console.log('═══════════════════════════════════════════════════════════');
}

main().catch(err => {
  console.error('\n❌ Error fatal:', err.message);
  process.exit(1);
});
