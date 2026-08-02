#!/usr/bin/env node
/**
 * colapsoColaDE.mjs — escenario (n), la mitad que no se reproduce sola.
 *
 * (n) corrido tal cual (dos ediciones seguidas en el CRM) da el resultado
 * correcto pero NO reproduce el colapso: los dos webhooks llegaron lo bastante
 * separados como para que el primero terminara antes de que entrara el segundo,
 * y `superseded` quedó en 0. Sin colapso, (n) prueba que las dos props llegan,
 * pero no prueba lo que el diseño de la tanda E dice defender.
 *
 * Y el colapso no se fuerza "editando más rápido", por cómo está escrito
 * `processNext` (webhookQueue.js:148-182):
 *
 *     SELECT ... WHERE status='pending' ORDER BY priority DESC, created_at ASC LIMIT 1
 *     UPDATE ... SET status='superseded' WHERE ... AND id < <el elegido>
 *
 * Elige el MÁS VIEJO por `created_at` y recién ahí descarta los pendientes con id
 * MENOR. Con dos jobs normales el más viejo es también el de id menor, así que no
 * hay nada que descartar. El colapso sólo aparece cuando el orden por `created_at`
 * y el orden por `id` NO coinciden — que es lo que pasa cuando un job se reencola
 * (`deal_locked` le pone `created_at = now()`, webhookQueue.js:203).
 *
 * Este script arma esa condición a mano y verifica lo que importa: que el job que
 * sobrevive deje el ticket COMPLETO, con las dos props, aunque el otro no corra.
 *
 * Uso: node scripts/seed/colapsoColaDE.mjs
 */

import 'dotenv/config';
import fs from 'fs';
import { hubspotClient } from '../../src/hubspotClient.js';
import pool from '../../src/db.js';
import { enqueue, startWorker, stopWorker } from '../../src/webhookQueue.js';

if (String(process.env.HUBSPOT_ENV || '').toLowerCase() !== 'sandbox') {
  console.error('❌ SOLO sandbox.'); process.exit(1);
}

const m = JSON.parse(fs.readFileSync('ronda-de-manifest.json', 'utf8'));
const dealId = String(m.deals.manualE.id);
const OWNER_NUEVO = '80741440';   // Maximiliano Lema
const MONEDA_NUEVA = 'EUR';   // el sandbox sólo tiene habilitadas USD, EUR, UYU: 'ARS' da 400 INVALID_OPTION

async function ticketsDelNegocio() {
  const r = await hubspotClient.crm.tickets.searchApi.doSearch({
    filterGroups: [{ filters: [{ propertyName: 'of_deal_id', operator: 'EQ', value: dealId }] }],
    properties: ['fecha_resolucion_esperada', 'hs_pipeline', 'hs_pipeline_stage', 'of_propietario_secundario', 'of_moneda'],
    limit: 100,
  });
  return (r.results || []).sort((a, b) => (a.properties.fecha_resolucion_esperada || '').localeCompare(b.properties.fecha_resolucion_esperada || ''));
}

function mostrar(ts, titulo) {
  console.log(`\n── ${titulo} ──`);
  for (const t of ts) {
    console.log(`   ${t.properties.fecha_resolucion_esperada}  stage=${t.properties.hs_pipeline_stage}  vend=${t.properties.of_propietario_secundario || '—'}  mon=${t.properties.of_moneda || '—'}`);
  }
}

// 1) Dejar el NEGOCIO con los valores nuevos, sin que los tickets se enteren.
//    (los webhooks que dispare esto se drenan y descartan antes de armar el caso)
console.log(`▸ negocio ${dealId}: owner → ${OWNER_NUEVO}, moneda → ${MONEDA_NUEVA}`);
await hubspotClient.crm.deals.basicApi.update(dealId, {
  properties: { hubspot_owner_id: OWNER_NUEVO, deal_currency_code: MONEDA_NUEVA },
});

console.log('  … esperando 25s a que pasen los webhooks reales de esa edición');
await new Promise(r => setTimeout(r, 25000));
await pool.query(`UPDATE webhook_queue SET status='superseded', finished_at=now() WHERE status='pending'`);

mostrar(await ticketsDelNegocio(), 'tickets tras la edición real');

// 2) Volver los TICKETS a valores viejos: así vuelve a haber algo que escribir.
const ts = await ticketsDelNegocio();
for (const t of ts) {
  await hubspotClient.crm.tickets.basicApi.update(String(t.id), {
    properties: { of_propietario_secundario: '65820526', of_moneda: 'USD' },
  });
}
console.log('\n▸ tickets vueltos a vend=65820526 / mon=USD — hay delta para escribir');

// 3) Los dos jobs, con el orden de `created_at` invertido respecto del de `id`:
//    el de id MAYOR queda como el MÁS VIEJO ⇒ es el que processNext elige, y al
//    elegirlo descarta al de id menor. Es el estado que deja un reencolado.
const jobViejo = await enqueue({
  source: 'ronda-de-colapso', objectType: 'deal', objectId: dealId,
  propertyName: 'hubspot_owner_id', propertyValue: OWNER_NUEVO,
  dealId, actionType: 'deal_prop_sync', priority: 0, eventId: 1, rawPayload: {},
});
const jobNuevo = await enqueue({
  source: 'ronda-de-colapso', objectType: 'deal', objectId: dealId,
  propertyName: 'deal_currency_code', propertyValue: MONEDA_NUEVA,
  dealId, actionType: 'deal_prop_sync', priority: 0, eventId: 2, rawPayload: {},
});
await pool.query(`UPDATE webhook_queue SET created_at = now() - interval '1 minute' WHERE id = $1`, [jobNuevo]);

console.log(`\n▸ job ${jobViejo} (hubspot_owner_id) e id ${jobNuevo} (deal_currency_code), los dos PENDING`);
console.log(`   ${jobNuevo} tiene el created_at más viejo ⇒ processNext lo elige y descarta a ${jobViejo}`);

// 4) Correr el worker en este proceso.
startWorker(200);
for (let i = 0; i < 60; i++) {
  await new Promise(r => setTimeout(r, 500));
  const r = await pool.query(`SELECT count(*)::int n FROM webhook_queue WHERE id = ANY($1::int[]) AND status IN ('pending','processing')`, [[jobViejo, jobNuevo]]);
  if (r.rows[0].n === 0) break;
}
stopWorker();

const fin = await pool.query(`SELECT id, property_name, status FROM webhook_queue WHERE id = ANY($1::int[]) ORDER BY id`, [[jobViejo, jobNuevo]]);
console.log('\n── qué pasó con cada job ──');
for (const j of fin.rows) console.log(`   ${j.id} ${String(j.property_name).padEnd(20)} ${j.status}`);

const colapso = fin.rows.some(j => j.status === 'superseded');
console.log(colapso
  ? '\n✅ EL COLAPSO OCURRIÓ: un job quedó superseded y nunca corrió.'
  : '\n⚠️  no hubo colapso — el escenario no probó lo que tenía que probar.');

const despues = await ticketsDelNegocio();
mostrar(despues, 'tickets DESPUÉS (acá se juega (n))');

const manualesNoNotificados = despues.filter(t =>
  String(t.properties.hs_pipeline) === process.env.BILLING_TICKET_PIPELINE_ID &&
  String(t.properties.hs_pipeline_stage) === process.env.BILLING_TICKET_STAGE_ID);

const conLasDos = manualesNoNotificados.filter(t =>
  String(t.properties.of_propietario_secundario) === OWNER_NUEVO &&
  String(t.properties.of_moneda) === MONEDA_NUEVA);

console.log(`\n⇒ tickets manuales no notificados: ${manualesNoNotificados.length}`);
console.log(`⇒ con LAS DOS props actualizadas: ${conLasDos.length}`);
console.log(conLasDos.length === manualesNoNotificados.length && manualesNoNotificados.length > 0
  ? '✅ (n) EN VERDE: el job que sobrevivió resolvió las DOS props desde el estado del negocio.'
  : '🔴 (n) FALLA: se perdió al menos una prop en el colapso.');

process.exit(0);
