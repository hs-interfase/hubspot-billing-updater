#!/usr/bin/env node
/**
 * seedRondaEtapaUnicaDE.mjs
 *
 * SEED de la ronda de sandbox que valida las TANDAS D (espejo,
 * MIRROR_PUNTUAL_ENABLED) y E (vendedor/moneda, DEAL_PROP_SYNC_ENABLED).
 * Guion: definitivos/PLAN_ronda_sandbox_etapa_unica_DE.md §2.
 *
 * Hermano de seedRondaEtapaUnicaBC.mjs — misma mecánica (manifest, claves
 * canónicas, guarda de sandbox) con lo que agrega el §2 del guion de D+E.
 *
 * ⚠️ SOLO SANDBOX (HUBSPOT_ENV=sandbox). Aborta en cualquier otro portal.
 *
 * ─── POR QUÉ TRES NEGOCIOS ORIGEN Y NO UNO ───────────────────────────────────
 * El §2 pide "LI-3 con el espejo SELLADO" como si fuera un line item más del
 * mismo original. NO SE PUEDE: `mig_espejo_independiente` es una propiedad del
 * DEAL espejo (dealMirroring.js:378, mirrorLiPuntualSync.js:55), no del line
 * item. Sellar el espejo de LI-3 sellaría también el de LI-1 y LI-2, y los
 * escenarios (a)-(d) dejarían de probar la copia. Por eso LI-3 vive en su
 * propio negocio PY, con su propio espejo, y ése es el que se sella.
 *
 * ─── LAS FECHAS SALEN DEL MOTOR, NO DE ACÁ ───────────────────────────────────
 * Igual que en B+C: los tickets sembrados llevan la clave canónica que calcula
 * Phase P (buildDesiredDates + buildTicketKeyFromLineItemKey). Si no coincide,
 * el motor los toma por ajenos y el escenario no prueba nada.
 *
 * ─── LOS COSTOS SON DIVISIBLES A PROPÓSITO ───────────────────────────────────
 * price del espejo = costo_total_usd ÷ quantity (mirrorLiPropMap.js:155). Con
 * un costo que no divide exacto sale un periódico (33.333333333333336), HubSpot
 * lo redondea al guardarlo y el escenario (i) —convergencia— daría un falso
 * "sigue habiendo diferencias" en cada pasada. Todos los costos de acá dividen
 * exacto.
 *
 * Uso:
 *   node scripts/seed/seedRondaEtapaUnicaDE.mjs --deals    → empresa + 3 deals + 5 line items
 *   node scripts/seed/seedRondaEtapaUnicaDE.mjs --tickets  → los tickets sembrados (tanda E)
 *   node scripts/seed/seedRondaEtapaUnicaDE.mjs --mirrors  → registra los espejos que creó el motor + sella el de LI-3
 *   node scripts/seed/seedRondaEtapaUnicaDE.mjs            → --deals y --tickets
 *   ... --dry                                              → no escribe nada
 *
 * ORDEN DE LA RONDA:
 *   1) --deals  2) --tickets  3) cronDealsBatch sobre los 3 originales
 *   4) --mirrors  5) cronDealsBatch sobre los 2 espejos (para que nazcan sus tickets)
 *
 * Manifest: ronda-de-manifest.json (lo consume snapshotRondaEtapaUnicaDE.mjs)
 */

import 'dotenv/config';
import fs from 'fs';
import { hubspotClient } from '../../src/hubspotClient.js';
import { buildLineItemKey } from '../../src/utils/lineItemKey.js';
import { buildTicketKeyFromLineItemKey } from '../../src/utils/ticketKey.js';
import { buildDesiredDates } from '../../src/phases/phasep.js';
import { buildTicketFullProps, createTicketAssociations, getDealCompanies } from '../../src/services/tickets/ticketService.js';

// ─── Guardas ──────────────────────────────────────────────────────────────────

if (String(process.env.HUBSPOT_ENV || '').toLowerCase() !== 'sandbox') {
  console.error('❌ Este seed es SOLO para sandbox (HUBSPOT_ENV=sandbox). Abortando.');
  process.exit(1);
}

const DRY       = process.argv.includes('--dry');
const ONLY_D    = process.argv.includes('--deals');
const ONLY_T    = process.argv.includes('--tickets');
const ONLY_M    = process.argv.includes('--mirrors');
const ANY_ONLY  = ONLY_D || ONLY_T || ONLY_M;
const DO_DEALS   = ONLY_D || !ANY_ONLY;
const DO_TICKETS = ONLY_T || !ANY_ONLY;
const DO_MIRRORS = ONLY_M;

const PREFIX   = '[RONDA-DE]';
const MANIFEST = 'ronda-de-manifest.json';

// ─── Etapas del pipeline manual 875213463 (sandbox) ───────────────────────────

const PIPE      = process.env.BILLING_TICKET_PIPELINE_ID;   // 875213463
const ST_PROX   = process.env.BILLING_TICKET_STAGE_ID;      // 1311451807 Próximos a facturar
const ST_NOTIF  = process.env.BILLING_TICKET_STAGE_READY;   // 1311451808 Notificado

for (const [k, v] of Object.entries({ PIPE, ST_PROX, ST_NOTIF })) {
  if (!v) { console.error(`❌ Falta el env de etapa: ${k}`); process.exit(1); }
}

// ─── Los negocios ─────────────────────────────────────────────────────────────

const DEALS = {
  origPY: {
    nombre: `${PREFIX} original PY — escenarios (a)(b)(c)(d)(g)(h)(i)(j)(k)`,
    pais: 'Paraguay',
  },
  selloPY: {
    nombre: `${PREFIX} original PY con espejo SELLADO — escenario (e)`,
    pais: 'Paraguay',
  },
  manualE: {
    nombre: `${PREFIX} negocio manual — TANDA E, escenarios (l)(m)(n)(o)(p)`,
    pais: 'Uruguay',
  },
};

// ─── Los line items ───────────────────────────────────────────────────────────
//
// `siembra` describe QUÉ tickets se crean a mano, por ÍNDICE dentro de la lista
// de fechas que devuelve buildDesiredDates (0 = la primera del plan).

const LINE_ITEMS = {
  'LI-1': {
    deal: 'origPY',
    escenarios: '(a)(b)(c)(d)(h)(i)(k) — manual con espejo',
    props: {
      name: `${PREFIX} LI-1 — manual PY con espejo UY`,
      price: '1000', quantity: '2',
      costo_total_usd: '600',            // → price del espejo = 600/2 = 300 exacto
      recurringbillingfrequency: 'monthly',
      hs_recurring_billing_start_date: '2026-08-15',
      hs_recurring_billing_period: 'P4M',
      facturacion_automatica: 'false',
      uy: 'true',
      pais_operativo: 'Paraguay',
      description: 'Descripción ORIGINAL del LI-1 (la que edita el escenario (a))',
    },
    siembra: [],   // los arma el motor
  },
  'LI-2': {
    deal: 'origPY',
    escenarios: '(g) — automático: Phase 3 emite y promueve el ticket UY',
    props: {
      name: `${PREFIX} LI-2 — automático PY con espejo UY`,
      price: '500', quantity: '1',
      costo_total_usd: '200',            // → price del espejo = 200
      recurringbillingfrequency: 'monthly',
      hs_recurring_billing_start_date: '2026-07-20',   // VENCIDA: Phase 3 tiene que emitir
      hs_recurring_billing_period: 'P3M',
      facturacion_automatica: 'true',
      uy: 'true',
      pais_operativo: 'Paraguay',
    },
    siembra: [],
  },
  'LI-3': {
    deal: 'selloPY',
    escenarios: '(e) — el espejo de ESTE negocio se sella con --mirrors',
    props: {
      name: `${PREFIX} LI-3 — manual PY con espejo SELLADO`,
      price: '3000', quantity: '1',
      costo_total_usd: '900',            // → price del espejo = 900
      recurringbillingfrequency: 'monthly',
      hs_recurring_billing_start_date: '2026-08-20',
      hs_recurring_billing_period: 'P3M',
      facturacion_automatica: 'false',
      uy: 'true',
      pais_operativo: 'Paraguay',
      description: 'Descripción ORIGINAL del LI-3 (espejo sellado: NO se copia, sí avisa)',
    },
    siembra: [],
  },
  'LI-E1': {
    deal: 'manualE',
    escenarios: '(l)(m)(n)(p) — pipeline MANUAL: un notificado y uno no notificado',
    props: {
      name: `${PREFIX} LI-E1 — manual (tanda E)`,
      price: '1000', quantity: '1',
      recurringbillingfrequency: 'monthly',
      hs_recurring_billing_start_date: '2026-08-18',
      hs_recurring_billing_period: 'P4M',
      facturacion_automatica: 'false',
    },
    siembra: [
      { idx: 0, stage: ST_NOTIF, nota: 'NOTIFICADO — el que NO se puede tocar (l)(m)' },
      { idx: 1, stage: ST_PROX,  nota: 'Próximos a facturar — el que SÍ se sincroniza (l)(m)(n)' },
    ],
  },
  'LI-E2': {
    deal: 'manualE',
    escenarios: '(o) — pipeline AUTOMÁTICO: no se toca',
    props: {
      name: `${PREFIX} LI-E2 — automático (tanda E)`,
      price: '700', quantity: '1',
      recurringbillingfrequency: 'monthly',
      hs_recurring_billing_start_date: '2026-09-25',
      hs_recurring_billing_period: 'P3M',
      facturacion_automatica: 'true',
    },
    siembra: [],   // los tickets del pipeline automático los arma el motor
  },
};

// Qué negocio origen sella su espejo en --mirrors (escenario (e)).
const DEAL_CON_ESPEJO_SELLADO = 'selloPY';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function loadManifest() {
  if (!fs.existsSync(MANIFEST)) return null;
  return JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
}

function saveManifest(m) {
  if (DRY) return;
  fs.writeFileSync(MANIFEST, JSON.stringify(m, null, 2));
  console.log(`\n💾 Manifest → ${MANIFEST}`);
}

async function crearEmpresa(name) {
  if (DRY) { console.log(`  🔍 [DRY] company: ${name}`); return { id: 'DRY_CO' }; }
  const r = await hubspotClient.crm.companies.basicApi.create({ properties: { name } });
  console.log(`  🏢 company ${r.id} — ${name}`);
  return r;
}

async function crearDeal(props) {
  if (DRY) { console.log(`  🔍 [DRY] deal: ${props.dealname}`); return { id: 'DRY_DEAL' }; }
  const r = await hubspotClient.crm.deals.basicApi.create({ properties: props });
  console.log(`  ✅ deal ${r.id} — ${props.dealname}`);
  return r;
}

async function crearLineItem(props) {
  if (DRY) { console.log(`    🔍 [DRY] LI: ${props.name}`); return { id: 'DRY_LI' }; }
  const r = await hubspotClient.crm.lineItems.basicApi.create({ properties: props });
  console.log(`    📦 LI ${r.id} — ${props.name}`);
  return r;
}

async function asociar(fromType, fromId, toType, toId, typeId) {
  if (DRY) return;
  await hubspotClient.crm.associations.v4.basicApi.create(
    fromType, String(fromId), toType, String(toId),
    [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: typeId }]
  );
}

async function idsAsociados(fromType, fromId, toType) {
  const out = [];
  let after;
  do {
    const r = await hubspotClient.crm.associations.v4.basicApi.getPage(fromType, String(fromId), toType, 100, after);
    for (const x of (r.results || [])) out.push(String(x.toObjectId));
    after = r.paging?.next?.after;
  } while (after);
  return [...new Set(out)];
}

// ═══════════════════════════════════════════════════════════════════════════════
// PASO 1 — empresa + deals + line items
// ═══════════════════════════════════════════════════════════════════════════════

async function pasoDeals() {
  console.log('\n═══ PASO 1 — empresa, negocios y line items ═══');

  const co = await crearEmpresa(`${PREFIX} Cliente de la ronda D+E`);

  const manifest = {
    prefix: PREFIX,
    createdAt: new Date().toISOString(),
    companyId: co.id,
    deals: {},
    lineItems: {},
    mirrors: {},
  };

  for (const [slug, d] of Object.entries(DEALS)) {
    const deal = await crearDeal({
      dealname: d.nombre,
      dealstage: process.env.DEAL_STAGE_CLOSED_WON || 'closedwon',
      pipeline: process.env.DEAL_PIPELINE_ID || 'default',
      facturacion_activa: 'true',
      pais_operativo: d.pais,
    });
    await asociar('companies', co.id, 'deals', deal.id, 342);
    manifest.deals[slug] = { id: deal.id, nombre: d.nombre, pais: d.pais };
  }

  for (const [slug, def] of Object.entries(LINE_ITEMS)) {
    const dealId = manifest.deals[def.deal].id;
    const li = await crearLineItem({ facturacion_activa: 'true', ...def.props });
    await asociar('line_items', li.id, 'deals', dealId, 20);

    const lik = DRY ? `${dealId}:${li.id}:dry` : buildLineItemKey({ dealId, lineItemIdOriginal: li.id });
    if (!DRY) {
      await hubspotClient.crm.lineItems.basicApi.update(String(li.id), { properties: { line_item_key: lik } });
    }
    console.log(`       line_item_key = ${lik}`);

    manifest.lineItems[slug] = {
      id: li.id, dealSlug: def.deal, dealId, lineItemKey: lik,
      escenarios: def.escenarios, nombre: def.props.name, tickets: [],
    };
  }

  saveManifest(manifest);
  return manifest;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PASO 2 — los tickets sembrados, sobre las fechas que calcula el motor
// ═══════════════════════════════════════════════════════════════════════════════

async function pasoTickets(manifest) {
  console.log('\n═══ PASO 2 — tickets sembrados (fechas calculadas por el motor) ═══');

  for (const [slug, def] of Object.entries(LINE_ITEMS)) {
    const entry = manifest.lineItems[slug];
    if (!entry) { console.warn(`  ⚠️  ${slug} no está en el manifest, salteado`); continue; }
    if (!def.siembra.length) { console.log(`\n  ${slug} — sin tickets a sembrar (los arma el motor)`); continue; }

    const dealId = entry.dealId;
    const deal = DRY ? { properties: {} } : await hubspotClient.crm.deals.basicApi.getById(String(dealId), ['dealname', 'of_pais_operativo', 'pais_operativo', 'dealstage']);
    const lineItem = DRY
      ? { id: entry.id, properties: def.props }
      : await hubspotClient.crm.lineItems.basicApi.getById(String(entry.id), [
          'name', 'price', 'quantity', 'amount', 'recurringbillingfrequency',
          'hs_recurring_billing_start_date', 'hs_recurring_billing_number_of_payments',
          'line_item_key', 'unidad_de_negocio', 'servicio', 'hs_product_id',
          'facturacion_automatica', 'facturacion_activa', 'mig_migracion_historica',
        ]);

    const { dates } = buildDesiredDates(lineItem, []);
    console.log(`\n  ${slug} — fechas del motor: ${dates.slice(0, 6).join(', ')}${dates.length > 6 ? ' …' : ''}`);

    const companies = DRY ? [] : await getDealCompanies(dealId);

    for (const s of def.siembra) {
      const ymd = dates[s.idx];
      if (!ymd) { console.warn(`    ⚠️  ${slug} idx ${s.idx} sin fecha, salteado`); continue; }

      const ticketKey = buildTicketKeyFromLineItemKey(dealId, entry.lineItemKey, ymd);

      if (DRY) {
        console.log(`    🔍 [DRY] ticket ${ymd} · etapa ${s.stage} · ${s.nota}`);
        console.log(`             key = ${ticketKey}`);
        continue;
      }

      const props = await buildTicketFullProps({
        deal, lineItem, dealId, lineItemId: entry.id,
        lineItemKey: entry.lineItemKey, ticketKey, expectedYMD: ymd,
      });

      const t = await hubspotClient.crm.tickets.basicApi.create({
        properties: {
          ...props,
          hs_pipeline: PIPE,
          hs_pipeline_stage: s.stage,
          ...(s.extra || {}),
        },
      });
      await createTicketAssociations(String(t.id), String(dealId), String(entry.id), companies, []);

      console.log(`    🎫 ${t.id} · ${ymd} · etapa ${s.stage} · ${s.nota}`);
      entry.tickets.push({ id: t.id, fecha: ymd, stageSembrada: s.stage, nota: s.nota, ticketKey });
    }
  }

  saveManifest(manifest);
  return manifest;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PASO 3 — registrar los espejos que creó el motor y SELLAR el de LI-3
// ═══════════════════════════════════════════════════════════════════════════════
//
// Se corre DESPUÉS de la primera pasada del motor sobre los negocios PY: el
// espejo lo crea Phase 1 (dealMirroring.mirrorDealToUruguay), no este seed.

async function pasoMirrors(manifest) {
  console.log('\n═══ PASO 3 — espejos creados por el motor ═══');

  manifest.mirrors ||= {};

  for (const [slug, d] of Object.entries(manifest.deals)) {
    if (DEALS[slug]?.pais !== 'Paraguay') continue;

    const py = await hubspotClient.crm.deals.basicApi.getById(String(d.id), ['deal_uy_mirror_id', 'pais_operativo', 'dealname']);
    const mirrorDealId = String(py.properties?.deal_uy_mirror_id || '').trim();

    console.log(`\n▸ ${slug} (deal ${d.id}) — pais_operativo=${py.properties?.pais_operativo}`);
    if (!mirrorDealId) {
      console.warn('   ⚠️  todavía SIN deal_uy_mirror_id — ¿corriste el motor sobre este negocio?');
      continue;
    }
    console.log(`   espejo UY = ${mirrorDealId}`);

    // Line items del espejo, mapeados a su origen PY.
    const uyIds = await idsAsociados('deals', mirrorDealId, 'line_items');
    const lis = uyIds.length
      ? (await hubspotClient.crm.lineItems.batchApi.read({
          inputs: uyIds.map(id => ({ id })),
          properties: ['name', 'price', 'quantity', 'of_line_item_py_origen_id', 'line_item_key', 'description'],
        })).results || []
      : [];

    const porOrigen = {};
    for (const li of lis) {
      const origen = String(li.properties?.of_line_item_py_origen_id || '').trim();
      if (!origen) continue;
      porOrigen[origen] = {
        id: String(li.id),
        lineItemKey: li.properties?.line_item_key || '',
        price: li.properties?.price,
        quantity: li.properties?.quantity,
      };
      console.log(`     LI espejo ${li.id}  ← PY ${origen}  price=${li.properties?.price} qty=${li.properties?.quantity}`);
    }

    // Enganchar cada LI del manifest con su espejo.
    for (const [ls, entry] of Object.entries(manifest.lineItems)) {
      if (entry.dealSlug !== slug) continue;
      const esp = porOrigen[String(entry.id)];
      if (esp) {
        entry.mirrorLineItemId = esp.id;
        entry.mirrorLineItemKey = esp.lineItemKey;
        console.log(`     ${ls} → espejo LI ${esp.id}`);
      } else {
        console.warn(`     ⚠️  ${ls} (LI ${entry.id}) todavía sin espejo`);
      }
    }

    const sellado = slug === DEAL_CON_ESPEJO_SELLADO;
    manifest.mirrors[slug] = { mirrorDealId, sellado, lineItems: porOrigen };

    if (sellado) {
      if (DRY) {
        console.log(`   🔍 [DRY] sellaría el espejo ${mirrorDealId} (mig_espejo_independiente=true)`);
      } else {
        await hubspotClient.crm.deals.basicApi.update(String(mirrorDealId), {
          properties: { mig_espejo_independiente: 'true' },
        });
        console.log(`   🔒 espejo ${mirrorDealId} SELLADO (mig_espejo_independiente=true) — escenario (e)`);
      }
    }
  }

  saveManifest(manifest);
  return manifest;
}

// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  SEED RONDA D+E ${DRY ? '(DRY RUN)' : '— sandbox 51101688'}`);
  console.log('═══════════════════════════════════════════════════════════');

  let manifest = DO_DEALS ? await pasoDeals() : loadManifest();
  if (!manifest) { console.error(`❌ No existe ${MANIFEST}. Corré primero con --deals.`); process.exit(1); }
  if (DO_TICKETS) manifest = await pasoTickets(manifest);
  if (DO_MIRRORS) manifest = await pasoMirrors(manifest);

  console.log('\n═══ RESUMEN ═══');
  for (const [slug, d] of Object.entries(manifest.deals)) {
    console.log(`\n${slug.padEnd(9)} deal ${d.id} — ${d.nombre}`);
    console.log(`          node src/jobs/cronDealsBatch.js --deal ${d.id}`);
    const esp = manifest.mirrors?.[slug];
    if (esp) console.log(`          espejo UY ${esp.mirrorDealId}${esp.sellado ? '  🔒 SELLADO' : ''}`);
    for (const [ls, li] of Object.entries(manifest.lineItems)) {
      if (li.dealSlug !== slug) continue;
      console.log(`   └─ ${ls.padEnd(6)} LI ${li.id}${li.mirrorLineItemId ? ` → espejo ${li.mirrorLineItemId}` : ''} — ${li.escenarios} — ${li.tickets.length} ticket(s) sembrado(s)`);
    }
  }

  if (!DO_MIRRORS) {
    console.log('\n👉 Ahora: correr el motor sobre los negocios PY y después `--mirrors`.');
  }
}

main().catch(err => {
  console.error('❌ Error fatal:', err.message);
  if (err.response?.data) console.error(JSON.stringify(err.response.data, null, 2));
  if (err.body) console.error(JSON.stringify(err.body, null, 2));
  process.exit(1);
});
