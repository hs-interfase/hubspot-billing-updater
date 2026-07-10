#!/usr/bin/env node
/**
 * cleanupMirrorsStack.mjs — 2026-07-05
 *
 * Borra el STACK de mirrors para poder rearmarlo: cada PAR completo
 *   PY (negocio Paraguay) + su mirror UY + sus TICKETS + FACTURAS + LINE ITEMS.
 *
 * Ubica los pares por DOS fuentes (unión, dedup):
 *   (1) BARRIDO  es_mirror_de_py=true  → cada mirror + su deal_py_origen_id (el PY).
 *   (2) JSON de TWINS (twinsApartados, opcional `--twins <ruta>`): por cada twin resuelve
 *       el/los PY por id_crm_origen (origenPY + ramasPY) y su mirror (deal_uy_mirror_id
 *       o fallback search es_mirror_de_py + deal_py_origen_id). Atrapa PY cuyo mirror aún
 *       no exista y viceversa.
 *
 * Borrado por deal con MATCH DE KEY (no solo los asociados):
 *   - TICKETS: unión de  search of_deal_id = <dealId>  (key match → huérfanos incluidos)
 *              + asociación CRM deals→tickets.
 *   - FACTURAS: of_invoice_id del ticket (key) + asoc tickets→invoices + asoc deals→invoices.
 *   - LINE ITEMS: asoc deals→line_items.
 *   Orden de archivado: invoices → tickets → line items → deal.
 *
 * SEGURIDAD: DRY por defecto (solo cuenta y lista). Para borrar de verdad: --execute
 *   (+ --confirm-production si HUBSPOT_ENV no es sandbox/test/dev — ver guardProduction).
 *
 * Uso (raíz del repo, .env del portal objetivo):
 *   node scripts/cleanup/cleanupMirrorsStack.mjs                                  # DRY, solo barrido
 *   node scripts/cleanup/cleanupMirrorsStack.mjs --twins 1_MIGRAR/pruebas_twins.json   # DRY, barrido + twins
 *   node scripts/cleanup/cleanupMirrorsStack.mjs --twins 1_MIGRAR/pruebas_twins.json --execute   # BORRA
 *   node scripts/cleanup/cleanupMirrorsStack.mjs --no-sweep --twins <ruta>        # solo twins (sin barrido)
 */

import 'dotenv/config';
import fs from 'node:fs';
import { guardProduction } from '../_lib/guardProduction.mjs';
import { hubspotClient } from '../../src/hubspotClient.js';

// ─── args ────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const EXECUTE = args.includes('--execute');
const DRY = !EXECUTE;
const NO_SWEEP = args.includes('--no-sweep');
const twinsPath = (() => { const i = args.indexOf('--twins'); return i >= 0 ? args[i + 1] : null; })();
guardProduction({ scriptName: 'cleanupMirrorsStack.mjs', dryRun: DRY });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isNumId = (v) => /^\d+$/.test(String(v || ''));

// ─── helpers HubSpot ──────────────────────────────────────────────────────────
async function safeArchive(objectType, id, label = '') {
  if (DRY) { console.log(`      🔍 [DRY] archivaría ${objectType} ${id} ${label}`); return true; }
  try {
    // invoices no existe como cliente tipado en el SDK (crm.invoices = undefined, visto 5-jul):
    // va por la API genérica de objetos. El resto (deals/tickets/lineItems) por su cliente.
    if (hubspotClient.crm[objectType]?.basicApi) await hubspotClient.crm[objectType].basicApi.archive(String(id));
    else await hubspotClient.crm.objects.basicApi.archive(objectType, String(id));
    console.log(`      🗑️  ${objectType} ${id} ${label}`);
    return true;
  } catch (err) {
    const status = err?.statusCode || err?.code;
    if (status === 404) { console.log(`      ⚠️  ${objectType} ${id} no existe (¿ya borrado?)`); return true; }
    if (status === 429) { console.log('      ⏳ 429, espero 10s…'); await sleep(10000); return safeArchive(objectType, id, label); }
    console.error(`      ❌ error archivando ${objectType} ${id}: ${err.message}`);
    return false;
  }
}

async function getAssoc(fromType, fromId, toType) {
  try {
    const resp = await hubspotClient.crm.associations.v4.basicApi.getPage(fromType, String(fromId), toType, 100);
    return (resp.results || []).map((r) => String(r.toObjectId));
  } catch (err) {
    if (err?.statusCode === 404) return [];
    console.warn(`      ⚠️  assoc ${fromType}/${fromId}→${toType}: ${err.message}`);
    return [];
  }
}

async function searchDeals(filters, properties = []) {
  const out = [];
  let after;
  do {
    const resp = await hubspotClient.crm.deals.searchApi.doSearch({
      filterGroups: [{ filters }], properties, limit: 100, ...(after ? { after } : {}),
    });
    for (const d of resp.results || []) out.push({ id: d.id, ...(d.properties || {}) });
    after = resp.paging?.next?.after;
    await sleep(250); // Search API: límite SECONDLY bajo
  } while (after);
  return out;
}

// tickets con of_deal_id = dealId (key match; incluye NO asociados). Trae of_invoice_id para las facturas.
async function searchTicketsByDealKey(dealId) {
  const out = [];
  let after;
  do {
    const resp = await hubspotClient.crm.tickets.searchApi.doSearch({
      filterGroups: [{ filters: [{ propertyName: 'of_deal_id', operator: 'EQ', value: String(dealId) }] }],
      properties: ['of_deal_id', 'of_ticket_key', 'of_invoice_id'], limit: 100, ...(after ? { after } : {}),
    });
    for (const t of resp.results || []) out.push({ id: t.id, ...(t.properties || {}) });
    after = resp.paging?.next?.after;
    await sleep(250);
  } while (after);
  return out;
}

// ─── resolución de dealIds a borrar ───────────────────────────────────────────
// devuelve Map(dealId -> etiqueta 'PY'|'mirror'|'?') para el reporte
async function resolverStack() {
  const roles = new Map(); // dealId -> rol
  const marcar = (id, rol) => { if (id && isNumId(id)) roles.set(String(id), roles.get(String(id)) || rol); };

  if (!NO_SWEEP) {
    const mirrors = await searchDeals(
      [{ propertyName: 'es_mirror_de_py', operator: 'EQ', value: 'true' }],
      ['dealname', 'deal_py_origen_id']
    );
    console.log(`  · barrido es_mirror_de_py=true: ${mirrors.length} mirror(s).`);
    for (const m of mirrors) { marcar(m.id, 'mirror'); marcar(m.deal_py_origen_id, 'PY'); }
  }

  if (twinsPath) {
    if (!fs.existsSync(twinsPath)) { console.error(`  ✖ no existe el JSON de twins: ${twinsPath}`); process.exit(1); }
    const data = JSON.parse(fs.readFileSync(twinsPath, 'utf8'));
    const twins = data.twinsApartados || [];
    console.log(`  · twins JSON (${twinsPath}): ${twins.length} twin(s).`);
    for (const t of twins) {
      const origenes = new Set();
      if (t.origenPY) origenes.add(String(t.origenPY));
      for (const r of t.ramasPY || []) if (r) origenes.add(String(r));
      for (const o of origenes) {
        const pys = await searchDeals(
          [{ propertyName: 'id_crm_origen', operator: 'EQ', value: o }],
          ['deal_uy_mirror_id']
        );
        for (const py of pys) {
          marcar(py.id, 'PY');
          if (py.deal_uy_mirror_id) marcar(py.deal_uy_mirror_id, 'mirror'); // solo numérico entra (guardia isNumId)
          const ms = await searchDeals(
            [{ propertyName: 'es_mirror_de_py', operator: 'EQ', value: 'true' },
             { propertyName: 'deal_py_origen_id', operator: 'EQ', value: String(py.id) }],
            ['dealname']
          );
          for (const mm of ms) marcar(mm.id, 'mirror');
        }
      }
    }
  }
  return roles;
}

// ─── wipe de un deal ──────────────────────────────────────────────────────────
async function wipeDeal(dealId, rol) {
  console.log(`\n  🧹 ${rol} ${dealId}`);
  // 1) tickets: key match (of_deal_id) ∪ asociación
  const byKey = await searchTicketsByDealKey(dealId);
  const assocT = await getAssoc('deals', dealId, 'tickets');
  const ofInvoiceByTicket = new Map(byKey.map((t) => [String(t.id), t.of_invoice_id]));
  const ticketIds = new Set([...byKey.map((t) => String(t.id)), ...assocT]);

  // 2) facturas: of_invoice_id del ticket (key) + asoc tickets→invoices + asoc deals→invoices
  const invoiceIds = new Set();
  for (const tid of ticketIds) {
    const inv = ofInvoiceByTicket.get(String(tid));
    if (isNumId(inv)) invoiceIds.add(String(inv));
    for (const id of await getAssoc('tickets', tid, 'invoices')) invoiceIds.add(id);
  }
  for (const id of await getAssoc('deals', dealId, 'invoices')) invoiceIds.add(id);

  // 3) line items del deal
  const liIds = await getAssoc('deals', dealId, 'line_items');

  console.log(`     tickets: ${ticketIds.size} (key ${byKey.length} · asoc ${assocT.length}) · facturas: ${invoiceIds.size} · line items: ${liIds.length}`);

  // 4) archivar: invoices → tickets → line items → deal
  for (const id of invoiceIds) { await safeArchive('invoices', id); await sleep(120); }
  for (const id of ticketIds) { await safeArchive('tickets', id); await sleep(120); }
  for (const id of liIds) { await safeArchive('lineItems', id); await sleep(120); }
  await safeArchive('deals', dealId, `(${rol})`);

  return { tickets: ticketIds.size, invoices: invoiceIds.size, lis: liIds.length };
}

// ─── main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  CLEANUP MIRRORS STACK — ${DRY ? 'DRY (no borra)' : 'EJECUTA (BORRA)'} · env=${process.env.HUBSPOT_ENV || '?'}`);
  console.log(`  fuentes: ${NO_SWEEP ? '' : 'barrido es_mirror_de_py=true'}${twinsPath ? (NO_SWEEP ? '' : ' + ') + 'twins ' + twinsPath : ''}`);
  console.log('═══════════════════════════════════════════════════════════');

  const roles = await resolverStack();
  if (!roles.size) { console.log('\n✅ No hay deals de mirror stack para borrar.'); return; }

  const pares = [...roles.entries()];
  console.log(`\n📋 Deals a borrar: ${pares.length}  (PY: ${pares.filter(([, r]) => r === 'PY').length} · mirror: ${pares.filter(([, r]) => r === 'mirror').length})`);
  for (const [id, rol] of pares) console.log(`   ${rol.padEnd(6)} ${id}`);

  const tot = { tickets: 0, invoices: 0, lis: 0 };
  for (const [id, rol] of pares) {
    const r = await wipeDeal(id, rol);
    tot.tickets += r.tickets; tot.invoices += r.invoices; tot.lis += r.lis;
    await sleep(300);
  }

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(`  ${DRY ? 'SE BORRARÍA' : 'BORRADO'}: ${pares.length} deals · ${tot.tickets} tickets · ${tot.invoices} facturas · ${tot.lis} line items`);
  if (DRY) console.log('  Fue DRY. Para borrar de verdad, repetí con  --execute');
  console.log('═══════════════════════════════════════════════════════════');
}

main().catch((err) => {
  console.error('❌ Fatal:', err.message);
  if (err.response?.data) console.error(JSON.stringify(err.response.data, null, 2));
  process.exit(1);
});
