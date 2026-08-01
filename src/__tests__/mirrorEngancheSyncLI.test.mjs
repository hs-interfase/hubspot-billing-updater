// src/__tests__/mirrorEngancheSyncLI.test.mjs
//
// TANDA D — el ENGANCHE: el sync quirúrgico LI→ticket es el único punto del
// motor donde existe el valor ANTERIOR (lo que el ticket tenía antes del patch).
// De ahí sale el "pasó de X a Y" del aviso al espejo, y de ahí salen los
// PERÍODOS a los que se avisa.
//
// PAR OFF/ON: con MIRROR_PUNTUAL_ENABLED apagada, el sync se comporta como hoy
// (aviso al DEAL espejo) y no se llama a la propagación nueva.
//
//   DATABASE_URL='postgres://u:p@localhost:5432/x' node --test src/__tests__/mirrorEngancheSyncLI.test.mjs

process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/x';
// El sync sólo alcanza tickets de «Próximos a facturar» del pipeline manual:
// se fijan ids sintéticos ANTES de importar (constants los lee al cargar).
process.env.BILLING_TICKET_PIPELINE_ID ||= 'PIPE-MANUAL';
process.env.BILLING_TICKET_STAGE_ID_NEW ||= 'STAGE-PROXIMOS';

import test from 'node:test';
import assert from 'node:assert/strict';

const { syncLineItemPropToTickets, ymdDelTicket } = await import(
  '../services/lineItems/syncLineItemPropToTicket.js'
);
const { TICKET_PIPELINE, PROXIMOS_A_FACTURAR_STAGE } = await import('../config/constants.js');

function makeDeps({ tickets = [], liProps = {} } = {}) {
  const propagaciones = [];
  const emailsMirror = [];
  const reportsMirror = [];
  const ticketUpdates = [];

  const client = {
    crm: {
      lineItems: { basicApi: { getById: async () => ({ properties: { line_item_key: 'LIK-PY', ...liProps } }) } },
      deals: { basicApi: { getById: async () => ({ properties: { deal_currency_code: 'USD' } }) } },
      tickets: { searchApi: { doSearch: async () => ({ results: tickets }) } },
    },
  };

  return {
    propagaciones, emailsMirror, reportsMirror, ticketUpdates,
    args: {
      client,
      extractFn: () => ({ of_descripcion_producto: 'DESC NUEVA', cantidad_real: '3', of_costo: '9', of_margen: '1' }),
      updateTicketFn: async (id, patch) => { ticketUpdates.push({ id, patch }); },
      findMirrorFn: async () => ({ mirrorDealId: 'DUY', mirrorLineItemId: 'LIUY', pyDealId: 'DPY' }),
      reportErrorFn: (a) => { reportsMirror.push(a); },
      notifyOwnerFn: async () => ({ notified: false }),
      emailMirrorFn: async (a) => { emailsMirror.push(a); },
      propagarEspejoFn: async (a) => { propagaciones.push(a); return { copiado: true, avisos: 1 }; },
    },
  };
}

const TICKET_PROXIMOS = {
  id: 'TKPY-1',
  properties: {
    hs_pipeline: TICKET_PIPELINE,
    hs_pipeline_stage: PROXIMOS_A_FACTURAR_STAGE,
    of_ticket_key: 'DPY::LIK:LIK-PY::2026-08-31',
    fecha_resolucion_esperada: '2026-08-31',
    of_descripcion_producto: 'DESC VIEJA',
  },
};

test('FLAG OFF — no se llama a la propagación al espejo; avisa al DEAL como hoy', async () => {
  delete process.env.MIRROR_PUNTUAL_ENABLED;
  const m = makeDeps({ tickets: [TICKET_PROXIMOS] });
  const r = await syncLineItemPropToTickets({ lineItemId: 'LIPY', propertyName: 'description', dealId: 'DPY', ...m.args });
  assert.equal(r.ticketsUpdated, 1);
  assert.equal(m.propagaciones.length, 0, 'la pieza nueva no corre con la llave apagada');
  assert.equal(r.mirrorNotified, true);
  assert.equal(m.reportsMirror.length, 1, 'billing_error en el DEAL espejo = comportamiento de hoy');
  assert.equal(m.emailsMirror.length, 1);
});

test('FLAG ON — se propaga al espejo con el ANTES y el DESPUÉS, y no se duplica el aviso al deal', async () => {
  process.env.MIRROR_PUNTUAL_ENABLED = 'true';
  try {
    const m = makeDeps({ tickets: [TICKET_PROXIMOS], liProps: { description: 'DESC NUEVA' } });
    const r = await syncLineItemPropToTickets({ lineItemId: 'LIPY', propertyName: 'description', dealId: 'DPY', ...m.args });
    assert.equal(r.ticketsUpdated, 1);
    assert.equal(m.propagaciones.length, 1);

    const p = m.propagaciones[0];
    assert.equal(p.lineItemId, 'LIPY');
    assert.equal(p.propertyName, 'description');
    assert.equal(p.sourceCurrency, 'USD');
    assert.deepEqual(p.cambiosPorPeriodo, [
      { ymd: '2026-08-31', antes: { of_descripcion_producto: 'DESC VIEJA' }, despues: { of_descripcion_producto: 'DESC NUEVA' } },
    ]);

    // El aviso ya salió al TICKET del espejo: no se repite en el deal.
    assert.equal(m.reportsMirror.length, 0);
    assert.equal(r.mirrorLiCopiado, true);
    assert.equal(r.mirrorAvisos, 1);
  } finally {
    delete process.env.MIRROR_PUNTUAL_ENABLED;
  }
});

test('FLAG ON — un período por cada ticket del original alcanzado', async () => {
  process.env.MIRROR_PUNTUAL_ENABLED = 'true';
  try {
    const t2 = {
      ...TICKET_PROXIMOS,
      id: 'TKPY-2',
      properties: { ...TICKET_PROXIMOS.properties, of_ticket_key: 'DPY::LIK:LIK-PY::2026-09-30', fecha_resolucion_esperada: '2026-09-30' },
    };
    const m = makeDeps({ tickets: [TICKET_PROXIMOS, t2] });
    await syncLineItemPropToTickets({ lineItemId: 'LIPY', propertyName: 'description', dealId: 'DPY', ...m.args });
    assert.deepEqual(m.propagaciones[0].cambiosPorPeriodo.map((c) => c.ymd), ['2026-08-31', '2026-09-30']);
  } finally {
    delete process.env.MIRROR_PUNTUAL_ENABLED;
  }
});

test('FLAG ON — sin tickets del original la COPIA al espejo corre igual (sin períodos)', async () => {
  process.env.MIRROR_PUNTUAL_ENABLED = 'true';
  try {
    const m = makeDeps({ tickets: [] });
    const r = await syncLineItemPropToTickets({ lineItemId: 'LIPY', propertyName: 'description', dealId: 'DPY', ...m.args });
    assert.equal(r.ticketsUpdated, 0);
    assert.equal(m.propagaciones.length, 1, 'la copia al espejo no depende de que haya tickets que actualizar');
    assert.deepEqual(m.propagaciones[0].cambiosPorPeriodo, []);
  } finally {
    delete process.env.MIRROR_PUNTUAL_ENABLED;
  }
});

test('FLAG ON — un fallo de la propagación no rompe el sync', async () => {
  process.env.MIRROR_PUNTUAL_ENABLED = 'true';
  try {
    const m = makeDeps({ tickets: [TICKET_PROXIMOS] });
    m.args.propagarEspejoFn = async () => { throw new Error('boom'); };
    const r = await syncLineItemPropToTickets({ lineItemId: 'LIPY', propertyName: 'description', dealId: 'DPY', ...m.args });
    assert.equal(r.ticketsUpdated, 1, 'el sync al ticket del original se completó igual');
  } finally {
    delete process.env.MIRROR_PUNTUAL_ENABLED;
  }
});

// ── El período del ticket ───────────────────────────────────────────────────

test('ymdDelTicket usa la fecha esperada y, si falta, la de la clave', () => {
  assert.equal(ymdDelTicket({ properties: { fecha_resolucion_esperada: '2026-08-31' } }), '2026-08-31');
  assert.equal(
    ymdDelTicket({ properties: { of_ticket_key: 'D::LIK:K::2026-09-30' } }),
    '2026-09-30',
    'sin fecha esperada, sale de la clave'
  );
  assert.equal(ymdDelTicket({ properties: {} }), '');
  // fecha con hora: se recorta a YMD (misma lección que el fix del 30-jun)
  assert.equal(ymdDelTicket({ properties: { fecha_resolucion_esperada: '2026-08-31T00:00:00Z' } }), '2026-08-31');
});
