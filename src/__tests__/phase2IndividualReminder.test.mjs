// src/__tests__/phase2IndividualReminder.test.mjs
//
// maybeSendIndividualBillingReminder (phase2.js) — pieza ADITIVA de TANDA A
// punto 3: busca el ticket manual por su clave, y si no se le mandó ya el
// aviso individual (AVISO_1MES_ENVIADO_PROP), lo envía y marca el ticket.
// Flag apagada (default): no-op inmediato, no toca nada.
//
// client / findTicketForReminderFn / notifyIndividualBillingReminderFn FAKE.

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@127.0.0.1:1/dummy';

const { maybeSendIndividualBillingReminder } = await import('../phases/phase2.js');
const { AVISO_1MES_ENVIADO_PROP } = await import('../services/notifications/individualBillingReminderAlert.js');

const PARAMS = { dealId: 'D1', dealName: 'Acme', dealOwnerId: 'OW1', lineItemKey: 'LIK1', lineItemName: 'Plan Anual', ymd: '2026-09-01' };

test('flag OFF (default): no-op, no busca ni notifica', async () => {
  delete process.env.ETAPA_UNICA_ENABLED;
  let findCalled = false;
  let notifyCalled = false;

  const r = await maybeSendIndividualBillingReminder(PARAMS, {
    findTicketForReminderFn: async () => { findCalled = true; return null; },
    notifyIndividualBillingReminderFn: async () => { notifyCalled = true; return { emailed: true }; },
  });

  assert.deepEqual(r, { sent: false, reason: 'flag_off' });
  assert.equal(findCalled, false);
  assert.equal(notifyCalled, false);
});

test('flag ON, ticket todavía no existe (Phase P no corrió) → no-op silencioso', async () => {
  process.env.ETAPA_UNICA_ENABLED = 'true';
  let notifyCalled = false;

  const r = await maybeSendIndividualBillingReminder(PARAMS, {
    findTicketForReminderFn: async () => null,
    notifyIndividualBillingReminderFn: async () => { notifyCalled = true; return { emailed: true }; },
  });

  assert.deepEqual(r, { sent: false, reason: 'missing_forecast_ticket' });
  assert.equal(notifyCalled, false);

  delete process.env.ETAPA_UNICA_ENABLED;
});

test('flag ON, ticket ya tiene el marker en true → NO reenvía', async () => {
  process.env.ETAPA_UNICA_ENABLED = 'true';
  let notifyCalled = false;

  const r = await maybeSendIndividualBillingReminder(PARAMS, {
    findTicketForReminderFn: async () => ({ id: 'T1', properties: { [AVISO_1MES_ENVIADO_PROP]: 'true' } }),
    notifyIndividualBillingReminderFn: async () => { notifyCalled = true; return { emailed: true }; },
  });

  assert.deepEqual(r, { sent: false, reason: 'ya_enviado', ticketId: 'T1' });
  assert.equal(notifyCalled, false);

  delete process.env.ETAPA_UNICA_ENABLED;
});

test('flag ON, sin marker: notifica y escribe el marker en el ticket', async () => {
  process.env.ETAPA_UNICA_ENABLED = 'true';
  const updateCalls = [];
  const notifyCalls = [];

  const client = {
    crm: { tickets: { basicApi: { update: async (id, body) => updateCalls.push({ id, ...body.properties }) } } },
  };

  const r = await maybeSendIndividualBillingReminder(PARAMS, {
    client,
    findTicketForReminderFn: async () => ({
      id: 'T1',
      properties: { hubspot_owner_id: 'OW-resp', fecha_resolucion_esperada: '2026-09-01' },
    }),
    notifyIndividualBillingReminderFn: async (args) => { notifyCalls.push(args); return { emailed: true }; },
  });

  assert.deepEqual(r, { sent: true, ticketId: 'T1' });
  assert.equal(notifyCalls.length, 1);
  assert.equal(notifyCalls[0].ticketId, 'T1');
  assert.equal(notifyCalls[0].ticketOwnerId, 'OW-resp');
  assert.equal(notifyCalls[0].dealId, 'D1');
  assert.equal(notifyCalls[0].lineItemName, 'Plan Anual');
  assert.deepEqual(updateCalls, [{ id: 'T1', [AVISO_1MES_ENVIADO_PROP]: 'true' }]);

  delete process.env.ETAPA_UNICA_ENABLED;
});

test('flag ON, notify no emailó (p.ej. DEAL_ALERTS_ENABLED=false) → NO escribe marker', async () => {
  process.env.ETAPA_UNICA_ENABLED = 'true';
  const updateCalls = [];
  const client = {
    crm: { tickets: { basicApi: { update: async (id, body) => updateCalls.push({ id, ...body.properties }) } } },
  };

  const r = await maybeSendIndividualBillingReminder(PARAMS, {
    client,
    findTicketForReminderFn: async () => ({ id: 'T1', properties: {} }),
    notifyIndividualBillingReminderFn: async () => ({ emailed: false, reason: 'sin_destinatario' }),
  });

  assert.deepEqual(r, { sent: false, reason: 'sin_destinatario', ticketId: 'T1' });
  assert.equal(updateCalls.length, 0);

  delete process.env.ETAPA_UNICA_ENABLED;
});

test('sin lineItemKey o sin ymd → no-op (guard de params)', async () => {
  process.env.ETAPA_UNICA_ENABLED = 'true';
  let findCalled = false;
  const deps = { findTicketForReminderFn: async () => { findCalled = true; return null; } };

  assert.deepEqual(
    await maybeSendIndividualBillingReminder({ ...PARAMS, lineItemKey: '' }, deps),
    { sent: false, reason: 'missing_params' }
  );
  assert.deepEqual(
    await maybeSendIndividualBillingReminder({ ...PARAMS, ymd: '' }, deps),
    { sent: false, reason: 'missing_params' }
  );
  assert.equal(findCalled, false);

  delete process.env.ETAPA_UNICA_ENABLED;
});

// ─── TANDA B punto 7: la ventana de 30 días deja de mover la etapa ───────────
// Bajo ETAPA_UNICA_ENABLED no hay a dónde promover (la etapa es una sola y el
// ticket nace ahí), así que promoteManualForecastTicketToProximos sale por
// arriba SIN tocar HubSpot. El aviso individual de la TANDA A no se toca: es
// otro camino, y sigue probado por los tests de arriba.

const { promoteManualForecastTicketToProximos } = await import('../phases/phase2.js');

test('flag ON: la promoción de etapa no ocurre (ni siquiera busca el ticket)', async () => {
  process.env.ETAPA_UNICA_ENABLED = 'true';

  const r = await promoteManualForecastTicketToProximos({
    dealId: 'D1',
    dealStage: 'closedwon',
    lineItemKey: 'LIK1',
    nextBillingDate: '2026-09-01',
    lineItemId: 'LI1',
  });

  assert.deepEqual(r, { moved: false, reason: 'etapa_unica_sin_promocion' });

  delete process.env.ETAPA_UNICA_ENABLED;
});

test('flag OFF (default): el guard nuevo no se interpone — sigue el camino de siempre', async () => {
  delete process.env.ETAPA_UNICA_ENABLED;

  // Sin lineItemKey corta antes de tocar la red: alcanza para ver que NO salió
  // por el guard de etapa única.
  const r = await promoteManualForecastTicketToProximos({
    dealId: 'D1',
    dealStage: 'closedwon',
    lineItemKey: '',
    nextBillingDate: '2026-09-01',
    lineItemId: 'LI1',
  });

  assert.deepEqual(r, { moved: false, reason: 'missing_line_item_key' });
});
