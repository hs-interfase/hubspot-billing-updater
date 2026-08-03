#!/usr/bin/env node
/**
 * cargarAreaEnProductos.mjs — carga el `area` de la biblioteca de PRODUCTOS.
 *
 * POR QUÉ: el motor asume que el producto trae el área. `syncLineItemAreaByCountry`
 * dice, textual: «pais_operativo === 'Uruguay' → se deja el área que HEREDA DEL
 * PRODUCTO». Pero los 13 productos tienen `area` VACÍA — verificado por API el
 * 2-ago-2026 en los DOS portales. O sea: la lógica está esperando una fuente que
 * nadie cargó, y el line item de un negocio UY nace sin área.
 *
 * DE DÓNDE SALE EL MAPEO: de `definitivos/4_PROGRAMAS/_shared/areas.mjs`, la fuente
 * ÚNICA de la migración (REGLAS §4.12), invirtiendo AREA_PRODUCT + SHARED_AREA y
 * traduciendo al valor del SELECT con AREA_SELECT. No es un criterio inventado acá.
 *
 * ⚠️ OJO CON EL CASING: la opción del select es `Payroll`, mientras que el PRODUCTO se
 *    llama `PayRoll`. Son distintos a propósito (así está en AREA_SELECT vs AREA_PRODUCT).
 *
 * Uso:
 *   node scripts/fix/cargarAreaEnProductos.mjs              → DRY RUN (no escribe)
 *   node scripts/fix/cargarAreaEnProductos.mjs --write      → escribe
 *
 * Es IDEMPOTENTE: sólo escribe los productos cuya área difiere. Y valida ANTES de
 * escribir que cada valor exista como opción del select — un valor inexistente da 400.
 */

import 'dotenv/config';
import { hubspotClient } from '../../src/hubspotClient.js';

const WRITE = process.argv.includes('--write');
const ENV = String(process.env.HUBSPOT_ENV || 'production').toLowerCase();

// Producto (nombre en la biblioteca) → valor del select `area`.
// Claves en minúsculas: los nombres difieren en casing entre portales (`iGDoc` en
// sandbox, `iGdoc` en prod), así que el match es case-insensitive.
const AREA_POR_PRODUCTO = {
  'igdoc':      'iGDoc',
  'payroll':    'Payroll',     // ⚠️ la OPCIÓN es 'Payroll'; el PRODUCTO se llama 'PayRoll'
  'portal':     'Portal',
  'iscert':     'iSCert',
  'iscert isa': 'iSCert ISA',
  'nndd ops':   'NNDD Ops',
  // Área COMPARTIDA (SHARED_AREA): Petróleo vende iJServ o Flota
  'ijserv':     'Petróleo',
  'flota':      'Petróleo',
  // Liferay va con Portal (decisión usuaria 20-jul: quien factura Portal factura Liferay).
  // 📌 Única fila que NO sale de _shared/areas.mjs — confirmada por la usuaria 2-ago.
  'liferay':    'Portal',
  // Productos de ISA PY (su `pais_operativo` en PROD es Paraguay) → AREA_SELECT 'isa py'
  'i2':         'Paraguay',
  'mifactura':  'Paraguay',
  'mirecibo':   'Paraguay',
  'proyectos':  'Paraguay',
};

console.log(`\n═══ ÁREA EN PRODUCTOS — ${WRITE ? 'ESCRIBE' : 'DRY RUN (no escribe)'} ═══`);
console.log(`Portal: HUBSPOT_ENV=${ENV}\n`);

// 1) Validar que cada valor exista como opción del select
const propRes = await hubspotClient.apiRequest({ method: 'GET', path: '/crm/v3/properties/products/area' });
if (!propRes.ok) { console.error('❌ No existe la propiedad `area` en productos de este portal.'); process.exit(1); }
const opciones = new Set(((await propRes.json()).options || []).map(o => o.value));
const invalidos = [...new Set(Object.values(AREA_POR_PRODUCTO))].filter(v => !opciones.has(v));
if (invalidos.length) {
  console.error(`❌ Estos valores NO son opciones del select \`area\` en este portal: ${invalidos.join(', ')}`);
  console.error(`   Opciones disponibles: ${[...opciones].join(' · ')}`);
  console.error('   Agregarlas en el portal antes de correr esto (escribir un valor inexistente da 400).');
  process.exit(1);
}
console.log(`✔️  los ${new Set(Object.values(AREA_POR_PRODUCTO)).size} valores existen como opción del select\n`);

// 2) Leer productos y calcular el diff
const j = await (await hubspotClient.apiRequest({
  method: 'GET', path: '/crm/v3/objects/products?limit=100&properties=name,area',
})).json();

const aCambiar = [];
const sinMapeo = [];
for (const p of (j.results || [])) {
  const nombre = String(p.properties.name || '').trim();
  const destino = AREA_POR_PRODUCTO[nombre.toLowerCase()];
  if (!destino) { sinMapeo.push(nombre); continue; }
  const actual = String(p.properties.area || '');
  const icono = actual === destino ? '  =' : (actual ? '  ~' : '  +');
  console.log(`${icono} ${nombre.padEnd(22)} ${String(actual || '(vacía)').padEnd(14)} → ${destino}`);
  if (actual !== destino) aCambiar.push({ id: p.id, nombre, de: actual || '(vacía)', a: destino });
}
if (sinMapeo.length) console.log(`\n⚠️  productos SIN mapeo (no se tocan): ${sinMapeo.join(', ')}`);

console.log(`\n${aCambiar.length} producto(s) a cambiar de ${j.results.length}.`);
if (!aCambiar.length) { console.log('Nada que hacer — ya está cargado.\n'); process.exit(0); }

if (!WRITE) {
  console.log('\nDRY RUN: no se escribió nada. Volvé a correrlo con --write para aplicarlo.\n');
  process.exit(0);
}

// 3) Escribir
await hubspotClient.crm.products.batchApi.update({
  inputs: aCambiar.map(x => ({ id: String(x.id), properties: { area: x.a } })),
});
console.log(`\n✅ ${aCambiar.length} producto(s) actualizados:`);
for (const x of aCambiar) console.log(`   ${x.nombre}: ${x.de} → ${x.a}`);
console.log('');
process.exit(0);
