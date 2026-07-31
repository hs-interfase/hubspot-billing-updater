// src/__tests__/cronGanadoDealsSearch.test.mjs
//
// TANDA A punto 1 (definitivos/PLAN_proximos_cambios_tickets_2026-07-29.md):
// bajo ETAPA_UNICA_ENABLED, cronDealsBatch/cronWeekendFull dejan de buscar
// 85%/95% por ETAPA de ticket vencida y en su lugar buscan NEGOCIOS en esas
// etapas de deal, verificando que tengan algún ticket en «Próximos a
// facturar». Se corre la MISMA batería contra los dos crons (misma lógica,
// duplicada por archivo — igual que el resto del módulo).
//
// client/withRetryFn FAKE — nada toca HubSpot.

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@127.0.0.1:1/dummy';

// IDs distintos y determinísticos — constants.js los lee a nivel de módulo.
process.env.DEAL_STAGE_85 = 'DEALSTAGE_85';
process.env.DEAL_STAGE_95 = 'DEALSTAGE_95';
process.env.DEAL_STAGE_100 = 'DEALSTAGE_100';
process.env.BILLING_TICKET_STAGE_ID = 'STAGE_PROXIMOS';
process.env.BILLING_TICKET_FORECAST = 'STAGE_F25';
process.env.BILLING_TICKET_FORECAST_50 = 'STAGE_F50';
process.env.BILLING_TICKET_FORECAST_75 = 'STAGE_F75';
process.env.BILLING_TICKET_FORECAST_85 = 'STAGE_F85';
process.env.BILLING_TICKET_FORECAST_95 = 'STAGE_F95';

const cronDealsBatch = await import('../jobs/cronDealsBatch.js');
const cronWeekendFull = await import('../jobs/cronWeekendFull.js');
const { etapaUnicaEnabled } = await import('../config/etapaUnicaFlags.js');

const MODULES = [
  ['cronDealsBatch', cronDealsBatch],
  ['cronWeekendFull', cronWeekendFull],
];

const withRetryFn = (fn) => fn(); // sin reintentos ni backoff en tests

for (const [name, mod] of MODULES) {

  test(`${name}: searchOverdueForecasts — flag OFF usa las 5 etapas (incluye 85/95)`, async () => {
    delete process.env.ETAPA_UNICA_ENABLED;
    let stagesUsed = null;
    const client = {
      crm: { tickets: { searchApi: { doSearch: async (body) => {
        stagesUsed = body.filterGroups.map(g => g.filters[0].value);
        return { results: [] };
      } } } },
    };
    await mod.searchOverdueForecasts({ after: null, limit: 10 }, { client, withRetryFn });
    assert.deepEqual(stagesUsed.sort(), ['STAGE_F25', 'STAGE_F50', 'STAGE_F75', 'STAGE_F85', 'STAGE_F95'].sort());
  });

  test(`${name}: searchOverdueForecasts — flag ON usa sólo hasta el 75%`, async () => {
    process.env.ETAPA_UNICA_ENABLED = 'true';
    let stagesUsed = null;
    const client = {
      crm: { tickets: { searchApi: { doSearch: async (body) => {
        stagesUsed = body.filterGroups.map(g => g.filters[0].value);
        return { results: [] };
      } } } },
    };
    await mod.searchOverdueForecasts({ after: null, limit: 10 }, { client, withRetryFn });
    assert.deepEqual(stagesUsed.sort(), ['STAGE_F25', 'STAGE_F50', 'STAGE_F75'].sort());
    delete process.env.ETAPA_UNICA_ENABLED;
  });

  test(`${name}: findDealIdsWithTicketInStage — junta of_deal_id paginando y trocea en chunks de 100`, async () => {
    const calls = [];
    const client = {
      crm: { tickets: { searchApi: { doSearch: async (body) => {
        calls.push(body);
        const values = body.filterGroups[0].filters[1].values;
        // Primera página de la primera tanda: 2 resultados + cursor; segunda página: 1 resultado.
        if (values[0] === 'D1' && !body.after) {
          return { results: [{ properties: { of_deal_id: 'D1' } }], paging: { next: { after: 'CURSOR1' } } };
        }
        if (values[0] === 'D1' && body.after === 'CURSOR1') {
          return { results: [{ properties: { of_deal_id: 'D2' } }] };
        }
        return { results: [{ properties: { of_deal_id: values[0] } }] };
      } } } },
    };

    // 101 dealIds → debe trocear en 2 chunks (<=100 cada uno, límite del IN).
    const dealIds = Array.from({ length: 101 }, (_, i) => `D${i + 1}`);
    dealIds[0] = 'D1'; // primer chunk arranca con D1, dispara la paginación simulada arriba

    const found = await mod.findDealIdsWithTicketInStage(dealIds, 'STAGE_PROXIMOS', { client, withRetryFn });

    assert.ok(found.has('D1'));
    assert.ok(found.has('D2'));
    // 2 chunks (<=100 y el resto) → al menos 2 llamadas con IN de <=100 values
    const chunkSizes = calls
      .filter(b => !b.after)
      .map(b => b.filterGroups[0].filters[1].values.length);
    assert.equal(chunkSizes.length, 2);
    for (const s of chunkSizes) assert.ok(s <= 100);
  });

  test(`${name}: findDealIdsWithTicketInStage — dealIds/stageId vacíos → set vacío, sin llamadas`, async () => {
    let called = false;
    const client = { crm: { tickets: { searchApi: { doSearch: async () => { called = true; return { results: [] }; } } } } };
    assert.deepEqual(await mod.findDealIdsWithTicketInStage([], 'STAGE_X', { client, withRetryFn }), new Set());
    assert.deepEqual(await mod.findDealIdsWithTicketInStage(['D1'], '', { client, withRetryFn }), new Set());
    assert.equal(called, false);
  });

  test(`${name}: searchGanadoDealsWithProximosTickets — busca deals en 85/95/100 y filtra por los que tienen ticket en Próximos`, async () => {
    let dealSearchFilters = null;
    const client = {
      crm: {
        deals: { searchApi: { doSearch: async (body) => {
          dealSearchFilters = body.filterGroups[0].filters[0];
          return { results: [{ id: 'D1' }, { id: 'D2' }, { id: 'D3' }] };
        } } },
      },
    };
    const found = new Set(['D1', 'D3']); // D2 no tiene ticket en Próximos
    const findDealIdsWithTicketInStageFn = async (dealIds, stageId) => {
      assert.equal(stageId, 'STAGE_PROXIMOS');
      assert.deepEqual(dealIds.sort(), ['D1', 'D2', 'D3']);
      return found;
    };

    const r = await mod.searchGanadoDealsWithProximosTickets(
      { after: null, limit: 100 },
      { client, withRetryFn, findDealIdsWithTicketInStageFn }
    );

    assert.equal(dealSearchFilters.propertyName, 'dealstage');
    assert.equal(dealSearchFilters.operator, 'IN');
    assert.deepEqual(dealSearchFilters.values.sort(), ['DEALSTAGE_100', 'DEALSTAGE_85', 'DEALSTAGE_95'].sort());

    assert.deepEqual(
      r.results.map(x => x.properties.of_deal_id).sort(),
      ['D1', 'D3']
    );
  });

  test(`${name}: searchGanadoDealsWithProximosTickets — sin deals → resultado vacío, no llama a la verificación de tickets`, async () => {
    let verifyCalled = false;
    const client = { crm: { deals: { searchApi: { doSearch: async () => ({ results: [] }) } } } };
    const r = await mod.searchGanadoDealsWithProximosTickets(
      { after: null, limit: 100 },
      { client, withRetryFn, findDealIdsWithTicketInStageFn: async () => { verifyCalled = true; return new Set(); } }
    );
    assert.deepEqual(r.results, []);
    assert.equal(verifyCalled, false);
  });
}

test('sanity: etapaUnicaEnabled queda apagada al cerrar la suite', () => {
  delete process.env.ETAPA_UNICA_ENABLED;
  assert.equal(etapaUnicaEnabled(), false);
});
