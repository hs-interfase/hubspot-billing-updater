// src/__tests__/mirrorAlert.test.mjs
//
// Email operativo de avisos a deal espejo UY (complemento del billing_error).
// Con sendAlertFn FAKE — nada toca Resend.
//
// Llave: DEAL_ALERTS_ENABLED (la misma de dealAlerts) apaga SOLO el email.
//
// Requiere DATABASE_URL dummy (el grafo de imports puede cargar src/db.js).
//   DATABASE_URL='postgres://u:p@localhost:5432/x' node --test src/__tests__/mirrorAlert.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@127.0.0.1:1/dummy';

const { emailAvisoMirror, mirrorEmailApagado } =
  await import('../services/notifications/mirrorAlert.js');

const ORIGINAL_FLAG = process.env.DEAL_ALERTS_ENABLED;

test('DEAL_ALERTS_ENABLED=false/0/no → email omitido, sin llamadas', async () => {
  for (const v of ['false', '0', 'no']) {
    process.env.DEAL_ALERTS_ENABLED = v;
    const calls = [];
    const r = await emailAvisoMirror(
      { mirrorDealId: 'DUY', message: 'aviso' },
      { sendAlertFn: async (...a) => { calls.push(a); } }
    );
    assert.deepEqual(r, { emailed: false, reason: 'DEAL_ALERTS_ENABLED=false' });
    assert.equal(calls.length, 0);
    assert.equal(mirrorEmailApagado('test'), true);
  }
  process.env.DEAL_ALERTS_ENABLED = '';
});

test('flag ausente/vacía = prendida', () => {
  delete process.env.DEAL_ALERTS_ENABLED;
  assert.equal(mirrorEmailApagado('test'), false);
  process.env.DEAL_ALERTS_ENABLED = '';
  assert.equal(mirrorEmailApagado('test'), false);
});

test('camino feliz: manda email warning con deal espejo + mensaje', async () => {
  delete process.env.DEAL_ALERTS_ENABLED;
  const calls = [];
  const r = await emailAvisoMirror(
    {
      mirrorDealId: 'DUY',
      title: 'Título X',
      message: 'el aviso completo',
      meta: { deal_py: 'DPY', li_py: 'LI1' },
    },
    { sendAlertFn: async (level, title, meta) => { calls.push({ level, title, meta }); } }
  );

  assert.deepEqual(r, { emailed: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].level, 'warning');
  assert.equal(calls[0].title, 'Título X');
  assert.equal(calls[0].meta.deal_espejo_uy, 'DUY');
  assert.equal(calls[0].meta.deal_py, 'DPY');
  assert.equal(calls[0].meta.li_py, 'LI1');
  assert.equal(calls[0].meta.mensaje, 'el aviso completo');
});

test('sendAlertFn que lanza: NO lanza, devuelve reason=error', async () => {
  delete process.env.DEAL_ALERTS_ENABLED;
  const r = await emailAvisoMirror(
    { mirrorDealId: 'DUY', message: 'aviso' },
    { sendAlertFn: async () => { throw new Error('boom-resend'); } }
  );
  assert.deepEqual(r, { emailed: false, reason: 'error' });

  // restaurar el valor original de la llave para no ensuciar otros tests del proceso
  if (ORIGINAL_FLAG === undefined) delete process.env.DEAL_ALERTS_ENABLED;
  else process.env.DEAL_ALERTS_ENABLED = ORIGINAL_FLAG;
});
