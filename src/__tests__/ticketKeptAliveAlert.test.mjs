// src/__tests__/ticketKeptAliveAlert.test.mjs
//
// Aviso al vendedor + responsable cuando cancelForecastTickets (bajo
// ETAPA_UNICA_ENABLED) conserva vivo el manual más cercano a hoy. FAKE deps —
// nada toca Resend.

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@127.0.0.1:1/dummy';

const { notifyTicketKeptAlive, ticketKeptAliveAlertApagado } =
  await import('../services/notifications/ticketKeptAliveAlert.js');

const BASE = { dealId: 'D1', dealName: 'Acme', dealOwnerId: 'OW-vendedor', ticketId: 'T1', ticketOwnerId: 'OW-responsable', fechaResolucionEsperada: '2026-09-01', motivo: 'Negocio perdido' };

test('DEAL_ALERTS_ENABLED=false/0/no → sin llamadas', async () => {
  for (const v of ['false', '0', 'no']) {
    process.env.DEAL_ALERTS_ENABLED = v;
    const calls = [];
    const r = await notifyTicketKeptAlive(BASE, {
      sendAlertToFn: async (...a) => calls.push(a),
      resolveOwnerEmailFn: async () => 'x@y.com',
    });
    assert.deepEqual(r, { emailed: false, reason: 'DEAL_ALERTS_ENABLED=false' });
    assert.equal(calls.length, 0);
    assert.equal(ticketKeptAliveAlertApagado('test'), true);
  }
  delete process.env.DEAL_ALERTS_ENABLED;
});

test('vendedor + responsable resueltos → sendAlertTo con ambos destinatarios (deduplicados)', async () => {
  delete process.env.DEAL_ALERTS_ENABLED;
  const toCalls = [];
  const resolved = { 'OW-vendedor': 'vendedor@x.com', 'OW-responsable': 'responsable@x.com' };
  const r = await notifyTicketKeptAlive(BASE, {
    sendAlertToFn: async (args) => toCalls.push(args),
    resolveOwnerEmailFn: async (id) => resolved[id] || null,
  });
  assert.deepEqual(r, { emailed: true });
  assert.equal(toCalls.length, 1);
  assert.deepEqual([...toCalls[0].to].sort(), ['responsable@x.com', 'vendedor@x.com']);
  assert.equal(toCalls[0].level, 'warning');
  assert.match(toCalls[0].title, /Acme/);
  assert.equal(toCalls[0].meta.ticket, 'T1');
  assert.equal(toCalls[0].meta.fecha, '2026-09-01');
  assert.equal(toCalls[0].meta.motivo, 'Negocio perdido');
});

test('mismo owner en ambos roles → un solo destinatario (Set deduplica)', async () => {
  delete process.env.DEAL_ALERTS_ENABLED;
  const toCalls = [];
  const r = await notifyTicketKeptAlive(BASE, {
    sendAlertToFn: async (args) => toCalls.push(args),
    resolveOwnerEmailFn: async () => 'mismo@x.com',
  });
  assert.deepEqual(r, { emailed: true });
  assert.deepEqual(toCalls[0].to, ['mismo@x.com']);
});

test('sin destinatarios resolubles → no manda, no lanza', async () => {
  delete process.env.DEAL_ALERTS_ENABLED;
  const toCalls = [];
  const r = await notifyTicketKeptAlive(BASE, {
    sendAlertToFn: async (args) => toCalls.push(args),
    resolveOwnerEmailFn: async () => null,
  });
  assert.deepEqual(r, { emailed: false, reason: 'sin_destinatarios' });
  assert.equal(toCalls.length, 0);
});

test('sendAlertTo que lanza → no lanza, devuelve reason=error', async () => {
  delete process.env.DEAL_ALERTS_ENABLED;
  const r = await notifyTicketKeptAlive(BASE, {
    sendAlertToFn: async () => { throw new Error('boom-resend'); },
    resolveOwnerEmailFn: async () => 'x@y.com',
  });
  assert.deepEqual(r, { emailed: false, reason: 'error' });
});
