// src/__tests__/ofMargen.test.mjs
//
// Prueba el cálculo de of_margen en el snapshot del ticket.
// Foco: of_margen = montoTotal (subtotal PRE-IVA = lp.amount) − costoTotal
//       (costo unitario × cantidad). Ya NO debe leer lp.hs_margin.
//
// Correr con:  node --test src/__tests__/ofMargen.test.mjs
//
// No toca HubSpot: extractLineItemSnapshots es una función pura sobre properties.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractLineItemSnapshots } from '../services/snapshotService.js';

const makeLI = (props) => ({ id: '999', properties: props });
const deal = { properties: {} };

test('of_margen = amount − (costo unitario × cantidad)', () => {
  const li = makeLI({ price: '100', quantity: '10', hs_cost_of_goods_sold: '30', amount: '1000' });
  const snap = extractLineItemSnapshots(li, deal);
  assert.equal(snap.of_costo, 300);   // 30 × 10
  assert.equal(snap.of_margen, 700);  // 1000 − 300
});

test('ignora hs_margin (ya no se usa esa fuente)', () => {
  // Aunque venga hs_margin con un valor, of_margen se calcula como monto − costo.
  const li = makeLI({ price: '100', quantity: '2', hs_cost_of_goods_sold: '40', amount: '200', hs_margin: '999' });
  const snap = extractLineItemSnapshots(li, deal);
  assert.equal(snap.of_margen, 120);  // 200 − (40 × 2), NO 999
});

test('sin costo → margen = monto completo (caso a vigilar: costo no cargado)', () => {
  const li = makeLI({ price: '500', quantity: '1', amount: '500' }); // sin hs_cost_of_goods_sold
  const snap = extractLineItemSnapshots(li, deal);
  assert.equal(snap.of_costo, 0);
  assert.equal(snap.of_margen, 500); // sobreestimado por falta de costo
});
