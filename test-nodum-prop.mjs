// getTaxGroups.mjs
import 'dotenv/config';
import { Client } from '@hubspot/api-client';

const hubspot = new Client({ accessToken: process.env.HUBSPOT_PRIVATE_TOKEN });

const assocs = await hubspot.crm.associations.v4.basicApi.getPage('deals', '59418974382', 'line_items', 100);
const liIds = (assocs.results || []).map(r => String(r.toObjectId));

console.log(`\nLine items del deal 59418974382: ${liIds.length}\n`);

for (const id of liIds) {
  const li = await hubspot.crm.lineItems.basicApi.getById(id, [
    'name', 'hs_tax_rate_group_id', 'hs_tax_rate', 'hs_tax_category',
  ]);
  const p = li.properties;
  console.log(`  ID: ${id}`);
  console.log(`    Nombre:            ${p.name || '(sin nombre)'}`);
  console.log(`    tax_rate_group_id: ${p.hs_tax_rate_group_id || '(vacío)'}`);
  console.log(`    tax_rate:          ${p.hs_tax_rate ?? '(vacío)'}`);
  console.log(`    tax_category:      ${p.hs_tax_category || '(vacío)'}`);
  console.log('');
}