// src/__tests__/dealWonScheduleSummaryAlert.test.mjs
//
// Resumen ÚNICO al cierre ganado (bajo ETAPA_UNICA_ENABLED): UN email con
// todo el cronograma, no uno por ticket. FAKE deps — nada toca Resend.

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@127.0.0.1:1/dummy';

const {
  notifyDealWonScheduleSummary,
  dealWonScheduleSummaryApagado,
  formatTicketRow,
  sortTicketsByFecha,
  RESUMEN_ENVIADO_PROP,
} = await import('../services/notifications/dealWonScheduleSummaryAlert.js');

test('RESUMEN_ENVIADO_PROP es el nombre de prop esperado', () => {
  assert.equal(RESUMEN_ENVIADO_PROP, 'of_resumen_cronograma_enviado');
});

test('formatTicketRow: fecha — line item key (id); sin fecha/lik → placeholders', () => {
  assert.equal(
    formatTicketRow({ id: '1', properties: { fecha_resolucion_esperada: '2026-09-01', of_line_item_key: 'LIK1' } }),
    '2026-09-01 — LIK1 (1)'
  );
  assert.equal(
    formatTicketRow({ id: '2', properties: {} }),
    '(sin fecha) — (sin line item) (2)'
  );
});

test('sortTicketsByFecha: ascendente, sin fecha al final', () => {
  const tickets = [
    { id: 'sin-fecha', properties: {} },
    { id: 'b', properties: { fecha_resolucion_esperada: '2026-06-01' } },
    { id: 'a', properties: { fecha_resolucion_esperada: '2026-01-01' } },
  ];
  const sorted = sortTicketsByFecha(tickets).map(t => t.id);
  assert.deepEqual(sorted, ['a', 'b', 'sin-fecha']);
});

test('DEAL_ALERTS_ENABLED=false/0/no → sin llamadas', async () => {
  for (const v of ['false', '0', 'no']) {
    process.env.DEAL_ALERTS_ENABLED = v;
    const calls = [];
    const r = await notifyDealWonScheduleSummary(
      { dealId: 'D1', dealName: 'Acme', dealOwnerId: 'OW1', tickets: [] },
      { sendAlertToFn: async (...a) => calls.push(a), resolveOwnerEmailFn: async () => 'x@y.com' }
    );
    assert.deepEqual(r, { emailed: false, reason: 'DEAL_ALERTS_ENABLED=false' });
    assert.equal(calls.length, 0);
    assert.equal(dealWonScheduleSummaryApagado('test'), true);
  }
  delete process.env.DEAL_ALERTS_ENABLED;
});

test('un solo email con TODO el cronograma (no uno por ticket)', async () => {
  delete process.env.DEAL_ALERTS_ENABLED;
  const tickets = [
    { id: 'T1', properties: { fecha_resolucion_esperada: '2026-10-01', of_line_item_key: 'LIK1' } },
    { id: 'T2', properties: { fecha_resolucion_esperada: '2026-09-01', of_line_item_key: 'LIK1' } },
    { id: 'T3', properties: { fecha_resolucion_esperada: '2026-11-01', of_line_item_key: 'LIK2' } },
  ];
  const toCalls = [];
  const r = await notifyDealWonScheduleSummary(
    { dealId: 'D1', dealName: 'Acme', dealOwnerId: 'OW-vendedor', tickets },
    { sendAlertToFn: async (args) => toCalls.push(args), resolveOwnerEmailFn: async () => 'vendedor@x.com' }
  );
  assert.deepEqual(r, { emailed: true });
  assert.equal(toCalls.length, 1, 'debe ser UN solo email, no uno por ticket');
  assert.deepEqual(toCalls[0].to, ['vendedor@x.com']);
  assert.equal(toCalls[0].meta.total_tickets, '3');
  // Orden cronológico dentro del resumen único
  assert.equal(
    toCalls[0].meta.cronograma,
    '2026-09-01 — LIK1 (T2) · 2026-10-01 — LIK1 (T1) · 2026-11-01 — LIK2 (T3)'
  );
});

test('sin email de vendedor resoluble → no manda, no lanza', async () => {
  delete process.env.DEAL_ALERTS_ENABLED;
  const toCalls = [];
  const r = await notifyDealWonScheduleSummary(
    { dealId: 'D1', dealName: 'Acme', dealOwnerId: null, tickets: [] },
    { sendAlertToFn: async (args) => toCalls.push(args), resolveOwnerEmailFn: async () => null }
  );
  assert.deepEqual(r, { emailed: false, reason: 'sin_destinatario' });
  assert.equal(toCalls.length, 0);
});

test('sendAlertTo que lanza → no lanza, devuelve reason=error', async () => {
  delete process.env.DEAL_ALERTS_ENABLED;
  const r = await notifyDealWonScheduleSummary(
    { dealId: 'D1', dealName: 'Acme', dealOwnerId: 'OW1', tickets: [] },
    { sendAlertToFn: async () => { throw new Error('boom'); }, resolveOwnerEmailFn: async () => 'x@y.com' }
  );
  assert.deepEqual(r, { emailed: false, reason: 'error' });
});
