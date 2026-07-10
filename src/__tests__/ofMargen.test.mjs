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

// ── Definición 2026-07-07 + copia-directa 2026-07-10: costo_total_usd = fuente de verdad ──

test('negocio PYG: of_costo = costo_total_usd × dolar, of_costo_usd = costo_total_usd', () => {
  const dealPyg = { properties: { deal_currency_code: 'PYG' } };
  const li = makeLI({
    price: '81923077', quantity: '1', amount: '81923077',
    costo_total_usd: '6498', dolar: '6870.38',
    hs_cost_of_goods_sold: '44643729.24', // derivada (guaraníes) — NO debe ser la fuente
  });
  const snap = extractLineItemSnapshots(li, dealPyg);
  assert.equal(snap.of_costo_usd, 6498);
  assert.ok(Math.abs(snap.of_costo - 6498 * 6870.38) < 0.01);      // guaraníes
  assert.ok(Math.abs(snap.of_margen - (81923077 - 6498 * 6870.38)) < 0.01);
});

test('escenario F resuelto: cogs aún 0 pero costo_total_usd presente → of_costo NO queda 0', () => {
  const dealUsd = { properties: { deal_currency_code: 'USD' } };
  const li = makeLI({
    price: '2000', quantity: '1', amount: '2000',
    costo_total_usd: '100', dolar: '1',
    hs_cost_of_goods_sold: '0', // la derivación corre después en la misma corrida
  });
  const snap = extractLineItemSnapshots(li, dealUsd);
  assert.equal(snap.of_costo, 100);
  assert.equal(snap.of_costo_usd, 100);
  assert.equal(snap.of_margen, 1900);
});

test('sin costo_total_usd: of_costo = cogs × cantidad; of_costo_usd = null (NO se deriva del cogs)', () => {
  const liUsd = makeLI({ price: '100', quantity: '2', hs_cost_of_goods_sold: '40', amount: '200' });
  const snapUsd = extractLineItemSnapshots(liUsd, { properties: { deal_currency_code: 'USD' } });
  assert.equal(snapUsd.of_costo, 80);        // cogs × cantidad, moneda del negocio
  assert.equal(snapUsd.of_costo_usd, null);  // copia-directa: sin costo_total_usd no se adivina el USD
});

// ── Intercompany (regla informes 2026-07-07): FACT 0 / MB con valor ─────────

test('deal espejo (es_mirror_de_py) → ticket nace con of_intercompany=true', () => {
  const dealEspejo = { properties: { deal_currency_code: 'USD', es_mirror_de_py: 'true' } };
  const li = makeLI({ price: '300', quantity: '1', amount: '300', costo_total_usd: '200', dolar: '1' });
  const snap = extractLineItemSnapshots(li, dealEspejo);
  assert.equal(snap.of_intercompany, 'true');
  // el MARGEN del espejo sí vale (monto UY − costo real UY); FACT 0 lo aplica la calc prop of_facturacion_usd
  assert.equal(snap.of_margen, 100);
});

test('deal normal → of_intercompany=false explícito', () => {
  const li = makeLI({ price: '100', quantity: '1', amount: '100' });
  assert.equal(extractLineItemSnapshots(li, deal).of_intercompany, 'false');
  assert.equal(extractLineItemSnapshots(li, { properties: { es_mirror_de_py: 'false' } }).of_intercompany, 'false');
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
