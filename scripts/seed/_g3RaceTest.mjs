#!/usr/bin/env node
// Test de carrera G3: deal ganado con facturacion_activa=false + LI auto del pasado.
// Se crea y se reporta el dealId por stdout para correr el cron ANTES de que el
// workflow del sandbox flipee facturacion_activa a true.
import 'dotenv/config';
import { hubspotClient } from '../../src/hubspotClient.js';
import fs from 'fs';

if (String(process.env.HUBSPOT_ENV || '').toLowerCase() !== 'sandbox') {
  console.error('❌ Solo sandbox'); process.exit(1);
}

const ymd = d => d.toISOString().slice(0, 10);
const ayer = new Date(); ayer.setDate(ayer.getDate() - 1);

const deal = await hubspotClient.crm.deals.basicApi.create({ properties: {
  dealname: '[TEST-NUEVO] G3 — race: auto pasado sin activa',
  dealstage: 'closedwon',
  pipeline: 'default',
  facturacion_activa: 'false',
  pais_operativo: 'Uruguay',
}});
const li = await hubspotClient.crm.lineItems.basicApi.create({ properties: {
  name: '[TEST-NUEVO] G3-LI1: auto mensual 3p start=yesterday',
  price: '1000', quantity: '1',
  recurringbillingfrequency: 'monthly',
  hs_recurring_billing_start_date: ymd(ayer),
  hs_recurring_billing_period: 'P3M',
  facturacion_automatica: 'true',
  facturacion_activa: 'true',
}});
await hubspotClient.crm.associations.v4.basicApi.create(
  'line_items', String(li.id), 'deals', String(deal.id),
  [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 20 }]
);

// registrar en manifest para el cleanup
const MANIFEST = 'test-nuevo-manifest.json';
const m = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
m.deals.push({ escenario: 'G3', dealId: deal.id, dealName: 'G3 — race', lineItemIds: [li.id] });
fs.writeFileSync(MANIFEST, JSON.stringify(m, null, 2));

console.log(`G3_DEAL_ID=${deal.id}`);
