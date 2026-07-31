// src/__tests__/contadoresEtapaUnica.test.mjs
//
// TANDA C — los OTROS escritores/lectores de las cuatro fechas viejas.
// El archivo hermano (tresFechasEtapaUnica.test.mjs) cubre recalcFromTickets,
// que con la llave prendida es la fuente única. Acá se prueba que los demás
// dejen de escribir la propiedad eliminada y de mover el contador a mano:
//
//   1. syncAfterPromotion  — era el ÚNICO writer de `pagos_restantes`
//      (decremental). Con la llave prendida no escribe ni el contador ni
//      `last_ticketed_date`: si lo hiciera, una promoción se contaría dos veces.
//   2. billingEngine.computeLastBillingDateFromLineItems — alimenta la
//      propiedad de NEGOCIO `facturacion_ultima_fecha` (Phase 1), que es panel
//      ejecutivo. Si siguiera leyendo `last_ticketed_date` se congelaría en
//      silencio, que es justo lo que esta tanda tiene que evitar.
//
// Criterio de aceptación: con ETAPA_UNICA_ENABLED apagada, todo idéntico a hoy.
//
// Correr con: node --test src/__tests__/contadoresEtapaUnica.test.mjs

import test from 'node:test';
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
process.env.BILLING_TICKET_STAGE_ID_BILLED = 'EMITIDO';
process.env.BILLING_TICKET_STAGE_CANCELLED = 'CANCELADO';
process.env.BILLING_AUTOMATED_FORECAST = 'AF25';
process.env.BILLING_AUTOMATED_READY = 'AUTO_NOTIFICADO';
process.env.BILLING_AUTOMATED_CANCELLED = 'AUTO_CANCELADO';
process.env.DEAL_ALERTS_ENABLED = 'false';

const { syncLineItemAfterPromotion } = await import('../services/lineItems/syncAfterPromotion.js');
const { computeLastBillingDateFromLineItems } = await import('../billingEngine.js');

const OFF = () => { delete process.env.ETAPA_UNICA_ENABLED; };
const ON = () => { process.env.ETAPA_UNICA_ENABLED = 'true'; };

// ═════════════════════════════════════════════════════════════════════════════
// 1) syncAfterPromotion — el contador decremental se apaga
// ═════════════════════════════════════════════════════════════════════════════

/** Cliente falso: el LI arranca con `liProps` y el search de forecasts devuelve `siguientes`. */
function makeClient({ liProps = {}, siguientes = [] } = {}) {
  const updates = [];
  const searches = [];
  return {
    updates,
    searches,
    crm: {
      tickets: {
        searchApi: {
          doSearch: async (body) => {
            searches.push(body);
            return { results: siguientes };
          },
        },
      },
      lineItems: {
        basicApi: {
          getById: async () => ({ properties: liProps }),
          update: async (id, body) => { updates.push(body.properties); return {}; },
        },
      },
    },
  };
}

const LI_EN_CURSO = {
  hs_recurring_billing_number_of_payments: '12',
  pagos_restantes: '10',
  last_ticketed_date: '2026-03-31',
  last_billing_period: '2026-03-31',
  billing_next_date: '2026-04-30',
};

test('flag OFF: la promoción descuenta pagos_restantes y escribe last_ticketed_date', async () => {
  OFF();
  const client = makeClient({ liProps: LI_EN_CURSO });

  await syncLineItemAfterPromotion({
    dealId: 'D1', lineItemId: 'LI1', lineItemKey: 'L1',
    expectedYMD: '2026-04-30', client,
  });

  assert.equal(client.updates.length, 1);
  const u = client.updates[0];
  assert.equal(u.pagos_restantes, '9');          // 10 − 1
  assert.equal(u.last_ticketed_date, '2026-04-30');
});

test('flag ON: la promoción NO toca pagos_restantes ni last_ticketed_date', async () => {
  ON();
  const client = makeClient({ liProps: LI_EN_CURSO });

  await syncLineItemAfterPromotion({
    dealId: 'D1', lineItemId: 'LI1', lineItemKey: 'L1',
    expectedYMD: '2026-04-30', client,
  });

  // Puede escribir billing_next_date, pero nunca el contador ni la fecha eliminada.
  for (const u of client.updates) {
    assert.equal('pagos_restantes' in u, false);
    assert.equal('last_ticketed_date' in u, false);
  }
  OFF();
});

test('flag ON: sin nada que escribir, no hay PATCH (no se inventa un write)', async () => {
  ON();
  // billing_next_date ya apunta al único candidato futuro → no hay diff.
  const client = makeClient({
    liProps: { ...LI_EN_CURSO, billing_next_date: '2026-05-31' },
    siguientes: [{ id: 'T2', properties: { fecha_resolucion_esperada: '2026-05-31' } }],
  });

  await syncLineItemAfterPromotion({
    dealId: 'D1', lineItemId: 'LI1', lineItemKey: 'L1',
    expectedYMD: '2026-04-30', client,
  });

  assert.equal(client.updates.length, 0);
  OFF();
});

test('flag ON: la búsqueda de la próxima fecha incluye «Próximos a facturar»', async () => {
  ON();
  const client = makeClient({ liProps: LI_EN_CURSO });

  await syncLineItemAfterPromotion({
    dealId: 'D1', lineItemId: 'LI1', lineItemKey: 'L1',
    expectedYMD: '2026-04-30', client,
  });

  const stagesBuscadas = client.searches[0].filterGroups[0].filters
    .find(f => f.propertyName === 'hs_pipeline_stage').values;
  assert.ok(stagesBuscadas.includes('PROXIMOS'),
    'sin «Próximos» no habría candidato y la próxima fecha se congelaría');
  OFF();
});

test('flag OFF: la búsqueda sigue siendo sólo de etapas forecast', async () => {
  OFF();
  const client = makeClient({ liProps: LI_EN_CURSO });

  await syncLineItemAfterPromotion({
    dealId: 'D1', lineItemId: 'LI1', lineItemKey: 'L1',
    expectedYMD: '2026-04-30', client,
  });

  const stagesBuscadas = client.searches[0].filterGroups[0].filters
    .find(f => f.propertyName === 'hs_pipeline_stage').values;
  assert.equal(stagesBuscadas.includes('PROXIMOS'), false);
});

// ═════════════════════════════════════════════════════════════════════════════
// 2) La última fecha A NIVEL NEGOCIO (facturacion_ultima_fecha) — panel ejecutivo
// ═════════════════════════════════════════════════════════════════════════════

const HOY = new Date('2026-07-31T12:00:00Z');

function li(props) {
  return { id: 'LI', properties: props };
}

test('flag OFF: facturacion_ultima_fecha sale de last_ticketed_date, como hoy', () => {
  OFF();
  const r = computeLastBillingDateFromLineItems(
    [li({ last_ticketed_date: '2026-06-30', last_billing_period: '2026-04-30' })],
    HOY
  );
  assert.equal(r.toISOString().slice(0, 10), '2026-06-30');
});

test('flag ON: sale de la fecha NOTIFICADO — no se congela ni se vacía en silencio', () => {
  ON();
  const r = computeLastBillingDateFromLineItems(
    [li({ last_ticketed_date: '2026-06-30', last_billing_period: '2026-04-30' })],
    HOY
  );
  assert.equal(r.toISOString().slice(0, 10), '2026-04-30');
  OFF();
});

test('flag ON: un plan ganado que todavía no notificó nada no reporta última fecha', () => {
  ON();
  // Antes daría 2026-06-30 leyendo el valor viejo, que incluía «Próximos»:
  // el informe mostraría como facturado un período que nunca se notificó.
  const r = computeLastBillingDateFromLineItems(
    [li({ last_ticketed_date: '2026-06-30', last_billing_period: '' })],
    HOY
  );
  assert.equal(r, null);
  OFF();
});

test('toma el máximo pasado entre varios line items (comportamiento intacto)', () => {
  ON();
  const r = computeLastBillingDateFromLineItems(
    [
      li({ last_billing_period: '2026-02-28' }),
      li({ last_billing_period: '2026-05-31' }),
      li({ last_billing_period: '2026-12-31' }),   // futura: no cuenta
    ],
    HOY
  );
  assert.equal(r.toISOString().slice(0, 10), '2026-05-31');
  OFF();
});
