// src/__tests__/consumeCupo.test.mjs
//
// Prueba el cálculo puro de consumo de cupo, con foco en NOTAS DE CRÉDITO.
// Regla clave: una NC se detecta por el SIGNO NEGATIVO del consumo (no por la
// marca `nc`), y DEVUELVE cupo (resta a cupo_consumido, suma a cupo_restante).
//
// Correr con:  node --test src/__tests__/consumeCupo.test.mjs
//
// No toca HubSpot: calcularConsumoCupo es una función pura sobre properties.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calcularConsumoCupo } from '../services/cupo/consumeCupo.js';

// ---------- Cupo Por Monto ----------

test('Por Monto: consumo positivo resta del cupo restante', () => {
  const r = calcularConsumoCupo({
    tipoCupo: 'Por Monto',
    dealProps: { cupo_total_monto: '1000', cupo_consumido: '200' },
    ticketProps: { subtotal_real: '300' },
  });
  assert.equal(r.ok, true);
  assert.equal(r.consumo, 300);
  assert.equal(r.cupoConsumidoNuevo, 500);   // 200 + 300
  assert.equal(r.cupoRestanteNuevo, 500);    // 1000 - 500
  assert.equal(r.cupoDeactivated, false);
});

test('NC Por Monto: subtotal_real negativo DEVUELVE cupo (resta consumido)', () => {
  const r = calcularConsumoCupo({
    tipoCupo: 'Por Monto',
    dealProps: { cupo_total_monto: '1000', cupo_consumido: '500' },
    ticketProps: { subtotal_real: '-300' },   // nota de crédito
  });
  assert.equal(r.ok, true);
  assert.equal(r.consumo, -300);
  assert.equal(r.cupoConsumidoNuevo, 200);   // 500 + (-300) → devuelve 300
  assert.equal(r.cupoRestanteNuevo, 800);    // 1000 - 200
  assert.equal(r.cupoDeactivated, false);
});

// ---------- Cupo Por Horas ----------

test('Por Horas: usa total_de_horas_consumidas cuando la cantidad es positiva', () => {
  const r = calcularConsumoCupo({
    tipoCupo: 'Por Horas',
    dealProps: { cupo_total: '40', cupo_consumido: '10' },
    ticketProps: { total_de_horas_consumidas: '8', cantidad_real: '8' },
  });
  assert.equal(r.ok, true);
  assert.equal(r.consumo, 8);
  assert.equal(r.cupoConsumidoNuevo, 18);
  assert.equal(r.cupoRestanteNuevo, 22);
});

test('NC Por Horas: cantidad_real negativa manda aunque las horas vengan positivas', () => {
  // Escenario de edición manual: el ticket viejo trae horas=8 pero se corrige la
  // cantidad_real a -8 para acreditar. El signo negativo debe primar.
  const r = calcularConsumoCupo({
    tipoCupo: 'Por Horas',
    dealProps: { cupo_total: '40', cupo_consumido: '18' },
    ticketProps: { total_de_horas_consumidas: '8', cantidad_real: '-8' },
  });
  assert.equal(r.ok, true);
  assert.equal(r.consumo, -8);               // el negativo prima sobre las horas
  assert.equal(r.cupoConsumidoNuevo, 10);    // 18 + (-8)
  assert.equal(r.cupoRestanteNuevo, 30);     // 40 - 10
});

// ---------- Agotamiento / desactivación ----------

test('cupoDeactivated=true cuando el restante llega a 0 o menos', () => {
  const r = calcularConsumoCupo({
    tipoCupo: 'Por Monto',
    dealProps: { cupo_total_monto: '1000', cupo_consumido: '900' },
    ticketProps: { subtotal_real: '150' },   // 900 + 150 = 1050 > 1000
  });
  assert.equal(r.ok, true);
  assert.equal(r.cupoRestanteNuevo, -50);
  assert.equal(r.cupoDeactivated, true);
});

// ---------- Validaciones (consumo inválido) ----------

test('consumo 0 es inválido (no consume)', () => {
  const r = calcularConsumoCupo({
    tipoCupo: 'Por Monto',
    dealProps: { cupo_total_monto: '1000', cupo_consumido: '0' },
    ticketProps: { subtotal_real: '0' },
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /consumo inválido/);
});

test('tipo_de_cupo desconocido es rechazado', () => {
  const r = calcularConsumoCupo({
    tipoCupo: 'Por Banana',
    dealProps: {},
    ticketProps: {},
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /tipo_de_cupo desconocido/);
});

// ---------- Documenta el GAP conocido: sin clamp a >= 0 ----------

test('GAP conocido: una NC mayor a lo consumido deja cupo_consumido NEGATIVO (no se clampa)', () => {
  // El código NO protege contra sobre-crédito: si se acredita más de lo consumido,
  // cupo_consumido queda negativo. El tutorial lo advierte como responsabilidad del
  // usuario. Este test DOCUMENTA el comportamiento actual (cámbialo si se agrega clamp).
  const r = calcularConsumoCupo({
    tipoCupo: 'Por Monto',
    dealProps: { cupo_total_monto: '1000', cupo_consumido: '100' },
    ticketProps: { subtotal_real: '-300' },   // acredita más de lo consumido
  });
  assert.equal(r.ok, true);
  assert.equal(r.cupoConsumidoNuevo, -200);  // 100 + (-300) → negativo, sin clamp
  assert.equal(r.cupoRestanteNuevo, 1200);   // 1000 - (-200) → cupo "inflado"
});
