#!/usr/bin/env node
/**
 * correrDirectoDE.mjs
 *
 * Corre el camino reactivo llamando DIRECTO a `syncLineItemPropToTickets` con
 * los mismos argumentos que le pasa el worker (`webhookQueue.js`, case
 * `li_prop_sync`), en ESTE proceso y con LAS LLAVES DE ESTE PROCESO.
 *
 * ── PARA QUÉ, si el camino real ya se está ejercitando ───────────────────────
 * Dos escenarios del guion no se pueden correr por el camino real:
 *
 *  1. LAS PROPS SIN SUSCRIPCIÓN EN EL SANDBOX. `costo_total_usd` y
 *     `hs_cost_of_goods_sold` NO tienen `line_item.propertyChange` en el portal
 *     de pruebas (medido: editarlas no genera NINGÚN job). En producción sí —
 *     la usuaria las suscribió el 20-jul (WEBHOOK_SUBSCRIPTIONS_prod §nota).
 *     Sin eso, el escenario (b) —el COSTO, que es la prop insignia de la tanda
 *     D— no dispara nada en sandbox. Crear la suscripción es config persistente
 *     del portal y el propio doc pide OK antes de tocarla, así que acá se
 *     ejercita el servicio directamente y el hueco queda reportado.
 *
 *  2. LOS ESCENARIOS DE LLAVE APAGADA — (f) y (k). Quien ejecuta el camino real
 *     es el servicio `testing` de Railway, y sus llaves no se pueden cambiar
 *     desde acá (CLI sin autorizar). Las llaves se leen de `process.env` en cada
 *     llamada, así que corriéndolo en este proceso con la llave apagada se
 *     ejercita exactamente el mismo código en la variante que el guion pide.
 *
 * Lo único que NO pasa por acá es el salto HubSpot → router → cola. Todo lo
 * demás —el servicio, sus llaves, el portal— es el real.
 *
 * Uso:
 *   node scripts/seed/correrDirectoDE.mjs --li <id> --prop costo_total_usd
 *   node scripts/seed/correrDirectoDE.mjs --li <id> --prop description --off ETAPA_UNICA_ENABLED
 *   ... --off <LLAVE>      → apaga esa llave sólo para esta corrida (repetible)
 *   ... --set <K>=<V>      → escribe antes la prop en el portal (repetible)
 */

import 'dotenv/config';
import fs from 'fs';

const argv = process.argv.slice(2);
function arg(name, def) { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : def; }
function args(name) { return argv.map((a, i) => (a === `--${name}` ? argv[i + 1] : null)).filter(Boolean); }

// Las llaves se apagan ANTES de importar los servicios: los módulos de config
// las leen por llamada, pero así queda explícito en el log qué entorno corrió.
for (const k of args('off')) {
  process.env[k] = 'false';
  console.log(`🔻 ${k}=false para esta corrida`);
}
for (const k of args('on')) {
  process.env[k] = 'true';
  console.log(`🔺 ${k}=true para esta corrida`);
}

const { hubspotClient } = await import('../../src/hubspotClient.js');
const { syncLineItemPropToTickets } = await import('../../src/services/lineItems/syncLineItemPropToTicket.js');

if (String(process.env.HUBSPOT_ENV || '').toLowerCase() !== 'sandbox') {
  console.error('❌ SOLO sandbox.'); process.exit(1);
}

const lineItemId = arg('li');
const propertyName = arg('prop');
if (!lineItemId || !propertyName) { console.error('❌ Faltan --li / --prop'); process.exit(1); }

// dealId: igual que el worker, se resuelve desde el line item.
const assoc = await hubspotClient.crm.associations.v4.basicApi.getPage('line_items', String(lineItemId), 'deals', 10);
const dealId = String((assoc.results || [])[0]?.toObjectId || '');

for (const kv of args('set')) {
  const i = kv.indexOf('=');
  const k = kv.slice(0, i), v = kv.slice(i + 1);
  const antes = await hubspotClient.crm.lineItems.basicApi.getById(String(lineItemId), [k]);
  await hubspotClient.crm.lineItems.basicApi.update(String(lineItemId), { properties: { [k]: v } });
  console.log(`✏️  LI ${lineItemId}.${k}: ${JSON.stringify(antes.properties?.[k])} → ${JSON.stringify(v)}`);
}

console.log(`\n▸ syncLineItemPropToTickets({ lineItemId: ${lineItemId}, propertyName: ${propertyName}, dealId: ${dealId} })`);
console.log(`   llaves: ETAPA_UNICA=${process.env.ETAPA_UNICA_ENABLED} MIRROR_PUNTUAL=${process.env.MIRROR_PUNTUAL_ENABLED} LI_PROP_SYNC=${process.env.LI_PROP_SYNC_ENABLED}\n`);

const r = await syncLineItemPropToTickets({ lineItemId, propertyName, dealId });
console.log('\n── resultado ──');
console.log(JSON.stringify(r, null, 2));
process.exit(0);
