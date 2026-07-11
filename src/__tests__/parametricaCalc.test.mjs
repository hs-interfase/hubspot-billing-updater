// node --test src/__tests__/parametricaCalc.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calcularPriceNuevo, validarPorcentaje } from '../services/parametrica/calc.js';

test('calcularPriceNuevo: casos base', () => {
  assert.equal(calcularPriceNuevo(5000, 0.4264), 5021.32); // ejemplo real Petróleo ene-2026
  assert.equal(calcularPriceNuevo(100, 10), 110);
  assert.equal(calcularPriceNuevo(100, 7.5), 107.5);
  assert.equal(calcularPriceNuevo(100, -12), 88);
});

test('calcularPriceNuevo: redondeo a 2 decimales', () => {
  assert.equal(calcularPriceNuevo(100.005, 10), 110.01);
  assert.equal(calcularPriceNuevo(33.335, 10), 36.67);
  assert.equal(calcularPriceNuevo(0.01, 10), 0.01);
  assert.equal(calcularPriceNuevo(1234.56, 3.33), 1275.67);
});

test('calcularPriceNuevo: precios negativos (notas de crédito)', () => {
  assert.equal(calcularPriceNuevo(-500, 10), -550);
  assert.equal(calcularPriceNuevo(-33.335, 10), -36.67);
});

test('la reversa no puede usar el % inverso (redondeo no reversible)', () => {
  // Justifica guardar price_viejo en DB: aplicar el inverso matemático
  // sobre el precio redondeado NO devuelve el original.
  const original = 33.33;
  const pct = 7.77;
  const ajustado = calcularPriceNuevo(original, pct);
  const inverso = calcularPriceNuevo(ajustado, -pct / (1 + pct / 100) * 100);
  assert.notEqual(inverso, original);
});

test('validarPorcentaje: rechazos', () => {
  assert.equal(validarPorcentaje(NaN).ok, false);
  assert.equal(validarPorcentaje('').ok, false);
  assert.equal(validarPorcentaje('abc').ok, false);
  assert.equal(validarPorcentaje(0).ok, false);
  assert.equal(validarPorcentaje(-100).ok, false);
  assert.equal(validarPorcentaje(null).ok, false);
});

test('validarPorcentaje: acepta números y strings con coma', () => {
  assert.deepEqual(validarPorcentaje(7.5), { ok: true, pct: 7.5 });
  assert.deepEqual(validarPorcentaje('7,5'), { ok: true, pct: 7.5 });
  assert.deepEqual(validarPorcentaje(-15), { ok: true, pct: -15 });
});

test('validarPorcentaje: warning sobre umbral', () => {
  const r = validarPorcentaje(31, 30);
  assert.equal(r.ok, true);
  assert.ok(r.warning);
  assert.equal(validarPorcentaje(30, 30).warning, undefined);
  assert.ok(validarPorcentaje(-45, 30).warning);
});
