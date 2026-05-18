// z.mjs — diagnóstico facturas_restantes + test side-effect
import { hubspotClient } from './src/hubspotClient.js';
import { INVOICED_STAGES } from './src/config/constants.js';

const LI_ID = '55298530056';
const LIK = '60299770128:55298530056:478432';

// 1. Leer LI
const { properties } = await hubspotClient.crm.lineItems.basicApi.getById(LI_ID, [
  'hs_recurring_billing_number_of_payments',
  'renovacion_automatica',
  'facturas_restantes',
  'line_item_key',
]);
console.log('\n=== LINE ITEM ===');
console.log('number_of_payments:', properties.hs_recurring_billing_number_of_payments);
console.log('renovacion_automatica:', properties.renovacion_automatica);
console.log('facturas_restantes:', properties.facturas_restantes);
console.log('line_item_key:', properties.line_item_key);

// 2. Buscar tickets por LIK
const resp = await hubspotClient.crm.tickets.searchApi.doSearch({
  filterGroups: [{
    filters: [{ propertyName: 'of_line_item_key', operator: 'EQ', value: LIK }],
  }],
  properties: ['hs_pipeline_stage', 'hs_pipeline', 'subject', 'of_ticket_key'],
  limit: 100,
});
const tickets = resp?.results ?? [];
console.log('\n=== TICKETS ENCONTRADOS:', tickets.length, '===');
for (const t of tickets) {
  const p = t.properties;
  const stage = String(p.hs_pipeline_stage || '');
  const inInvoiced = INVOICED_STAGES.has(stage);
  console.log(`  Ticket ${t.id} | stage: ${stage} | inINVOICED_STAGES: ${inInvoiced} | pipeline: ${p.hs_pipeline} | key: ${p.of_ticket_key}`);
}

const count = tickets.filter(t => INVOICED_STAGES.has(String(t.properties?.hs_pipeline_stage))).length;
console.log('\n=== RESULTADO ===');
console.log('countTickets (INVOICED):', count);
console.log('cuotasTotales:', properties.hs_recurring_billing_number_of_payments);
console.log('restantes calculado:', Math.max(0, Number(properties.hs_recurring_billing_number_of_payments) - count));

// 3. History de facturas_restantes (con detalle de fuente)
const histResp = await hubspotClient.apiRequest({
  method: 'GET',
  path: `/crm/v3/objects/line_items/${LI_ID}?propertiesWithHistory=facturas_restantes`,
});
const histData = await histResp.json();
const history = histData.propertiesWithHistory?.facturas_restantes || [];
console.log('\n=== HISTORY facturas_restantes ===');
for (const h of history) {
  console.log(`  ${h.timestamp} | value: "${h.value}" | source: ${h.sourceType} | sourceId: ${h.sourceId} | sourceLabel: ${h.sourceLabel || '—'} | updatedByUserId: ${h.updatedByUserId || '—'}`);
}

// 4. TEST SIDE-EFFECT: ¿HubSpot sobreescribe facturas_restantes al tocar otra prop?
console.log('\n=== TEST SIDE-EFFECT ===');

// 4a. Forzar facturas_restantes a 1 (valor correcto)
await hubspotClient.crm.lineItems.basicApi.update(LI_ID, {
  properties: { facturas_restantes: '1' },
});
console.log('Paso 1: facturas_restantes seteado a "1"');

// Verificar
const check1 = await hubspotClient.crm.lineItems.basicApi.getById(LI_ID, ['facturas_restantes']);
console.log('Paso 1 verificación:', check1.properties.facturas_restantes);

// 4b. Hacer update inocuo de billing_next_date (simula Phase 1)
await hubspotClient.crm.lineItems.basicApi.update(LI_ID, {
  properties: { billing_next_date: '2026-08-16' },
});
console.log('Paso 2: billing_next_date seteado a "2026-08-16"');

// Esperar 2 segundos por si HubSpot recalcula async
await new Promise(r => setTimeout(r, 2000));

// Releer
const check2 = await hubspotClient.crm.lineItems.basicApi.getById(LI_ID, ['facturas_restantes']);
console.log('Paso 2 verificación:', check2.properties.facturas_restantes);

if (check2.properties.facturas_restantes === '1') {
  console.log('\n✅ SIN SIDE-EFFECT: billing_next_date no afectó facturas_restantes');
} else {
  console.log('\n🚨 SIDE-EFFECT DETECTADO: facturas_restantes cambió de "1" a "' + check2.properties.facturas_restantes + '" solo por tocar billing_next_date');
}
