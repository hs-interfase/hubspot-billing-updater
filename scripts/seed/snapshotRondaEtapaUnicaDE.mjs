#!/usr/bin/env node
/**
 * snapshotRondaEtapaUnicaDE.mjs
 *
 * El "antes" y el "después" de cada escenario de la ronda D+E. Hermano del de
 * B+C, con lo que D y E necesitan y aquél no tenía:
 *
 *   · LA HOJA ENTERA del LINE ITEM ESPEJO. El escenario (a) pide verificar que
 *     "cambió la descripción y NADA MÁS": sin todas las props del espejo eso no
 *     se puede afirmar, sólo suponer.
 *   · `of_billing_error` de cada ticket — es el canal del aviso de la tanda D,
 *     así que es un dato del escenario, no ruido.
 *   · `of_propietario_secundario` y `of_moneda` de cada ticket — las dos props
 *     que baja la tanda E.
 *   · Los tickets del deal ESPEJO, no sólo los del original.
 *
 * Uso:
 *   node scripts/seed/snapshotRondaEtapaUnicaDE.mjs <etiqueta>
 *     → imprime la tabla y la guarda en ronda-de-snapshots.json bajo esa etiqueta
 *   node scripts/seed/snapshotRondaEtapaUnicaDE.mjs --diff <antes> <despues>
 *     → compara dos snapshots ya guardados, prop por prop
 */

import 'dotenv/config';
import fs from 'fs';
import { hubspotClient } from '../../src/hubspotClient.js';

const MANIFEST  = 'ronda-de-manifest.json';
const SNAPSHOTS = 'ronda-de-snapshots.json';

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
  // pipeline automático
  '1311404147': 'AUTO Forecast',
  '1311404148': 'AUTO 50%',
  '1311404149': 'AUTO 75%',
  '1330252330': 'AUTO 85%',
  '1311404150': 'AUTO 95%',
  '1311404151': 'AUTO Listo',
  '1311404152': 'AUTO Emitido',
  '1311404153': 'AUTO Atrasado',
  '1311404154': 'AUTO Cobrado',
  '1311404155': 'AUTO CANCELADO',
};

const CANCELLED_STAGES = new Set(['1311451813', '1311404155']);

/**
 * TODAS las props del line item espejo que el motor puede escribir: la
 * `allowedProps` de dealMirroring.js + las que el upsert pone siempre + las que
 * alimentan la traducción costo→precio. Es la lista contra la que se afirma
 * "cambió X y NADA MÁS".
 */
const LI_PROPS = [
  'name', 'description', 'quantity', 'price', 'amount',
  'recurringbillingfrequency', 'hs_recurring_billing_frequency',
  'hs_recurring_billing_start_date', 'hs_recurring_billing_number_of_payments',
  'hs_recurring_billing_period', 'billing_anchor_date',
  'servicio', 'subrubro', 'unidad_de_negocio',
  'renovacion_automatica', 'facturacion_activa', 'facturacion_automatica',
  'pausa', 'motivo_de_pausa', 'hs_product_id', 'hs_sku',
  'costo_total_usd', 'hs_cost_of_goods_sold', 'dolar',
  'uy', 'pais_operativo', 'of_line_item_py_origen_id', 'mirror_missing_cost',
  'line_item_key', 'nota', 'of_billing_error', 'hubspot_owner_id',
  'pagos_restantes', 'billing_next_date', 'last_billing_period',
  'last_ticketed_date', 'facturas_restantes',
];

const TICKET_PROPS = [
  'subject', 'hs_pipeline', 'hs_pipeline_stage', 'of_ticket_key', 'of_line_item_key',
  'fecha_resolucion_esperada', 'of_invoice_id', 'monto_unitario_real', 'cantidad_real',
  'observaciones', 'of_billing_error', 'of_deal_id',
  'of_propietario_secundario', 'of_moneda', 'hubspot_owner_id',
  'of_descripcion_producto', 'of_producto_nombres', 'of_costo', 'of_costo_usd', 'of_margen',
];

function loadJson(p, fb) {
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : fb;
}

/**
 * Tickets de un negocio.
 *
 * 🔴 NO alcanza con la asociación deal→ticket: en los deals ESPEJO el motor deja
 * tickets que todavía no aparecen asociados (la primera corrida de esta ronda
 * mostró 4 tickets del espejo de LI-1 por clave y sólo 2 por asociación). Un
 * snapshot que se los pierda hace fallar escenarios que en realidad pasan. Por
 * eso se unen las dos fuentes: la asociación y la búsqueda por `of_deal_id`.
 */
async function ticketsDelDeal(dealId) {
  const ids = new Set();

  let after;
  do {
    const r = await hubspotClient.crm.associations.v4.basicApi.getPage('deals', String(dealId), 'tickets', 100, after);
    for (const x of (r.results || [])) ids.add(String(x.toObjectId));
    after = r.paging?.next?.after;
  } while (after);

  try {
    const r = await hubspotClient.crm.tickets.searchApi.doSearch({
      filterGroups: [{ filters: [{ propertyName: 'of_deal_id', operator: 'EQ', value: String(dealId) }] }],
      properties: ['hs_object_id'], limit: 100,
    });
    for (const t of (r.results || [])) ids.add(String(t.id));
  } catch { /* la búsqueda es el complemento, no la fuente única */ }

  const uniq = [...ids];
  if (!uniq.length) return [];

  const out = [];
  for (let i = 0; i < uniq.length; i += 100) {
    const r = await hubspotClient.crm.tickets.batchApi.read({
      inputs: uniq.slice(i, i + 100).map(id => ({ id })),
      properties: TICKET_PROPS,
    });
    out.push(...(r.results || []));
  }
  return out;
}

async function leerLi(id) {
  try {
    const r = await hubspotClient.crm.lineItems.basicApi.getById(String(id), LI_PROPS);
    return r.properties || {};
  } catch (err) {
    return { _error: err.message };
  }
}

function resumenTicket(t) {
  return {
    id: String(t.id),
    fecha: t.properties?.fecha_resolucion_esperada || '',
    etapa: STAGE_LABEL[String(t.properties?.hs_pipeline_stage)] || String(t.properties?.hs_pipeline_stage || '?'),
    stageId: String(t.properties?.hs_pipeline_stage || ''),
    pipeline: String(t.properties?.hs_pipeline || ''),
    key: t.properties?.of_ticket_key || '',
    liKey: t.properties?.of_line_item_key || '',
    invoiceId: t.properties?.of_invoice_id || '',
    monto: t.properties?.monto_unitario_real || '',
    cantidad: t.properties?.cantidad_real || '',
    descripcion: t.properties?.of_descripcion_producto || '',
    costo: t.properties?.of_costo || '',
    billingError: t.properties?.of_billing_error || '',
    propietarioSecundario: t.properties?.of_propietario_secundario || '',
    moneda: t.properties?.of_moneda || '',
  };
}

async function tomarSnapshot(manifest) {
  const snap = { tomadoEn: new Date().toISOString(), deals: {}, lineItems: {}, mirrorLineItems: {}, tickets: {} };

  // Todos los deals que hay que mirar: los del manifest + los espejos.
  const todos = { ...manifest.deals };
  for (const [slug, m] of Object.entries(manifest.mirrors || {})) {
    if (m?.mirrorDealId) todos[`${slug}__espejo`] = { id: m.mirrorDealId, nombre: `espejo UY de ${slug}`, sellado: m.sellado };
  }

  for (const [slug, d] of Object.entries(todos)) {
    let dp = {};
    try {
      const r = await hubspotClient.crm.deals.basicApi.getById(String(d.id), [
        'dealname', 'dealstage', 'pais_operativo', 'hubspot_owner_id', 'deal_currency_code',
        'deal_uy_mirror_id', 'es_mirror_de_py', 'mig_espejo_independiente', 'billing_error',
      ]);
      dp = r.properties || {};
    } catch (err) { dp = { _error: err.message }; }

    const ts = await ticketsDelDeal(d.id);
    snap.deals[slug] = {
      id: String(d.id),
      owner: dp.hubspot_owner_id || '',
      moneda: dp.deal_currency_code || '',
      pais: dp.pais_operativo || '',
      esEspejo: dp.es_mirror_de_py || '',
      sellado: dp.mig_espejo_independiente || '',
      mirrorId: dp.deal_uy_mirror_id || '',
      billingError: dp.billing_error || '',
      totalTickets: ts.length,
      noCancelados: ts.filter(t => !CANCELLED_STAGES.has(String(t.properties?.hs_pipeline_stage))).length,
    };
    snap.tickets[slug] = ts.map(resumenTicket).sort((a, b) => (a.fecha || '').localeCompare(b.fecha || ''));
  }

  for (const [slug, li] of Object.entries(manifest.lineItems)) {
    snap.lineItems[slug] = { id: String(li.id), dealSlug: li.dealSlug, props: await leerLi(li.id) };
    if (li.mirrorLineItemId) {
      snap.mirrorLineItems[slug] = { id: String(li.mirrorLineItemId), origen: String(li.id), props: await leerLi(li.mirrorLineItemId) };
    }
  }

  return snap;
}

function imprimir(snap, etiqueta) {
  console.log(`\n═══════ SNAPSHOT «${etiqueta}» — ${snap.tomadoEn} ═══════`);

  for (const [slug, d] of Object.entries(snap.deals)) {
    console.log(`\n▸ ${slug}  deal ${d.id}${d.sellado === 'true' ? '  🔒 SELLADO' : ''}`);
    console.log(`   owner=${d.owner || '—'}  moneda=${d.moneda || '—'}  pais=${d.pais || '—'}  espejo=${d.mirrorId || '—'}`);
    console.log(`   tickets: ${d.totalTickets} (no cancelados: ${d.noCancelados})`);
    for (const t of (snap.tickets[slug] || [])) {
      const extra = [
        t.propietarioSecundario ? `vend=${t.propietarioSecundario}` : null,
        t.moneda ? `mon=${t.moneda}` : null,
        t.billingError ? `AVISO(${t.billingError.length}c)` : null,
      ].filter(Boolean).join(' ');
      console.log(`      ${String(t.fecha).padEnd(12)} ${t.etapa.padEnd(21)} ${t.id.padEnd(12)} ${extra}`);
    }
  }

  console.log('\n── LINE ITEMS ──');
  for (const [slug, li] of Object.entries(snap.lineItems)) {
    const p = li.props;
    console.log(`\n▸ ${slug}  LI ${li.id}   price=${p.price} qty=${p.quantity} costo_usd=${p.costo_total_usd}`);
    console.log(`   description = ${JSON.stringify(p.description ?? null)}`);
    const esp = snap.mirrorLineItems[slug];
    if (esp) {
      console.log(`   ↳ ESPEJO ${esp.id}  price=${esp.props.price} qty=${esp.props.quantity}`);
      console.log(`     description = ${JSON.stringify(esp.props.description ?? null)}`);
    }
  }
}

/** Diff prop a prop de un objeto de properties. */
function diffProps(a = {}, b = {}, ignore = new Set()) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const out = [];
  for (const k of keys) {
    if (ignore.has(k)) continue;
    const x = a[k] ?? null, y = b[k] ?? null;
    if (String(x ?? '') !== String(y ?? '')) out.push(`${k}: ${JSON.stringify(x)} → ${JSON.stringify(y)}`);
  }
  return out;
}

// `amount` es derivada de price×quantity y `hs_lastmodifieddate` cambia siempre:
// no son cambios que el escenario pueda atribuir a nadie.
const IGNORAR = new Set(['amount', 'hs_lastmodifieddate']);

function diff(a, b, la, lb) {
  console.log(`\n═══════ DIFF  «${la}» → «${lb}» ═══════`);

  console.log('\n── DEALS / conteo de tickets ──');
  for (const slug of Object.keys(b.deals)) {
    const x = a.deals[slug], y = b.deals[slug];
    if (!x) { console.log(`\n▸ ${slug}: NUEVO`); continue; }
    const cambios = [];
    for (const k of ['owner', 'moneda', 'pais', 'sellado', 'mirrorId', 'totalTickets', 'noCancelados']) {
      if (String(x[k]) !== String(y[k])) cambios.push(`${k}: ${x[k]} → ${y[k]}`);
    }
    if (String(x.billingError) !== String(y.billingError)) cambios.push(`billing_error del DEAL: ${y.billingError ? 'ESCRITO' : 'borrado'}`);
    if (cambios.length) {
      console.log(`\n▸ ${slug}`);
      for (const c of cambios) console.log(`   ${c}`);
      if (y.noCancelados < x.noCancelados) console.log('   🔴 BAJÓ el conteo de no-cancelados — es un hallazgo');
    } else {
      console.log(`\n▸ ${slug}: sin cambios`);
    }
  }

  console.log('\n── LINE ITEMS ORIGINALES ──');
  for (const slug of Object.keys(b.lineItems)) {
    const x = a.lineItems[slug]?.props, y = b.lineItems[slug]?.props;
    if (!x) continue;
    const d = diffProps(x, y, IGNORAR);
    console.log(`\n▸ ${slug} ${d.length ? '' : '— SIN CAMBIOS'}`);
    for (const c of d) console.log(`   ${c}`);
  }

  console.log('\n── LINE ITEMS ESPEJO 🔴 (acá se prueba «cambió X y NADA MÁS») ──');
  for (const slug of Object.keys(b.mirrorLineItems)) {
    const x = a.mirrorLineItems[slug]?.props, y = b.mirrorLineItems[slug]?.props;
    if (!x) { console.log(`\n▸ ${slug}: espejo nuevo`); continue; }
    const d = diffProps(x, y, IGNORAR);
    console.log(`\n▸ ${slug} (espejo ${b.mirrorLineItems[slug].id}) ${d.length ? `— ${d.length} prop(s) cambiada(s)` : '— SIN CAMBIOS'}`);
    for (const c of d) console.log(`   ${c}`);
  }

  console.log('\n── TICKETS ──');
  for (const slug of Object.keys(b.tickets)) {
    const antes = new Map((a.tickets[slug] || []).map(t => [t.id, t]));
    const desp = b.tickets[slug] || [];
    const lineas = [];
    for (const t of desp) {
      const x = antes.get(t.id);
      if (!x) { lineas.push(`   + NUEVO ${t.id} ${t.fecha} ${t.etapa}`); continue; }
      const d = diffProps(x, t, new Set(['id']));
      if (d.length) lineas.push(`   ~ ${t.id} ${t.fecha} ${t.etapa}\n       ${d.join('\n       ')}`);
      antes.delete(t.id);
    }
    for (const [id, t] of antes) lineas.push(`   - DESAPARECIÓ ${id} ${t.fecha} ${t.etapa}  🔴`);
    console.log(`\n▸ ${slug} ${lineas.length ? '' : '— sin cambios'}`);
    for (const l of lineas) console.log(l);
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
  if (!etiqueta) { console.error('❌ Falta la etiqueta. Uso: node scripts/seed/snapshotRondaEtapaUnicaDE.mjs <etiqueta>'); process.exit(1); }

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
