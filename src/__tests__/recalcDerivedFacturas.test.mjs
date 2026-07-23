// src/__tests__/recalcDerivedFacturas.test.mjs
//
// Prueba el guard de migración del aviso de derivación completa:
//   - sin guard: porDerivar=0 reconfirmado → alertDerivacionCompleta se dispara
//   - esEmisionHistorica (ticket mig_emision_historica) → aviso omitido
//   - LI con mig_migracion_historica → aviso omitido
//   - el recálculo del contador NO se ve afectado por el guard
//
// Correr con:  node --test src/__tests__/recalcDerivedFacturas.test.mjs
// No toca HubSpot: cliente y alerta se inyectan.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recalcDerivedFacturas } from '../services/billing/recalcDerivedFacturas.js';
import { DERIVED_STAGES } from '../config/constants.js';

const DERIVED_STAGE = [...DERIVED_STAGES][0];

// Fake hubspotClient: getById/update de line items + search de tickets.
function makeClient({ liProps, derivedCount }) {
  const updates = [];
  const client = {
    crm: {
      lineItems: {
        basicApi: {
          async getById() { return { properties: liProps }; },
          async update(id, { properties }) { updates.push({ id, properties }); },
        },
      },
      tickets: {
        searchApi: {
          async doSearch() {
            return {
              results: Array.from({ length: derivedCount }, () => ({
                properties: { hs_pipeline_stage: DERIVED_STAGE },
              })),
            };
          },
        },
      },
    },
  };
  return { client, updates };
}

function makeAlertSpy() {
  const calls = [];
  const fn = async (args) => { calls.push(args); };
  return { fn, calls };
}

const BASE_LI = {
  renovacion_automatica: 'false',
  hs_recurring_billing_number_of_payments: '2',
  recurringbillingfrequency: 'monthly',
  facturas_por_derivar: '0',
  line_item_key: 'LIK-TEST',
};

test('porDerivar=0 reconfirmado sin guard → alerta se dispara', async () => {
  const { client, updates } = makeClient({ liProps: { ...BASE_LI }, derivedCount: 2 });
  const alert = makeAlertSpy();

  const r = await recalcDerivedFacturas({
    hubspotClient: client, lineItemId: '1', dealId: '9',
    alertDerivacionCompletaFn: alert.fn,
  });

  assert.equal(r.facturas_por_derivar, 0);
  assert.equal(updates.length, 0); // ya era '0', noop
  assert.equal(alert.calls.length, 1);
  assert.equal(alert.calls[0].lik, 'LIK-TEST');
});

test('esEmisionHistorica=true → aviso omitido', async () => {
  const { client } = makeClient({ liProps: { ...BASE_LI }, derivedCount: 2 });
  const alert = makeAlertSpy();

  const r = await recalcDerivedFacturas({
    hubspotClient: client, lineItemId: '1', dealId: '9',
    esEmisionHistorica: true,
    alertDerivacionCompletaFn: alert.fn,
  });

  assert.equal(r.facturas_por_derivar, 0);
  assert.equal(alert.calls.length, 0);
});

test('LI con mig_migracion_historica=true → aviso omitido', async () => {
  const { client } = makeClient({
    liProps: { ...BASE_LI, mig_migracion_historica: 'true' },
    derivedCount: 2,
  });
  const alert = makeAlertSpy();

  const r = await recalcDerivedFacturas({
    hubspotClient: client, lineItemId: '1', dealId: '9',
    alertDerivacionCompletaFn: alert.fn,
  });

  assert.equal(r.facturas_por_derivar, 0);
  assert.equal(alert.calls.length, 0);
});

test('guard activo NO afecta el recálculo del contador (transición 1→0)', async () => {
  const { client, updates } = makeClient({
    liProps: { ...BASE_LI, facturas_por_derivar: '1' },
    derivedCount: 2,
  });
  const alert = makeAlertSpy();

  const r = await recalcDerivedFacturas({
    hubspotClient: client, lineItemId: '1', dealId: '9',
    esEmisionHistorica: true,
    alertDerivacionCompletaFn: alert.fn,
  });

  assert.equal(r.facturas_por_derivar, 0);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].properties.facturas_por_derivar, '0');
  assert.equal(alert.calls.length, 0);
});

test('porDerivar > 0 → sin alerta, con o sin guard', async () => {
  const { client } = makeClient({ liProps: { ...BASE_LI, facturas_por_derivar: '1' }, derivedCount: 1 });
  const alert = makeAlertSpy();

  const r = await recalcDerivedFacturas({
    hubspotClient: client, lineItemId: '1', dealId: '9',
    alertDerivacionCompletaFn: alert.fn,
  });

  assert.equal(r.facturas_por_derivar, 1);
  assert.equal(alert.calls.length, 0);
});
