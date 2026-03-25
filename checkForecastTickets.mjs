import { hubspotClient } from './src/hubspotClient.js';

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
