// src/__tests__/resolveCancellationBranch.test.mjs
//
// Bifurcación cancel/revert (bloque 2 del flujo cancelar/revertir):
//   - resolveCancellationBranch (helper puro de propagacion/invoice.js)
//   - llaves CANCEL_REVERT_FLOW_ENABLED / CUPO_REVERT_ON_CANCEL_ENABLED
//     (evaluación POR LLAMADA — no depende del orden de import)
//
// Requiere DATABASE_URL dummy (el grafo de imports de propagacion/invoice.js
// carga src/db.js).
//   DATABASE_URL='postgres://u:p@localhost:5432/x' node --test src/__tests__/resolveCancellationBranch.test.mjs

process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/x';

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { resolveCancellationBranch } = await import('../propagacion/invoice.js');
const { cancelRevertFlowEnabled, cupoRevertOnCancelEnabled } =
  await import('../config/cancelRevertFlags.js');

// ═════════════════════════════════════════════════════════════════════════════
// resolveCancellationBranch (puro)
// ═════════════════════════════════════════════════════════════════════════════

test('cancelIntent null → revert (comportamiento actual)', () => {
  assert.equal(resolveCancellationBranch({ cancelIntent: null }), 'revert');
});

test("cancelIntent 'revert' → revert", () => {
  assert.equal(resolveCancellationBranch({ cancelIntent: 'revert' }), 'revert');
});

test("cancelIntent 'cancel' → cancel", () => {
  assert.equal(resolveCancellationBranch({ cancelIntent: 'cancel' }), 'cancel');
});

test('sin argumento / undefined / basura → revert (default seguro)', () => {
  assert.equal(resolveCancellationBranch(), 'revert');
  assert.equal(resolveCancellationBranch({}), 'revert');
  assert.equal(resolveCancellationBranch({ cancelIntent: undefined }), 'revert');
  assert.equal(resolveCancellationBranch({ cancelIntent: 'CANCEL' }), 'revert');
  assert.equal(resolveCancellationBranch({ cancelIntent: 'cancelar' }), 'revert');
});

// ═════════════════════════════════════════════════════════════════════════════
// Llaves — default OFF; solo 'true'/'1'/'yes' prenden (al revés que
// DEAL_ALERTS_ENABLED: acá lo seguro es apagado). Evaluación por llamada.
// ═════════════════════════════════════════════════════════════════════════════

const FLAGS = [
  ['CANCEL_REVERT_FLOW_ENABLED', cancelRevertFlowEnabled],
  ['CUPO_REVERT_ON_CANCEL_ENABLED', cupoRevertOnCancelEnabled],
];

const ORIGINALS = Object.fromEntries(FLAGS.map(([name]) => [name, process.env[name]]));

test('default (env ausente o vacía) → OFF', () => {
  for (const [name, enabled] of FLAGS) {
    delete process.env[name];
    assert.equal(enabled(), false, `${name} ausente`);
    process.env[name] = '';
    assert.equal(enabled(), false, `${name} vacía`);
  }
});

test("'true' / '1' / 'yes' (con trim y case-insensitive) → ON", () => {
  for (const [name, enabled] of FLAGS) {
    for (const v of ['true', '1', 'yes', ' TRUE ', 'Yes']) {
      process.env[name] = v;
      assert.equal(enabled(), true, `${name}=${JSON.stringify(v)}`);
    }
  }
});

test("cualquier otro valor ('false', '0', 'no', basura) → OFF", () => {
  for (const [name, enabled] of FLAGS) {
    for (const v of ['false', '0', 'no', 'on', 'si', 'enabled', 'truee']) {
      process.env[name] = v;
      assert.equal(enabled(), false, `${name}=${JSON.stringify(v)}`);
    }
  }
});

test('las dos llaves son independientes', () => {
  process.env.CANCEL_REVERT_FLOW_ENABLED = 'true';
  delete process.env.CUPO_REVERT_ON_CANCEL_ENABLED;
  assert.equal(cancelRevertFlowEnabled(), true);
  assert.equal(cupoRevertOnCancelEnabled(), false);

  delete process.env.CANCEL_REVERT_FLOW_ENABLED;
  process.env.CUPO_REVERT_ON_CANCEL_ENABLED = 'true';
  assert.equal(cancelRevertFlowEnabled(), false);
  assert.equal(cupoRevertOnCancelEnabled(), true);
});

test('restore flags', () => {
  for (const [name] of FLAGS) {
    if (ORIGINALS[name] === undefined) delete process.env[name];
    else process.env[name] = ORIGINALS[name];
  }
});
