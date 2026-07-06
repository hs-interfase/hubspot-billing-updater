// scripts/fix/recalcContadores.mjs
//
// Corre el MOTOR NUEVO de Phase R (recalcContadores) de forma PUNTUAL sobre uno
// o varios deals, SIN activar Phase R en el flujo automático del motor.
//
// Recalcula los contadores derivados de cada line item desde el estado real de
// sus tickets, en UNA búsqueda por line_item_key:
//   - facturas_restantes, facturas_por_derivar, progreso_pagos (cosméticos)
//   - fechas_completas (reconciliado BIDIRECCIONALMENTE: sella y des-sella)
//
// A diferencia de recalcProgresoPagos.mjs (que usa los writers viejos), este
// usa el motor real recalcContadores, así que SÍ ejercita el des-sellado.
//
// PRUDENCIA:
//   * Por defecto corre en DRY: NO escribe, solo reporta qué cambiaría.
//   * --apply escribe (usa el motor con dryRun=false).
//   * --all --apply exige además --yes (escritura masiva).
//
// USO:
//   node scripts/fix/recalcContadores.mjs --deal 123456            # dry, un deal
//   node scripts/fix/recalcContadores.mjs --deal 123456 --apply    # escribe ese deal
//   node scripts/fix/recalcContadores.mjs --all --limit 20         # dry, primeros 20
//   node scripts/fix/recalcContadores.mjs --all --apply --yes      # escribe TODOS (cuidado)

import 'dotenv/config';
import { hubspotClient, getDealWithLineItems } from '../../src/hubspotClient.js';
import { recalcContadores } from '../../src/services/billing/recalcContadores.js';

// -------------------- args --------------------
function parseArgs(argv) {
  const a = { deal: null, all: false, apply: false, yes: false, limit: 0, pause: 200 };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--deal') a.deal = argv[++i] || null;
    else if (x === '--all') a.all = true;
    else if (x === '--apply') a.apply = true;
    else if (x === '--yes') a.yes = true;
    else if (x === '--limit') a.limit = Number(argv[++i] || 0) || 0;
    else if (x === '--pause') a.pause = Number(argv[++i] || 200) || 0;
  }
  return a;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (v) => String(v ?? '').trim();

const stats = { deals: 0, lineItems: 0, sinLik: 0, conCambios: 0, aplicados: 0, errores: 0, sellados: 0, dessellados: 0 };

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

function describeDiff(update) {
  return Object.entries(update).map(([k, v]) => `${k} → "${v}"`).join('  |  ');
}

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
    const liId = String(li.id || p.hs_object_id || '');
    const liName = p.name || liId;
    const lik = norm(p.line_item_key);

    if (!liId || !lik) {
      stats.sinLik++;
      console.log(`   - LI ${liName}: sin line_item_key, skip`);
      continue;
    }

    let res;
    try {
      res = await recalcContadores({ hubspotClient, lineItemId: liId, dealId, dryRun: !apply });
    } catch (err) {
      stats.errores++;
      console.log(`   - LI ${liName}: ERROR: ${err?.message || err}`);
      continue;
    }

    const tag = `[${res.mode}] emitidos=${res.counts?.invoiced} derived=${res.counts?.derived}`;
    const changes = res.update || {};
    if (Object.keys(changes).length === 0) {
      console.log(`   - LI ${liName}: OK, sin desfase  ${tag}`);
      continue;
    }

    stats.conCambios++;
    if (apply) stats.aplicados++;
    if ('fechas_completas' in changes) {
      if (changes.fechas_completas === 'true') stats.sellados++;
      else stats.dessellados++;
    }

    const accion = apply ? '✓ aplicado' : 'DRY (no escribe)';
    const sello = 'fechas_completas' in changes
      ? (changes.fechas_completas === 'true' ? '  [SELLA]' : '  [DES-SELLA]')
      : '';
    console.log(`   - LI ${liName}: CAMBIO  ${tag}${sello}`);
    console.log(`        ${describeDiff(changes)}`);
    console.log(`        ${accion}`);
  }
}

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
  console.log(` recalcContadores (motor Phase R) — MODO: ${args.apply ? 'APPLY (ESCRIBE)' : 'DRY (solo lectura)'}`);
  console.log(` destino: ${args.deal ? `deal ${args.deal}` : `TODOS los deals${args.limit ? ` (límite ${args.limit})` : ''}`}`);
  console.log('========================================================');

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
  console.log(`Con cambios:          ${stats.conCambios}  (sella ${stats.sellados} / des-sella ${stats.dessellados})`);
  console.log(`Aplicados:            ${args.apply ? stats.aplicados : '0 (modo DRY)'}`);
  console.log(`Errores:              ${stats.errores}`);
  console.log('===========================================================');
  if (!args.apply && stats.conCambios > 0) {
    console.log('Para aplicar estos cambios, volvé a correr con --apply.');
  }
}

main().catch((err) => {
  console.error('Fatal:', err?.stack || err?.message || err);
  process.exitCode = 1;
});
