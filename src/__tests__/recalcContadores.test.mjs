// src/__tests__/recalcContadores.test.mjs
//
// Prueba el MOTOR de Phase R:
//   - computeContadores (PURA): cuotas, pago único, auto-renew, sin total, y el
//     espejo bidireccional de fechas_completas (sella y des-sella).
//   - recalcContadores (IO con fakes): PATCH solo si cambió, des-sellado del
//     latch, y alertas SOLO en la transición (sin spam).
//
// Correr con:  node --test src/__tests__/recalcContadores.test.mjs
// No toca HubSpot: el conteo de tickets, el cliente y las alertas se inyectan.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { computeContadores, recalcContadores } from '../services/billing/recalcContadores.js';
import { buildPagoDisplay } from '../services/billing/syncBillingState.js';

// ───────────────────────── computeContadores (pura) ─────────────────────────

test('PLAN_FIJO parcial: contadores y sin sellar', () => {
  const props = { hs_recurring_billing_number_of_payments: '12' };
  const r = computeContadores(props, { invoiced: 3, derived: 5 });
  assert.equal(r.mode, 'PLAN_FIJO');
  assert.equal(r.restantes, '9');
  assert.equal(r.porDerivar, '7');
  assert.equal(r.progreso, buildPagoDisplay(3, 12));
  assert.equal(r.sealFechasCompletas, false);
});

test('PLAN_FIJO completo: restantes 0 → sella', () => {
  const props = { hs_recurring_billing_number_of_payments: '6' };
  const r = computeContadores(props, { invoiced: 6, derived: 6 });
  assert.equal(r.restantes, '0');
  assert.equal(r.porDerivar, '0');
  assert.equal(r.sealFechasCompletas, true);
});

test('PLAN_FIJO over-complete (invoiced > total): clamp a 0 y sella', () => {
  // Caso clon: total bajado a 2 con 3 ya facturados.
  const props = { hs_recurring_billing_number_of_payments: '2' };
  const r = computeContadores(props, { invoiced: 3, derived: 3 });
  assert.equal(r.restantes, '0');
  assert.equal(r.sealFechasCompletas, true);
  assert.equal(r.progreso, buildPagoDisplay(3, 2)); // emitidas capadas al total
});

test('PAGO ÚNICO (sin freq, sin total): se trata como 1 cuota', () => {
  const r0 = computeContadores({}, { invoiced: 0, derived: 0 });
  assert.equal(r0.mode, 'PLAN_FIJO');
  assert.equal(r0.restantes, '1');
  assert.equal(r0.sealFechasCompletas, false);

  const r1 = computeContadores({}, { invoiced: 1, derived: 1 });
  assert.equal(r1.restantes, '0');
  assert.equal(r1.sealFechasCompletas, true);
});

test('AUTO_RENEW: cosméticos vacíos y NO toca fechas_completas (null)', () => {
  const props = { renovacion_automatica: 'true', recurringbillingfrequency: 'monthly' };
  const r = computeContadores(props, { invoiced: 5, derived: 5 });
  assert.equal(r.mode, 'AUTO_RENEW');
  assert.equal(r.restantes, '');
  assert.equal(r.porDerivar, '');
  assert.equal(r.progreso, '');
  assert.equal(r.sealFechasCompletas, null);
});

test('SIN_TOTAL (freq pero sin total, forzado no-autorenew): vacíos, flag null', () => {
  const props = { renovacion_automatica: 'false', recurringbillingfrequency: 'monthly' };
  const r = computeContadores(props, { invoiced: 0, derived: 0 });
  assert.equal(r.mode, 'SIN_TOTAL');
  assert.equal(r.restantes, '');
  assert.equal(r.sealFechasCompletas, null);
});

// ───────────────────────── recalcContadores (IO con fakes) ──────────────────

// Fake hubspotClient: solo getById + lineItems.update (el conteo se inyecta).
function makeClient(liProps) {
  const updates = [];
  const client = {
    crm: {
      lineItems: {
        basicApi: {
          getById: async () => ({ id: 'LI1', properties: liProps }),
          update: async (_id, body) => { updates.push(body.properties); return {}; },
        },
      },
    },
  };
  return { client, updates };
}

const noopAlert = () => mock.fn(async () => {});

async function runRecalc(liProps, counts) {
  const { client, updates } = makeClient(liProps);
  const alertSeal = noopAlert();
  const alertDeriv = noopAlert();
  const res = await recalcContadores({
    hubspotClient: client,
    lineItemId: 'LI1',
    dealId: 'DEAL1',
    countTicketsFn: async () => counts,
    alertFechasCompletasFn: alertSeal,
    alertDerivacionCompletaFn: alertDeriv,
  });
  return { res, updates, alertSeal, alertDeriv };
}

test('DES-SELLA: fechas_completas=true pero el estado real tiene cuotas pendientes', async () => {
  // El latch que mataba líneas: ahora se corrige a false.
  const liProps = {
    hs_recurring_billing_number_of_payments: '12',
    fechas_completas: 'true',
    facturas_restantes: '0',
    facturas_por_derivar: '0',
    progreso_pagos: buildPagoDisplay(12, 12),
    line_item_key: 'LIK-1',
  };
  const { updates, alertSeal } = await runRecalc(liProps, { invoiced: 3, derived: 5 });

  assert.equal(updates.length, 1);
  assert.equal(updates[0].fechas_completas, 'false');
  assert.equal(updates[0].facturas_restantes, '9');
  assert.equal(alertSeal.mock.callCount(), 0, 'des-sellar no dispara alerta de sello');
});

test('SELLA en transición y dispara alerta una sola vez', async () => {
  const liProps = {
    hs_recurring_billing_number_of_payments: '6',
    fechas_completas: 'false',
    facturas_restantes: '1',
    facturas_por_derivar: '1',
    progreso_pagos: buildPagoDisplay(5, 6),
    line_item_key: 'LIK-2',
  };
  const { updates, alertSeal } = await runRecalc(liProps, { invoiced: 6, derived: 6 });

  assert.equal(updates[0].fechas_completas, 'true');
  assert.equal(alertSeal.mock.callCount(), 1);
});

test('YA sellado y completo: noop, sin alerta (sin spam)', async () => {
  const liProps = {
    hs_recurring_billing_number_of_payments: '6',
    fechas_completas: 'true',
    facturas_restantes: '0',
    facturas_por_derivar: '0',
    progreso_pagos: buildPagoDisplay(6, 6),
    line_item_key: 'LIK-3',
  };
  const { updates, alertSeal, alertDeriv } = await runRecalc(liProps, { invoiced: 6, derived: 6 });

  assert.equal(updates.length, 0, 'sin cambios → no escribe');
  assert.equal(alertSeal.mock.callCount(), 0);
  assert.equal(alertDeriv.mock.callCount(), 0);
});

test('alerta de derivación SOLO en transición a 0', async () => {
  // Antes derivar=2, ahora 0 → alerta.
  const liProps = {
    hs_recurring_billing_number_of_payments: '6',
    fechas_completas: 'false',
    facturas_restantes: '3',
    facturas_por_derivar: '2',
    progreso_pagos: buildPagoDisplay(3, 6),
    line_item_key: 'LIK-4',
  };
  const { alertDeriv } = await runRecalc(liProps, { invoiced: 3, derived: 6 });
  assert.equal(alertDeriv.mock.callCount(), 1);
});

test('skip si no hay line_item_key', async () => {
  const { res, updates } = await runRecalc({ hs_recurring_billing_number_of_payments: '6' }, { invoiced: 0, derived: 0 });
  assert.equal(res.skipped, true);
  assert.equal(updates.length, 0);
});
