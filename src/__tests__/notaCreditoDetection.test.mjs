// src/__tests__/notaCreditoDetection.test.mjs
//
// Detección de NOTA DE CRÉDITO para el aviso al mirror UY.
// Regla: manda el SIGNO del ticket PY (cantidad o subtotal negativos), igual que
// consumeCupo / Paso D; el flag `nc` del LI PY es solo respaldo. Función pura.
//
// Correr con:  node --test src/__tests__/notaCreditoDetection.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isNotaCreditoFromSignals } from '../services/mirrorUtils.js';

test('cantidad_real negativa → es NC (por signo)', () => {
  assert.equal(isNotaCreditoFromSignals({ cantidadReal: '-8', subtotalReal: '500' }), true);
});

test('subtotal_real negativo → es NC (por signo)', () => {
  assert.equal(isNotaCreditoFromSignals({ cantidadReal: '1', subtotalReal: '-300' }), true);
});

test('flag nc=true sin ticket → es NC (respaldo por marca)', () => {
  assert.equal(isNotaCreditoFromSignals({ ncFlag: 'true' }), true);
  assert.equal(isNotaCreditoFromSignals({ ncFlag: 'TRUE' }), true);
});

test('emisión normal (todo positivo, sin flag) → NO es NC', () => {
  assert.equal(isNotaCreditoFromSignals({ cantidadReal: '8', subtotalReal: '500', ncFlag: 'false' }), false);
});

test('sin señales → NO es NC', () => {
  assert.equal(isNotaCreditoFromSignals({}), false);
  assert.equal(isNotaCreditoFromSignals(), false);
});

test('el signo prima aunque el flag venga vacío/ausente', () => {
  assert.equal(isNotaCreditoFromSignals({ subtotalReal: '-1' }), true);
});

test('valores no numéricos se ignoran (no rompen)', () => {
  assert.equal(isNotaCreditoFromSignals({ cantidadReal: '', subtotalReal: 'abc' }), false);
});
