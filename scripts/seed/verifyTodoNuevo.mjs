#!/usr/bin/env node
/**
 * verifyTodoNuevo.mjs
 *
 * Verifica los escenarios creados por seedTodoNuevo.mjs después de correr
 * el cron por deal. Imprime PASS/FAIL por chequeo. No escribe nada.
 *
 * Uso:
 *   node scripts/seed/verifyTodoNuevo.mjs
 */

import 'dotenv/config';
import { hubspotClient } from '../../src/hubspotClient.js';
import fs from 'fs';

const MANIFEST = 'test-nuevo-manifest.json';
const PREFIX   = '[TEST-NUEVO]';

const STAGE_AUTO_READY   = process.env.BILLING_AUTOMATED_READY   || '1311404151';
const STAGE_AUTO_CREATED = process.env.BILLING_AUTOMATED_CREATED || '1311404152';
const STAGE_AUTO_F85     = process.env.BILLING_AUTOMATED_FORECAST_85 || '1330252330';

const LABEL_FACTURA = parseInt(process.env.ASSOC_LABEL_EMPRESA_FACTURA || '2', 10);
const LABEL_PARTNER = parseInt(process.env.ASSOC_LABEL_EMPRESA_PARTNER || '3', 10);

if (String(process.env.HUBSPOT_ENV || '').toLowerCase() !== 'sandbox') {
  console.error('❌ Solo sandbox. Abortando.');
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
const byEsc = Object.fromEntries(manifest.deals.map(d => [d.escenario, d]));

let pass = 0, fail = 0;
function check(nombre, ok, detalle = '') {
  if (ok) { pass++; console.log(`  ✅ PASS  ${nombre}${detalle ? ` — ${detalle}` : ''}`); }
  else    { fail++; console.log(`  ❌ FAIL  ${nombre}${detalle ? ` — ${detalle}` : ''}`); }
}
function info(msg) { console.log(`  ℹ️  ${msg}`); }

async function getDeal(id, props) {
  return hubspotClient.crm.deals.basicApi.getById(String(id), props);
}
async function getLIs(ids, props) {
  if (!ids.length) return [];
  const br = await hubspotClient.crm.lineItems.batchApi.read({
    inputs: ids.map(id => ({ id: String(id) })),
    properties: props,
  });
  return br.results || [];
}
async function getAssocIds(fromType, fromId, toType) {
  const resp = await hubspotClient.crm.associations.v4.basicApi.getPage(
    fromType, String(fromId), toType, 100
  );
  return resp?.results || [];
}
async function getTicketsOfDeal(dealId) {
  const assoc = await getAssocIds('deals', dealId, 'tickets');
  const ids = assoc.map(r => r.toObjectId);
  if (!ids.length) return [];
  const br = await hubspotClient.crm.tickets.batchApi.read({
    inputs: ids.map(id => ({ id: String(id) })),
    properties: ['subject', 'hs_pipeline', 'hs_pipeline_stage', 'cliente_partner', 'nombre_empresa', 'empresa_que_factura', 'of_line_item_ids'],
  });
  return br.results || [];
}
const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : NaN; };
const aprox = (a, b, tol = 0.02) => Math.abs(num(a) - b) <= tol;

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  VERIFY TODO-LO-NUEVO — sandbox');
  console.log('═══════════════════════════════════════════════════════════');

  // ── F — Área por país + Costo USD ──────────────────────────────────────────
  {
    const d = byEsc['F'];
    console.log(`\n📋 F — Área país + Costo USD (deal ${d.dealId})`);
    const deal = await getDeal(d.dealId, ['dolar', 'dolar_cierre_asignado', 'area', 'pais_operativo']);
    const dp = deal.properties;
    check('deal.dolar = 1 (USD)', aprox(dp.dolar, 1), `dolar=${dp.dolar}`);
    check('deal.dolar_cierre_asignado = true', String(dp.dolar_cierre_asignado) === 'true', `val=${dp.dolar_cierre_asignado}`);
    check('deal.area incluye Paraguay', String(dp.area || '').includes('Paraguay'), `area=${dp.area}`);

    const lis = await getLIs(d.lineItemIds, ['name', 'area', 'dolar', 'hs_cost_of_goods_sold', 'costo_total_usd', 'monto_usd', 'margen_usd', 'quantity']);
    for (const li of lis) {
      const p = li.properties;
      const esLI1 = p.name?.includes('F-LI1');
      check(`${p.name}: area = Paraguay`, String(p.area || '') === 'Paraguay', `area=${p.area}`);
      check(`${p.name}: dolar = 1`, aprox(p.dolar, 1), `dolar=${p.dolar}`);
      const cogsEsperado = esLI1 ? 50 : 30;
      check(`${p.name}: cogs = ${cogsEsperado}`, aprox(p.hs_cost_of_goods_sold, cogsEsperado), `cogs=${p.hs_cost_of_goods_sold}`);
      info(`${p.name}: monto_usd=${p.monto_usd} margen_usd=${p.margen_usd} (props de cálculo HubSpot)`);
    }
  }

  // ── G — Zero-emission gate ──────────────────────────────────────────────────
  {
    const d = byEsc['G'];
    console.log(`\n📋 G — Auto pasado SIN facturacion_activa (deal ${d.dealId})`);
    const tickets = await getTicketsOfDeal(d.dealId);
    info(`${tickets.length} ticket(s)`);
    const enReady = tickets.filter(t => t.properties.hs_pipeline_stage === STAGE_AUTO_READY);
    check('ningún ticket en AUTO READY', enReady.length === 0, `${enReady.length} en READY`);
    const enF85 = tickets.filter(t => t.properties.hs_pipeline_stage === STAGE_AUTO_F85);
    check('ticket del pasado quedó en forecast 85', enF85.length >= 1, `${enF85.length} en F85`);
  }

  // ── G2 — Control ────────────────────────────────────────────────────────────
  {
    const d = byEsc['G2'];
    console.log(`\n📋 G2 — Control CON facturacion_activa (deal ${d.dealId})`);
    const tickets = await getTicketsOfDeal(d.dealId);
    info(`${tickets.length} ticket(s)`);
    const promovidos = tickets.filter(t =>
      [STAGE_AUTO_READY, STAGE_AUTO_CREATED].includes(t.properties.hs_pipeline_stage));
    check('ticket del pasado nació READY (o ya CREATED)', promovidos.length >= 1,
      `stages=${tickets.map(t => t.properties.hs_pipeline_stage).join(',')}`);
  }

  // ── H — Aviso no-ganado ─────────────────────────────────────────────────────
  {
    const d = byEsc['H'];
    console.log(`\n📋 H — No ganado, factura en 5 días (deal ${d.dealId})`);
    const deal = await getDeal(d.dealId, ['billing_error', 'billing_error_at', 'dealstage']);
    const be = String(deal.properties.billing_error || '');
    check('billing_error en el deal menciona no-ganado', /Cierre ganado/i.test(be),
      be ? `"${be.slice(0, 120)}..."` : 'billing_error VACÍO');
  }

  // ── I — Sanitizer clon ──────────────────────────────────────────────────────
  {
    const d = byEsc['I'];
    console.log(`\n📋 I — Clon (Copia) + key ajena (deal ${d.dealId})`);
    const lis = await getLIs(d.lineItemIds, ['name', 'billing_error', 'line_item_key']);
    for (const li of lis) {
      const p = li.properties;
      check('nombre sin "(Copia)"', !/\((copia|copy)\)/i.test(p.name || ''), `name="${p.name}"`);
      check('billing_error reseteado', !p.billing_error, `billing_error="${p.billing_error || ''}"`);
      info(`line_item_key actual: ${p.line_item_key}`);
    }
  }

  // ── J — cliente_partner ─────────────────────────────────────────────────────
  {
    const d = byEsc['J'];
    console.log(`\n📋 J — cliente_partner en ticket (deal ${d.dealId})`);
    const tickets = await getTicketsOfDeal(d.dealId);
    info(`${tickets.length} ticket(s)`);
    for (const t of tickets) {
      const p = t.properties;
      check('ticket.cliente_partner = Partner SRL', (p.cliente_partner || '').includes('Partner SRL'),
        `cliente_partner="${p.cliente_partner || ''}"`);
      check('ticket.nombre_empresa = Cliente SA', (p.nombre_empresa || '').includes('Cliente SA'),
        `nombre_empresa="${p.nombre_empresa || ''}"`);
    }
  }

  // ── K — Mirror PY→UY ────────────────────────────────────────────────────────
  {
    const d = byEsc['K'];
    console.log(`\n📋 K — Mirror PY→UY (deal ${d.dealId})`);
    const py = await getDeal(d.dealId, ['deal_uy_mirror_id', 'dealname']);
    const mirrorId = String(py.properties.deal_uy_mirror_id || '');
    check('PY tiene deal_uy_mirror_id', Boolean(mirrorId), `mirrorId=${mirrorId || '(vacío)'}`);

    if (mirrorId) {
      const mirror = await getDeal(mirrorId, ['dealname', 'pais_operativo', 'es_mirror_de_py', 'deal_py_origen_id', 'mig_espejo_independiente', 'billing_error', 'deal_currency_code']);
      const mp = mirror.properties;
      check('mirror.es_mirror_de_py = true', String(mp.es_mirror_de_py) === 'true');
      check('mirror.pais_operativo = Uruguay', mp.pais_operativo === 'Uruguay', `pais=${mp.pais_operativo}`);
      check('mirror.deal_py_origen_id apunta al PY', String(mp.deal_py_origen_id) === String(d.dealId));
      check('mirror.deal_currency_code = USD (hardcode nuevo)', String(mp.deal_currency_code || '') === 'USD', `currency=${mp.deal_currency_code}`);
      info(`mirror sellado (mig_espejo_independiente)=${mp.mig_espejo_independiente || '(vacío)'} | billing_error="${mp.billing_error || ''}"`);

      // LIs del mirror: price = costo_total_usd/qty (definición 2026-07-07):
      // K-LI1 = 1500/3 = 500; K-LI2 (fase2) = 300/1 = 300
      const liAssoc = await getAssocIds('deals', mirrorId, 'line_items');
      const mirrorLis = await getLIs(liAssoc.map(r => r.toObjectId), ['name', 'price', 'quantity', 'of_line_item_py_origen_id', 'facturacion_automatica']);
      info(`${mirrorLis.length} LI(s) en el mirror`);
      for (const li of mirrorLis) {
        const p = li.properties;
        if (p.name?.includes('K-LI1')) {
          // price mirror = costo_total_usd ÷ qty (fuente de verdad USD, definición 2026-07-07)
          check('mirror K-LI1 price = 500 (costo_total_usd 1500 / qty 3)', aprox(p.price, 500, 0.05), `price=${p.price}`);
        }
        if (p.name?.includes('K-LI2')) {
          check('mirror K-LI2 price = 300 (LI nueva espejada)', aprox(p.price, 300, 0.05), `price=${p.price}`);
        }
        check(`mirror ${p.name}: facturacion_automatica=false`, String(p.facturacion_automatica) !== 'true', `val=${p.facturacion_automatica}`);
      }
      const tieneLI2 = mirrorLis.some(li => li.properties.name?.includes('K-LI2'));
      if (!tieneLI2) info('K-LI2 todavía no espejada (correr --fase2 + cron y re-verificar)');

      // Empresas del mirror: Interfase con etiquetas Factura (2) + Partner (3)
      const compAssoc = await getAssocIds('deals', mirrorId, 'companies');
      const interfaseId = String(process.env.INTERFASE_PY_COMPANY_ID || '');
      const interfase = compAssoc.find(r => String(r.toObjectId) === interfaseId);
      const tipos = (interfase?.associationTypes || []).map(t => t.typeId);
      check('mirror: Interfase con etiqueta Empresa Factura', tipos.includes(LABEL_FACTURA), `typeIds=[${tipos.join(',')}]`);
      check('mirror: Interfase con etiqueta Partner', tipos.includes(LABEL_PARTNER), `typeIds=[${tipos.join(',')}]`);
    }
  }

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(`  RESULTADO: ${pass} PASS / ${fail} FAIL`);
  console.log('═══════════════════════════════════════════════════════════');
  process.exit(fail ? 1 : 0);
}

main().catch(err => {
  console.error('❌ Error fatal:', err.message);
  if (err.response?.data) console.error(JSON.stringify(err.response.data, null, 2));
  process.exit(1);
});
