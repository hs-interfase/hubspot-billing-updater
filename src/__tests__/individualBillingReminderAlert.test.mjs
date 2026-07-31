// src/__tests__/individualBillingReminderAlert.test.mjs
//
// Aviso individual al responsable cuando falta ~1 mes para la fecha de un
// ticket manual (bajo ETAPA_UNICA_ENABLED, sobrevive de la ventana de 30
// días que se elimina como regla de edición/promoción — ver §2.2 del plan).
// FAKE deps — nada toca Resend.

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@127.0.0.1:1/dummy';

const { notifyIndividualBillingReminder, individualBillingReminderApagado, AVISO_1MES_ENVIADO_PROP } =
  await import('../services/notifications/individualBillingReminderAlert.js');

const BASE = { dealId: 'D1', dealName: 'Acme', dealOwnerId: 'OW-vendedor', ticketId: 'T1', ticketOwnerId: 'OW-responsable', fechaResolucionEsperada: '2026-09-01', lineItemName: 'Plan Anual' };

test('AVISO_1MES_ENVIADO_PROP es el nombre de prop esperado', () => {
  assert.equal(AVISO_1MES_ENVIADO_PROP, 'of_aviso_1mes_enviado');
});

test('DEAL_ALERTS_ENABLED=false/0/no → sin llamadas', async () => {
  for (const v of ['false', '0', 'no']) {
    process.env.DEAL_ALERTS_ENABLED = v;
    const calls = [];
    const r = await notifyIndividualBillingReminder(BASE, {
      sendAlertToFn: async (...a) => calls.push(a),
      resolveOwnerEmailFn: async () => 'x@y.com',
    });
    assert.deepEqual(r, { emailed: false, reason: 'DEAL_ALERTS_ENABLED=false' });
    assert.equal(calls.length, 0);
    assert.equal(individualBillingReminderApagado('test'), true);
  }
  delete process.env.DEAL_ALERTS_ENABLED;
});

test('ticket con owner → le llega al responsable (no al vendedor)', async () => {
  delete process.env.DEAL_ALERTS_ENABLED;
  const toCalls = [];
  const resolved = { 'OW-responsable': 'responsable@x.com', 'OW-vendedor': 'vendedor@x.com' };
  const r = await notifyIndividualBillingReminder(BASE, {
    sendAlertToFn: async (args) => toCalls.push(args),
    resolveOwnerEmailFn: async (id) => resolved[id] || null,
  });
  assert.deepEqual(r, { emailed: true });
  assert.deepEqual(toCalls[0].to, ['responsable@x.com']);
  assert.equal(toCalls[0].meta.ticket, 'T1');
  assert.equal(toCalls[0].meta.elemento_de_pedido, 'Plan Anual');
  assert.equal(toCalls[0].meta.fecha, '2026-09-01');
});

test('ticket sin owner → cae al vendedor (mismo fallback que assignTicketOwners.js)', async () => {
  delete process.env.DEAL_ALERTS_ENABLED;
  const toCalls = [];
  const r = await notifyIndividualBillingReminder(
    { ...BASE, ticketOwnerId: null },
    {
      sendAlertToFn: async (args) => toCalls.push(args),
      resolveOwnerEmailFn: async (id) => (id === 'OW-vendedor' ? 'vendedor@x.com' : null),
    }
  );
  assert.deepEqual(r, { emailed: true });
  assert.deepEqual(toCalls[0].to, ['vendedor@x.com']);
});

test('sin destinatario resoluble (ni responsable ni vendedor) → no manda, no lanza', async () => {
  delete process.env.DEAL_ALERTS_ENABLED;
  const toCalls = [];
  const r = await notifyIndividualBillingReminder(BASE, {
    sendAlertToFn: async (args) => toCalls.push(args),
    resolveOwnerEmailFn: async () => null,
  });
  assert.deepEqual(r, { emailed: false, reason: 'sin_destinatario' });
  assert.equal(toCalls.length, 0);
});

test('sendAlertTo que lanza → no lanza, devuelve reason=error', async () => {
  delete process.env.DEAL_ALERTS_ENABLED;
  const r = await notifyIndividualBillingReminder(BASE, {
    sendAlertToFn: async () => { throw new Error('boom'); },
    resolveOwnerEmailFn: async () => 'x@y.com',
  });
  assert.deepEqual(r, { emailed: false, reason: 'error' });
});
