#!/usr/bin/env node
/**
 * snapshotRondaEtapaUnicaBC.mjs
 *
 * El "antes" y el "después" de cada escenario de la ronda B+C. Sin esto los
 * escenarios no son verificables (PLAN_ronda_sandbox_etapa_unica_BC.md §2 y §4-3:
 * *contar los tickets antes y después; el motor ya no borra, así que un conteo
 * que baja es un hallazgo*).
 *
 * Por line item: pagos_restantes · billing_next_date · last_billing_period ·
 * last_ticketed_date · facturas_restantes + los tickets por etapa.
 *
 * Uso:
 *   node scripts/seed/snapshotRondaEtapaUnicaBC.mjs <etiqueta>
 *     → imprime la tabla y la guarda en ronda-bc-snapshots.json bajo esa etiqueta
 *   node scripts/seed/snapshotRondaEtapaUnicaBC.mjs --diff <antes> <despues>
 *     → compara dos snapshots ya guardados
 */

import 'dotenv/config';
import fs from 'fs';
import { hubspotClient } from '../../src/hubspotClient.js';

const MANIFEST  = 'ronda-bc-manifest.json';
const SNAPSHOTS = 'ronda-bc-snapshots.json';

const STAGE_LABEL = {
  '1311451803': 'Forecast',
  '1311451804': '50% Forecast',
  '1311451805': '75% Forecast',
  '1330250642': '85% Forecast',
  '1311451806': '95% Forecast',
  '1311451807': 'Próximos a facturar',
  '1311451808': 'Notificado',
  '1311451809': 'Emitido',
  '1311451810': 'Enviado',
  '1311451811': 'Atrasado',
  '1311451812': 'Cobrado',
  '1311451813': 'CANCELADO',
};

const LI_PROPS = [
  'name', 'pagos_restantes', 'billing_next_date', 'last_billing_period',
  'last_ticketed_date', 'facturas_restantes', 'line_item_key',
  'recurringbillingfrequency', 'hs_recurring_billing_number_of_payments',
  'hs_recurring_billing_start_date', 'facturacion_activa', 'mig_migracion_historica',
];

const TICKET_PROPS = [
  'subject', 'hs_pipeline', 'hs_pipeline_stage', 'of_ticket_key', 'of_line_item_key',
  'fecha_resolucion_esperada', 'of_invoice_id', 'monto_unitario_real', 'observaciones',
  'mig_emision_historica', 'of_deal_id',
];

function loadJson(p, fb) {
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : fb;
}

async function todosLosTicketsDelDeal(dealId) {
  const ids = [];
  let after;
  do {
    const r = await hubspotClient.crm.associations.v4.basicApi.getPage('deals', String(dealId), 'tickets', 100, after);
    for (const x of (r.results || [])) ids.push(String(x.toObjectId));
    after = r.paging?.next?.after;
  } while (after);
  if (!ids.length) return [];

  const out = [];
  for (let i = 0; i < ids.length; i += 100) {
    const r = await hubspotClient.crm.tickets.batchApi.read({
      inputs: ids.slice(i, i + 100).map(id => ({ id })),
      properties: TICKET_PROPS,
    });
    out.push(...(r.results || []));
  }
  return out;
}

async function tomarSnapshot(manifest) {
  const snap = { tomadoEn: new Date().toISOString(), lineItems: {}, deals: {} };

  // Los tickets se leen UNA vez por deal y se reparten por of_line_item_key.
  const ticketsPorDeal = {};
  for (const [slug, d] of Object.entries(manifest.deals)) {
    const ts = await todosLosTicketsDelDeal(d.id);
    ticketsPorDeal[d.id] = ts;
    snap.deals[slug] = { id: d.id, totalTickets: ts.length };
  }

  for (const [slug, li] of Object.entries(manifest.lineItems)) {
    let props = {};
    try {
      const r = await hubspotClient.crm.lineItems.basicApi.getById(String(li.id), LI_PROPS);
      props = r.properties || {};
    } catch (err) {
      props = { _error: err.message };
    }

    const propios = (ticketsPorDeal[li.dealId] || [])
      .filter(t => String(t.properties?.of_line_item_key || '') === String(li.lineItemKey));

    const porEtapa = {};
    for (const t of propios) {
      const st = String(t.properties?.hs_pipeline_stage || '?');
      const label = STAGE_LABEL[st] || st;
      (porEtapa[label] ||= []).push({
        id: t.id,
        fecha: t.properties?.fecha_resolucion_esperada || '',
        invoiceId: t.properties?.of_invoice_id || '',
        monto: t.properties?.monto_unitario_real || '',
        obs: t.properties?.observaciones || '',
        migrado: t.properties?.mig_emision_historica || '',
      });
    }
    for (const k of Object.keys(porEtapa)) porEtapa[k].sort((a, b) => (a.fecha || '').localeCompare(b.fecha || ''));

    const noCancelados = propios.filter(t => String(t.properties?.hs_pipeline_stage) !== '1311451813').length;

    snap.lineItems[slug] = {
      id: li.id, dealId: li.dealId, lineItemKey: li.lineItemKey,
      pagos_restantes:     props.pagos_restantes ?? null,
      billing_next_date:   props.billing_next_date ?? null,
      last_billing_period: props.last_billing_period ?? null,
      last_ticketed_date:  props.last_ticketed_date ?? null,
      facturas_restantes:  props.facturas_restantes ?? null,
      frecuencia:          props.recurringbillingfrequency ?? null,
      cuotas:              props.hs_recurring_billing_number_of_payments ?? null,
      totalTickets: propios.length,
      noCancelados,
      porEtapa,
    };
  }
  return snap;
}

function imprimir(snap, etiqueta) {
  console.log(`\n═══════ SNAPSHOT «${etiqueta}» — ${snap.tomadoEn} ═══════`);
  for (const [slug, s] of Object.entries(snap.lineItems)) {
    console.log(`\n▸ ${slug}  (LI ${s.id} · deal ${s.dealId} · ${s.frecuencia || '—'} × ${s.cuotas || '—'})`);
    console.log(`   pagos_restantes=${s.pagos_restantes}  billing_next_date=${s.billing_next_date}`);
    console.log(`   last_billing_period=${s.last_billing_period}  last_ticketed_date=${s.last_ticketed_date}  facturas_restantes=${s.facturas_restantes}`);
    console.log(`   tickets: ${s.totalTickets} (no cancelados: ${s.noCancelados})`);
    for (const [etapa, ts] of Object.entries(s.porEtapa)) {
      console.log(`      ${etapa.padEnd(22)} ${ts.length}  ${ts.map(t => `${t.fecha}${t.migrado === 'true' ? '*' : ''}`).join(' ')}`);
    }
  }
  console.log('\n   deals:', Object.entries(snap.deals).map(([k, v]) => `${k}=${v.totalTickets}`).join('  '));
}

function diff(a, b, la, lb) {
  console.log(`\n═══════ DIFF  «${la}» → «${lb}» ═══════`);
  for (const slug of Object.keys(b.lineItems)) {
    const x = a.lineItems[slug], y = b.lineItems[slug];
    if (!x) { console.log(`\n▸ ${slug}: nuevo`); continue; }
    const cambios = [];
    for (const k of ['pagos_restantes', 'billing_next_date', 'last_billing_period', 'last_ticketed_date', 'facturas_restantes', 'totalTickets', 'noCancelados']) {
      if (String(x[k]) !== String(y[k])) cambios.push(`${k}: ${x[k]} → ${y[k]}`);
    }
    const etapas = new Set([...Object.keys(x.porEtapa), ...Object.keys(y.porEtapa)]);
    for (const e of etapas) {
      const na = (x.porEtapa[e] || []).length, nb = (y.porEtapa[e] || []).length;
      if (na !== nb) cambios.push(`etapa «${e}»: ${na} → ${nb}`);
    }
    if (!cambios.length) { console.log(`\n▸ ${slug}: SIN CAMBIOS`); continue; }
    console.log(`\n▸ ${slug}`);
    for (const c of cambios) console.log(`   ${c}`);
    if (y.noCancelados < x.noCancelados) console.log(`   🔴 BAJÓ el conteo de no-cancelados — es un hallazgo (§4-3)`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const store = loadJson(SNAPSHOTS, {});

  if (args[0] === '--diff') {
    const [, la, lb] = args;
    if (!store[la] || !store[lb]) { console.error(`❌ Falta alguno de los snapshots: ${la} / ${lb}`); process.exit(1); }
    diff(store[la], store[lb], la, lb);
    return;
  }

  const etiqueta = args[0];
  if (!etiqueta) { console.error('❌ Falta la etiqueta. Uso: node scripts/seed/snapshotRondaEtapaUnicaBC.mjs <etiqueta>'); process.exit(1); }

  const manifest = loadJson(MANIFEST, null);
  if (!manifest) { console.error(`❌ No existe ${MANIFEST}`); process.exit(1); }

  const snap = await tomarSnapshot(manifest);
  imprimir(snap, etiqueta);

  store[etiqueta] = snap;
  fs.writeFileSync(SNAPSHOTS, JSON.stringify(store, null, 2));
  console.log(`\n💾 Guardado en ${SNAPSHOTS} como «${etiqueta}»`);
}

main().catch(err => {
  console.error('❌ Error fatal:', err.message);
  if (err.body) console.error(JSON.stringify(err.body, null, 2));
  process.exit(1);
});
