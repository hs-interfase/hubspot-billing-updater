// src/__tests__/phaseR.test.mjs
//
// Prueba la ORQUESTACIÓN de Phase R (runPhaseR), no el motor de cálculo.
// recalcContadores se inyecta como mock para verificar SOLO la lógica del loop:
//   - llama a recalcContadores una vez por line item con line_item_key
//   - saltea los line items sin line_item_key (o sin id)
//   - un error no bloquea el resto (cuenta el error y sigue)
//   - propaga dealId / lineItemId al motor
//   - EL FRENO (PHASE_R_SKIP_SEALED): saltea las líneas con el ciclo cerrado
//     en caliente, pero NUNCA en una corrida full
//
// Correr con:  node --test src/__tests__/phaseR.test.mjs
//
// No toca HubSpot: runPhaseR recibe el motor por inyección de dependencias.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { runPhaseR } from '../phases/index.js';

function makeLI(id, props = {}) {
  return { id, properties: props };
}

async function run(lineItems, { impl, fullReconcile } = {}) {
  const recalc = mock.fn(impl || (async () => ({})));
  const result = await runPhaseR({
    dealId: 'DEAL1',
    lineItems,
    hubspotClient: { tag: 'fake-client' },
    recalcContadoresFn: recalc,
    ...(fullReconcile === undefined ? {} : { fullReconcile }),
  });
  return { result, recalc };
}

/** Corre `fn` con el freno en un valor dado y restaura el env al salir. */
async function conFreno(valor, fn) {
  const previo = process.env.PHASE_R_SKIP_SEALED;
  if (valor === undefined) delete process.env.PHASE_R_SKIP_SEALED;
  else process.env.PHASE_R_SKIP_SEALED = valor;
  try {
    return await fn();
  } finally {
    if (previo === undefined) delete process.env.PHASE_R_SKIP_SEALED;
    else process.env.PHASE_R_SKIP_SEALED = previo;
  }
}

test('llama a recalcContadores una vez por LI con line_item_key', async () => {
  const lineItems = [
    makeLI('1', { line_item_key: 'LIK-1' }),
    makeLI('2', { line_item_key: 'LIK-2' }),
  ];
  const { result, recalc } = await run(lineItems);

  assert.deepEqual(result, { processed: 2, skipped: 0, sealedSkipped: 0, errors: 0 });
  assert.equal(recalc.mock.callCount(), 2);
});

test('saltea LIs sin line_item_key (no llama al motor)', async () => {
  const lineItems = [
    makeLI('1', { line_item_key: 'LIK-1' }),
    makeLI('2', { line_item_key: '   ' }), // vacío tras trim → skip
    makeLI('3', {}),                        // sin la prop → skip
  ];
  const { result, recalc } = await run(lineItems);

  assert.deepEqual(result, { processed: 1, skipped: 2, sealedSkipped: 0, errors: 0 });
  assert.equal(recalc.mock.callCount(), 1);
});

test('saltea LI sin id (ni id ni hs_object_id)', async () => {
  const lineItems = [
    { properties: { line_item_key: 'LIK-1' } }, // sin id
    makeLI('2', { line_item_key: 'LIK-2' }),
  ];
  const { result } = await run(lineItems);
  assert.deepEqual(result, { processed: 1, skipped: 1, sealedSkipped: 0, errors: 0 });
});

test('usa hs_object_id cuando no hay li.id', async () => {
  const lineItems = [{ properties: { hs_object_id: '99', line_item_key: 'LIK-9' } }];
  const { result, recalc } = await run(lineItems);

  assert.deepEqual(result, { processed: 1, skipped: 0, sealedSkipped: 0, errors: 0 });
  assert.equal(recalc.mock.calls[0].arguments[0].lineItemId, '99');
});

test('un error en el motor NO bloquea el resto', async () => {
  const lineItems = [
    makeLI('1', { line_item_key: 'LIK-1' }),
    makeLI('2', { line_item_key: 'LIK-2' }), // este falla
    makeLI('3', { line_item_key: 'LIK-3' }),
  ];
  const impl = async ({ lineItemId }) => {
    if (lineItemId === '2') throw new Error('boom');
  };
  const { result } = await run(lineItems, { impl });
  assert.deepEqual(result, { processed: 2, skipped: 0, sealedSkipped: 0, errors: 1 });
});

test('propaga dealId y lineItemId al motor', async () => {
  const { recalc } = await run([makeLI('7', { line_item_key: 'LIK-7' })]);
  const arg = recalc.mock.calls[0].arguments[0];
  assert.equal(arg.dealId, 'DEAL1');
  assert.equal(arg.lineItemId, '7');
  assert.deepEqual(arg.hubspotClient, { tag: 'fake-client' });
});

test('lista vacía o no-array → no rompe, todo en cero', async () => {
  const { result: r1 } = await run([]);
  assert.deepEqual(r1, { processed: 0, skipped: 0, sealedSkipped: 0, errors: 0 });
  const { result: r2 } = await run(undefined);
  assert.deepEqual(r2, { processed: 0, skipped: 0, sealedSkipped: 0, errors: 0 });
});

// ═══════════════════════════════════════════════════════════════════════════
// EL FRENO — PHASE_R_SKIP_SEALED
// ═══════════════════════════════════════════════════════════════════════════

const SELLADA = { line_item_key: 'LIK-CERRADA', fechas_completas: 'true' };
const ABIERTA = { line_item_key: 'LIK-ABIERTA' };

test('freno APAGADO (default): la línea sellada se procesa igual que hoy', async () => {
  await conFreno(undefined, async () => {
    const { result, recalc } = await run([makeLI('1', SELLADA), makeLI('2', ABIERTA)]);
    assert.deepEqual(result, { processed: 2, skipped: 0, sealedSkipped: 0, errors: 0 });
    assert.equal(recalc.mock.callCount(), 2);
  });
});

test('freno PRENDIDO: saltea la sellada y procesa la abierta', async () => {
  await conFreno('true', async () => {
    const { result, recalc } = await run([makeLI('1', SELLADA), makeLI('2', ABIERTA)]);
    assert.deepEqual(result, { processed: 1, skipped: 0, sealedSkipped: 1, errors: 0 });
    assert.equal(recalc.mock.callCount(), 1);
    // la que corrió es la abierta, no la sellada
    assert.equal(recalc.mock.calls[0].arguments[0].lineItemId, '2');
  });
});

test('freno PRENDIDO pero corrida FULL: revisa TODO (así se des-sella)', async () => {
  await conFreno('true', async () => {
    const { result, recalc } = await run([makeLI('1', SELLADA), makeLI('2', ABIERTA)], {
      fullReconcile: true,
    });
    assert.deepEqual(result, { processed: 2, skipped: 0, sealedSkipped: 0, errors: 0 });
    assert.equal(recalc.mock.callCount(), 2);
  });
});

test('freno PRENDIDO: solo frena con fechas_completas verdadero', async () => {
  await conFreno('true', async () => {
    const lineItems = [
      makeLI('1', { line_item_key: 'A', fechas_completas: 'TRUE' }),  // mayúsculas → frena
      makeLI('2', { line_item_key: 'B', fechas_completas: ' true ' }), // con espacios → frena
      makeLI('3', { line_item_key: 'C', fechas_completas: 'false' }), // → procesa
      makeLI('4', { line_item_key: 'D', fechas_completas: '' }),      // → procesa
      makeLI('5', { line_item_key: 'E' }),                            // sin la prop → procesa
    ];
    const { result } = await run(lineItems);
    assert.deepEqual(result, { processed: 3, skipped: 0, sealedSkipped: 2, errors: 0 });
  });
});

test('freno PRENDIDO: una línea sin LIK sigue contando en skipped, no en sealedSkipped', async () => {
  await conFreno('true', async () => {
    const lineItems = [
      makeLI('1', { fechas_completas: 'true' }), // sin LIK → skipped (gana el guard previo)
      makeLI('2', SELLADA),                      // → sealedSkipped
    ];
    const { result } = await run(lineItems);
    assert.deepEqual(result, { processed: 0, skipped: 1, sealedSkipped: 1, errors: 0 });
  });
});
