import 'dotenv/config';
import { Client } from '@hubspot/api-client';

const TOKEN = process.env.HUBSPOT_PRIVATE_TOKEN;
if (!TOKEN) { console.error('Falta HUBSPOT_PRIVATE_TOKEN'); process.exit(1); }

const hubspot = new Client({ accessToken: TOKEN });
const DEAL_ID = '59018148725';

async function main() {
  // ── 1) DEAL ──
  console.log('\n══════════════════════════════════════');
  console.log('1. DEAL PROPERTIES');
  console.log('══════════════════════════════════════');
  const deal = await hubspot.crm.deals.basicApi.getById(DEAL_ID, [
    'dealname', 'dealstage', 'pipeline', 'hs_deal_stage_probability',
    'hubspot_owner_id', 'deal_currency_code', 'pais_operativo',
  ]);
  const dp = deal.properties;
  console.log('dealname:', dp.dealname);
  console.log('hs_deal_stage_probability:', dp.hs_deal_stage_probability, '← ¿decimal o entero?');
  console.log('hubspot_owner_id:', dp.hubspot_owner_id);

  // ── 2) OWNER ──
  console.log('\n══════════════════════════════════════');
  console.log('2. OWNER LOOKUP');
  console.log('══════════════════════════════════════');
  if (dp.hubspot_owner_id) {
    try {
      const owner = await hubspot.crm.owners.ownersApi.getById(parseInt(dp.hubspot_owner_id));
      console.log('Nombre:', `${owner.firstName} ${owner.lastName}`.trim());
      console.log('Email:', owner.email);
    } catch (e) {
      console.log('ERROR al buscar owner:', e.message);
    }
  } else {
    console.log('hubspot_owner_id está VACÍO en el deal');
  }

  // ── 3) COMPANIES + ASSOCIATION TYPES ──
  console.log('\n══════════════════════════════════════');
  console.log('3. COMPANIES Y ASSOCIATION TYPES');
  console.log('══════════════════════════════════════');
  const assocs = await hubspot.crm.associations.v4.basicApi.getPage('deals', DEAL_ID, 'companies', 100);
  for (const a of assocs.results || []) {
    const company = await hubspot.crm.companies.basicApi.getById(String(a.toObjectId), ['name']);
    console.log(`\nCompany: ${company.properties.name} (ID: ${a.toObjectId})`);
    console.log('Association types:', JSON.stringify(a.associationTypes, null, 2));
  }

  // ── 4) LINE ITEMS ──
  console.log('\n══════════════════════════════════════');
  console.log('4. LINE ITEMS — MARGEN Y COSTO');
  console.log('══════════════════════════════════════');
  const liAssocs = await hubspot.crm.associations.v4.basicApi.getPage('deals', DEAL_ID, 'line_items', 100);
  const liIds = (liAssocs.results || []).map(r => String(r.toObjectId));

  if (!liIds.length) {
    console.log('Sin line items');
  } else {
    const liResp = await hubspot.crm.lineItems.batchApi.read({
      inputs: liIds.map(id => ({ id })),
      properties: [
        'name', 'price', 'quantity', 'amount',
        'costo_total_usd', 'dolar',
        'hs_cost_of_goods_sold', 'hs_margin', 'porcentaje_margen',
        'facturacion_automatica', 'hubspot_owner_id',
      ],
    });
    for (const li of liResp.results || []) {
      const lp = li.properties;
      console.log(`\nLine Item: ${lp.name} (ID: ${li.id})`);
      console.log('  price:', lp.price);
      console.log('  quantity:', lp.quantity);
      console.log('  amount:', lp.amount);
      console.log('  costo_total_usd:', lp.costo_total_usd, '← FUENTE DE VERDAD del costo (total de línea, USD)');
      console.log('  dolar:', lp.dolar, '← TC sellado del LI');
      console.log('  hs_cost_of_goods_sold:', lp.hs_cost_of_goods_sold, '← DERIVADA: costo_total_usd × dolar ÷ qty (unitario, moneda del deal)');
      console.log('  hs_margin:', lp.hs_margin, '← margen nativo HubSpot');
      console.log('  porcentaje_margen:', lp.porcentaje_margen, '← campo custom');
      console.log('  hubspot_owner_id:', lp.hubspot_owner_id, '← owner del LI');
      console.log('  facturacion_automatica:', lp.facturacion_automatica);
    }
  }
}

main().catch(err => {
  console.error('Error fatal:', err.message);
  process.exit(1);
});
