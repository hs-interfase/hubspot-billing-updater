// src/__tests__/mirrorLiPropMap.test.mjs
//
// TANDA D — el mapeo LI original → LI espejo (piezas puras, sin I/O).
// Fija la traducción costo→precio, las sensibles y el patch puntual.
//
//   DATABASE_URL='postgres://u:p@localhost:5432/x' node --test src/__tests__/mirrorLiPropMap.test.mjs

process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/x';

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const {
  MIRROR_COPY_PROPS,
  MIRROR_SENSITIVE_LI_PROPS,
  buildMirrorLiPatch,
  computeMirrorUnitPrice,
  pickChangedProps,
  isMirrorableLiProp,
  esPropSensible,
  labelDeProp,
} = await import('../services/mirror/mirrorLiPropMap.js');

// ── Las sensibles son exactamente las tres confirmadas ───────────────────────

test('sensibles = costo · precio · cantidad, y nada más', () => {
  assert.deepEqual(
    [...MIRROR_SENSITIVE_LI_PROPS].sort(),
    ['costo_total_usd', 'hs_cost_of_goods_sold', 'price', 'quantity'].sort()
  );
  assert.equal(esPropSensible('price'), true);
  assert.equal(esPropSensible('quantity'), true);
  assert.equal(esPropSensible('costo_total_usd'), true);
  assert.equal(esPropSensible('hs_cost_of_goods_sold'), true);
  // La descripción se copia, pero NO avisa antes.
  assert.equal(esPropSensible('description'), false);
  assert.equal(esPropSensible('dolar'), false);
});

// ── La lista de copiables no se puede separar de dealMirroring ───────────────

test('MIRROR_COPY_PROPS es la MISMA lista que la allowedProps de dealMirroring', () => {
  const src = readFileSync(new URL('../dealMirroring.js', import.meta.url), 'utf8');
  const bloque = src.match(/const allowedProps = new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(bloque, 'no se encontró allowedProps en dealMirroring.js');
  const enDealMirroring = [...bloque[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual([...MIRROR_COPY_PROPS].sort(), enDealMirroring);
});

// ── La traducción costo → precio ─────────────────────────────────────────────

test('price del espejo = costo_total_usd ÷ quantity (fuente de verdad)', () => {
  const r = computeMirrorUnitPrice({ costo_total_usd: '300', quantity: '3', hs_cost_of_goods_sold: '999' }, 'PYG');
  assert.equal(r.price, '100');
  assert.equal(r.source, 'costo_total_usd/qty');
  assert.equal(r.missingCost, false);
});

test('sin costo_total_usd cae a cogs ÷ dolar (legacy)', () => {
  const r = computeMirrorUnitPrice({ hs_cost_of_goods_sold: '7500', dolar: '7500', quantity: '1' }, 'PYG');
  assert.equal(r.price, '1');
  assert.equal(r.source, 'cogs/dolar');
});

test('deal en guaraníes sin dato USD confiable NO adivina: missingCost', () => {
  const r = computeMirrorUnitPrice({ hs_cost_of_goods_sold: '750000', quantity: '1' }, 'PYG');
  assert.equal(r.missingCost, true);
  assert.equal(r.price, '0');
});

test('deal ya en USD sí puede usar el cogs directo', () => {
  const r = computeMirrorUnitPrice({ hs_cost_of_goods_sold: '250', quantity: '1' }, 'USD');
  assert.equal(r.price, '250');
  assert.equal(r.source, 'cogs');
});

// ── El patch puntual ─────────────────────────────────────────────────────────

test('descripción → descripción (identidad) y NADA más', () => {
  const { patch } = buildMirrorLiPatch({
    propertyName: 'description',
    srcProps: { description: 'nueva desc', name: 'Producto X', quantity: '2', costo_total_usd: '200' },
  });
  assert.deepEqual(patch, { description: 'nueva desc' });
});

test('🔴 el PRECIO del original no se copia al espejo (el espejo factura al costo)', () => {
  const { patch } = buildMirrorLiPatch({
    propertyName: 'price',
    srcProps: { price: '9999', costo_total_usd: '200', quantity: '2' },
  });
  assert.deepEqual(patch, {}, 'price no debe escribir nada en el espejo');
  // pero SÍ avisa
  assert.equal(esPropSensible('price'), true);
  assert.equal(isMirrorableLiProp('price'), true);
});

test('el costo del original cambia el PRECIO del espejo', () => {
  const { patch } = buildMirrorLiPatch({
    propertyName: 'costo_total_usd',
    srcProps: { costo_total_usd: '500', quantity: '5' },
  });
  assert.deepEqual(patch, { price: '100' });
});

test('la cantidad se copia Y recalcula el precio unitario del espejo', () => {
  const { patch } = buildMirrorLiPatch({
    propertyName: 'quantity',
    srcProps: { quantity: '4', costo_total_usd: '400' },
  });
  assert.deepEqual(patch, { quantity: '4', price: '100' });
});

test('prop que no es del espejo → patch vacío y no es espejable', () => {
  assert.equal(isMirrorableLiProp('momento_de_facturacion'), false);
  assert.equal(isMirrorableLiProp(''), false);
  assert.equal(isMirrorableLiProp(undefined), false);
});

// ── pickChangedProps: lo que hace puntual al update del cron ─────────────────

test('sólo devuelve lo que difiere', () => {
  const out = pickChangedProps(
    { name: 'A', description: 'nueva', quantity: '2' },
    { name: 'A', description: 'vieja', quantity: '2' }
  );
  assert.deepEqual(out, { description: 'nueva' });
});

test('120 y 120.0 NO cuentan como cambio (HubSpot devuelve texto)', () => {
  const out = pickChangedProps({ price: '120' }, { price: '120.0' });
  assert.deepEqual(out, {});
});

test('un numérico que sí cambia se escribe', () => {
  const out = pickChangedProps({ price: '120.5' }, { price: '120' });
  assert.deepEqual(out, { price: '120.5' });
});

test('vacío vs valor cuenta como cambio', () => {
  assert.deepEqual(pickChangedProps({ nota: 'x' }, {}), { nota: 'x' });
  assert.deepEqual(pickChangedProps({ nota: '' }, { nota: 'x' }), { nota: '' });
});

test('etiquetas legibles para el texto del aviso', () => {
  assert.equal(labelDeProp('hs_cost_of_goods_sold'), 'costo');
  assert.equal(labelDeProp('quantity'), 'cantidad');
  assert.equal(labelDeProp('price'), 'precio');
  assert.equal(labelDeProp('prop_rara'), 'prop_rara');
});
