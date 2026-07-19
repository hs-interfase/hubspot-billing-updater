// src/__tests__/valorMargenDesdeTickets.test.mjs
//
// VALOR y MARGEN del negocio calculados desde TICKETS (regla usuaria 2026-07-19).
// Ver la cabecera de src/services/deal/recalcValorTotal.js para el porqué de cada regla.
//
// Lo que se protege acá:
//   1. VALOR = Σ subtotal_real de los tickets (no de line items).
//   2. COSTO = Σ of_costo_usd de EXACTAMENTE los mismos tickets (simetría).
//   3. Auto-renew → solo el año calendario en curso. Plan fijo → todos.
//   4. Un negocio puede mezclar ambos: se clasifica POR TICKET.
//   5. El MIRROR no tiene caso especial: se calcula como cualquier negocio.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ticketsDelCalculo,
  valorLocalDesdeTickets,
  costoUsdDesdeTickets,
} from '../services/deal/recalcValorTotal.js';

const ANIO = 2026;

/** Ticket de PLAN FIJO: tiene nº de pagos. */
const fijo = (subtotal, costoUsd, fecha = '2026-03-15', pagos = 3) => ({
  id: String(Math.random()).slice(2, 8),
  properties: {
    subtotal_real: String(subtotal),
    of_costo_usd: costoUsd == null ? null : String(costoUsd),
    of_cantidad_de_pagos: String(pagos),
    fecha_resolucion_esperada: fecha,
  },
});

/** Ticket de AUTO-RENEW: SIN nº de pagos (marcador). */
const autoRenew = (subtotal, costoUsd, fecha) => ({
  id: String(Math.random()).slice(2, 8),
  properties: {
    subtotal_real: String(subtotal),
    of_costo_usd: costoUsd == null ? null : String(costoUsd),
    of_cantidad_de_pagos: '',
    fecha_resolucion_esperada: fecha,
  },
});

// ─────────────────────────── selección de tickets ───────────────────────────

test('plan fijo: entran TODOS los tickets, sin importar el año', () => {
  const tickets = [
    fijo(100, 10, '2024-05-01'),
    fijo(100, 10, '2026-05-01'),
    fijo(100, 10, '2028-05-01'),
  ];
  const { elegidos } = ticketsDelCalculo(tickets, ANIO);
  assert.equal(elegidos.length, 3, 'el plan fijo no se recorta por año');
});

test('auto-renew: entran SOLO los del año calendario en curso', () => {
  const tickets = [
    autoRenew(100, 10, '2025-12-31'), // año anterior → fuera
    autoRenew(100, 10, '2026-01-01'), // primer día    → dentro
    autoRenew(100, 10, '2026-12-31'), // último día    → dentro
    autoRenew(100, 10, '2027-01-01'), // año siguiente → fuera
  ];
  const { elegidos, autoRenewFuera } = ticketsDelCalculo(tickets, ANIO);
  assert.equal(elegidos.length, 2);
  assert.equal(autoRenewFuera, 2);
});

test('auto-renew mensual de un contrato viejo: 12 tickets del año, no toda la historia', () => {
  const tickets = [];
  for (const anio of [2024, 2025, 2026]) {
    for (let m = 1; m <= 12; m++) {
      tickets.push(autoRenew(1000, 100, `${anio}-${String(m).padStart(2, '0')}-01`));
    }
  }
  const { elegidos } = ticketsDelCalculo(tickets, ANIO);
  assert.equal(elegidos.length, 12, 'run-rate anual = 12 tickets, no 36');
  assert.equal(valorLocalDesdeTickets(elegidos), 12000);
});

test('negocio MIXTO: el plan fijo entra completo y el auto-renew solo el año en curso', () => {
  const tickets = [
    fijo(500, 50, '2024-01-01'),      // fijo viejo → entra igual
    fijo(500, 50, '2027-01-01'),      // fijo futuro → entra igual
    autoRenew(100, 10, '2025-06-01'), // auto-renew fuera de año → NO
    autoRenew(100, 10, '2026-06-01'), // auto-renew del año → sí
  ];
  const { elegidos } = ticketsDelCalculo(tickets, ANIO);
  assert.equal(elegidos.length, 3);
  assert.equal(valorLocalDesdeTickets(elegidos), 1100); // 500 + 500 + 100
});

test('auto-renew SIN fecha: queda fuera (no se puede ubicar en el año)', () => {
  const tickets = [autoRenew(100, 10, null), autoRenew(100, 10, '2026-06-01')];
  const { elegidos, autoRenewFuera } = ticketsDelCalculo(tickets, ANIO);
  assert.equal(elegidos.length, 1);
  assert.equal(autoRenewFuera, 1);
});

// ──────────────────────────────── VALOR ────────────────────────────────

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

test('SIMETRÍA: el costo se suma sobre el mismo conjunto filtrado que el valor', () => {
  const tickets = [
    autoRenew(1000, 400, '2026-01-01'), // dentro
    autoRenew(1000, 400, '2025-01-01'), // FUERA: no debe aportar ni valor ni costo
  ];
  const { elegidos } = ticketsDelCalculo(tickets, ANIO);
  assert.equal(valorLocalDesdeTickets(elegidos), 1000);
  assert.equal(costoUsdDesdeTickets(elegidos), 400, 'el ticket excluido tampoco suma costo');
});

test('ticket sin of_costo_usd cuenta como costo 0 (margen queda inflado, y se avisa)', () => {
  const tickets = [fijo(1000, null), fijo(1000, 300)];
  assert.equal(costoUsdDesdeTickets(tickets), 300);
});

test('MARGEN = VALOR USD − COSTO USD (caso completo, dólar 1:1)', () => {
  const tickets = [fijo(1000, 600), fijo(500, 200)];
  const valor = valorLocalDesdeTickets(tickets); // 1500 (moneda del negocio)
  const costo = costoUsdDesdeTickets(tickets);   // 800 USD
  const dolar = 1;
  assert.equal(Math.round((valor / dolar - costo) * 100) / 100, 700);
});

test('MARGEN con moneda ≠ USD: el valor se divide por el dólar del negocio, el costo ya está en USD', () => {
  const tickets = [fijo(40000, 500)]; // 40.000 en moneda local
  const dolar = 40;                   // 1 USD = 40
  const valorUsd = valorLocalDesdeTickets(tickets) / dolar; // 1000 USD
  const costoUsd = costoUsdDesdeTickets(tickets);           // 500 USD
  assert.equal(valorUsd - costoUsd, 500);
});

// ──────────────────────────────── MIRROR ────────────────────────────────

test('MIRROR: no tiene caso especial — mismos tickets, misma fórmula', () => {
  // El espejo lleva como price el costo del original (regla N-D8), así que sus
  // tickets ya traen el número correcto. Lo intercompany se resuelve en REPORTES.
  const tickets = [fijo(25437, 20000)];
  assert.equal(valorLocalDesdeTickets(tickets), 25437);
  assert.equal(costoUsdDesdeTickets(tickets), 20000);
});

// ──────────────────────────────── borde ────────────────────────────────

test('negocio sin tickets: valor y costo en 0, no explota', () => {
  const { elegidos } = ticketsDelCalculo([], ANIO);
  assert.equal(elegidos.length, 0);
  assert.equal(valorLocalDesdeTickets(elegidos), 0);
  assert.equal(costoUsdDesdeTickets(elegidos), 0);
});
