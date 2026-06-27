// scripts/fix/recalcProgresoPagos.mjs
//
// Recalcula los CONTADORES DE PROGRESO de pagos de los line items:
//   - facturas_restantes   (total - tickets EMITIDOS/INVOICED)
//   - facturas_por_derivar (total - tickets DERIVED = READY + INVOICED)
//   - progreso_pagos       (la barra "███░░ 3 / 12")
//
// POR QUÉ EXISTE:
//   Estos 3 campos solo se recalculan cuando ocurre un EVENTO real de
//   facturación (emisión / cambio de etapa de ticket / cancelación). NI
//   "Actualizar" NI el cron nocturno los recomputan. Por eso, si se clona un
//   negocio de 12 pagos y se edita el clon a 6, el progreso queda desfasado
//   hasta la próxima emisión. Este script los pone al día de forma controlada.
//
// PRUDENCIA (lo importante):
//   * Por defecto corre en modo DRY: NO escribe nada, solo reporta el desfase.
//   * Para escribir hay que pasar --apply de forma explícita.
//   * Para escribir sobre TODOS los negocios (--all --apply) exige además --yes.
//   * Cuando aplica, NO reinventa el cálculo: delega en las MISMAS funciones de
//     producción (syncBillingState + recalcDerivedFacturas), que son
//     idempotentes (solo escriben si el valor realmente cambió).
//
// USO:
//   node scripts/fix/recalcProgresoPagos.mjs --deal 123456            # dry, un negocio
//   node scripts/fix/recalcProgresoPagos.mjs --deal 123456 --apply    # escribe ese negocio
//   node scripts/fix/recalcProgresoPagos.mjs --all                    # dry, todos
//   node scripts/fix/recalcProgresoPagos.mjs --all --limit 50         # dry, primeros 50
//   node scripts/fix/recalcProgresoPagos.mjs --all --apply --yes      # escribe TODOS (cuidado)

import 'dotenv/config';
import { hubspotClient, getDealWithLineItems } from '../../src/hubspotClient.js';
import {
  syncBillingState,
  buildPagoDisplay,
} from '../../src/services/billing/syncBillingState.js';
import { recalcDerivedFacturas } from '../../src/services/billing/recalcDerivedFacturas.js';
import { isAutoRenew } from '../../src/services/billing/mode.js';
import { INVOICED_STAGES, DERIVED_STAGES } from '../../src/config/constants.js';

// -------------------- args --------------------
function parseArgs(argv) {
  const a = { deal: null, all: false, apply: false, yes: false, limit: 0, pause: 200 };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--deal') { a.deal = argv[++i] || null; }
    else if (x === '--all') { a.all = true; }
    else if (x === '--apply') { a.apply = true; }
    else if (x === '--yes') { a.yes = true; }
    else if (x === '--limit') { a.limit = Number(argv[++i] || 0) || 0; }
    else if (x === '--pause') { a.pause = Number(argv[++i] || 200) || 0; }
  }
  return a;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (v) => String(v ?? '').trim();

// -------------------- helpers --------------------

// Trae todos los tickets del LIK y cuenta EMITIDOS (INVOICED) y DERIVED en una
// sola búsqueda. Mismo filtro/limite que usan las funciones de producción
// (of_line_item_key, limit 100, sin paginar).
async function countTicketsForLIK(lik) {
  const resp = await hubspotClient.crm.tickets.searchApi.doSearch({
    filterGroups: [{ filters: [{ propertyName: 'of_line_item_key', operator: 'EQ', value: lik }] }],
    properties: ['hs_pipeline_stage'],
    limit: 100,
  });
  const tickets = resp?.results ?? [];
  let invoiced = 0;
  let derived = 0;
  for (const t of tickets) {
    const stage = String(t.properties?.hs_pipeline_stage || '');
    if (INVOICED_STAGES.has(stage)) invoiced++;
    if (DERIVED_STAGES.has(stage)) derived++;
  }
  return { total: tickets.length, invoiced, derived };
}

// Reproduce EXACTAMENTE la lógica de cuotasTotales de recalcFacturasRestantes /
// recalcDerivedFacturas para poder mostrar el "esperado" sin escribir nada.
function computeExpected(props, counts) {
  if (isAutoRenew({ properties: props })) {
    // AUTO_RENEW: los 3 contadores van vacíos.
    return { mode: 'AUTO_RENEW', restantes: '', porDerivar: '', progreso: '' };
  }

  let total = Number.parseInt(norm(props.hs_recurring_billing_number_of_payments), 10);
  const freq = norm(props.recurringbillingfrequency || props.hs_recurring_billing_frequency);

  // PAGO ÚNICO: sin total y sin frecuencia → se trata como plan de 1 cuota.
  if ((!Number.isFinite(total) || total <= 0) && !freq) total = 1;

  // Sin total utilizable → contadores vacíos (igual que los writers).
  if (!Number.isFinite(total) || total <= 0) {
    return { mode: 'SIN_TOTAL', restantes: '', porDerivar: '', progreso: '' };
  }

  const restantes = Math.max(0, total - counts.invoiced);
  const porDerivar = Math.max(0, total - counts.derived);
  const progreso = buildPagoDisplay(counts.invoiced, total);
  return {
    mode: 'PLAN_FIJO',
    total,
    restantes: String(restantes),
    porDerivar: String(porDerivar),
    progreso,
  };
}

async function getAllDealIds() {
  const out = [];
  let after;
  do {
    const resp = await hubspotClient.crm.deals.basicApi.getPage(100, after, ['dealname'], undefined, false);
    out.push(...(resp.results || []).map((d) => String(d.id)));
    after = resp.paging?.next?.after;
  } while (after);
  return out;
}

// -------------------- core --------------------
const stats = { deals: 0, lineItems: 0, sinLik: 0, conDesfase: 0, aplicados: 0, errores: 0 };

async function processDeal(dealId, { apply }) {
  const { deal, lineItems } = await getDealWithLineItems(dealId);
  const dealName = deal?.properties?.dealname || dealId;
  if (!Array.isArray(lineItems) || lineItems.length === 0) {
    console.log(`· Deal ${dealId} (${dealName}): sin line items, skip`);
    return;
  }
  stats.deals++;
  console.log(`\n■ Deal ${dealId} — ${dealName}`);

  for (const li of lineItems) {
    stats.lineItems++;
    const p = li.properties || {};
    const lik = norm(p.line_item_key);
    const liId = String(li.id);
    const liName = p.name || liId;

    if (!lik) {
      stats.sinLik++;
      console.log(`   - LI ${liId} (${liName}): sin line_item_key, skip`);
      continue;
    }

    let counts;
    try {
      counts = await countTicketsForLIK(lik);
    } catch (err) {
      stats.errores++;
      console.log(`   - LI ${liId} (${liName}): ERROR contando tickets: ${err?.message || err}`);
      continue;
    }

    const exp = computeExpected(p, counts);

    const cur = {
      restantes: norm(p.facturas_restantes),
      porDerivar: norm(p.facturas_por_derivar),
      progreso: norm(p.progreso_pagos),
    };

    const drift = [];
    if (cur.restantes !== norm(exp.restantes)) drift.push(`facturas_restantes: "${cur.restantes}" → "${exp.restantes}"`);
    if (cur.porDerivar !== norm(exp.porDerivar)) drift.push(`facturas_por_derivar: "${cur.porDerivar}" → "${exp.porDerivar}"`);
    if (cur.progreso !== norm(exp.progreso)) drift.push(`progreso_pagos: "${cur.progreso}" → "${exp.progreso}"`);

    const tag = `[${exp.mode}] tickets: emitidos=${counts.invoiced} derived=${counts.derived} total_plan=${exp.total ?? '—'}`;

    if (drift.length === 0) {
      console.log(`   - LI ${liId} (${liName}): OK, sin desfase  ${tag}`);
      continue;
    }

    stats.conDesfase++;
    console.log(`   - LI ${liId} (${liName}): DESFASE  ${tag}`);
    for (const d of drift) console.log(`        ${d}`);

    if (!apply) continue;

    // APPLY: delegamos en las funciones reales de producción (idempotentes).
    try {
      await syncBillingState({ hubspotClient, lineItemId: liId, dealId, dealIsCanceled: false });
      await recalcDerivedFacturas({ hubspotClient, lineItemId: liId, dealId });
      stats.aplicados++;
      console.log(`        ✓ aplicado`);
    } catch (err) {
      stats.errores++;
      console.log(`        ✗ ERROR aplicando: ${err?.message || err}`);
    }
  }
}

// -------------------- main --------------------
async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.deal && !args.all) {
    console.error('Falta destino: usá --deal <ID> o --all. (--apply para escribir; sin él es DRY)');
    process.exitCode = 1;
    return;
  }
  if (args.all && args.apply && !args.yes) {
    console.error('Seguridad: --all --apply requiere también --yes para confirmar escritura masiva.');
    process.exitCode = 1;
    return;
  }

  console.log('========================================================');
  console.log(` recalcProgresoPagos — MODO: ${args.apply ? 'APPLY (ESCRIBE)' : 'DRY (solo lectura)'}`);
  console.log(` destino: ${args.deal ? `deal ${args.deal}` : `TODOS los deals${args.limit ? ` (límite ${args.limit})` : ''}`}`);
  console.log('========================================================');
  if (args.apply) {
    console.log('Nota: al aplicar, syncBillingState también puede ajustar billing_next_date');
    console.log('      en líneas auto-renew (mismo comportamiento que producción).');
  }

  let ids;
  if (args.deal) {
    ids = [String(args.deal)];
  } else {
    console.log('Listando todos los deals...');
    ids = await getAllDealIds();
    if (args.limit > 0) ids = ids.slice(0, args.limit);
    console.log(`Total a recorrer: ${ids.length}`);
  }

  for (const id of ids) {
    try {
      await processDeal(id, { apply: args.apply });
    } catch (err) {
      stats.errores++;
      console.log(`■ Deal ${id}: ERROR: ${err?.message || err}`);
    }
    if (args.pause > 0) await sleep(args.pause);
  }

  console.log('\n========================= RESUMEN =========================');
  console.log(`Deals procesados:     ${stats.deals}`);
  console.log(`Line items revisados: ${stats.lineItems}`);
  console.log(`Sin line_item_key:    ${stats.sinLik}`);
  console.log(`Con desfase:          ${stats.conDesfase}`);
  console.log(`Aplicados:            ${args.apply ? stats.aplicados : '0 (modo DRY)'}`);
  console.log(`Errores:              ${stats.errores}`);
  console.log('===========================================================');
  if (!args.apply && stats.conDesfase > 0) {
    console.log('Para corregir estos desfases, volvé a correr con --apply.');
  }
}

main().catch((err) => {
  console.error('Fatal:', err?.stack || err?.message || err);
  process.exitCode = 1;
});
