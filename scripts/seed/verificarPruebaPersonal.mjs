#!/usr/bin/env node
/**
 * verificarPruebaPersonal.mjs — ETAPA 1: el negocio TODAVÍA NO GANADO
 *
 * SOLO LECTURA. Corre contra el negocio sembrado por seedPruebaPersonal.mjs y
 * imprime una tabla PASS/FAIL de todo lo que tiene que funcionar ANTES del cierre
 * ganado. No arregla nada ni escribe nada: sirve para ver el estado real de un
 * vistazo y para volver a correrlo después de cada arreglo.
 *
 * Uso:
 *   node scripts/seed/verificarPruebaPersonal.mjs            → tabla resumida
 *   node scripts/seed/verificarPruebaPersonal.mjs --detalle  → + el detalle de cada ticket
 *
 * Lee `prueba-personal-manifest.json`. Salida: exit 0 si todo PASS, 1 si hay FAIL.
 *
 * ⚠️ Los tickets se leen por of_line_item_key Y por asociación (lección de la ronda
 *    D+E: por asociación faltan tickets, y antes del cierre ganado no hay NINGUNO
 *    asociado). Afirmar "no existe" sólo es válido si las dos vías dan 0.
 */

import 'dotenv/config';
import fs from 'fs';
import { hubspotClient } from '../../src/hubspotClient.js';

const DETALLE = process.argv.includes('--detalle');
const MANIFEST = 'prueba-personal-manifest.json';

// Etapas del pipeline manual de tickets (sandbox).
const STAGE_LABEL = {
  '1311451803': 'Forecast', '1311451804': '50% Forecast', '1311451805': '75% Forecast',
  '1330250642': '85% Forecast', '1311451806': '95% Forecast',
  '1311451807': 'Próximos a facturar', '1311451808': 'Notificado', '1311451809': 'Emitido',
  '1311451810': 'Enviado', '1311451811': 'Atrasado', '1311451812': 'Cobrado',
  '1311451813': 'CANCELADO',
};
const stageLbl = (s) => STAGE_LABEL[String(s)] || `(${s})`;
const ETAPA_ESPERADA = '1311451804'; // 50% Forecast — el deal está en «Calificado»

// Empresa emisora esperada del espejo (ISA PARAGUAY S.A — confirmado usuaria 2-ago).
const EMISORA_ESPEJO_ESPERADA = 'ISA PARAGUAY';

const M = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));

// ── Checks ────────────────────────────────────────────────────────────────────
const checks = [];
function check(bloque, nombre, esperado, actual, ok = null) {
  const pass = ok === null ? String(esperado) === String(actual) : ok;
  checks.push({ bloque, nombre, esperado, actual, pass });
}

const num = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));
const casiIgual = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 0.01;

// ── Lecturas ──────────────────────────────────────────────────────────────────
const LI_PROPS = ['name', 'price', 'quantity', 'costo_total_usd', 'hs_cost_of_goods_sold',
  'area', 'empresa_que_factura', 'nombre_producto', 'hs_product_id', 'dolar', 'uy',
  'parte_del_cupo', 'line_item_key'];
const TK_PROPS = ['subject', 'hs_pipeline', 'hs_pipeline_stage', 'fecha_resolucion_esperada',
  'of_line_item_key', 'of_ticket_key', 'area', 'entidad_facturadora', 'of_producto',
  'of_producto_nombres', 'of_costo', 'of_margen', 'of_costo_usd', 'nombre_empresa',
  'empresa_que_factura', 'monto_unitario_real', 'cantidad_real', 'of_invoice_id',
  'of_billing_error'];

async function ticketsDeLik(lik) {
  const r = await hubspotClient.crm.tickets.searchApi.doSearch({
    filterGroups: [{ filters: [{ propertyName: 'of_line_item_key', operator: 'EQ', value: lik }] }],
    properties: TK_PROPS, limit: 100,
  });
  return r.results || [];
}

async function ticketsAsociados(dealId) {
  try {
    const r = await hubspotClient.apiRequest({ method: 'GET', path: `/crm/v4/objects/deals/${dealId}/associations/tickets` });
    const j = await r.json();
    return (j.results || []).map((x) => String(x.toObjectId));
  } catch { return []; }
}

async function empresasDe(dealId) {
  const r = await hubspotClient.apiRequest({ method: 'GET', path: `/crm/v4/objects/deals/${dealId}/associations/companies` });
  const j = await r.json();
  const out = [];
  for (const a of (j.results || [])) {
    let nombre = '';
    try { nombre = (await hubspotClient.crm.companies.basicApi.getById(a.toObjectId, ['name'])).properties.name || ''; } catch { /* borrada */ }
    out.push({ id: String(a.toObjectId), nombre, labels: (a.associationTypes || []).map((t) => t.label).filter(Boolean) });
  }
  return out;
}

const deal = await hubspotClient.crm.deals.basicApi.getById(M.dealId, ['dealname', 'dealstage',
  'pais_operativo', 'facturacion_activa', 'cupo_activo', 'cupo_total', 'cupo_consumido',
  'valor_total', 'amount', 'margen_total_usd', 'dolar', 'tc_pesos', 'deal_uy_mirror_id',
  'facturacion_proxima_fecha', 'billing_error', 'producto', 'area']);
const dp = deal.properties;

// ── BLOQUE A: el negocio ──────────────────────────────────────────────────────
check('NEGOCIO', 'sigue NO ganado', M.dealStageInicial, dp.dealstage);
check('NEGOCIO', 'país operativo', 'Paraguay', dp.pais_operativo);
check('NEGOCIO', 'facturación NO se prendió sola', '(vacía)', dp.facturacion_activa || '(vacía)');
check('NEGOCIO', 'TC a pesos congelado (tc_pesos)', 'un número > 0', dp.tc_pesos ?? '(vacía)', num(dp.tc_pesos) > 0);
check('NEGOCIO', 'próxima fecha de facturación', M.fechas.d15, String(dp.facturacion_proxima_fecha || '').slice(0, 10));
check('NEGOCIO', 'sin billing_error', '(vacío)', dp.billing_error ? dp.billing_error.slice(0, 60) : '(vacío)', !dp.billing_error);

// ── BLOQUE B: line items ──────────────────────────────────────────────────────
const lisPorSlug = {};
for (const [slug, li] of Object.entries(M.lineItems)) {
  const p = (await hubspotClient.crm.lineItems.basicApi.getById(li.id, LI_PROPS)).properties;
  lisPorSlug[slug] = p;

  // costo unitario = costo_total_usd × dolar ÷ cantidad (moneda del negocio)
  const esperado = (num(p.costo_total_usd) * (num(p.dolar) || 1)) / (num(p.quantity) || 1);
  check('LINE ITEMS', `${slug} · costo unitario = total×dólar÷cant`,
    Number.isFinite(esperado) ? esperado : '?', p.hs_cost_of_goods_sold ?? '(vacío)',
    casiIgual(num(p.hs_cost_of_goods_sold), esperado));

  check('LINE ITEMS', `${slug} · área`, 'Paraguay', p.area || '(vacía)');
  check('LINE ITEMS', `${slug} · empresa que factura`, 'ISA PY', p.empresa_que_factura || '(vacía)');
  check('LINE ITEMS', `${slug} · hs_product_id sembrado`, 'presente', p.hs_product_id || '(vacío)', Boolean(p.hs_product_id));

  // El producto tiene que EXISTIR en este portal (si no, es un id de PROD → HUBSPOT_ENV)
  let prodOk = false, prodNombre = '(404 — id de otro portal)';
  if (p.hs_product_id) {
    try { prodNombre = (await hubspotClient.crm.products.basicApi.getById(p.hs_product_id, ['name'])).properties.name; prodOk = true; }
    catch { /* 404 */ }
  }
  check('LINE ITEMS', `${slug} · el producto EXISTE en el portal`, 'sí', prodNombre, prodOk);
  check('LINE ITEMS', `${slug} · select nombre_producto lo rellenó el motor`, 'no vacío', p.nombre_producto || '(vacío)', Boolean(p.nombre_producto));
}

// ── BLOQUE C: tickets del original ────────────────────────────────────────────
const ESPERADOS = { 'LI-1': 1, 'LI-2': 1, 'LI-3': 16, 'LI-4': 12, 'LI-5': 1 };
let totalOriginal = 0;
const todosLosTickets = [];
for (const [slug, li] of Object.entries(M.lineItems)) {
  const ts = await ticketsDeLik(li.lineItemKey);
  totalOriginal += ts.length;
  todosLosTickets.push(...ts.map((t) => ({ slug, t })));
  check('TICKETS', `${slug} · cantidad`, ESPERADOS[slug], ts.length);

  if (!ts.length) continue;
  const fechas = ts.map((t) => t.properties.fecha_resolucion_esperada).sort();
  check('TICKETS', `${slug} · primera fecha`, li.fecha, fechas[0]);

  const etapas = [...new Set(ts.map((t) => t.properties.hs_pipeline_stage))];
  check('TICKETS', `${slug} · etapa`, stageLbl(ETAPA_ESPERADA),
    etapas.map(stageLbl).join('|'), etapas.length === 1 && String(etapas[0]) === ETAPA_ESPERADA);

  const p = lisPorSlug[slug];
  const costoEsperado = num(p.costo_total_usd) * (num(p.dolar) || 1);
  const costos = [...new Set(ts.map((t) => t.properties.of_costo))];
  check('TICKETS', `${slug} · costo del ticket (TOTAL de la línea)`, costoEsperado,
    costos.join('|'), costos.length === 1 && casiIgual(num(costos[0]), costoEsperado));

  const areas = [...new Set(ts.map((t) => t.properties.area || '(vacía)'))];
  check('TICKETS', `${slug} · área en el ticket`, 'Paraguay', areas.join('|'), areas.length === 1 && areas[0] === 'Paraguay');

  const ents = [...new Set(ts.map((t) => t.properties.entidad_facturadora || '(vacía)'))];
  check('TICKETS', `${slug} · empresa que factura (emisora)`, 'ISA PY', ents.join('|'), ents.length === 1 && ents[0] === 'ISA PY');

  // of_producto = nombre del PRODUCTO asociado al LI (definición usuaria 2-ago)
  let nombreProd = '';
  try { nombreProd = (await hubspotClient.crm.products.basicApi.getById(p.hs_product_id, ['name'])).properties.name; } catch { /* 404 */ }
  const prods = [...new Set(ts.map((t) => t.properties.of_producto || '(vacío)'))];
  check('TICKETS', `${slug} · producto en el ticket`, nombreProd || '(producto del LI)',
    prods.join('|'), Boolean(nombreProd) && prods.length === 1 && prods[0] === nombreProd);

  const benef = [...new Set(ts.map((t) => t.properties.nombre_empresa || '(vacío)'))];
  check('TICKETS', `${slug} · cliente beneficiario`, 'la empresa del negocio', benef.join('|'), benef.length === 1 && benef[0] !== '(vacío)');

  const facturados = ts.filter((t) => t.properties.of_invoice_id).length;
  check('TICKETS', `${slug} · sin facturas emitidas`, 0, facturados);
}

// ── BLOQUE D: el espejo ───────────────────────────────────────────────────────
let mirrorId = dp.deal_uy_mirror_id || '';
if (!mirrorId) {
  const r = await hubspotClient.crm.deals.searchApi.doSearch({
    filterGroups: [{ filters: [
      { propertyName: 'dealname', operator: 'CONTAINS_TOKEN', value: M.prefix.replace(/[[\]]/g, '') },
      { propertyName: 'es_mirror_de_py', operator: 'EQ', value: 'true' }] }],
    properties: ['dealname'], limit: 5,
  });
  mirrorId = r.results?.[0]?.id || '';
}
check('ESPEJO', 'el negocio espejo existe', 'sí', mirrorId || 'NO EXISTE', Boolean(mirrorId));

let totalEspejo = 0;
if (mirrorId) {
  const emp = await empresasDe(mirrorId);
  const emisora = emp.find((e) => e.labels.includes('Empresa Factura'));
  check('ESPEJO', 'Empresa Factura', EMISORA_ESPEJO_ESPERADA, emisora?.nombre || '(ninguna)',
    Boolean(emisora) && emisora.nombre.toUpperCase().includes(EMISORA_ESPEJO_ESPERADA));
  const partner = emp.find((e) => e.labels.includes('Partner'));
  check('ESPEJO', 'Partner', EMISORA_ESPEJO_ESPERADA, partner?.nombre || '(ninguna)',
    Boolean(partner) && partner.nombre.toUpperCase().includes(EMISORA_ESPEJO_ESPERADA));

  const mlis = await hubspotClient.crm.lineItems.searchApi.doSearch({
    filterGroups: [{ filters: [{ propertyName: 'line_item_key', operator: 'CONTAINS_TOKEN', value: mirrorId }] }],
    properties: LI_PROPS, limit: 20,
  });
  check('ESPEJO', 'tiene 1 line item', 1, mlis.results.length);

  if (mlis.results.length) {
    const ml = mlis.results[0].properties;
    const li5 = lisPorSlug['LI-5'];
    const precioEsperado = num(li5.costo_total_usd) / (num(li5.quantity) || 1);
    check('ESPEJO', 'price del espejo = costo unitario USD de PY', precioEsperado, ml.price,
      casiIgual(num(ml.price), precioEsperado));
    check('ESPEJO', 'producto copiado del original', li5.hs_product_id || '(el de PY)', ml.hs_product_id || '(vacío)',
      Boolean(ml.hs_product_id) && String(ml.hs_product_id) === String(li5.hs_product_id));
    check('ESPEJO', 'área propia (deriva de SU producto)', 'no vacía', ml.area || '(vacía)', Boolean(ml.area));
    check('ESPEJO', 'emisora propia (deriva de SU producto)', 'no vacía', ml.empresa_que_factura || '(vacía)', Boolean(ml.empresa_que_factura));

    const mt = await ticketsDeLik(ml.line_item_key);
    totalEspejo = mt.length;
    check('ESPEJO', 'tiene 1 ticket', 1, mt.length);
  }
}

check('TOTAL', 'tickets del stack (31 original + 1 espejo)', 32, totalOriginal + totalEspejo);

// Diagnóstico informativo (no es PASS/FAIL): asociación de tickets al negocio
const asociados = await ticketsAsociados(M.dealId);

// ── Salida ────────────────────────────────────────────────────────────────────
const anchoNombre = Math.max(...checks.map((c) => c.nombre.length));
let bloqueActual = '';
for (const c of checks) {
  if (c.bloque !== bloqueActual) { bloqueActual = c.bloque; console.log(`\n── ${bloqueActual}`); }
  const icono = c.pass ? '✅' : '❌';
  const detalle = c.pass ? String(c.actual) : `obtuvo: ${c.actual}   ·   esperaba: ${c.esperado}`;
  console.log(`  ${icono} ${c.nombre.padEnd(anchoNombre)}  ${detalle}`);
}

const fails = checks.filter((c) => !c.pass);
console.log(`\n${'═'.repeat(72)}`);
console.log(`  ETAPA 1 (negocio NO ganado)   ${checks.length - fails.length}/${checks.length} en verde`);
console.log(`${'═'.repeat(72)}`);
if (fails.length) {
  console.log('\n  Lo que falla:');
  for (const f of fails) console.log(`   ❌ [${f.bloque}] ${f.nombre} → ${f.actual}  (esperaba ${f.esperado})`);
}
console.log(`\n  ℹ️  tickets asociados al negocio: ${asociados.length} de ${totalOriginal}` +
  `  ${asociados.length === 0 ? '(esperado: la asociación ocurre recién en el CIERRE GANADO)' : ''}`);
console.log(`  ℹ️  negocio ${M.dealId} · espejo ${mirrorId || '—'}\n`);

if (DETALLE) {
  console.log('── DETALLE de los tickets');
  for (const { slug, t } of todosLosTickets.sort((a, b) =>
    String(a.t.properties.fecha_resolucion_esperada).localeCompare(String(b.t.properties.fecha_resolucion_esperada)))) {
    const p = t.properties;
    console.log(`  ${slug}  ${p.fecha_resolucion_esperada}  ${stageLbl(p.hs_pipeline_stage).padEnd(20)} ` +
      `monto=${p.monto_unitario_real} cant=${p.cantidad_real} costo=${p.of_costo} margen=${p.of_margen} prod="${p.of_producto || ''}"`);
  }
}

process.exit(fails.length ? 1 : 0);
