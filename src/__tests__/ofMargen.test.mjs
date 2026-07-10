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

// of_costo_usd = copia DIRECTA de costo_total_usd del LI (editable; sin derivar → sin carrera).
test('of_costo_usd = costo_total_usd del line item (copia directa)', () => {
  const li = makeLI({ price: '100', quantity: '10', amount: '1000', costo_total_usd: '305' });
  const snap = extractLineItemSnapshots(li, deal);
  assert.equal(snap.of_costo_usd, 305);
});

test('of_costo_usd = null si el LI no tiene costo_total_usd (costo no cargado, editable)', () => {
  const li = makeLI({ price: '100', quantity: '1', amount: '100' });
  const snap = extractLineItemSnapshots(li, deal);
  assert.equal(snap.of_costo_usd, null);
});

// TC sellado del ticket: alimenta la conversión USD de facturación/margen (of_margen_usd calc).
test('dolar del ticket = dolar de la LÍNEA', () => {
  const li = makeLI({ price: '100', quantity: '1', amount: '100', dolar: '40.17' });
  const snap = extractLineItemSnapshots(li, deal);
  assert.equal(snap.dolar, 40.17);
});

test('dolar del ticket cae al dolar del NEGOCIO si la línea no lo tiene', () => {
  const li = makeLI({ price: '100', quantity: '1', amount: '100' }); // sin dolar en el LI
  const dealConDolar = { properties: { dolar: '6043.31' } };
  const snap = extractLineItemSnapshots(li, dealConDolar);
  assert.equal(snap.dolar, 6043.31);
});

test('dolar del ticket = null si no hay ni en línea ni en negocio (calc cae al fallback fx)', () => {
  const li = makeLI({ price: '100', quantity: '1', amount: '100' });
  const snap = extractLineItemSnapshots(li, deal);
  assert.equal(snap.dolar, null);
});
