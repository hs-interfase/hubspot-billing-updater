/*import { hubspotClient } from './src/hubspotClient.js';

const dealId = '57093541225';

const resp = await hubspotClient.crm.tickets.searchApi.doSearch({
  filterGroups: [
    { filters: [{ propertyName: 'of_deal_id', operator: 'EQ', value: dealId }] },
  ],
  properties: ['hs_pipeline_stage', 'of_ticket_key', 'of_line_item_key', 'fecha_resolucion_esperada'],
  limit: 100,
});

const tickets = resp?.results || [];
console.log(`Total tickets encontrados: ${tickets.length}\n`);

// Agrupar por of_line_item_key
const byLik = new Map();
for (const t of tickets) {
  const lik = t.properties?.of_line_item_key || '(sin LIK)';
  const stage = t.properties?.hs_pipeline_stage || '';
  const key = t.properties?.of_ticket_key || '(sin key)';
  const fecha = t.properties?.fecha_resolucion_esperada || '';

  if (!byLik.has(lik)) byLik.set(lik, []);
  byLik.get(lik).push({ id: t.id, stage, key, fecha });
}

for (const [lik, list] of byLik.entries()) {
  console.log(`\nLIK: ${lik} → ${list.length} tickets`);
  for (const t of list.sort((a,b) => a.fecha.localeCompare(b.fecha))) {
    console.log(`  ${t.id} | stage=${t.stage} | fecha=${t.fecha}`);
  }
}
*/














/*
// checkForecastPastDue.js
// Busca tickets en stages FORECAST con fecha_resolucion_esperada en el pasado
// Uso: node checkForecastPastDue.js

import { hubspotClient } from './src/hubspotClient.js';
import {
  FORECAST_AUTO_STAGES,
  FORECAST_MANUAL_STAGES,
} from './src/config/constants.js';

const ALL_FORECAST_STAGES = new Set([...FORECAST_AUTO_STAGES, ...FORECAST_MANUAL_STAGES]);

// Stage ID → label legible
const STAGE_LABELS = {};
for (const id of FORECAST_AUTO_STAGES)  STAGE_LABELS[id] = `AUTO_FORECAST`;
for (const id of FORECAST_MANUAL_STAGES) STAGE_LABELS[id] = `MANUAL_FORECAST`;

function todayYMD() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Montevideo',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

// ── 1) Buscar deals con facturacion_activa = true ──
async function getActiveDeals() {
  const deals = [];
  let after;

  do {
    const resp = await hubspotClient.crm.deals.searchApi.doSearch({
      filterGroups: [
        { filters: [{ propertyName: 'facturacion_activa', operator: 'EQ', value: 'true' }] },
      ],
      properties: ['dealname', 'facturacion_activa', 'dealstage'],
      limit: 100,
      ...(after ? { after } : {}),
    });

    deals.push(...(resp?.results || []));
    after = resp?.paging?.next?.after || null;
  } while (after);

  return deals;
}

// ── 2) Buscar tickets de un deal ──
async function getTicketsForDeal(dealId) {
  const tickets = [];
  let after;

  do {
    const resp = await hubspotClient.crm.tickets.searchApi.doSearch({
      filterGroups: [
        { filters: [{ propertyName: 'of_deal_id', operator: 'EQ', value: String(dealId) }] },
      ],
      properties: [
        'hs_pipeline_stage', 'of_ticket_key', 'of_line_item_key',
        'fecha_resolucion_esperada', 'hs_pipeline',
      ],
      limit: 100,
      ...(after ? { after } : {}),
    });

    tickets.push(...(resp?.results || []));
    after = resp?.paging?.next?.after || null;
  } while (after);

  return tickets;
}

// ── Main ──
async function main() {
  const today = todayYMD();
  console.log(`\n🗓  Hoy: ${today}`);
  console.log(`📋 Buscando deals con facturacion_activa=true...\n`);

  const deals = await getActiveDeals();
  console.log(`   Deals activos encontrados: ${deals.length}\n`);

  let totalPastDue = 0;
  const summary = []; // { dealId, dealName, ticketId, lik, stage, fecha, daysPast }

  for (const deal of deals) {
    const dealId = deal.id;
    const dealName = deal.properties?.dealname || '(sin nombre)';

    const tickets = await getTicketsForDeal(dealId);

    for (const t of tickets) {
      const stage = t.properties?.hs_pipeline_stage || '';
      const fecha = (t.properties?.fecha_resolucion_esperada || '').slice(0, 10);

      if (!ALL_FORECAST_STAGES.has(stage)) continue;  // no es forecast
      if (!fecha || fecha >= today) continue;          // no está pasada

      const daysPast = Math.floor(
        (new Date(today) - new Date(fecha)) / (1000 * 60 * 60 * 24)
      );

      totalPastDue++;
      summary.push({
        dealId,
        dealName,
        ticketId: t.id,
        lik: t.properties?.of_line_item_key || '(sin LIK)',
        stageType: STAGE_LABELS[stage] || stage,
        stage,
        fecha,
        daysPast,
      });
    }

    // Rate limit courtesy
    await new Promise(r => setTimeout(r, 150));
  }

  // ── Reporte ──
  console.log('═'.repeat(80));

  if (totalPastDue === 0) {
    console.log('\n✅ No hay tickets forecast con fecha pasada. Todo limpio.\n');
    return;
  }

  console.log(`\n⚠️  ${totalPastDue} ticket(s) forecast con fecha pasada:\n`);

  // Agrupar por deal
  const byDeal = new Map();
  for (const row of summary) {
    if (!byDeal.has(row.dealId)) byDeal.set(row.dealId, { dealName: row.dealName, tickets: [] });
    byDeal.get(row.dealId).tickets.push(row);
  }

  for (const [dealId, { dealName, tickets }] of byDeal) {
    console.log(`📁 Deal ${dealId} — ${dealName} (${tickets.length} tickets)`);
    for (const t of tickets.sort((a, b) => a.fecha.localeCompare(b.fecha))) {
      console.log(
        `   🔴 ticket=${t.ticketId} | ${t.stageType} | fecha=${t.fecha} | ${t.daysPast}d atrás | LIK=${t.lik}`
      );
    }
    console.log('');
  }

  console.log('═'.repeat(80));
  console.log(`Total: ${totalPastDue} tickets forecast con fecha pasada en ${byDeal.size} deal(s)`);
  console.log('');
}

main().catch(err => {
  console.error('❌ Error:', err);
  process.exit(1);
});
*/






