// src/__tests__/shouldNotifyMirrorOnPauseChange.test.mjs
//
// Prueba el gate/transición del aviso al mirror UY cuando una línea PY
// cambia su estado de pausa.
//
// Avisa SOLO si: automático + es PY (no espejo) + uy=true + la pausa
// realmente cambió de estado. Devuelve { paused } o null.
//
// Correr con:  node --test src/__tests__/shouldNotifyMirrorOnPauseChange.test.mjs
//
// No toca HubSpot: shouldNotifyMirrorOnPauseChange es una función pura.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldNotifyMirrorOnPauseChange } from '../phases/phasep.js';

// Helper: line item PY automático con uy=true (caso "feliz" base).
function makeLI(extra = {}) {
  return {
    id: '123',
    properties: {
      facturacion_automatica: 'true',
      uy: 'true',
      ...extra,
    },
  };
}

const PAUSA_ON  = { prop: 'pausa', before: 'false', after: 'true' };
const PAUSA_OFF = { prop: 'pausa', before: 'true',  after: 'false' };

test('transición false → true (se pausa) → avisa con paused=true', () => {
  const res = shouldNotifyMirrorOnPauseChange(makeLI(), PAUSA_ON);
  assert.deepEqual(res, { paused: true });
});

test('transición true → false (se reactiva) → avisa con paused=false', () => {
  const res = shouldNotifyMirrorOnPauseChange(makeLI(), PAUSA_OFF);
  assert.deepEqual(res, { paused: false });
});

test('sin pausaDiff → no avisa (null)', () => {
  assert.equal(shouldNotifyMirrorOnPauseChange(makeLI(), undefined), null);
});

test('pausaDiff sin cambio real (true → true) → no avisa', () => {
  const noCambio = { prop: 'pausa', before: 'true', after: 'true' };
  assert.equal(shouldNotifyMirrorOnPauseChange(makeLI(), noCambio), null);
});

test('no es automático → no avisa', () => {
  const li = makeLI({ facturacion_automatica: 'false' });
  assert.equal(shouldNotifyMirrorOnPauseChange(li, PAUSA_ON), null);
});

test('es un LI espejo (tiene of_line_item_py_origen_id) → no avisa', () => {
  const li = makeLI({ of_line_item_py_origen_id: '999' });
  assert.equal(shouldNotifyMirrorOnPauseChange(li, PAUSA_ON), null);
});

test('uy != true → no avisa', () => {
  const li = makeLI({ uy: 'false' });
  assert.equal(shouldNotifyMirrorOnPauseChange(li, PAUSA_ON), null);
});

test('uy ausente → no avisa', () => {
  const li = makeLI();
  delete li.properties.uy;
  assert.equal(shouldNotifyMirrorOnPauseChange(li, PAUSA_ON), null);
});

test('acepta variantes de booleano de HubSpot (uy="si", auto="1")', () => {
  const li = makeLI({ uy: 'si', facturacion_automatica: '1' });
  assert.deepEqual(shouldNotifyMirrorOnPauseChange(li, PAUSA_ON), { paused: true });
});
