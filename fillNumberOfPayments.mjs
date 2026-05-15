#!/usr/bin/env node
/**
 * fillNumberOfPayments.mjs
 *
 * Calcula hs_recurring_billing_number_of_payments a partir de:
 *   - hs_recurring_billing_start_date  (inicio)
 *   - fecha_vencimiento_contrato       (vigencia)
 *   - recurringbillingfrequency        (frecuencia)
 *
 * Reglas:
 *   - Si vigencia = 2099-*  → skip (auto-renew, infinito)
 *   - Si ya tiene number_of_payments → skip (no pisar)
 *   - Si falta start_date o frecuencia → skip y reportar
 *
 * Uso:
 *   node fillNumberOfPayments.mjs                  # dry run, muestra lo que haría
 *   node fillNumberOfPayments.mjs --apply           # aplica los updates en HubSpot
 *   node fillNumberOfPayments.mjs --deal 12345      # solo un deal
 *   node fillNumberOfPayments.mjs --deal 12345 --apply
 */

import 'dotenv/config';
import { hubspotClient } from './src/hubspotClient.js';

// ── CLI args ────────────────────────────────────────────────────────────────

const APPLY = process.argv.includes('--apply');
const DEAL_IDX = process.argv.indexOf('--deal');
const SINGLE_DEAL_ID = DEAL_IDX !== -1 ? process.argv[DEAL_IDX + 1] : null;

// ── Frecuencia → meses ─────────────────────────────────────────────────────

const FREQ_TO_MONTHS = {
  monthly:         1,
  quarterly:       3,
  per_six_months:  6,
  semi_annually:   6,
  annually:        12,
  per_two_years:   24,
};

function freqToMonths(freq) {
  const f = (freq || '').trim().toLowerCase();
  return FREQ_TO_MONTHS[f] ?? null;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const safe = (v) => (v ?? '').toString().trim();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function ymd(v) {
  const s = safe(v);
  if (!s) return null;
  // HubSpot puede devolver timestamps en ms
  if (/^\d{13}$/.test(s)) {
    return new Date(parseInt(s, 10)).toISOString().slice(0, 10);
  }
  return s.slice(0, 10);
}

function isAutoRenew(fechaVenc) {
  const d = ymd(fechaVenc);
  return d && d.startsWith('2099');
}

/**
 * Calcula la diferencia en meses entre dos fechas YYYY-MM-DD.
 * Redondea al mes más cercano.
 */
function diffMonths(startYMD, endYMD) {
  const [sy, sm, sd] = startYMD.split('-').map(Number);
  const [ey, em, ed] = endYMD.split('-').map(Number);
  return (ey - sy) * 12 + (em - sm) + (ed >= sd ? 0 : -1);
}

/**
 * Calcula number_of_payments = ceil(meses_entre / meses_por_freq)
 * Retorna null si no es calculable.
 */
function calculatePayments(startYMD, endYMD, freqMonths) {
  const months = diffMonths(startYMD, endYMD);
  if (months <= 0) return null;
  // Usamos ceil para incluir el último período parcial
  return Math.ceil(months / freqMonths);
}

// ── Fetch all deals (keyset pagination) ─────────────────────────────────────

async function fetchAllDeals() {
  if (SINGLE_DEAL_ID) {
    try {
      const d = await hubspotClient.crm.deals.basicApi.getById(SINGLE_DEAL_ID, [
        'dealname', 'pais_operativo',
      ]);
      return [d];
    } catch (err) {
      console.error(`❌ No se pudo leer deal ${SINGLE_DEAL_ID}: ${err.message}`);
      process.exit(1);
    }
  }

  console.log('🔍 Buscando deals con facturación activa...');
  const all = [];
  let lastId = '0';
  const MAX_PAGES = 100;

  for (let page = 0; page < MAX_PAGES; page++) {
    const resp = await hubspotClient.crm.deals.searchApi.doSearch({
      filterGroups: [{
        filters: [
          { propertyName: 'facturacion_activa', operator: 'EQ', value: 'true' },
          { propertyName: 'hs_object_id', operator: 'GT', value: lastId },
        ],
      }],
      properties: ['dealname', 'pais_operativo'],
      sorts: [{ propertyName: 'hs_object_id', direction: 'ASCENDING' }],
      limit: 100,
    });

    const results = resp.results || [];
    if (!results.length) break;

    all.push(...results);
    lastId = String(results[results.length - 1].id);
    if (results.length < 100) break;
    await sleep(150);
  }

  console.log(`   Encontrados: ${all.length} deals`);
  return all;
}

// ── Fetch line items de un deal ─────────────────────────────────────────────

async function getLineItemsForDeal(dealId) {
  // 1) Obtener IDs asociados
  const ids = [];
  let after;
  do {
    const resp = await hubspotClient.crm.associations.v4.basicApi.getPage(
      'deals', String(dealId), 'line_items', 100, after,
    );
    for (const r of (resp.results || [])) ids.push(String(r.toObjectId));
    after = resp.paging?.next?.after;
  } while (after);

  if (!ids.length) return [];

  // 2) Batch read
  const batch = await hubspotClient.crm.lineItems.batchApi.read({
    inputs: ids.map(id => ({ id })),
    properties: [
      'name',
      'line_item_key',
      'recurringbillingfrequency',
      'hs_recurring_billing_frequency',
      'hs_recurring_billing_start_date',
      'fecha_inicio_de_facturacion',
      'fecha_vencimiento_contrato',
      'hs_recurring_billing_number_of_payments',
      'hs_recurring_billing_period',
      'pausa',
      'facturacion_activa',
    ],
  });

  return batch.results || [];
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  FILL hs_recurring_billing_number_of_payments');
  console.log(`  Modo: ${APPLY ? '🔴 APPLY (updates reales)' : '🟢 DRY RUN (solo muestra)'}`);
  if (SINGLE_DEAL_ID) console.log(`  Deal: ${SINGLE_DEAL_ID}`);
  console.log('═══════════════════════════════════════════════════════════\n');

  const deals = await fetchAllDeals();

  const stats = {
    totalLIs: 0,
    skippedAutoRenew: 0,
    skippedAlreadySet: 0,
    skippedNoFreq: 0,
    skippedNoStart: 0,
    skippedNoVigencia: 0,
    skippedPaused: 0,
    skippedZeroOrNeg: 0,
    toUpdate: 0,
    updated: 0,
    failed: 0,
  };

  const updates = [];  // { dealId, dealName, liId, liName, freq, start, end, payments }
  const skipped = [];  // { dealId, liId, liName, reason }

  for (let i = 0; i < deals.length; i++) {
    const deal = deals[i];
    const dealId = String(deal.id);
    const dealName = safe(deal.properties?.dealname) || dealId;

    if (i > 0 && i % 50 === 0) {
      console.log(`   ... procesando deal ${i}/${deals.length}`);
    }

    let lineItems;
    try {
      lineItems = await getLineItemsForDeal(dealId);
    } catch (err) {
      console.error(`   ⚠️  Error leyendo LIs del deal ${dealId}: ${err.message}`);
      continue;
    }

    for (const li of lineItems) {
      stats.totalLIs++;
      const lp = li.properties || {};
      const liId = String(li.id);
      const liName = safe(lp.name) || liId;

      // ── Skip: ya tiene number_of_payments ──
      const currentPayments = safe(lp.hs_recurring_billing_number_of_payments);
      if (currentPayments && currentPayments !== '0') {
        stats.skippedAlreadySet++;
        continue;
      }

      // ── Skip: pausado ──
      if (safe(lp.pausa).toLowerCase() === 'true') {
        stats.skippedPaused++;
        skipped.push({ dealId, liId, liName, reason: 'pausado' });
        continue;
      }

      // ── Frecuencia ──
      const rawFreq = safe(lp.recurringbillingfrequency) || safe(lp.hs_recurring_billing_frequency);
      const freqMonths = freqToMonths(rawFreq);
      if (!freqMonths) {
        stats.skippedNoFreq++;
        skipped.push({ dealId, liId, liName, reason: `sin frecuencia válida (${rawFreq || 'vacío'})` });
        continue;
      }

      // ── Fecha inicio ──
      const startDate = ymd(lp.hs_recurring_billing_start_date) || ymd(lp.fecha_inicio_de_facturacion);
      if (!startDate) {
        stats.skippedNoStart++;
        skipped.push({ dealId, liId, liName, reason: 'sin fecha inicio' });
        continue;
      }

      // ── Fecha vigencia ──
      const endDate = ymd(lp.fecha_vencimiento_contrato);
      if (!endDate) {
        stats.skippedNoVigencia++;
        skipped.push({ dealId, liId, liName, reason: 'sin fecha vigencia' });
        continue;
      }

      // ── Auto-renew ──
      if (isAutoRenew(endDate)) {
        stats.skippedAutoRenew++;
        continue;
      }

      // ── Calcular ──
      const payments = calculatePayments(startDate, endDate, freqMonths);
      if (!payments || payments <= 0) {
        stats.skippedZeroOrNeg++;
        skipped.push({ dealId, liId, liName, reason: `cálculo ≤ 0 (inicio=${startDate}, fin=${endDate}, freq=${rawFreq})` });
        continue;
      }

      stats.toUpdate++;
      updates.push({
        dealId,
        dealName,
        liId,
        liName,
        freq: rawFreq,
        freqMonths,
        start: startDate,
        end: endDate,
        payments,
      });
    }

    await sleep(100);
  }

  // ── Mostrar resultados ──────────────────────────────────────────────────

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  RESULTADOS');
  console.log('═══════════════════════════════════════════════════════════\n');

  if (updates.length > 0) {
    console.log(`📋 Line items a actualizar: ${updates.length}\n`);
    console.log('  Deal                         | LI                           | Freq           | Inicio     | Vigencia   | Pagos');
    console.log('  ' + '-'.repeat(120));

    for (const u of updates) {
      const deal = u.dealName.slice(0, 28).padEnd(28);
      const li   = u.liName.slice(0, 28).padEnd(28);
      const freq = u.freq.padEnd(14);
      console.log(`  ${deal} | ${li} | ${freq} | ${u.start} | ${u.end} | ${u.payments}`);
    }
  }

  if (skipped.length > 0) {
    console.log(`\n⏭️  Skips relevantes (${skipped.length}):\n`);
    for (const s of skipped) {
      console.log(`  LI ${s.liId} (${s.liName.slice(0, 30)}): ${s.reason}`);
    }
  }

  console.log('\n📊 Resumen:');
  console.log(`   Total LIs revisados:        ${stats.totalLIs}`);
  console.log(`   Ya tenían payments:          ${stats.skippedAlreadySet}`);
  console.log(`   Auto-renew (2099):           ${stats.skippedAutoRenew}`);
  console.log(`   Sin frecuencia válida:       ${stats.skippedNoFreq}`);
  console.log(`   Sin fecha inicio:            ${stats.skippedNoStart}`);
  console.log(`   Sin fecha vigencia:          ${stats.skippedNoVigencia}`);
  console.log(`   Pausados:                    ${stats.skippedPaused}`);
  console.log(`   Cálculo ≤ 0:                 ${stats.skippedZeroOrNeg}`);
  console.log(`   A actualizar:                ${stats.toUpdate}`);

  // ── Apply ───────────────────────────────────────────────────────────────

  if (!APPLY) {
    console.log(`\n💡 Dry run completo. Para aplicar, correr con --apply`);
    return;
  }

  if (updates.length === 0) {
    console.log('\n✅ Nada que actualizar.');
    return;
  }

  console.log(`\n🔴 Aplicando ${updates.length} updates...\n`);

  // Batch de 10 para no saturar API
  const BATCH_SIZE = 10;
  for (let i = 0; i < updates.length; i += BATCH_SIZE) {
    const batch = updates.slice(i, i + BATCH_SIZE);

    const inputs = batch.map(u => ({
      id: u.liId,
      properties: {
        hs_recurring_billing_number_of_payments: String(u.payments),
      },
    }));

    try {
      await hubspotClient.crm.lineItems.batchApi.update({ inputs });
      stats.updated += batch.length;
      console.log(`   ✅ Batch ${Math.floor(i / BATCH_SIZE) + 1}: ${batch.length} LIs actualizados`);
    } catch (err) {
      console.error(`   ❌ Batch ${Math.floor(i / BATCH_SIZE) + 1} falló: ${err.message}`);
      // Fallback individual
      for (const u of batch) {
        try {
          await hubspotClient.crm.lineItems.basicApi.update(u.liId, {
            properties: {
              hs_recurring_billing_number_of_payments: String(u.payments),
            },
          });
          stats.updated++;
          console.log(`      ✅ ${u.liId} ok (individual)`);
        } catch (e2) {
          stats.failed++;
          console.error(`      ❌ ${u.liId} falló: ${e2.message}`);
        }
      }
    }

    await sleep(300);
  }

  console.log(`\n🏁 Completado: ${stats.updated} actualizados, ${stats.failed} fallidos.`);
}

main().catch(err => {
  console.error('❌ Error fatal:', err.message);
  if (err.response?.data) console.error(JSON.stringify(err.response.data, null, 2));
  process.exit(1);
});
