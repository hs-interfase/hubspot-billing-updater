// src/__tests__/ticketCancelledByEngineAlert.test.mjs
//
// TANDA B §2.4 — EL MOTOR NO BORRA: CANCELA Y AVISA.
// UN email por line item con la lista de fechas, al vendedor + los responsables
// de los tickets cancelados. Apagable por DEAL_ALERTS_ENABLED. Nunca lanza.
//
// sendAlertTo / resolveOwnerEmail FAKE — no toca Resend ni HubSpot.

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@127.0.0.1:1/dummy';

const {
  notifyTicketsCancelledByEngine,
  ticketCancelledAlertApagado,
} = await import('../services/notifications/ticketCancelledByEngineAlert.js');

const CANCELADOS = [
  { ticketId: 'T2', fecha: '2026-09-30', ownerId: 'OW-resp' },
  { ticketId: 'T1', fecha: '2026-08-31', ownerId: 'OW-resp' },
  { ticketId: 'T3', fecha: '2026-10-31', ownerId: null },
];

function deps(sent) {
  return {
    sendAlertToFn: async (arg) => { sent.push(arg); },
    resolveOwnerEmailFn: async (id) => (id ? `${id}@interfase.com` : null),
  };
}

test('avisa una sola vez, al vendedor + responsables, con las fechas ordenadas', async () => {
  delete process.env.DEAL_ALERTS_ENABLED;
  const sent = [];

  const r = await notifyTicketsCancelledByEngine(
    { dealId: 'D1', dealName: 'Acme', dealOwnerId: 'OW-vend', lineItemName: 'Plan Anual', lineItemId: 'LI1', cancelados: CANCELADOS, motivo: 'El cronograma se rearmó' },
    deps(sent)
  );

  assert.deepEqual(r, { emailed: true });
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].to.sort(), ['OW-resp@interfase.com', 'OW-vend@interfase.com']);
  assert.equal(sent[0].meta.cancelados, '3');
  assert.equal(sent[0].meta.fechas, '2026-08-31, 2026-09-30, 2026-10-31');
  assert.match(sent[0].title, /3 ticket\(s\) cancelado\(s\)/);
  assert.match(sent[0].meta.mensaje, /NO se borraron/);
});

test('sin cancelados no manda nada', async () => {
  const sent = [];
  const r = await notifyTicketsCancelledByEngine({ dealId: 'D1', cancelados: [] }, deps(sent));
  assert.deepEqual(r, { emailed: false, reason: 'sin_cancelados' });
  assert.equal(sent.length, 0);
});

test('DEAL_ALERTS_ENABLED=false apaga el email (la cancelación ya ocurrió igual)', async () => {
  process.env.DEAL_ALERTS_ENABLED = 'false';
  const sent = [];

  assert.equal(ticketCancelledAlertApagado('test'), true);
  const r = await notifyTicketsCancelledByEngine({ dealId: 'D1', cancelados: CANCELADOS }, deps(sent));

  assert.deepEqual(r, { emailed: false, reason: 'DEAL_ALERTS_ENABLED=false' });
  assert.equal(sent.length, 0);
  delete process.env.DEAL_ALERTS_ENABLED;
});

test('sin destinatarios resolubles no manda (y no rompe)', async () => {
  const sent = [];
  const r = await notifyTicketsCancelledByEngine(
    { dealId: 'D1', dealOwnerId: null, cancelados: [{ ticketId: 'T1', fecha: '2026-08-31', ownerId: null }] },
    deps(sent)
  );
  assert.deepEqual(r, { emailed: false, reason: 'sin_destinatarios' });
  assert.equal(sent.length, 0);
});

test('si el envío falla, NUNCA lanza', async () => {
  const r = await notifyTicketsCancelledByEngine(
    { dealId: 'D1', dealOwnerId: 'OW1', cancelados: CANCELADOS },
    {
      sendAlertToFn: async () => { throw new Error('Resend caído'); },
      resolveOwnerEmailFn: async (id) => (id ? `${id}@interfase.com` : null),
    }
  );
  assert.deepEqual(r, { emailed: false, reason: 'error' });
});

test('un ticket sin fecha se lista por su id (no queda un renglón vacío)', async () => {
  const sent = [];
  await notifyTicketsCancelledByEngine(
    { dealId: 'D1', dealOwnerId: 'OW1', cancelados: [{ ticketId: 'T9', fecha: null, ownerId: null }] },
    deps(sent)
  );
  assert.equal(sent[0].meta.fechas, '(ticket T9)');
});
