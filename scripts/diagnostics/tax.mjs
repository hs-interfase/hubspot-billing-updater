// checkTaxAndTickets.mjs
import 'dotenv/config';
import { Client } from '@hubspot/api-client';

const hubspot = new Client({ accessToken: process.env.HUBSPOT_PRIVATE_TOKEN });

// ── 1. Tax groups en line items ──

const deals = [
  { label: 'PY Original', id: '59698770343' },
  { label: 'UY Mirror',   id: '59672907374' },
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
  { label: 'PY LI1 (Manual)',  lik: '59698770343:54763861670:445277' },
  { label: 'PY LI2 (Auto)',    lik: '59698770343:54765723718:578242' },
  { label: 'UY LI1 (Mirror Manual)', lik: '59672907374:54774823268:8ea1b7' },
  { label: 'UY LI2 (Mirror Auto)',   lik: '59672907374:54768195842:aa84e6' },
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