// node --test src/__tests__/lineItemWriteBuffer.test.mjs
//
// Tests del buffer de escrituras de line items (patrón DI de recalcContadores.test.mjs:
// fake hubspotClient inyectado que captura los bodies, sin red).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLineItemWriteBuffer } from '../services/lineItems/lineItemWriteBuffer.js';

function makeFakeClient({ basicFail = () => false, batchFail = () => false } = {}) {
  const calls = { basic: [], batch: [] };
  return {
    calls,
    crm: {
      lineItems: {
        basicApi: {
          async update(id, body) {
            calls.basic.push({ id: String(id), properties: body.properties });
            if (basicFail(String(id))) {
              const err = new Error(`basic update failed for ${id}`);
              err.code = 400;
              throw err;
            }
            return {};
          },
        },
        batchApi: {
          async update(body) {
            calls.batch.push(body.inputs.map(i => ({ id: String(i.id), properties: i.properties })));
            if (batchFail(body)) {
              const err = new Error('batch validation error');
              err.code = 400;
              throw err;
            }
            return {};
          },
        },
      },
    },
  };
}

test('flag OFF: N queueUpdate = N basicApi.update inmediatos en orden, bodies idénticos', async () => {
  const fake = makeFakeClient();
  const buf = createLineItemWriteBuffer({ hubspotClient: fake, enabled: false });

  await buf.queueUpdate('11', { billing_next_date: '2026-08-01' }, { label: 'a' });
  await buf.queueUpdate('22', { billing_error: '' }, { label: 'b' });
  await buf.queueUpdate('11', { billing_error: 'x' }, { label: 'c' });

  assert.equal(fake.calls.basic.length, 3);
  assert.equal(fake.calls.batch.length, 0);
  assert.deepEqual(fake.calls.basic[0], { id: '11', properties: { billing_next_date: '2026-08-01' } });
  assert.deepEqual(fake.calls.basic[1], { id: '22', properties: { billing_error: '' } });
  assert.deepEqual(fake.calls.basic[2], { id: '11', properties: { billing_error: 'x' } });
  assert.equal(buf.pendingCount(), 0);

  // flush es noop con flag off
  const r = await buf.flush();
  assert.deepEqual(r, { updated: 0, failed: 0, batchCalls: 0, individualCalls: 0 });
});

test('flag OFF: el error del update se PROPAGA al caller (semántica previa)', async () => {
  const fake = makeFakeClient({ basicFail: id => id === '11' });
  const buf = createLineItemWriteBuffer({ hubspotClient: fake, enabled: false });

  await assert.rejects(
    () => buf.queueUpdate('11', { billing_error: 'x' }),
    /basic update failed for 11/
  );
});

test('flag ON: merge por LI (último gana por prop) y 1 solo batchApi.update al flush', async () => {
  const fake = makeFakeClient();
  const buf = createLineItemWriteBuffer({ hubspotClient: fake, enabled: true });

  await buf.queueUpdate('11', { billing_next_date: '2026-08-01', billing_error: 'viejo' }, { label: 'schedule' });
  await buf.queueUpdate('22', { mansoft_pendiente: 'true' }, { label: 'mansoft' });
  await buf.queueUpdate('11', { billing_error: '' }, { label: 'clear' }); // pisa billing_error, conserva next_date

  assert.equal(fake.calls.basic.length, 0, 'no debe haber llamadas antes del flush');
  assert.equal(buf.pendingCount(), 2);

  const r = await buf.flush();

  assert.equal(fake.calls.batch.length, 1);
  assert.deepEqual(fake.calls.batch[0], [
    { id: '11', properties: { billing_next_date: '2026-08-01', billing_error: '' } },
    { id: '22', properties: { mansoft_pendiente: 'true' } },
  ]);
  assert.deepEqual(r, { updated: 2, failed: 0, batchCalls: 1, individualCalls: 0 });
  assert.equal(buf.pendingCount(), 0);
});

test('flag ON: chunking — 150 LIs pendientes → 2 llamadas batch (100+50)', async () => {
  const fake = makeFakeClient();
  const buf = createLineItemWriteBuffer({ hubspotClient: fake, enabled: true });

  for (let i = 1; i <= 150; i++) {
    await buf.queueUpdate(String(i), { billing_error: '' });
  }

  const r = await buf.flush();

  assert.equal(fake.calls.batch.length, 2);
  assert.equal(fake.calls.batch[0].length, 100);
  assert.equal(fake.calls.batch[1].length, 50);
  assert.deepEqual(r, { updated: 150, failed: 0, batchCalls: 2, individualCalls: 0 });
});

test('flag ON: fallback 400 — batch falla → updates individuales, el LI que falla no bloquea al resto', async () => {
  const fake = makeFakeClient({
    batchFail: () => true,          // el lote entero rechaza (validación)
    basicFail: id => id === '22',   // solo el 22 falla también individualmente
  });
  const buf = createLineItemWriteBuffer({ hubspotClient: fake, enabled: true, context: { dealId: 'D1' } });

  await buf.queueUpdate('11', { billing_error: '' }, { label: 'a' });
  await buf.queueUpdate('22', { billing_error: 'x' }, { label: 'b' });
  await buf.queueUpdate('33', { billing_next_date: '2026-09-01' }, { label: 'c' });

  const r = await buf.flush(); // no debe lanzar

  assert.equal(fake.calls.batch.length, 1, 'intentó el batch primero');
  assert.equal(fake.calls.basic.length, 3, 'fallback individual para los 3');
  assert.deepEqual(r, { updated: 2, failed: 1, batchCalls: 0, individualCalls: 3 });
  // aislamiento: 11 y 33 se escribieron aunque 22 falló
  assert.deepEqual(fake.calls.basic.map(c => c.id), ['11', '22', '33']);
});

test('flag ON: flush vacío = 0 llamadas; doble flush idempotente', async () => {
  const fake = makeFakeClient();
  const buf = createLineItemWriteBuffer({ hubspotClient: fake, enabled: true });

  const r1 = await buf.flush();
  assert.deepEqual(r1, { updated: 0, failed: 0, batchCalls: 0, individualCalls: 0 });

  await buf.queueUpdate('11', { billing_error: '' });
  await buf.flush();
  const r3 = await buf.flush(); // segundo flush: nada pendiente

  assert.equal(fake.calls.batch.length, 1);
  assert.deepEqual(r3, { updated: 0, failed: 0, batchCalls: 0, individualCalls: 0 });
});

test('queueUpdate ignora id vacío y properties vacías (sin llamadas, sin pendientes)', async () => {
  const fake = makeFakeClient();
  const buf = createLineItemWriteBuffer({ hubspotClient: fake, enabled: true });

  await buf.queueUpdate('', { billing_error: '' });
  await buf.queueUpdate('11', {});
  await buf.queueUpdate('11', null);

  assert.equal(buf.pendingCount(), 0);
  const r = await buf.flush();
  assert.deepEqual(r, { updated: 0, failed: 0, batchCalls: 0, individualCalls: 0 });
});

test('stats() acumula a través de flushes', async () => {
  const fake = makeFakeClient();
  const buf = createLineItemWriteBuffer({ hubspotClient: fake, enabled: true });

  await buf.queueUpdate('1', { a: '1' });
  await buf.flush();
  await buf.queueUpdate('2', { b: '2' });
  await buf.queueUpdate('3', { c: '3' });
  await buf.flush();

  const s = buf.stats();
  assert.equal(s.queued, 3);
  assert.equal(s.updatesSent, 3);
  assert.equal(s.batchCalls, 2);
  assert.equal(s.flushes, 2);
});
