// src/__tests__/associateOnClosedWonScheduleSummary.test.mjs
//
// TANDA A punto 3 (definitivos/PLAN_proximos_cambios_tickets_2026-07-29.md):
// resumen ÚNICO al cierre ganado, enganchado al final de
// associateAllTicketsOnClosedWon (que ya trae los tickets del deal fetcheados).
// Bajo ETAPA_UNICA_ENABLED apagada (default): no llama al resumen — cero
// cambios de comportamiento. Prendida: llama UNA vez y marca
// RESUMEN_ENVIADO_PROP en el deal para no reenviar en la próxima pasada
// (este hook corre en cada corrida de phases sobre negocios ya ganados).
//
// client / notifyDealWonScheduleSummaryFn FAKE — nada toca HubSpot ni Resend.
process.env.TICKET_LABEL_SYNC_ENABLED = 'false'; // aislar del re-sync de etiquetas (ver associateOnClosedWon.test.mjs)

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@127.0.0.1:1/dummy';

const { associateAllTicketsOnClosedWon } = await import('../services/tickets/associateOnClosedWon.js');
const { RESUMEN_ENVIADO_PROP } = await import('../services/notifications/dealWonScheduleSummaryAlert.js');

function makeFakeClient({ tickets = [] } = {}) {
  const dealUpdateCalls = [];
  const sorted = [...tickets].sort((a, b) => Number(a.id) - Number(b.id));
  return {
    dealUpdateCalls,
    client: {
      crm: {
        tickets: {
          searchApi: {
            async doSearch(body) {
              const filters = body?.filterGroups?.[0]?.filters || [];
              const gt = filters.find(f => f.propertyName === 'hs_object_id' && f.operator === 'GT');
              const lastId = Number(gt?.value ?? 0);
              return { results: sorted.filter(t => Number(t.id) > lastId).slice(0, 100) };
            },
          },
        },
        associations: {
          v4: {
            basicApi: {
              async getPage() { return { results: [] }; },
              async create() { return { ok: true }; },
            },
          },
        },
        deals: {
          basicApi: {
            async update(dealId, body) {
              dealUpdateCalls.push({ dealId, ...body.properties });
            },
          },
        },
      },
    },
  };
}

const ticket = (id, fecha = '2026-09-01') => ({
  id: String(id),
  properties: { of_deal_id: 'D1', hs_pipeline: 'PIPE_MANUAL', fecha_resolucion_esperada: fecha },
});

test('flag OFF (default): no llama al resumen ni escribe el marker', async () => {
  delete process.env.ETAPA_UNICA_ENABLED;
  const { client, dealUpdateCalls } = makeFakeClient({ tickets: [ticket(1)] });
  let notifyCalled = false;

  const stats = await associateAllTicketsOnClosedWon({
    dealId: 'D1',
    dealProps: { facturacion_activa: 'true', dealname: 'Acme' },
    onlyManualPipeline: false,
    client,
    getDealCompaniesFn: async () => [],
    getDealContactsFn: async () => [],
    notifyDealWonScheduleSummaryFn: async () => { notifyCalled = true; return { emailed: true }; },
  });

  assert.equal(notifyCalled, false);
  assert.equal(dealUpdateCalls.length, 0);
  assert.equal(stats.scheduleSummarySent, false);
});

test('flag ON, sin marker: llama al resumen con los tickets ya fetcheados y marca el deal', async () => {
  process.env.ETAPA_UNICA_ENABLED = 'true';
  const { client, dealUpdateCalls } = makeFakeClient({ tickets: [ticket(1, '2026-09-01'), ticket(2, '2026-10-01')] });
  const notifyCalls = [];

  const stats = await associateAllTicketsOnClosedWon({
    dealId: 'D1',
    dealProps: { facturacion_activa: 'true', dealname: 'Acme', hubspot_owner_id: 'OW1' },
    onlyManualPipeline: false,
    client,
    getDealCompaniesFn: async () => [],
    getDealContactsFn: async () => [],
    notifyDealWonScheduleSummaryFn: async (args) => { notifyCalls.push(args); return { emailed: true }; },
  });

  assert.equal(notifyCalls.length, 1);
  assert.equal(notifyCalls[0].dealId, 'D1');
  assert.equal(notifyCalls[0].dealName, 'Acme');
  assert.equal(notifyCalls[0].dealOwnerId, 'OW1');
  assert.equal(notifyCalls[0].tickets.length, 2);

  assert.deepEqual(dealUpdateCalls, [{ dealId: 'D1', [RESUMEN_ENVIADO_PROP]: 'true' }]);
  assert.equal(stats.scheduleSummarySent, true);

  delete process.env.ETAPA_UNICA_ENABLED;
});

test('flag ON, marker ya en true: NO reenvía (evita el spam en cada pasada de phases)', async () => {
  process.env.ETAPA_UNICA_ENABLED = 'true';
  const { client, dealUpdateCalls } = makeFakeClient({ tickets: [ticket(1)] });
  let notifyCalled = false;

  const stats = await associateAllTicketsOnClosedWon({
    dealId: 'D1',
    dealProps: { facturacion_activa: 'true', dealname: 'Acme', [RESUMEN_ENVIADO_PROP]: 'true' },
    onlyManualPipeline: false,
    client,
    getDealCompaniesFn: async () => [],
    getDealContactsFn: async () => [],
    notifyDealWonScheduleSummaryFn: async () => { notifyCalled = true; return { emailed: true }; },
  });

  assert.equal(notifyCalled, false);
  assert.equal(dealUpdateCalls.length, 0);
  assert.equal(stats.scheduleSummarySent, false);

  delete process.env.ETAPA_UNICA_ENABLED;
});

test('flag ON, email omitido (DEAL_ALERTS_ENABLED=false dentro del notify): NO marca — reintenta la próxima pasada', async () => {
  process.env.ETAPA_UNICA_ENABLED = 'true';
  const { client, dealUpdateCalls } = makeFakeClient({ tickets: [ticket(1)] });

  const stats = await associateAllTicketsOnClosedWon({
    dealId: 'D1',
    dealProps: { facturacion_activa: 'true', dealname: 'Acme' },
    onlyManualPipeline: false,
    client,
    getDealCompaniesFn: async () => [],
    getDealContactsFn: async () => [],
    notifyDealWonScheduleSummaryFn: async () => ({ emailed: false, reason: 'DEAL_ALERTS_ENABLED=false' }),
  });

  assert.equal(dealUpdateCalls.length, 0);
  assert.equal(stats.scheduleSummarySent, false);

  delete process.env.ETAPA_UNICA_ENABLED;
});
