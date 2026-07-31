// src/__tests__/cancelForecastTickets.test.mjs
//
// TANDA A punto 2 (definitivos/PLAN_proximos_cambios_tickets_2026-07-29.md):
// ETAPA_UNICA_ENABLED apagada (default) → comportamiento IDÉNTICO al de
// siempre (cancela sólo tickets forecast). Prendida → cancela TODOS los
// tickets no notificados del negocio MENOS el manual con fecha más cercana a
// hoy, y avisa al vendedor + responsable explicando por qué quedó vivo.
//
// client/notifyTicketKeptAliveFn FAKE — nada toca HubSpot ni Resend.

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@127.0.0.1:1/dummy';

// Stage/pipeline IDs distintos y determinísticos — constants.js los lee a
// nivel de módulo, así que se fuerzan ANTES de cualquier import.
process.env.BILLING_TICKET_PIPELINE_ID = 'PIPE_MANUAL';
process.env.BILLING_AUTOMATED_PIPELINE_ID = 'PIPE_AUTO';
process.env.BILLING_TICKET_STAGE_CANCELLED = 'STAGE_CANCELLED_MANUAL';
process.env.BILLING_AUTOMATED_CANCELLED = 'STAGE_CANCELLED_AUTO';
process.env.BILLING_TICKET_STAGE_ID = 'STAGE_PROXIMOS';
process.env.BILLING_TICKET_STAGE_READY = 'STAGE_LISTO';
process.env.BILLING_TICKET_STAGE_ID_BILLED = 'STAGE_EMITIDO';
process.env.BILLING_TICKET_FORECAST = 'STAGE_F25';
process.env.BILLING_TICKET_FORECAST_50 = 'STAGE_F50';
process.env.BILLING_TICKET_FORECAST_75 = 'STAGE_F75';
process.env.BILLING_TICKET_FORECAST_85 = 'STAGE_F85';
process.env.BILLING_TICKET_FORECAST_95 = 'STAGE_F95';
process.env.BILLING_AUTOMATED_FORECAST = 'STAGE_AF25';
process.env.BILLING_AUTOMATED_FORECAST_50 = 'STAGE_AF50';
process.env.BILLING_AUTOMATED_FORECAST_75 = 'STAGE_AF75';
process.env.BILLING_AUTOMATED_FORECAST_85 = 'STAGE_AF85';
process.env.BILLING_AUTOMATED_FORECAST_95 = 'STAGE_AF95';

const { cancelForecastTickets } = await import('../propagacion/tickets/cancelForecastTickets.js');
const { getTodayYMD } = await import('../utils/dateUtils.js');

const today = getTodayYMD();

function ymdPlus(days) {
  const d = new Date(`${today}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function ticket(id, { pipeline = 'PIPE_MANUAL', stage, fecha, owner } = {}) {
  return {
    id: String(id),
    properties: {
      hs_pipeline: pipeline,
      hs_pipeline_stage: stage,
      fecha_resolucion_esperada: fecha,
      hubspot_owner_id: owner,
    },
  };
}

function fakeClient({ ticketsByLIK = {}, updateCalls = [] } = {}) {
  return {
    crm: {
      tickets: {
        searchApi: {
          doSearch: async (body) => {
            const lik = body.filterGroups[0].filters[0].value;
            return { results: ticketsByLIK[lik] || [] };
          },
        },
        basicApi: {
          update: async (id, body) => {
            updateCalls.push({ id, ...body.properties });
          },
        },
      },
    },
  };
}

const LI1 = { id: 'LI1', properties: { line_item_key: 'LIK1' } };
const LI2 = { id: 'LI2', properties: { line_item_key: 'LIK2' } };

test('flag OFF (default): sólo cancela tickets forecast — Próximos a facturar queda intacto (comportamiento actual)', async () => {
  delete process.env.ETAPA_UNICA_ENABLED;

  const updateCalls = [];
  const client = fakeClient({
    ticketsByLIK: {
      LIK1: [
        ticket('T1', { stage: 'STAGE_F25', fecha: ymdPlus(10) }),      // forecast → se cancela
        ticket('T2', { stage: 'STAGE_PROXIMOS', fecha: ymdPlus(1) }),  // Próximos → NO se toca (flag off)
      ],
    },
    updateCalls,
  });

  let notifyCalled = false;
  const result = await cancelForecastTickets(
    { lineItems: [LI1], closedLostReason: 'Negocio perdido', dealId: 'D1', dealProps: {} },
    { client, notifyTicketKeptAliveFn: async () => { notifyCalled = true; } }
  );

  assert.deepEqual(result, { totalCancelled: 1, totalErrors: 0 });
  assert.deepEqual(updateCalls, [{ id: 'T1', hs_pipeline_stage: 'STAGE_CANCELLED_MANUAL', motivo_cancelacion_del_ticket: 'Negocio perdido' }]);
  assert.equal(notifyCalled, false);
});

test('flag ON: cancela todos los no-notificados MENOS el manual más cercano a hoy; avisa', async () => {
  process.env.ETAPA_UNICA_ENABLED = 'true';

  const updateCalls = [];
  const client = fakeClient({
    ticketsByLIK: {
      // LI1: dos manuales no-notificados (forecast y Próximos) + uno YA notificado (intocable)
      LIK1: [
        ticket('T-far',   { stage: 'STAGE_F25',     fecha: ymdPlus(20), owner: 'OW-far' }),
        ticket('T-close', { stage: 'STAGE_PROXIMOS', fecha: ymdPlus(2),  owner: 'OW-close' }),
        ticket('T-notif', { stage: 'STAGE_EMITIDO',  fecha: ymdPlus(1),  owner: 'OW-notif' }), // intocable
      ],
      // LI2: un ticket automático forecast no-notificado (se cancela, nunca es "el manual")
      LIK2: [
        ticket('T-auto', { pipeline: 'PIPE_AUTO', stage: 'STAGE_AF25', fecha: ymdPlus(1) }),
      ],
    },
    updateCalls,
  });

  const notifyCalls = [];
  const result = await cancelForecastTickets(
    { lineItems: [LI1, LI2], closedLostReason: 'Cliente canceló', dealId: 'D1', dealProps: { dealname: 'Acme', hubspot_owner_id: 'OW-vendedor' } },
    { client, notifyTicketKeptAliveFn: async (args) => { notifyCalls.push(args); return { emailed: true }; } }
  );

  // T-close sobrevive; T-far, T-auto se cancelan; T-notif nunca se toca.
  assert.deepEqual(result, { totalCancelled: 2, totalErrors: 0 });
  const cancelledIds = updateCalls.map(c => c.id).sort();
  assert.deepEqual(cancelledIds, ['T-auto', 'T-far']);
  for (const c of updateCalls) {
    assert.equal(c.motivo_cancelacion_del_ticket, 'Cliente canceló');
  }
  const farUpdate = updateCalls.find(c => c.id === 'T-far');
  assert.equal(farUpdate.hs_pipeline_stage, 'STAGE_CANCELLED_MANUAL');
  const autoUpdate = updateCalls.find(c => c.id === 'T-auto');
  assert.equal(autoUpdate.hs_pipeline_stage, 'STAGE_CANCELLED_AUTO');

  // Aviso: una sola vez, sobre el ticket que quedó vivo.
  assert.equal(notifyCalls.length, 1);
  assert.equal(notifyCalls[0].ticketId, 'T-close');
  assert.equal(notifyCalls[0].ticketOwnerId, 'OW-close');
  assert.equal(notifyCalls[0].dealId, 'D1');
  assert.equal(notifyCalls[0].dealName, 'Acme');
  assert.equal(notifyCalls[0].dealOwnerId, 'OW-vendedor');
  assert.equal(notifyCalls[0].fechaResolucionEsperada, ymdPlus(2));
  assert.equal(notifyCalls[0].motivo, 'Cliente canceló');

  delete process.env.ETAPA_UNICA_ENABLED;
});

test('flag ON: sin candidato manual entre los no-notificados → cancela todo, sin aviso', async () => {
  process.env.ETAPA_UNICA_ENABLED = 'true';

  const updateCalls = [];
  const client = fakeClient({
    ticketsByLIK: {
      LIK1: [
        ticket('T-auto1', { pipeline: 'PIPE_AUTO', stage: 'STAGE_AF25', fecha: ymdPlus(1) }),
        ticket('T-auto2', { pipeline: 'PIPE_AUTO', stage: 'STAGE_AF50', fecha: ymdPlus(5) }),
      ],
    },
    updateCalls,
  });

  let notifyCalled = false;
  const result = await cancelForecastTickets(
    { lineItems: [LI1], closedLostReason: '', dealId: 'D2', dealProps: {} },
    { client, notifyTicketKeptAliveFn: async () => { notifyCalled = true; } }
  );

  assert.deepEqual(result, { totalCancelled: 2, totalErrors: 0 });
  assert.equal(notifyCalled, false);
  // Motivo default cuando closedLostReason viene vacío
  assert.equal(updateCalls[0].motivo_cancelacion_del_ticket, 'Negocio perdido');

  delete process.env.ETAPA_UNICA_ENABLED;
});

test('flag ON: empate en distancia → sobrevive el manual más próximo al futuro (no el vencido)', async () => {
  process.env.ETAPA_UNICA_ENABLED = 'true';

  const updateCalls = [];
  const client = fakeClient({
    ticketsByLIK: {
      LIK1: [
        ticket('T-past',   { stage: 'STAGE_F25', fecha: ymdPlus(-3) }), // vencido hace 3 días
        ticket('T-future', { stage: 'STAGE_F25', fecha: ymdPlus(3) }),  // en 3 días
      ],
    },
    updateCalls,
  });

  const notifyCalls = [];
  await cancelForecastTickets(
    { lineItems: [LI1], closedLostReason: 'x', dealId: 'D3', dealProps: {} },
    { client, notifyTicketKeptAliveFn: async (args) => { notifyCalls.push(args); return { emailed: true }; } }
  );

  assert.equal(notifyCalls[0].ticketId, 'T-future');
  assert.deepEqual(updateCalls.map(c => c.id), ['T-past']);

  delete process.env.ETAPA_UNICA_ENABLED;
});
