#!/usr/bin/env node
/**
 * mutarRondaEtapaUnicaDE.mjs
 *
 * Las ediciones que pide cada escenario de la ronda D+E, hechas desde AFUERA del
 * motor: como las haría una persona en la UI del CRM.
 *
 * Cada escenario ESCRIBE la propiedad de verdad en el portal y después mira. No
 * dispara ningún evento ni levanta ningún worker: el webhook lo manda HubSpot y
 * lo ejecuta el servicio `testing` de Railway. El porqué está abajo, en
 * `drenarTodo`.
 *
 * Uso:
 *   node scripts/seed/mutarRondaEtapaUnicaDE.mjs --a     (a) descripción del LI-1 (no sensible)
 *   node scripts/seed/mutarRondaEtapaUnicaDE.mjs --b     (b) COSTO del LI-1 (sensible)
 *   node scripts/seed/mutarRondaEtapaUnicaDE.mjs --c     (c) PRECIO del LI-1 (sensible, NO se copia)
 *   node scripts/seed/mutarRondaEtapaUnicaDE.mjs --d     (d) CANTIDAD del LI-1 (sensible)
 *   node scripts/seed/mutarRondaEtapaUnicaDE.mjs --e     (e) descripción del LI-3 (espejo sellado)
 *   node scripts/seed/mutarRondaEtapaUnicaDE.mjs --j     (j) anti-loop: prop del LI ESPEJO
 *   node scripts/seed/mutarRondaEtapaUnicaDE.mjs --l     (l) propietario del negocio manualE
 *   node scripts/seed/mutarRondaEtapaUnicaDE.mjs --m     (m) moneda del negocio manualE
 *   node scripts/seed/mutarRondaEtapaUnicaDE.mjs --n     (n) las dos seguidas, SIN drenar en el medio
 *
 *   ... --value <v>   → fuerza el valor nuevo (si no, usa el default del escenario)
 */

import 'dotenv/config';
import fs from 'fs';
import { hubspotClient } from '../../src/hubspotClient.js';

import pool from '../../src/db.js';


if (String(process.env.HUBSPOT_ENV || '').toLowerCase() !== 'sandbox') {
  console.error('❌ SOLO sandbox.'); process.exit(1);
}

const m = JSON.parse(fs.readFileSync('ronda-de-manifest.json', 'utf8'));
const has = (n) => process.argv.includes(`--${n}`);
function arg(name, def) { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : def; }

const API = {
  line_item: hubspotClient.crm.lineItems.basicApi,
  deal: hubspotClient.crm.deals.basicApi,
  ticket: hubspotClient.crm.tickets.basicApi,
};

/** Escribe la prop en el portal e informa el antes/después real. */
async function escribir(objectType, objectId, propertyName, valor) {
  const antes = await API[objectType].getById(String(objectId), [propertyName]);
  const viejo = antes.properties?.[propertyName];
  await API[objectType].update(String(objectId), { properties: { [propertyName]: String(valor) } });
  console.log(`  ✏️  ${objectType} ${objectId}.${propertyName}: ${JSON.stringify(viejo)} → ${JSON.stringify(String(valor))}`);
  return viejo;
}

const TERMINAL = `('done','failed','superseded')`;

/**
 * 🔴 QUIÉN EJECUTA LOS ESCENARIOS — y por qué NO es este proceso
 *
 * El guion (P1-P7) da por sentado que la ronda corre en el servicio `testing` de
 * Railway. Acá no hay acceso al CLI (`railway status` → "Unauthorized"), así que
 * las llaves de ese servicio no se pueden ESCRIBIR ni LEER. Lo que sí se puede es
 * medirlas por lo que el servicio hace, y eso se hizo antes de arrancar:
 *
 *   · tocar una prop del LINE ITEM  → aparece un job `li_prop_sync`
 *       ⇒ LI_PROP_SYNC_ENABLED=true en testing            (P4 ✅ verificado)
 *   · tocar el OWNER del negocio    → aparece un job `deal_prop_sync`
 *       ⇒ DEAL_PROP_SYNC_ENABLED=true en testing          (P3 ✅ verificado)
 *   · esos jobs alcanzan tickets en «Próximos a facturar», que sólo entran en
 *     `isEngineManagedStage` con la etapa única prendida
 *       ⇒ ETAPA_UNICA_ENABLED=true en testing             (P7 ✅ verificado)
 *   · la copia al LI espejo toca UNA sola propiedad, no la hoja entera
 *       ⇒ MIRROR_PUNTUAL_ENABLED=true en testing          (P2 ✅ verificado)
 *
 * Y el token de `testing` YA NO está roto (la ronda B+C lo había roto a propósito
 * para aislarlo; a esta altura funciona: cero jobs con 401 en las últimas horas).
 * O sea que el servicio real recibe el webhook, lo rutea, lo encola Y lo ejecuta
 * contra el sandbox, con las cuatro llaves puestas.
 *
 * Entonces este script NO levanta worker: escribe la propiedad y mira. Levantar
 * uno acá haría que los dos workers corran el MISMO job (el `FOR UPDATE SKIP
 * LOCKED` del pick no está dentro de una transacción, así que no excluye a nadie)
 * y los stats quedarían partidos entre dos procesos — que es exactamente lo que
 * pasó en el primer intento del escenario (a) y lo hacía parecer fallado.
 */
async function drenarTodo({ desdeId, esperaWebhookMs = 45000, timeoutMs = 180000 } = {}) {
  const t0 = Date.now();
  let visto = false;
  while (Date.now() - t0 < esperaWebhookMs) {
    const r = await pool.query(`SELECT count(*)::int n FROM webhook_queue WHERE id > $1`, [desdeId]);
    if (r.rows[0].n > 0) { visto = true; break; }
    await new Promise(res => setTimeout(res, 500));
  }
  if (!visto) {
    console.log(`  ⚠️  no llegó ningún webhook en ${esperaWebhookMs / 1000}s — ¿la suscripción de esa prop no existe en el sandbox?`);
    return [];
  }

  // Esperar a que la cola quede quieta. Incluye los jobs EN CASCADA: la copia al
  // espejo cambia el LI espejo, y eso dispara su propio webhook.
  let quietoDesde = null;
  while (Date.now() - t0 < timeoutMs) {
    const r = await pool.query(`SELECT count(*)::int n FROM webhook_queue WHERE status IN ('pending','processing')`);
    if (r.rows[0].n === 0) {
      quietoDesde ||= Date.now();
      if (Date.now() - quietoDesde > 8000) break;   // 8s sin nada nuevo = terminó la cascada
    } else {
      quietoDesde = null;
    }
    await new Promise(res => setTimeout(res, 500));
  }

  const r = await pool.query(
    `SELECT id, action_type, object_id, property_name, status, left(coalesce(error,''),180) err
       FROM webhook_queue WHERE id > $1 ORDER BY id`, [desdeId]
  );
  console.log(`\n  ── jobs que generó esta edición (${r.rows.length}) ──`);
  for (const j of r.rows) {
    console.log(`  ← ${j.id} ${String(j.action_type).padEnd(15)} obj=${String(j.object_id).padEnd(12)} ${String(j.property_name).padEnd(14)} → ${j.status}${j.err ? `  ${j.err}` : ''}`);
    if (/401|Authentication credentials/i.test(j.err || '')) {
      console.log('  🔴 401: el token de `testing` volvió a estar roto — ese job NO se ejecutó, repetir el escenario');
    }
  }
  return r.rows;
}

async function ultimoJobId() {
  const r = await pool.query(`SELECT coalesce(max(id),0)::int m FROM webhook_queue`);
  return r.rows[0].m;
}

/** Escribe la prop y drena lo que HubSpot dispare por ella. */
async function mutarYCorrer(objectType, objectId, propertyName, valor) {
  const desdeId = await ultimoJobId();
  await escribir(objectType, objectId, propertyName, valor);
  console.log(`  … esperando el webhook real de HubSpot (jobs > ${desdeId})`);
  return drenarTodo({ desdeId });
}

// ─── Los escenarios ───────────────────────────────────────────────────────────

const LI1 = () => m.lineItems['LI-1'];
const LI3 = () => m.lineItems['LI-3'];
const MANUAL_E = () => m.deals.manualE;

const ESCENARIOS = {
  a: async () => {
    console.log('\n▸ (a) prop NO sensible: descripción del LI-1 → se copia puntual y avisa DESPUÉS');
    const v = arg('value', `Descripción EDITADA por el escenario (a) — ${new Date().toISOString()}`);
    return mutarYCorrer('line_item', LI1().id, 'description', v);
  },

  b: async () => {
    console.log('\n▸ (b) SENSIBLE: costo del LI-1 → PRECIO del espejo, y avisa ANTES');
    const v = arg('value', '800');   // 800/2 = 400 exacto en el espejo
    return mutarYCorrer('line_item', LI1().id, 'costo_total_usd', v);
  },

  c: async () => {
    console.log('\n▸ (c) 🔴 SENSIBLE: precio del LI-1 → avisa pero NO copia');
    console.log('     el price del espejo ES el costo de PY: si se copió, es un BUG');
    const v = arg('value', '1750');
    return mutarYCorrer('line_item', LI1().id, 'price', v);
  },

  d: async () => {
    console.log('\n▸ (d) SENSIBLE: cantidad del LI-1 → avisa antes + SÍ se copia');
    const v = arg('value', '4');     // costo 800 / qty 4 = 200 exacto
    return mutarYCorrer('line_item', LI1().id, 'quantity', v);
  },

  e: async () => {
    console.log('\n▸ (e) espejo SELLADO: no copia, sí avisa');
    const v = arg('value', `Descripción EDITADA por el escenario (e) — ${new Date().toISOString()}`);
    return mutarYCorrer('line_item', LI3().id, 'description', v);
  },

  j: async () => {
    console.log('\n▸ (j) anti-loop: se edita el LI que YA ES espejo → ni aviso ni propagación');
    const espejo = LI1().mirrorLineItemId;
    if (!espejo) { console.error('❌ LI-1 no tiene espejo registrado; corré el seed con --mirrors'); process.exit(1); }
    const v = arg('value', `Toque en el ESPEJO — escenario (j) — ${new Date().toISOString()}`);
    return mutarYCorrer('line_item', espejo, 'description', v);
  },

  l: async () => {
    console.log('\n▸ (l) TANDA E: propietario del negocio → tickets manuales NO notificados');
    const v = arg('value', '89497033');   // Victoria Caimi
    return mutarYCorrer('deal', MANUAL_E().id, 'hubspot_owner_id', v);
  },

  m: async () => {
    console.log('\n▸ (m) TANDA E: moneda del negocio');
    const v = arg('value', 'EUR');
    return mutarYCorrer('deal', MANUAL_E().id, 'deal_currency_code', v);
  },

  n: async () => {
    console.log('\n▸ (n) 🔴 TANDA E: las dos seguidas SIN drenar en el medio — el colapso de la cola');
    const dealId = MANUAL_E().id;
    const owner = arg('owner', '89701984');   // Maria Bittencourt
    const moneda = arg('moneda', 'UYU');
    const desdeId = await ultimoJobId();

    // Las dos ediciones seguidas: los dos webhooks llegan y quedan PENDING a la
    // vez, que es exactamente la condición que colapsa la cola.
    await escribir('deal', dealId, 'hubspot_owner_id', owner);
    await escribir('deal', dealId, 'deal_currency_code', moneda);
    console.log('  … los dos webhooks tienen que quedar PENDING antes de drenar');

    const jobs = await drenarTodo({ desdeId });
    const sup = jobs.filter(j => j.status === 'superseded');
    console.log(`\n  ⇒ colapsados a 'superseded': ${sup.length} (${sup.map(j => j.id).join(', ') || '—'})`);
    console.log('     La prueba de (n): el ticket tiene que terminar con LAS DOS props, aunque un job no haya corrido.');
    return jobs;
  },
};

async function main() {
  const pedidos = Object.keys(ESCENARIOS).filter(k => has(k));
  if (!pedidos.length) {
    console.error(`Falta el escenario. Opciones: ${Object.keys(ESCENARIOS).map(k => `--${k}`).join(' ')}`);
    process.exit(1);
  }
  for (const k of pedidos) await ESCENARIOS[k]();
  await pool.end();
}

main().catch(async e => {
  console.error('❌', e.message);
  if (e.body) console.error(JSON.stringify(e.body));
  try { await pool.end(); } catch {}
  process.exit(1);
});
