// checkTaxAndTickets.mjs
import 'dotenv/config';
import { Client } from '@hubspot/api-client';

const hubspot = new Client({ accessToken: process.env.HUBSPOT_PRIVATE_TOKEN });

// ── 1. Tax groups en line items ──

const deals = [
  { label: 'PY Original', id: '59668094637' },
  { label: 'UY Mirror',   id: '59668678006' },
];

console.log('╔══════════════════════════════════════════╗');
console.log('║   LINE ITEMS — hs_tax_rate_group_id      ║');
console.log('╚══════════════════════════════════════════╝');

for (const deal of deals) {
  console.log(`\n=== ${deal.label} (Deal ${deal.id}) ===`);

  const assocs = await hubspot.crm.associations.v4.basicApi.getPage(
    'deals', deal.id, 'line_items', undefined, 100
  );
  const liIds = (assocs.results || []).map(r => String(r.toObjectId));

  for (const liId of liIds) {
    const li = await hubspot.crm.lineItems.basicApi.getById(liId, [
      'name', 'hs_tax_rate_group_id', 'hs_tax_rate', 'of_line_item_py_origen_id', 'line_item_key',
    ]);
    const p = li.properties;
    console.log(`  LI ${liId}: "${p.name}"`);
    console.log(`    hs_tax_rate_group_id: ${p.hs_tax_rate_group_id || '(vacío)'}`);
    console.log(`    hs_tax_rate:          ${p.hs_tax_rate ?? '(vacío)'}`);
    console.log(`    py_origen_id:         ${p.of_line_item_py_origen_id || '—'}`);
    console.log(`    line_item_key:        ${p.line_item_key || '—'}`);
  }
}

// ── 2. Tickets — of_iva actual ──

console.log('\n╔══════════════════════════════════════════╗');
console.log('║   TICKETS — of_iva por LIK                ║');
console.log('╚══════════════════════════════════════════╝');

const liks = [
  { label: 'PY LI1 (IVA PY 17541897)',  lik: '59668094637:54769253184:9c2b05' },
  { label: 'PY LI2 (vacío)',             lik: '59668094637:54748543579:c07b9f' },
  { label: 'UY LI1 (IVA UY 17287244)',   lik: '59668678006:54772133027:7fb4d1' },
  { label: 'UY LI2 (Exento 17524493)',   lik: '59668678006:54758263381:d3c5e8' },
];

for (const { label, lik } of liks) {
  console.log(`\n=== ${label} ===`);
  console.log(`    LIK: ${lik}`);

  const resp = await hubspot.crm.tickets.searchApi.doSearch({
    filterGroups: [{ filters: [{ propertyName: 'of_line_item_key', operator: 'EQ', value: lik }] }],
    properties: ['subject', 'of_iva', 'of_line_item_key', 'hs_pipeline_stage', 'fecha_resolucion_esperada'],
    sorts: [{ propertyName: 'fecha_resolucion_esperada', direction: 'ASCENDING' }],
    limit: 10,
  });

  if (!resp.results?.length) {
    console.log('    (sin tickets)');
    continue;
  }

  for (const t of resp.results) {
    const p = t.properties;
    console.log(`    Ticket ${t.id}: of_iva=${p.of_iva ?? '(null)'}  |  fecha=${p.fecha_resolucion_esperada || '—'}  |  stage=${p.hs_pipeline_stage}`);
  }
}