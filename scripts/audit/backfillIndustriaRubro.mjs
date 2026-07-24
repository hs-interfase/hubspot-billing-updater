// scripts/audit/backfillIndustriaRubro.mjs
//
// Recalcula `industria__rubro` (multi-select curado) de TODAS las empresas de un portal,
// a partir del valor crudo que quedó en `giro_comercial`.
//
// Usa el MISMO mapa que la migración (definitivos/4_PROGRAMAS/_shared/industriaRubro.mjs),
// así que backfill y migración no se pueden desincronizar.
//
// ⚠️ DRY-RUN POR DEFECTO.
// Uso:  node scripts/audit/backfillIndustriaRubro.mjs --portal=SANDBOX
//       node scripts/audit/backfillIndustriaRubro.mjs --portal=PROD --apply
//
// Nunca inventa: si `giro_comercial` no está en el mapa, NO escribe y lo lista al final
// para decidir a mano.

import dotenv from 'dotenv';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const MOD = process.env.INDUSTRIA_RUBRO_MODULE
  || 'C:/Users/promi/OneDrive/Escritorio/definitivos/4_PROGRAMAS/_shared/industriaRubro.mjs';
const { mapIndustria } = await import(pathToFileURL(MOD).href);

const APPLY = process.argv.includes('--apply');
const PORTAL = (process.argv.find(a => a.startsWith('--portal=')) || '--portal=SANDBOX').split('=')[1].toUpperCase();
const TOKEN = dotenv.parse(fs.readFileSync(PORTAL === 'PROD' ? '.env.real' : '.env')).HUBSPOT_PRIVATE_TOKEN;
if (!TOKEN) { console.error(`Sin token para ${PORTAL}`); process.exit(1); }

const H = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 1) Traer todas las empresas con su giro crudo
const empresas = [];
let after;
do {
  const url = new URL('https://api.hubapi.com/crm/v3/objects/companies');
  url.searchParams.set('limit', '100');
  url.searchParams.set('properties', 'name,giro_comercial,industria__rubro');
  if (after) url.searchParams.set('after', after);
  const r = await fetch(url, { headers: H });
  if (!r.ok) { console.error(`Error listando empresas: ${r.status} ${await r.text()}`); process.exit(1); }
  const j = await r.json();
  empresas.push(...(j.results || []));
  after = j.paging?.next?.after;
  await sleep(120);
} while (after);

console.log(`${PORTAL}: ${empresas.length} empresas\n`);

// 2) Calcular qué hay que escribir
const aEscribir = [];
const desconocidos = {};
let iguales = 0, sinGiro = 0;

for (const e of empresas) {
  const giro = e.properties?.giro_comercial;
  const actual = e.properties?.industria__rubro || '';
  const m = mapIndustria(giro);

  if (m.vacio) { sinGiro++; continue; }
  if (m.desconocido) { desconocidos[giro] = (desconocidos[giro] || 0) + 1; continue; }

  // HubSpot devuelve multi-select como "A;B" — comparar como conjunto para no reescribir al pedo
  const set = s => new Set(String(s).split(';').map(x => x.trim()).filter(Boolean));
  const a = set(actual), b = set(m.valor);
  if (a.size === b.size && [...b].every(x => a.has(x))) { iguales++; continue; }

  aEscribir.push({ id: e.id, name: e.properties?.name, de: actual || '(vacío)', a: m.valor });
}

console.log(`sin giro_comercial: ${sinGiro} · ya correctas: ${iguales} · A CORREGIR: ${aEscribir.length} · sin mapear: ${Object.keys(desconocidos).length}`);

if (aEscribir.length) {
  console.log(`\n--- muestra (primeras 15) ---`);
  for (const x of aEscribir.slice(0, 15)) console.log(`  ${String(x.name || x.id).slice(0, 34).padEnd(36)} ${x.de}  →  ${x.a}`);
}

if (Object.keys(desconocidos).length) {
  console.log(`\n⚠️  SIN MAPEAR (no se escribe nada, revisar a mano):`);
  for (const [k, v] of Object.entries(desconocidos)) console.log(`  ${v}×  "${k}"`);
}

// 3) Escribir en lotes de 100
if (APPLY && aEscribir.length) {
  let ok = 0, err = 0;
  for (let i = 0; i < aEscribir.length; i += 100) {
    const lote = aEscribir.slice(i, i + 100);
    const r = await fetch('https://api.hubapi.com/crm/v3/objects/companies/batch/update', {
      method: 'POST', headers: H,
      body: JSON.stringify({ inputs: lote.map(x => ({ id: x.id, properties: { industria__rubro: x.a } })) }),
    });
    if (r.ok) { ok += lote.length; process.stdout.write(`\r  escritas ${ok}/${aEscribir.length}`); }
    else { err += lote.length; console.log(`\n  ❌ lote ${i}: ${r.status} ${(await r.text()).slice(0, 200)}`); }
    await sleep(200);
  }
  console.log(`\n\n✅ APLICADO — ${ok} actualizadas, ${err} con error`);
} else {
  console.log(`\n${APPLY ? '✅ nada para escribir' : '🔍 DRY-RUN — usá --apply para escribir'}`);
}
