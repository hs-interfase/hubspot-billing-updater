#!/usr/bin/env node
/**
 * correrEventoDE.mjs
 *
 * Dispara UN evento de webhook como lo haría HubSpot y lo procesa acá,
 * localmente, con el código real: el router de `api/escuchar-cambios.js`, la
 * cola `webhook_queue` de Postgres y el worker de `src/webhookQueue.js`.
 *
 * ── CUÁNDO USARLO — y cuándo NO ─────────────────────────────────────────────
 * Sirve para UNA cosa: **leer la decisión de RUTEO** sin tocar el portal. Es la
 * forma barata de contestar «¿esta propiedad está detrás de una llave apagada?»,
 * porque el router devuelve el `action` que eligió (`li_prop_sync`,
 * `deal_prop_sync`, …) o el fallback `"Property not supported, skipped"`.
 *
 * 🔴 NO usarlo para correr un escenario. Al escribir una propiedad, HubSpot manda
 * el webhook DE VERDAD, lo rutea el servicio `testing` de Railway y lo ejecuta su
 * worker. Sumar un evento sintético deja DOS jobs del mismo cambio, y levantar un
 * worker acá hace que los dos procesos corran el MISMO job: el `FOR UPDATE SKIP
 * LOCKED` del pick no está dentro de una transacción, así que no excluye a nadie.
 * Los stats quedan partidos entre procesos y un escenario que pasó parece
 * fallado. Para los escenarios va `mutarRondaEtapaUnicaDE.mjs`, que sólo escribe
 * y mira.
 *
 * Uso:
 *   node scripts/seed/correrEventoDE.mjs --type line_item --id 123 --prop description --value "x"
 *   node scripts/seed/correrEventoDE.mjs --type deal --id 456 --prop hubspot_owner_id --value 65820526
 *   ... --no-drain     → sólo encola (para armar el escenario (n): dos pendientes a la vez)
 *   ... --drain-only   → no encola nada, sólo drena lo que haya pendiente
 */

import 'dotenv/config';
import { pathToFileURL } from 'url';
import handler from '../../api/escuchar-cambios.js';
import pool from '../../src/db.js';
import { startWorker, stopWorker } from '../../src/webhookQueue.js';

if (String(process.env.HUBSPOT_ENV || '').toLowerCase() !== 'sandbox') {
  console.error('❌ SOLO sandbox.'); process.exit(1);
}

function arg(name, def = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}
const has = (n) => process.argv.includes(`--${n}`);

const TERMINAL = new Set(['done', 'failed', 'superseded']);

/** Fake de (req,res) para invocar el handler real sin levantar el servidor. */
function fakeRes() {
  const out = {};
  const res = {
    status(code) { out.code = code; return res; },
    json(body) { out.body = body; return res; },
  };
  return { res, out };
}

/** Dispara el evento contra el router real y devuelve su respuesta. */
export async function emitirEvento({ objectType, objectId, propertyName, propertyValue }) {
  const payload = {
    eventId: Number(String(Date.now()).slice(-9)),
    subscriptionType: `${objectType}.propertyChange`,
    objectId: Number(objectId),
    propertyName,
    propertyValue: String(propertyValue ?? ''),
  };
  // El router mira `objectTypeId`/`subscriptionType` para saber de qué objeto es.
  if (objectType === 'line_item') payload.objectTypeId = '0-8';
  if (objectType === 'deal') payload.objectTypeId = '0-3';
  if (objectType === 'ticket') payload.objectTypeId = '0-5';

  const { res, out } = fakeRes();
  await handler({ method: 'POST', body: payload }, res);
  return out;
}

/** Drena la cola hasta que los jobs indicados (o todos) terminen. */
async function drenar(esperados = [], { timeoutMs = 180000, pollMs = 200 } = {}) {
  startWorker(pollMs);
  const t0 = Date.now();
  try {
    while (Date.now() - t0 < timeoutMs) {
      const pend = await pool.query(
        esperados.length
          ? `SELECT id, status FROM webhook_queue WHERE id = ANY($1::int[]) AND status NOT IN ('done','failed','superseded')`
          : `SELECT id, status FROM webhook_queue WHERE status IN ('pending','processing')`,
        esperados.length ? [esperados] : []
      );
      if (pend.rows.length === 0) break;
      await new Promise(r => setTimeout(r, pollMs));
    }
  } finally {
    stopWorker();
  }
}

async function estado(ids) {
  if (!ids.length) return [];
  const r = await pool.query(
    `SELECT id, action_type, object_id, property_name, status, left(coalesce(error,''),200) err
       FROM webhook_queue WHERE id = ANY($1::int[]) ORDER BY id`,
    [ids]
  );
  return r.rows;
}

async function main() {
  const drainOnly = has('drain-only');
  const noDrain = has('no-drain');
  const ids = [];

  if (!drainOnly) {
    const objectType = arg('type');
    const objectId = arg('id');
    const propertyName = arg('prop');
    const propertyValue = arg('value', '');
    if (!objectType || !objectId || !propertyName) {
      console.error('❌ Faltan --type / --id / --prop'); process.exit(1);
    }

    console.log(`\n▸ EVENTO  ${objectType}.propertyChange  obj=${objectId}  prop=${propertyName}  value=${JSON.stringify(propertyValue)}`);
    const out = await emitirEvento({ objectType, objectId, propertyName, propertyValue });
    console.log(`  ← router: HTTP ${out.code}  ${JSON.stringify(out.body)}`);

    if (!out.body?.queued) {
      console.log('  ⚠️  el router NO encoló nada — con esto el escenario no prueba el camino reactivo.');
      await pool.end();
      return;
    }
    ids.push(Number(out.body.queueId));
  }

  if (noDrain) {
    console.log(`  (encolado ${ids.join(',')} — sin drenar, como pide el escenario)`);
    await pool.end();
    return;
  }

  console.log('  … drenando la cola localmente');
  await drenar(ids);

  const rows = await estado(ids.length ? ids : []);
  for (const r of rows) {
    const robado = /401|Authentication credentials/i.test(r.err || '');
    console.log(`  ← job ${r.id} ${r.action_type} → ${r.status}${r.err ? `  ${r.err.slice(0, 140)}` : ''}`);
    if (robado) {
      console.log('  🔴 ESE JOB LO PROCESÓ EL SERVICIO `testing` DE RAILWAY (401 = su token roto), NO este proceso.');
      console.log('     El escenario NO corrió. Repetir el evento.');
    }
  }

  await pool.end();
}

// Sólo corre como script. mutarRondaEtapaUnicaDE.mjs importa `emitirEvento`
// de acá: sin este guard, importarlo dispararía main() y abortaría por faltarle
// los argumentos.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(async err => {
    console.error('❌', err?.message);
    if (err?.body) console.error(JSON.stringify(err.body));
    try { await pool.end(); } catch {}
    process.exit(1);
  });
}
