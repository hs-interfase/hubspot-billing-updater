// src/__tests__/phaseR.test.mjs
//
// Prueba la ORQUESTACIÓN de Phase R (runPhaseR), no los writers.
// Los writers (syncBillingState / recalcDerivedFacturas) son producción ya
// ejercitada; acá se inyectan mocks para verificar SOLO la lógica del loop:
//   - llama a ambos writers una vez por line item con line_item_key
//   - saltea los line items sin line_item_key (o sin id)
//   - un error en un writer no bloquea el resto (cuenta el error y sigue)
//   - propaga dealId / lineItemId / dealIsCanceled:false a los writers
//
// Correr con:  node --test src/__tests__/phaseR.test.mjs
//
// No toca HubSpot: runPhaseR recibe los writers por inyección de dependencias.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { runPhaseR } from '../phases/index.js';

// Helper: arma un line item falso.
function makeLI(id, props = {}) {
  return { id, properties: props };
}

// Helper: corre runPhaseR con writers mock y devuelve { result, sync, derived }.
async function run(lineItems, { syncImpl, derivedImpl } = {}) {
  const sync = mock.fn(syncImpl || (async () => {}));
  const derived = mock.fn(derivedImpl || (async () => ({})));
  const result = await runPhaseR({
    dealId: 'DEAL1',
    lineItems,
    hubspotClient: { tag: 'fake-client' },
    syncBillingStateFn: sync,
    recalcDerivedFacturasFn: derived,
  });
  return { result, sync, derived };
}

test('llama a ambos writers una vez por LI con line_item_key', async () => {
  const lineItems = [
    makeLI('1', { line_item_key: 'LIK-1' }),
    makeLI('2', { line_item_key: 'LIK-2' }),
  ];
  const { result, sync, derived } = await run(lineItems);

  assert.deepEqual(result, { processed: 2, skipped: 0, errors: 0 });
  assert.equal(sync.mock.callCount(), 2);
  assert.equal(derived.mock.callCount(), 2);
});

test('saltea LIs sin line_item_key (no llama writers para esos)', async () => {
  const lineItems = [
    makeLI('1', { line_item_key: 'LIK-1' }),
    makeLI('2', { line_item_key: '   ' }), // vacío tras trim → skip
    makeLI('3', {}),                        // sin la prop → skip
  ];
  const { result, sync, derived } = await run(lineItems);

  assert.deepEqual(result, { processed: 1, skipped: 2, errors: 0 });
  assert.equal(sync.mock.callCount(), 1);
  assert.equal(derived.mock.callCount(), 1);
});

test('saltea LI sin id (ni id ni hs_object_id)', async () => {
  const lineItems = [
    { properties: { line_item_key: 'LIK-1' } }, // sin id
    makeLI('2', { line_item_key: 'LIK-2' }),
  ];
  const { result } = await run(lineItems);

  assert.deepEqual(result, { processed: 1, skipped: 1, errors: 0 });
});

test('usa hs_object_id cuando no hay li.id', async () => {
  const lineItems = [
    { properties: { hs_object_id: '99', line_item_key: 'LIK-9' } },
  ];
  const { result, sync } = await run(lineItems);

  assert.deepEqual(result, { processed: 1, skipped: 0, errors: 0 });
  assert.equal(sync.mock.calls[0].arguments[0].lineItemId, '99');
});

test('un error en un writer NO bloquea el resto', async () => {
  const lineItems = [
    makeLI('1', { line_item_key: 'LIK-1' }),
    makeLI('2', { line_item_key: 'LIK-2' }), // este falla
    makeLI('3', { line_item_key: 'LIK-3' }),
  ];
  // syncBillingState falla solo para el LI '2'
  const syncImpl = async ({ lineItemId }) => {
    if (lineItemId === '2') throw new Error('boom');
  };
  const { result, derived } = await run(lineItems, { syncImpl });

  assert.deepEqual(result, { processed: 2, skipped: 0, errors: 1 });
  // El LI que falló en sync no debe llamar a derived; los otros 2 sí.
  assert.equal(derived.mock.callCount(), 2);
});

test('propaga dealId, lineItemId y dealIsCanceled:false a los writers', async () => {
  const { sync, derived } = await run([makeLI('7', { line_item_key: 'LIK-7' })]);

  const syncArg = sync.mock.calls[0].arguments[0];
  assert.equal(syncArg.dealId, 'DEAL1');
  assert.equal(syncArg.lineItemId, '7');
  assert.equal(syncArg.dealIsCanceled, false);
  assert.deepEqual(syncArg.hubspotClient, { tag: 'fake-client' });

  const derivedArg = derived.mock.calls[0].arguments[0];
  assert.equal(derivedArg.dealId, 'DEAL1');
  assert.equal(derivedArg.lineItemId, '7');
});

test('lista vacía o no-array → no rompe, todo en cero', async () => {
  const { result: r1 } = await run([]);
  assert.deepEqual(r1, { processed: 0, skipped: 0, errors: 0 });

  const { result: r2 } = await run(undefined);
  assert.deepEqual(r2, { processed: 0, skipped: 0, errors: 0 });
});
