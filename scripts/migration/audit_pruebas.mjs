// audit_pruebas.mjs — AUDITORÍA READ-ONLY de la base de prueba en sandbox.
// Cruza el ESPERADO (manifests de Paso A/base) vs el ESTADO REAL en HubSpot:
//   por deal → #LIs, #tickets por stage, #invoices por etapa, históricos Emitidos.
// No escribe nada. Correr desde la raíz del repo con .env (sandbox).
//   node scripts/migration/audit_pruebas.mjs

import 'dotenv/config';
import { Client } from '@hubspot/api-client';
import { readFileSync } from 'node:fs';

const h = new Client({ accessToken: process.env.HUBSPOT_PRIVATE_TOKEN });
const E = process.env;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MANUAL_PIPE = E.BILLING_TICKET_PIPELINE_ID;          // 875213463
const AUTO_PIPE   = E.BILLING_AUTOMATED_PIPELINE_ID;       // 875177783

const STAGE = {
  // manual
  [E.BILLING_TICKET_STAGE_ID]: 'NEW',
  [E.BILLING_TICKET_STAGE_READY]: 'READY',
  [E.BILLING_TICKET_STAGE_ID_CREATED]: 'EMITIDO',
  [E.BILLING_TICKET_STAGE_ID_LATE]: 'LATE',
  [E.BILLING_TICKET_PIPELINE_ID_PAID]: 'PAID',
  [E.BILLING_TICKET_STAGE_CANCELLED]: 'CANCEL',
  [E.BILLING_TICKET_FORECAST]: 'FCAST', [E.BILLING_TICKET_FORECAST_50]: 'FCAST', [E.BILLING_TICKET_FORECAST_75]: 'FCAST',
  [E.BILLING_TICKET_FORECAST_85]: 'FCAST', [E.BILLING_TICKET_FORECAST_95]: 'FCAST',
  // auto
  [E.BILLING_AUTOMATED_READY]: 'READY',
  [E.BILLING_AUTOMATED_CREATED]: 'EMITIDO',
  [E.BILLING_AUTOMATED_LATE]: 'LATE',
  [E.BILLING_AUTOMATED_PAID]: 'PAID',
  [E.BILLING_AUTOMATED_CANCELLED]: 'CANCEL',
  [E.BILLING_AUTOMATED_FORECAST]: 'FCAST', [E.BILLING_AUTOMATED_FORECAST_50]: 'FCAST', [E.BILLING_AUTOMATED_FORECAST_75]: 'FCAST',
  [E.BILLING_AUTOMATED_FORECAST_85]: 'FCAST', [E.BILLING_AUTOMATED_FORECAST_95]: 'FCAST',
};
const stageLabel = (t) => {
  const p = t.properties || {};
  const pipe = String(p.hs_pipeline) === String(AUTO_PIPE) ? 'A' : String(p.hs_pipeline) === String(MANUAL_PIPE) ? 'M' : '?';
  return `${pipe}:${STAGE[p.hs_pipeline_stage] || p.hs_pipeline_stage}`;
};

const norm = (s) => String(s ?? '').trim().toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');

// ── Cargar manifests ────────────────────────────────────────────
const load = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
const unicos = load('scripts/migration/pruebas_unicos.json');
const mansoft = load('scripts/migration/pruebas_mansoft.json');
const twins = load('scripts/migration/pruebas_twins.json');

// Esperado por id_crm_origen (únicos) y por dealname (mansoft / twins)
const expByOrigen = new Map();
const expByName = new Map();

for (const d of (unicos?.deals || [])) {
  const lis = d.lineItems || [];
  const exp = {
    tipo: 'UNICO', dealname: d.deal?.dealname, nLIs: lis.length,
    nHist: (d.historicalTickets || []).length,
    histNodums: (d.historicalTickets || []).map((x) => String(x.numero_de_factura)),
  };
  if (d.deal?.id_crm_origen) expByOrigen.set(String(d.deal.id_crm_origen), exp);
  expByName.set(norm(d.deal?.dealname), exp);
}
for (const t of (twins?.twinsApartados || [])) {
  const lis = t.lineItems || [];
  const exp = { tipo: 'TWIN/MIRROR', dealname: t.deal?.dealname, nLIs: lis.length, nHist: (t.historicalTickets || []).length, histNodums: [] };
  if (t.deal?.id_crm_origen) expByOrigen.set(String(t.deal.id_crm_origen), exp);
  expByName.set(norm(t.deal?.dealname), exp);
}
for (const d of (mansoft?.deals || [])) {
  const lis = d.lineItems || [];
  expByName.set(norm(d.dealname), { tipo: 'MANSOFT', dealname: d.dealname, nLIs: lis.length, nHist: 0, histNodums: [] });
}

// ── Traer deals de sandbox (base de prueba = facturacion_activa true) ──
const deals = [];
let after;
do {
  const r = await h.crm.deals.searchApi.doSearch({
    filterGroups: [{ filters: [{ propertyName: 'facturacion_activa', operator: 'EQ', value: 'true' }] }],
    properties: ['dealname', 'id_crm_origen', 'amount', 'deal_currency_code', 'dealstage', 'es_mirror_de_py', 'deal_py_origen_id'],
    sorts: [{ propertyName: 'hs_object_id', direction: 'ASCENDING' }], limit: 100, ...(after ? { after } : {}),
  });
  deals.push(...(r.results || [])); after = r.paging?.next?.after;
  if (after) await sleep(150);
} while (after);

const rows = [];
const matchedNames = new Set();

for (const d of deals) {
  const dp = d.properties || {};
  // LIs
  const liIds = [];
  let aa;
  do {
    const ar = await h.crm.associations.v4.basicApi.getPage('deals', d.id, 'line_items', aa, 100);
    for (const x of (ar.results || [])) liIds.push(String(x.toObjectId));
    aa = ar.paging?.next?.after; if (aa) await sleep(100);
  } while (aa);
  // Tickets
  const tIds = [];
  do {
    const ar = await h.crm.associations.v4.basicApi.getPage('deals', d.id, 'tickets', aa, 100);
    for (const x of (ar.results || [])) tIds.push(String(x.toObjectId));
    aa = ar.paging?.next?.after; if (aa) await sleep(100);
  } while (aa);
  let tickets = [];
  for (let i = 0; i < tIds.length; i += 100) {
    const b = await h.crm.tickets.batchApi.read({ inputs: tIds.slice(i, i + 100).map((id) => ({ id })), properties: ['hs_pipeline', 'hs_pipeline_stage', 'of_invoice_id', 'numero_de_factura', 'of_estado'] });
    tickets.push(...(b.results || []));
  }
  // descartar duplicados marcados
  const dup = tickets.filter((t) => ['DUPLICADO_UI', 'DEPRECATED'].includes(String(t.properties?.of_estado || '').toUpperCase())).length;
  tickets = tickets.filter((t) => !['DUPLICADO_UI', 'DEPRECATED'].includes(String(t.properties?.of_estado || '').toUpperCase()));
  // Invoices
  const iIds = [];
  do {
    const ar = await h.crm.associations.v4.basicApi.getPage('deals', d.id, 'invoices', aa, 100);
    for (const x of (ar.results || [])) iIds.push(String(x.toObjectId));
    aa = ar.paging?.next?.after; if (aa) await sleep(100);
  } while (aa);
  let invoices = [];
  for (let i = 0; i < iIds.length; i += 100) {
    const b = await h.crm.objects.batchApi.read('invoices', { inputs: iIds.slice(i, i + 100).map((id) => ({ id })), properties: ['etapa_de_la_factura', 'id_factura_nodum'] });
    invoices.push(...(b.results || []));
  }

  // stage breakdown
  const byStage = {};
  for (const t of tickets) { const l = stageLabel(t); byStage[l] = (byStage[l] || 0) + 1; }
  const byEtapa = {};
  for (const iv of invoices) { const e = iv.properties?.etapa_de_la_factura || '∅'; byEtapa[e] = (byEtapa[e] || 0) + 1; }

  // match esperado
  let exp = (dp.id_crm_origen && expByOrigen.get(String(dp.id_crm_origen))) || expByName.get(norm(dp.dealname)) || null;
  if (exp) matchedNames.add(norm(exp.dealname));
  const isMirror = String(dp.es_mirror_de_py || '').toLowerCase() === 'true' || !!dp.deal_py_origen_id;

  rows.push({
    id: d.id, dealname: dp.dealname, origen: dp.id_crm_origen || (isMirror ? `MIRROR(py:${dp.deal_py_origen_id || '?'})` : '∅'),
    moneda: dp.deal_currency_code, amount: dp.amount,
    nLIs: liIds.length, expLIs: exp?.nLIs ?? '?', tipo: exp?.tipo ?? (isMirror ? 'MIRROR' : '??'),
    nTk: tickets.length, dup, byStage, byEtapa, expHist: exp?.nHist ?? 0,
    emitidos: (byStage['M:EMITIDO'] || 0) + (byStage['A:EMITIDO'] || 0),
    conInvoiceSinEmitir: tickets.filter((t) => (t.properties?.of_invoice_id || t.properties?.numero_de_factura) && !/EMITIDO|PAID|LATE|CANCEL/.test(stageLabel(t))).length,
  });
  await sleep(120);
}

// ── Reporte ─────────────────────────────────────────────────────
console.log('\n══════════ AUDITORÍA BASE DE PRUEBA (sandbox) ══════════\n');
for (const r of rows) {
  const liFlag = r.expLIs !== '?' && r.nLIs !== r.expLIs ? `  ⚠️ LIs ${r.nLIs}≠${r.expLIs}` : '';
  const histFlag = r.expHist && r.emitidos < r.expHist ? `  ⚠️ Emitidos ${r.emitidos}<${r.expHist}` : '';
  const stuckFlag = r.conInvoiceSinEmitir ? `  ⚠️ ${r.conInvoiceSinEmitir} con invoice sin stage emitido` : '';
  const dupFlag = r.dup ? `  ⚠️ ${r.dup} dup` : '';
  console.log(`▸ ${r.dealname}  [${r.tipo}] (${r.moneda} ${r.amount ?? '∅'})  deal ${r.id}`);
  console.log(`    origen: ${r.origen}`);
  console.log(`    LIs: ${r.nLIs}${r.expLIs !== '?' ? `/${r.expLIs}` : ''}${liFlag}   Tickets: ${r.nTk}  →  ${JSON.stringify(r.byStage)}${dupFlag}`);
  console.log(`    Invoices: ${JSON.stringify(r.byEtapa)}   Históricos esperados: ${r.expHist} · Emitidos: ${r.emitidos}${histFlag}${stuckFlag}`);
}

// deals esperados que NO aparecieron
const faltan = [];
for (const [k, v] of expByName) if (!matchedNames.has(k)) faltan.push(v.dealname);

console.log('\n── RESUMEN ──');
console.log(`Deals en sandbox (facturacion_activa=true): ${rows.length}`);
console.log(`Total tickets: ${rows.reduce((s, r) => s + r.nTk, 0)} · Emitidos: ${rows.reduce((s, r) => s + r.emitidos, 0)} · Duplicados: ${rows.reduce((s, r) => s + r.dup, 0)}`);
console.log(`Tickets con invoice pero stage no-emitido: ${rows.reduce((s, r) => s + r.conInvoiceSinEmitir, 0)}`);
const liMismatch = rows.filter((r) => r.expLIs !== '?' && r.nLIs !== r.expLIs);
console.log(`Deals con #LIs ≠ esperado: ${liMismatch.length}${liMismatch.length ? ' → ' + liMismatch.map((r) => r.dealname).join(', ') : ''}`);
console.log(`Deals esperados (manifest) sin aparecer en sandbox: ${faltan.length}${faltan.length ? ' → ' + faltan.join(' | ') : ''}`);
console.log(`Históricos esperados totales: ${[...expByOrigen.values()].reduce((s, v) => s + v.nHist, 0)}`);
