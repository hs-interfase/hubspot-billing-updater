#!/usr/bin/env node
/**
 * mutarRondaEtapaUnicaBC.mjs
 *
 * Las ediciones que piden los escenarios (b) y (c) de la ronda B+C, hechas
 * desde afuera del motor (como las haría una persona en la UI).
 *
 * Uso:
 *   node scripts/seed/mutarRondaEtapaUnicaBC.mjs --b   → LI-B: mensual → trimestral
 *   node scripts/seed/mutarRondaEtapaUnicaBC.mjs --c   → LI-A: edita el ticket de «Próximos» + toca el LI
 */

import 'dotenv/config';
import fs from 'fs';
import { hubspotClient } from '../../src/hubspotClient.js';

if (String(process.env.HUBSPOT_ENV || '').toLowerCase() !== 'sandbox') {
  console.error('❌ SOLO sandbox.'); process.exit(1);
}

const m = JSON.parse(fs.readFileSync('ronda-bc-manifest.json', 'utf8'));
const PROX = process.env.BILLING_TICKET_STAGE_ID;

async function escenarioB() {
  const li = m.lineItems['LI-B'];
  console.log(`▸ (b) LI-B ${li.id}: recurringbillingfrequency mensual → trimestral`);
  const antes = await hubspotClient.crm.lineItems.basicApi.getById(String(li.id), [
    'recurringbillingfrequency', 'hs_recurring_billing_number_of_payments', 'hs_recurring_billing_period',
  ]);
  console.log('   antes :', JSON.stringify(antes.properties));
  await hubspotClient.crm.lineItems.basicApi.update(String(li.id), {
    properties: { recurringbillingfrequency: 'quarterly' },
  });
  const desp = await hubspotClient.crm.lineItems.basicApi.getById(String(li.id), [
    'recurringbillingfrequency', 'hs_recurring_billing_number_of_payments', 'hs_recurring_billing_period',
  ]);
  console.log('   después:', JSON.stringify(desp.properties));
}

async function escenarioC() {
  const li = m.lineItems['LI-A'];
  const t = (li.tickets || []).find(x => String(x.stageSembrada) === String(PROX));
  if (!t) { console.error('❌ LI-A no tiene ticket sembrado en «Próximos»'); process.exit(1); }

  console.log(`▸ (c) ticket ${t.id} (${t.fecha}) — edición a mano`);
  const antes = await hubspotClient.crm.tickets.basicApi.getById(String(t.id), [
    'monto_unitario_real', 'observaciones', 'hs_pipeline_stage',
  ]);
  console.log('   antes :', JSON.stringify(antes.properties));

  await hubspotClient.crm.tickets.basicApi.update(String(t.id), {
    properties: {
      monto_unitario_real: '7777',
      observaciones: 'EDICION MANUAL ESCENARIO C — no la puede pisar el motor',
    },
  });

  // 🔴 Sin esto el escenario NO prueba nada: el re-snapshot masivo sólo se
  // evalúa cuando cambió el LINE ITEM (phasep.js:1384, liLastMod !== ticketSnapshotMod).
  // Editando sólo el ticket, el camino peligroso ni se recorre y (c) daría verde
  // por omisión. Se toca una prop inocua del LI para forzar la comparación.
  console.log(`   tocando el line item ${li.id} para forzar la evaluación del re-snapshot`);
  await hubspotClient.crm.lineItems.basicApi.update(String(li.id), {
    properties: { description: `toque escenario C ${new Date().toISOString()}` },
  });

  console.log('   ticket editado: monto_unitario_real=7777 · observaciones puestas');
}

const args = process.argv.slice(2);
const run = async () => {
  if (args.includes('--b')) await escenarioB();
  if (args.includes('--c')) await escenarioC();
  if (!args.length) { console.error('Falta --b o --c'); process.exit(1); }
};

run().catch(e => { console.error('❌', e.message); if (e.body) console.error(JSON.stringify(e.body)); process.exit(1); });
