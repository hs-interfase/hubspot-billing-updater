// src/__tests__/syncLineItemEtapaUnica.test.mjs
//
// TANDA B punto 6 — el sync quirúrgico LI→ticket sigue la frontera.
//
// Hoy exige etapa == «Próximos a facturar». Bajo ETAPA_UNICA_ENABLED pasa a
// alcanzar TODO lo no notificado del pipeline manual (forecast incluidos, y los
// viejos 85/95), porque bajo la misma flag Phase P dejó de re-snapshotear esos
// tickets: si este sync no llegara, el tramo forecast se quedaría con datos
// viejos. Lo notificado en adelante sigue congelado.
//
// Client FAKE, sin red. Envs seteadas ANTES del import (constants.js las lee al
// importar) — por eso este archivo está separado de syncLineItemPropToTicket.test.mjs,
// que corre con las etapas vacías.

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@127.0.0.1:1/dummy';

process.env.BILLING_TICKET_PIPELINE_ID = 'PIPE_MANUAL';
process.env.BILLING_AUTOMATED_PIPELINE_ID = 'PIPE_AUTO';
process.env.BILLING_TICKET_FORECAST = 'F25';
process.env.BILLING_TICKET_FORECAST_50 = 'F50';
process.env.BILLING_TICKET_FORECAST_75 = 'F75';
process.env.BILLING_TICKET_FORECAST_85 = 'F85';
process.env.BILLING_TICKET_FORECAST_95 = 'F95';
process.env.BILLING_TICKET_STAGE_ID = 'PROXIMOS';
process.env.BILLING_TICKET_STAGE_READY = 'NOTIFICADO';
process.env.BILLING_TICKET_STAGE_CANCELLED = 'CANCELADO';
process.env.BILLING_AUTOMATED_FORECAST = 'AF25';
process.env.BILLING_AUTOMATED_READY = 'AUTO_NOTIFICADO';

const { syncLineItemPropToTickets } = await import('../services/lineItems/syncLineItemPropToTicket.js');

function makeCtx(tickets) {
  const updateCalls = [];
  const client = {
    crm: {
      lineItems: { basicApi: { async getById() { return { id: 'LI1', properties: { line_item_key: 'LIK1' } }; } } },
      deals: { basicApi: { async getById() { return { id: 'D1', properties: {} }; } } },
      tickets: { searchApi: { async doSearch() { return { results: tickets }; } } },
    },
  };
  return {
    client,
    extractFn: () => ({ area: 'Petróleo' }),
    updateTicketFn: async (id, patch) => { updateCalls.push({ id: String(id), patch }); },
    findMirrorFn: async () => null,
    reportErrorFn: () => {},
    notifyOwnerFn: async () => ({ notified: true }),
    emailMirrorFn: async () => ({ emailed: true }),
    updateCalls,
  };
}

const tk = (id, stage, pipeline = 'PIPE_MANUAL') => ({
  id: String(id),
  properties: { hs_pipeline: pipeline, hs_pipeline_stage: stage, of_line_item_key: 'LIK1', area: 'Vieja' },
});

const TICKETS = [
  tk('T-prox', 'PROXIMOS'),
  tk('T-f75', 'F75'),
  tk('T-f85', 'F85'),
  tk('T-notif', 'NOTIFICADO'),
  tk('T-cancel', 'CANCELADO'),
  tk('T-auto', 'AF25', 'PIPE_AUTO'),
];

test('flag OFF (default): sólo «Próximos a facturar» del pipeline manual', async () => {
  delete process.env.ETAPA_UNICA_ENABLED;

  const ctx = makeCtx(TICKETS);
  const r = await syncLineItemPropToTickets({ lineItemId: 'LI1', propertyName: 'area', dealId: 'D1', ...ctx });

  assert.equal(r.ticketsUpdated, 1);
  assert.deepEqual(ctx.updateCalls.map(c => c.id), ['T-prox']);
  assert.equal(r.skipped, 5);
});

test('flag ON: alcanza todo lo NO NOTIFICADO del pipeline manual (Próximos + forecast + 85/95)', async () => {
  process.env.ETAPA_UNICA_ENABLED = 'true';

  const ctx = makeCtx(TICKETS);
  const r = await syncLineItemPropToTickets({ lineItemId: 'LI1', propertyName: 'area', dealId: 'D1', ...ctx });

  assert.deepEqual(ctx.updateCalls.map(c => c.id), ['T-prox', 'T-f75', 'T-f85']);
  assert.equal(r.ticketsUpdated, 3);

  delete process.env.ETAPA_UNICA_ENABLED;
});

test('flag ON: lo notificado, lo cancelado y el pipeline automático siguen congelados', async () => {
  process.env.ETAPA_UNICA_ENABLED = 'true';

  const ctx = makeCtx([tk('T-notif', 'NOTIFICADO'), tk('T-cancel', 'CANCELADO'), tk('T-auto', 'AF25', 'PIPE_AUTO')]);
  const r = await syncLineItemPropToTickets({ lineItemId: 'LI1', propertyName: 'area', dealId: 'D1', ...ctx });

  assert.equal(r.ticketsUpdated, 0);
  assert.equal(r.skipped, 3);
  assert.equal(ctx.updateCalls.length, 0);

  delete process.env.ETAPA_UNICA_ENABLED;
});
