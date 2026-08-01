#!/usr/bin/env node
/**
 * seedRondaEtapaUnicaBC.mjs
 *
 * SEED de la ronda de sandbox que valida las TANDAS B + C juntas
 * (llave ETAPA_UNICA_ENABLED). Guion: definitivos/PLAN_ronda_sandbox_etapa_unica_BC.md §2.
 *
 * ⚠️ SOLO SANDBOX (HUBSPOT_ENV=sandbox). Aborta en cualquier otro portal.
 *
 * ─── POR QUÉ TRES NEGOCIOS Y NO UNO ───────────────────────────────────────────
 * El plan pide "un solo negocio con cinco line items". Dos escenarios no entran
 * ahí y se separan a propósito:
 *   · (e) espejo → necesita el NEGOCIO en Paraguay (el espejado es a nivel deal,
 *     no de line item). Meterlo en el principal volvería PY a LI-A/B/C/E.
 *   · (f) llave APAGADA → el plan mismo dice "correr el motor sobre un negocio
 *     EQUIVALENTE". Si se corriera sobre el principal, ya vendría tocado por las
 *     corridas con la llave prendida y no probaría nada.
 *
 * ─── LAS FECHAS SALEN DEL MOTOR, NO DE ACÁ ────────────────────────────────────
 * Los tickets sembrados tienen que llevar la clave canónica que Phase P calcula
 * para esa fecha, o el motor los toma por ajenos y el escenario no prueba nada.
 * Por eso el paso --tickets NO inventa fechas: llama a buildDesiredDates() del
 * propio motor y siembra sobre las que salgan.
 *
 * 📌 Ojo con LI-A: arranca el 2026-01-31 pero SIN momento_de_facturacion =
 *    'fin_de_mes', así que addInterval colapsa al día 28 después de febrero
 *    (ene-31, feb-28, mar-28, abr-28…). El plan anticipaba 2026-03-31 para la
 *    última notificada; el número real es 2026-03-28. No cambia ningún criterio
 *    de la ronda (los tres que importan —12 y no 13, el piso, pagos_restantes=9—
 *    no dependen del día del mes).
 *
 * Uso:
 *   node scripts/seed/seedRondaEtapaUnicaBC.mjs --deals     → empresa + 3 deals + line items
 *   node scripts/seed/seedRondaEtapaUnicaBC.mjs --tickets   → los tickets sembrados
 *   node scripts/seed/seedRondaEtapaUnicaBC.mjs             → los dos pasos
 *   ... --dry                                               → no escribe nada
 *
 * Manifest: ronda-bc-manifest.json (lo consume snapshotRondaEtapaUnicaBC.mjs)
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

const DRY      = process.argv.includes('--dry');
const ONLY_D   = process.argv.includes('--deals');
const ONLY_T   = process.argv.includes('--tickets');
const DO_DEALS   = ONLY_D || !ONLY_T;
const DO_TICKETS = ONLY_T || !ONLY_D;

const PREFIX   = '[RONDA-BC]';
const MANIFEST = 'ronda-bc-manifest.json';

// ─── Etapas del pipeline manual 875213463 (sandbox) ───────────────────────────

const PIPE      = process.env.BILLING_TICKET_PIPELINE_ID;   // 875213463
const ST_85     = process.env.BILLING_TICKET_FORECAST_85;   // 1330250642
const ST_95     = process.env.BILLING_TICKET_FORECAST_95;   // 1311451806
const ST_PROX   = process.env.BILLING_TICKET_STAGE_ID;      // 1311451807 Próximos a facturar
const ST_NOTIF  = process.env.BILLING_TICKET_STAGE_READY;   // 1311451808 Notificado
const ST_EMIT   = '1311451809';                             // Emitido

for (const [k, v] of Object.entries({ PIPE, ST_85, ST_95, ST_PROX, ST_NOTIF })) {
  if (!v) { console.error(`❌ Falta el env de etapa: ${k}`); process.exit(1); }
}

// ─── Definición de los line items ─────────────────────────────────────────────
//
// `siembra` describe QUÉ tickets se crean a mano, por ÍNDICE dentro de la lista
// de fechas que devuelve buildDesiredDates (0 = la primera del plan).

const LINE_ITEMS = {
  'LI-A': {
    deal: 'principal',
    escenarios: '(a) y (c)',
    props: {
      name: `${PREFIX} LI-A — plan fijo 12 mensual desde 2026-01-31`,
      price: '1000', quantity: '1',
      recurringbillingfrequency: 'monthly',
      hs_recurring_billing_start_date: '2026-01-31',
      hs_recurring_billing_period: 'P12M',   // NO 'hs_recurring_billing_number_of_payments': es calculada y readOnly
      facturacion_automatica: 'false',
    },
    siembra: [
      { idx: 0, stage: ST_EMIT,  nota: 'EMITIDO 1' },
      { idx: 1, stage: ST_EMIT,  nota: 'EMITIDO 2' },
      { idx: 2, stage: ST_NOTIF, nota: 'Notificado' },
      { idx: 3, stage: ST_PROX,  nota: 'Próximos (el que NO se puede perder — hallazgo #1)' },
    ],
  },
  'LI-B': {
    deal: 'principal',
    escenarios: '(b) — se le cambia la frecuencia',
    props: {
      name: `${PREFIX} LI-B — plan fijo 6 mensual`,
      price: '2000', quantity: '1',
      recurringbillingfrequency: 'monthly',
      hs_recurring_billing_start_date: '2026-06-30',
      hs_recurring_billing_period: 'P6M',
      facturacion_automatica: 'false',
    },
    siembra: [
      { idx: 0, stage: ST_NOTIF, nota: 'Notificado — no se toca en (b)' },
    ],
  },
  'LI-C': {
    deal: 'principal',
    escenarios: '(d) — migrado',
    props: {
      name: `${PREFIX} LI-C — plan fijo 12 MIGRADO`,
      price: '3000', quantity: '1',
      recurringbillingfrequency: 'monthly',
      hs_recurring_billing_start_date: '2026-08-15',
      hs_recurring_billing_period: 'P12M',   // NO 'hs_recurring_billing_number_of_payments': es calculada y readOnly
      facturacion_automatica: 'false',
      mig_migracion_historica: 'true',
    },
    siembra: [
      { idx: 0, stage: ST_PROX, nota: 'migrado 1', extra: { mig_emision_historica: 'true' } },
      { idx: 1, stage: ST_PROX, nota: 'migrado 2', extra: { mig_emision_historica: 'true' } },
      { idx: 2, stage: ST_PROX, nota: 'migrado 3', extra: { mig_emision_historica: 'true' } },
    ],
  },
  'LI-D': {
    deal: 'espejoPY',
    escenarios: '(e) — original PY de un par espejo',
    props: {
      name: `${PREFIX} LI-D — original PY con espejo UY`,
      price: '4000', quantity: '1',
      recurringbillingfrequency: 'monthly',
      hs_recurring_billing_start_date: '2026-08-20',
      hs_recurring_billing_period: 'P6M',
      facturacion_automatica: 'false',
      uy: 'true',
      pais_operativo: 'Paraguay',
    },
    // El ticket UY lo promueve mirrorUtils; acá no se siembra nada a mano.
    siembra: [],
  },
  'LI-E': {
    deal: 'principal',
    escenarios: 'reubicación de los 85/95 (§2.8-3)',
    props: {
      name: `${PREFIX} LI-E — plan fijo 12 con 2 tickets parados en 85/95`,
      price: '5000', quantity: '1',
      recurringbillingfrequency: 'monthly',
      hs_recurring_billing_start_date: '2026-09-10',
      hs_recurring_billing_period: 'P12M',   // NO 'hs_recurring_billing_number_of_payments': es calculada y readOnly
      facturacion_automatica: 'false',
    },
    siembra: [
      { idx: 0, stage: ST_85, nota: 'parado en 85% Forecast' },
      { idx: 1, stage: ST_95, nota: 'parado en 95% Forecast' },
    ],
  },
  'LI-F': {
    deal: 'controlOFF',
    escenarios: '(f) — llave APAGADA, negocio equivalente a LI-A',
    props: {
      name: `${PREFIX} LI-F — clon de LI-A para la corrida con la llave OFF`,
      price: '1000', quantity: '1',
      recurringbillingfrequency: 'monthly',
      hs_recurring_billing_start_date: '2026-01-31',
      hs_recurring_billing_period: 'P12M',   // NO 'hs_recurring_billing_number_of_payments': es calculada y readOnly
      facturacion_automatica: 'false',
    },
    siembra: [
      { idx: 0, stage: ST_EMIT,  nota: 'EMITIDO 1' },
      { idx: 1, stage: ST_EMIT,  nota: 'EMITIDO 2' },
      { idx: 2, stage: ST_NOTIF, nota: 'Notificado' },
      { idx: 3, stage: ST_PROX,  nota: 'Próximos' },
    ],
  },
};

const DEALS = {
  principal:  { nombre: `${PREFIX} principal — escenarios (a)(b)(c)(d) + reubicación`, pais: 'Uruguay' },
  espejoPY:   { nombre: `${PREFIX} espejo PY — escenario (e)`,                          pais: 'Paraguay' },
  controlOFF: { nombre: `${PREFIX} control llave OFF — escenario (f)`,                  pais: 'Uruguay' },
};

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

// ═══════════════════════════════════════════════════════════════════════════════
// PASO 1 — empresa + deals + line items
// ═══════════════════════════════════════════════════════════════════════════════

async function pasoDeals() {
  console.log('\n═══ PASO 1 — empresa, negocios y line items ═══');

  const co = await crearEmpresa(`${PREFIX} Cliente de la ronda B+C`);

  const manifest = {
    prefix: PREFIX,
    createdAt: new Date().toISOString(),
    companyId: co.id,
    deals: {},
    lineItems: {},
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

    // line_item_key: la ponemos nosotros (mismo formato que ensureLineItemKey)
    // para que las claves de ticket se puedan calcular antes de correr el motor.
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

    // Las fechas del plan, tal como las calcula Phase P (sin tickets previos).
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

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  SEED RONDA B+C ${DRY ? '(DRY RUN)' : '— sandbox 51101688'}`);
  console.log('═══════════════════════════════════════════════════════════');

  let manifest = DO_DEALS ? await pasoDeals() : loadManifest();
  if (!manifest) { console.error(`❌ No existe ${MANIFEST}. Corré primero con --deals.`); process.exit(1); }
  if (DO_TICKETS) manifest = await pasoTickets(manifest);

  console.log('\n═══ RESUMEN ═══');
  for (const [slug, d] of Object.entries(manifest.deals)) {
    console.log(`\n${slug.padEnd(11)} deal ${d.id} — ${d.nombre}`);
    console.log(`            node src/jobs/cronDealsBatch.js --deal ${d.id}`);
    for (const [ls, li] of Object.entries(manifest.lineItems)) {
      if (li.dealSlug !== slug) continue;
      console.log(`   └─ ${ls} LI ${li.id} — ${li.escenarios} — ${li.tickets.length} ticket(s) sembrado(s)`);
    }
  }
}

main().catch(err => {
  console.error('❌ Error fatal:', err.message);
  if (err.response?.data) console.error(JSON.stringify(err.response.data, null, 2));
  if (err.body) console.error(JSON.stringify(err.body, null, 2));
  process.exit(1);
});
