// src/__tests__/valorMargenDesdeTickets.test.mjs
//
// VALOR y MARGEN del negocio (regla usuaria 2026-07-21, correo Paola 2026-07-02).
// Ver la cabecera de src/services/deal/recalcValorTotal.js para el porqué de cada regla.
//
// Lo que se protege acá:
//   1. Plan fijo / pago único: VALOR = Σ subtotal_real de sus TICKETS (todos, sin recorte
//      por año) y COSTO = Σ of_costo_usd de EXACTAMENTE los mismos tickets (simetría).
//   2. AUTO-RENEW: VALOR = price × quantity × multiplicador anual, desde el LINE ITEM
//      (run-rate al precio vigente). Sus tickets quedan FUERA (serían doble conteo).
//   3. Multiplicador anual: mensual ×12 · trimestral ×4 · semestral ×2 · anual ×1 ·
//      bimestral ×6 · plurianual 12÷meses · semanal/quincenal por días (365÷n).
//   4. Un negocio puede mezclar ambos: tickets del fijo + run-rate del auto-renew.
//   5. El MIRROR no tiene caso especial: se calcula como cualquier negocio.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ticketsDelCalculo,
  valorLocalDesdeTickets,
  costoUsdDesdeTickets,
  valorAutoRenewDesdeLineItems,
  multAnual,
} from '../services/deal/recalcValorTotal.js';

// ───────────────────────────── factories de TICKETS ─────────────────────────────

/** Ticket de PLAN FIJO: frecuencia + nº de pagos. */
const fijo = (subtotal, costoUsd, fecha = '2026-03-15', pagos = 3) => ({
  id: String(Math.random()).slice(2, 8),
  properties: {
    subtotal_real: String(subtotal),
    of_costo_usd: costoUsd == null ? null : String(costoUsd),
    of_cantidad_de_pagos: String(pagos),
    of_frecuencia_de_facturacion: 'Frecuente',
    fecha_resolucion_esperada: fecha,
  },
});

/** Ticket ONE-OFF (manual, pago único): SIN frecuencia y SIN nº de pagos. */
const unico = (subtotal, costoUsd, fecha) => ({
  id: String(Math.random()).slice(2, 8),
  properties: {
    subtotal_real: String(subtotal),
    of_costo_usd: costoUsd == null ? null : String(costoUsd),
    of_cantidad_de_pagos: '',
    of_frecuencia_de_facturacion: 'Único',
    fecha_resolucion_esperada: fecha,
  },
});

/** Ticket de AUTO-RENEW: CON frecuencia y SIN nº de pagos. */
const tktAutoRenew = (subtotal, costoUsd, fecha) => ({
  id: String(Math.random()).slice(2, 8),
  properties: {
    subtotal_real: String(subtotal),
    of_costo_usd: costoUsd == null ? null : String(costoUsd),
    of_cantidad_de_pagos: '',
    of_frecuencia_de_facturacion: 'Frecuente',
    fecha_resolucion_esperada: fecha,
  },
});

// ───────────────────────────── factories de LINE ITEMS ─────────────────────────────

/** LI AUTO-RENEW: frecuencia sin nº de pagos. */
const liAutoRenew = (price, qty, freq = 'monthly', costoUsd = null) => ({
  id: String(Math.random()).slice(2, 8),
  properties: {
    price: String(price),
    quantity: qty == null ? '' : String(qty),
    recurringbillingfrequency: freq,
    hs_recurring_billing_number_of_payments: '',
    costo_total_usd: costoUsd == null ? '' : String(costoUsd),
  },
});

/** LI de PLAN FIJO: frecuencia + nº de pagos (NO aporta al run-rate). */
const liFijo = (price, qty = 1, freq = 'monthly', pagos = 12) => ({
  id: String(Math.random()).slice(2, 8),
  properties: {
    price: String(price),
    quantity: String(qty),
    recurringbillingfrequency: freq,
    hs_recurring_billing_number_of_payments: String(pagos),
    costo_total_usd: '',
  },
});

/** LI de PAGO ÚNICO: sin frecuencia (NO aporta al run-rate). */
const liUnico = (price) => ({
  id: String(Math.random()).slice(2, 8),
  properties: {
    price: String(price),
    quantity: '1',
    recurringbillingfrequency: '',
    hs_recurring_billing_number_of_payments: '',
    costo_total_usd: '',
  },
});

// ─────────────────────────── multiplicador anual ───────────────────────────

test('multAnual: las 4 frecuencias definidas por la usuaria', () => {
  assert.equal(multAnual('monthly'), 12);
  assert.equal(multAnual('quarterly'), 4);
  assert.equal(multAnual('per_six_months'), 2);
  assert.equal(multAnual('annually'), 1);
});

test('multAnual: también acepta los labels en español', () => {
  assert.equal(multAnual('mensual'), 12);
  assert.equal(multAnual('trimestral'), 4);
  assert.equal(multAnual('semestral'), 2);
  assert.equal(multAnual('anual'), 1);
});

test('multAnual: frecuencias no estándar → 12÷meses genérico y fallback por días', () => {
  assert.equal(multAnual('bimestral'), 6);            // 12 ÷ 2
  assert.equal(multAnual('per_two_years'), 0.5);      // 12 ÷ 24
  assert.equal(multAnual('per_three_years'), 12 / 36);
  assert.equal(multAnual('weekly'), 365 / 7);
  assert.equal(multAnual('biweekly'), 365 / 14);
});

test('multAnual: frecuencia no mapeable → null (no se inventa)', () => {
  assert.equal(multAnual('cualquier cosa'), null);
  assert.equal(multAnual(''), null);
  assert.equal(multAnual(null), null);
});

// ─────────────────────────── selección de tickets ───────────────────────────

test('plan fijo: entran TODOS los tickets, sin importar el año', () => {
  const tickets = [
    fijo(100, 10, '2024-05-01'),
    fijo(100, 10, '2026-05-01'),
    fijo(100, 10, '2028-05-01'),
  ];
  const { elegidos } = ticketsDelCalculo(tickets);
  assert.equal(elegidos.length, 3, 'el plan fijo no se recorta por año');
});

test('auto-renew: sus tickets quedan TODOS fuera (los reemplaza el run-rate del LI)', () => {
  const tickets = [
    tktAutoRenew(100, 10, '2025-12-31'),
    tktAutoRenew(100, 10, '2026-01-01'), // también fuera: antes entraba por año en curso
    tktAutoRenew(100, 10, '2026-12-31'),
    tktAutoRenew(100, 10, '2027-01-01'),
  ];
  const { elegidos, autoRenewExcluidos } = ticketsDelCalculo(tickets);
  assert.equal(elegidos.length, 0);
  assert.equal(autoRenewExcluidos, 4);
});

test('ONE-OFF sin frecuencia NI nº de pagos: NO es auto-renew, entra aunque sea de otro año', () => {
  // Regresión 19-jul: mirar solo `of_cantidad_de_pagos` clasificaba estos como
  // auto-renew y los borraba del VALOR.
  const tickets = [unico(40000, 250, '2028-01-02')];
  const { elegidos } = ticketsDelCalculo(tickets);
  assert.equal(elegidos.length, 1, 'un pago único a futuro NO se excluye');
  assert.equal(valorLocalDesdeTickets(elegidos), 40000);
});

// ──────────────────────────── VALOR auto-renew desde el LI ────────────────────────────

test('AUTO-RENEW mensual: price × qty × 12 (caso Paola: 22.000 → 264.000)', () => {
  const { totalLocal } = valorAutoRenewDesdeLineItems([liAutoRenew(22000, 1, 'monthly')]);
  assert.equal(totalLocal, 264000);
});

test('AUTO-RENEW con cantidad: 5 licencias × 100 mensual = 6.000 anual', () => {
  const { totalLocal } = valorAutoRenewDesdeLineItems([liAutoRenew(100, 5, 'monthly')]);
  assert.equal(totalLocal, 6000);
});

test('AUTO-RENEW quantity vacía cuenta como 1 (regla de María)', () => {
  const { totalLocal } = valorAutoRenewDesdeLineItems([liAutoRenew(1000, null, 'quarterly')]);
  assert.equal(totalLocal, 4000);
});

test('AUTO-RENEW trimestral/semestral/anual', () => {
  assert.equal(valorAutoRenewDesdeLineItems([liAutoRenew(9000, 1, 'quarterly')]).totalLocal, 36000);
  assert.equal(valorAutoRenewDesdeLineItems([liAutoRenew(18000, 1, 'per_six_months')]).totalLocal, 36000);
  assert.equal(valorAutoRenewDesdeLineItems([liAutoRenew(36000, 1, 'annually')]).totalLocal, 36000);
});

test('AUTO-RENEW: el COSTO del LI (por pago) se anualiza con el mismo multiplicador', () => {
  const { totalLocal, costoUsd } = valorAutoRenewDesdeLineItems([
    liAutoRenew(20000, 1, 'monthly', 250),
  ]);
  assert.equal(totalLocal, 240000);
  assert.equal(costoUsd, 3000, '250 USD por pago × 12');
});

test('AUTO-RENEW con frecuencia no mapeable: no aporta y se cuenta en sinMult', () => {
  const { totalLocal, sinMult, cuenta } = valorAutoRenewDesdeLineItems([
    liAutoRenew(1000, 1, 'frecuencia rara'),
    liAutoRenew(500, 1, 'monthly'),
  ]);
  assert.equal(totalLocal, 6000, 'solo el mensual aporta');
  assert.equal(sinMult, 1);
  assert.equal(cuenta, 1);
});

test('LIs de plan fijo y pago único NO aportan al run-rate (van por tickets)', () => {
  const { totalLocal, cuenta } = valorAutoRenewDesdeLineItems([
    liFijo(2000, 1, 'monthly', 12),
    liUnico(40000),
  ]);
  assert.equal(totalLocal, 0);
  assert.equal(cuenta, 0);
});

test('el flag renovacion_automatica=false gana sobre la heurística de frecuencia', () => {
  const li = liAutoRenew(1000, 1, 'monthly');
  li.properties.renovacion_automatica = 'false';
  const { totalLocal } = valorAutoRenewDesdeLineItems([li]);
  assert.equal(totalLocal, 0);
});

// ──────────────────────────────── VALOR tickets ────────────────────────────────

test('VALOR = suma de subtotal_real de los tickets elegidos', () => {
  const tickets = [fijo(1200.50, 0), fijo(799.50, 0), fijo(1000, 0)];
  assert.equal(valorLocalDesdeTickets(tickets), 3000);
});

test('VALOR: un ticket sin subtotal_real no rompe, simplemente no suma', () => {
  const t = fijo(100, 10);
  t.properties.subtotal_real = null;
  assert.equal(valorLocalDesdeTickets([t, fijo(250, 10)]), 250);
});

test('VALOR: las NC (subtotal negativo) RESTAN', () => {
  const nc = fijo(-300, 0);
  assert.equal(valorLocalDesdeTickets([fijo(1000, 0), nc]), 700);
});

// ──────────────────────────────── COSTO / MARGEN ────────────────────────────────

test('COSTO = suma de of_costo_usd de LOS MISMOS tickets', () => {
  const tickets = [fijo(1000, 250), fijo(1000, 250), fijo(1000, 100)];
  assert.equal(costoUsdDesdeTickets(tickets), 600);
});

test('SIMETRÍA: un ticket auto-renew excluido no aporta ni valor ni costo', () => {
  const tickets = [
    fijo(1000, 400),
    tktAutoRenew(1000, 400, '2026-01-01'), // FUERA: ni valor ni costo (va por el LI)
  ];
  const { elegidos } = ticketsDelCalculo(tickets);
  assert.equal(valorLocalDesdeTickets(elegidos), 1000);
  assert.equal(costoUsdDesdeTickets(elegidos), 400, 'el ticket excluido tampoco suma costo');
});

test('ticket sin of_costo_usd cuenta como costo 0 (margen queda inflado, y se avisa)', () => {
  const tickets = [fijo(1000, null), fijo(1000, 300)];
  assert.equal(costoUsdDesdeTickets(tickets), 300);
});

test('MARGEN con moneda ≠ USD: el valor se divide por el dólar del negocio, el costo ya está en USD', () => {
  const tickets = [fijo(40000, 500)]; // 40.000 en moneda local
  const dolar = 40;                   // 1 USD = 40
  const valorUsd = valorLocalDesdeTickets(tickets) / dolar; // 1000 USD
  const costoUsd = costoUsdDesdeTickets(tickets);           // 500 USD
  assert.equal(valorUsd - costoUsd, 500);
});

// ──────────────────────────────── MIRROR ────────────────────────────────

test('MIRROR: no tiene caso especial — misma fórmula que cualquier negocio', () => {
  // El espejo lleva como price el costo del original (regla N-D8), así que sus
  // tickets/LIs ya traen el número correcto. Lo intercompany se resuelve en REPORTES.
  const tickets = [fijo(25437, 20000)];
  assert.equal(valorLocalDesdeTickets(tickets), 25437);
  assert.equal(costoUsdDesdeTickets(tickets), 20000);
});

// ──────────────────────────────── borde ────────────────────────────────

test('negocio sin tickets ni LIs: valor y costo en 0, no explota', () => {
  const { elegidos } = ticketsDelCalculo([]);
  assert.equal(elegidos.length, 0);
  assert.equal(valorLocalDesdeTickets(elegidos), 0);
  assert.equal(costoUsdDesdeTickets(elegidos), 0);
  const ar = valorAutoRenewDesdeLineItems([]);
  assert.equal(ar.totalLocal, 0);
  assert.equal(ar.costoUsd, 0);
});

// ─────────── caso completo: negocio MIXTO (actualiza el caso usuaria 19-jul) ───────────

test('CASO COMPLETO: 3 one-off + auto-renew mensual + plan fijo histórico, dólar 40', () => {
  // 3 manuales one-off al 2-ene-2028: 40.000 c/u, costo 250 USD c/u  → por TICKETS
  // plan fijo 12 pagos de 2.000 durante 2023-2024                   → por TICKETS
  // auto-renew mensual 20.000 (contrato viejo, precio vigente 20.000) → por LINE ITEM
  const tickets = [
    unico(40000, 250, '2028-01-02'),
    unico(40000, 250, '2028-01-02'),
    unico(40000, 250, '2028-01-02'),
    // los tickets del auto-renew existen pero NO cuentan (ni 2025 ni 2026):
    ...Array.from({ length: 12 }, (_, i) =>
      tktAutoRenew(20000, null, `2026-${String(i + 1).padStart(2, '0')}-01`)),
    ...Array.from({ length: 12 }, (_, i) =>
      tktAutoRenew(20000, null, `2025-${String(i + 1).padStart(2, '0')}-01`)),
    ...Array.from({ length: 12 }, (_, i) =>
      fijo(2000, null, `2024-${String(i + 1).padStart(2, '0')}-01`, 12)),
  ];
  const lineItems = [liAutoRenew(20000, 1, 'monthly')];

  const { elegidos, autoRenewExcluidos } = ticketsDelCalculo(tickets);
  assert.equal(elegidos.length, 3 + 12, 'los 24 tickets auto-renew quedan fuera');
  assert.equal(autoRenewExcluidos, 24);

  const ar = valorAutoRenewDesdeLineItems(lineItems);
  const dolar = 40;
  const valorLocal = Math.round((valorLocalDesdeTickets(elegidos) + ar.totalLocal) * 100) / 100;
  const valorUsd = Math.round((valorLocal / dolar) * 100) / 100;
  const costoUsd = costoUsdDesdeTickets(elegidos) + ar.costoUsd;
  const margen = Math.round((valorUsd - costoUsd) * 100) / 100;

  // 120.000 (one-off) + 24.000 (fijo) + 240.000 (run-rate 20.000×12) = 384.000
  // → mismo total que el caso de la usuaria del 19-jul: el run-rate anual del LI
  //   equivale a los 12 tickets del año cuando el precio no cambió en el año.
  assert.equal(valorLocal, 384000);
  assert.equal(valorUsd, 9600);
  assert.equal(costoUsd, 750);
  assert.equal(margen, 8850);
});
