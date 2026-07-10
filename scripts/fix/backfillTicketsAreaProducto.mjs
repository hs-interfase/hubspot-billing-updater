#!/usr/bin/env node
/**
 * backfillTicketsAreaProducto.mjs
 *
 * Rellena en tickets existentes las propiedades que alimentan las vistas por
 * Área y por Producto:
 *   - area        ← area del line item asociado (of_line_item_ids)
 *   - of_producto ← deal.producto (checkbox múltiple) con la misma heurística
 *                   del motor (deriveProductoTicket): un valor → directo;
 *                   varios → match contra el nombre del LI (of_producto_nombres),
 *                   sin match → el primero.
 *
 * Solo escribe campos VACÍOS: nunca pisa un valor ya seteado.
 *
 * Uso:
 *   node scripts/fix/backfillTicketsAreaProducto.mjs             # dry run
 *   node scripts/fix/backfillTicketsAreaProducto.mjs --execute   # ejecución real
 *   (contra prod: correr con .env de prod y --confirm-production)
 */

import 'dotenv/config';
import { Client } from '@hubspot/api-client';
import { guardProduction } from '../_lib/guardProduction.mjs';

// Copia local de la heurística del motor (deriveProductoTicket, hoy en el stash
// assoc-wip-mirrors-A-F): deal.producto multi ";" → un valor directo; varios →
// match contra el nombre del LI; sin match → el primero.
function deriveProductoTicket(dealProducto, liName) {
  const values = String(dealProducto ?? '').split(';').map(v => v.trim()).filter(Boolean);
  if (!values.length) return '';
  if (values.length === 1) return values[0];
  const name = String(liName ?? '').toLowerCase();
  const hit = values.find(v => name.includes(v.toLowerCase()));
  return hit || values[0];
}

const TOKEN = process.env.HUBSPOT_PRIVATE_TOKEN;
if (!TOKEN) { console.error('❌ Falta HUBSPOT_PRIVATE_TOKEN'); process.exit(1); }

const hubspot = new Client({ accessToken: TOKEN });
const sleep = ms => new Promise(r => setTimeout(r, ms));

const DRY_RUN = !process.argv.includes('--execute');
guardProduction({ scriptName: 'backfillTicketsAreaProducto.mjs', dryRun: DRY_RUN });

const PAGE_SLEEP_MS = 350; // pace suave: el token es el mismo que usa el motor en Railway

/** Pagina por keyset todos los tickets con area u of_producto vacíos. */
async function fetchTicketsIncompletos() {
  const tickets = new Map(); // id → props
  for (const missingProp of ['area', 'of_producto']) {
    let lastId = '0';
    for (;;) {
      const resp = await hubspot.crm.tickets.searchApi.doSearch({
        filterGroups: [{
          filters: [
            { propertyName: missingProp, operator: 'NOT_HAS_PROPERTY' },
            { propertyName: 'hs_object_id', operator: 'GT', value: lastId },
          ],
        }],
        properties: ['area', 'of_producto', 'of_producto_nombres', 'of_line_item_ids', 'of_deal_id'],
        sorts: [{ propertyName: 'hs_object_id', direction: 'ASCENDING' }],
        limit: 200,
      });
      const results = resp?.results || [];
      if (!results.length) break;
      for (const t of results) tickets.set(String(t.id), t.properties || {});
      lastId = results[results.length - 1].id;
      await sleep(PAGE_SLEEP_MS);
      if (results.length < 200) break;
    }
  }
  return tickets;
}

/** Batch-read genérico con tolerancia a ids inexistentes. */
async function batchRead(objectType, ids, properties) {
  const out = new Map();
  const list = [...ids];
  for (let i = 0; i < list.length; i += 100) {
    const inputs = list.slice(i, i + 100).map(id => ({ id }));
    try {
      const resp = await hubspot.crm[objectType].batchApi.read({ inputs, properties, propertiesWithHistory: [] });
      for (const r of resp?.results || []) out.set(String(r.id), r.properties || {});
    } catch (err) {
      console.warn(`⚠️  batchRead ${objectType} lote ${i / 100}: ${err.message}`);
    }
    await sleep(PAGE_SLEEP_MS);
  }
  return out;
}

async function main() {
  console.log(`${DRY_RUN ? '🔍 DRY RUN' : '✍️  EJECUCIÓN REAL'} — backfill area / of_producto en tickets`);

  const tickets = await fetchTicketsIncompletos();
  console.log(`Tickets con area u of_producto vacíos: ${tickets.size}`);

  const liIds = new Set();
  const dealIds = new Set();
  for (const p of tickets.values()) {
    const li = String(p.of_line_item_ids || '').split(/[;,]/)[0].trim();
    if (li && !p.area) liIds.add(li);
    if (p.of_deal_id && !p.of_producto) dealIds.add(String(p.of_deal_id));
  }
  console.log(`Line items a leer: ${liIds.size} | Deals a leer: ${dealIds.size}`);

  const lis = await batchRead('lineItems', liIds, ['area']);
  const deals = await batchRead('deals', dealIds, ['producto']);

  const updates = [];
  const stats = { area: 0, producto: 0, sinFuenteArea: 0, sinFuenteProducto: 0 };
  for (const [id, p] of tickets) {
    const props = {};
    if (!p.area) {
      const li = String(p.of_line_item_ids || '').split(/[;,]/)[0].trim();
      const liArea = lis.get(li)?.area;
      if (liArea) { props.area = liArea; stats.area++; } else stats.sinFuenteArea++;
    }
    if (!p.of_producto) {
      const dealProducto = deals.get(String(p.of_deal_id))?.producto;
      const derived = deriveProductoTicket(dealProducto, p.of_producto_nombres);
      if (derived) { props.of_producto = derived; stats.producto++; } else stats.sinFuenteProducto++;
    }
    if (Object.keys(props).length) updates.push({ id, properties: props });
  }

  console.log(`A escribir: ${updates.length} tickets (area: ${stats.area}, of_producto: ${stats.producto})`);
  console.log(`Sin fuente: area ${stats.sinFuenteArea} (LI sin área o inexistente), of_producto ${stats.sinFuenteProducto} (deal sin producto o inexistente)`);
  console.log('Muestra:', JSON.stringify(updates.slice(0, 5), null, 2));

  if (DRY_RUN) { console.log('DRY RUN: no se escribió nada. Repetir con --execute.'); return; }

  let done = 0, failed = 0;
  for (let i = 0; i < updates.length; i += 100) {
    const inputs = updates.slice(i, i + 100);
    try {
      await hubspot.crm.tickets.batchApi.update({ inputs });
      done += inputs.length;
    } catch (err) {
      failed += inputs.length;
      console.warn(`⚠️  batch update lote ${i / 100}: ${err.message}`);
    }
    if ((i / 100) % 10 === 0) console.log(`  ...${done + failed}/${updates.length}`);
    await sleep(PAGE_SLEEP_MS);
  }
  console.log(`✅ Actualizados: ${done} | Fallidos: ${failed}`);
}

main().catch(err => { console.error('❌', err); process.exit(1); });
