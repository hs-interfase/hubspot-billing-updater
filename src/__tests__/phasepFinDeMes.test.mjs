// src/__tests__/phasepFinDeMes.test.mjs
//
// Regresión #6 (auditoría 2026-07-18): Phase P (buildDesiredDates) debe aplicar la
// regla fin_de_mes (último día HÁBIL) al PLANIFICAR las fechas, igual que billingEngine.
// Antes generaba en el día del ancla (~2 semanas antes) todos los meses.
//
// Referencia 2026 (año NO bisiesto, 2026-01-01 = jueves):
//   - 2026-01-31 = sábado  → último hábil 2026-01-30 (vie)
//   - 2026-02-28 = sábado  → último hábil 2026-02-27 (vie)
//   - 2026-03-31 = martes  → último hábil 2026-03-31
//
// Correr con:  node --test src/__tests__/phasepFinDeMes.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDesiredDates } from '../phases/phasep.js';

// Plan fijo mensual de 3 pagos. anchor = start (no manual). pagos_restantes > 0 para
// no disparar el early-return de plan fijo consumido.
const makeLI = ({ start, momento }) => ({
  id: 'LI-test',
  properties: {
    recurringbillingfrequency: 'monthly',
    hs_recurring_billing_start_date: start,
    billing_anchor_date: start,
    hs_recurring_billing_number_of_payments: '3',
    pagos_restantes: '3',
    ...(momento ? { momento_de_facturacion: momento } : {}),
  },
});

test('fin_de_mes: Phase P snapea cada período al último día hábil', () => {
  const li = makeLI({ start: '2026-01-15', momento: 'fin_de_mes' });
  const { dates } = buildDesiredDates(li, [], { overrideToday: '2026-01-01' });
  assert.deepEqual(dates, ['2026-01-30', '2026-02-27', '2026-03-31']);
});

test('SIN fin_de_mes: Phase P respeta el día del ancla (comportamiento previo)', () => {
  const li = makeLI({ start: '2026-01-15' }); // momento ausente
  const { dates } = buildDesiredDates(li, [], { overrideToday: '2026-01-01' });
  assert.deepEqual(dates, ['2026-01-15', '2026-02-15', '2026-03-15']);
});

test('fin_de_mes semanal NO snapea (solo intervalos mensuales+)', () => {
  const li = {
    id: 'LI-week',
    properties: {
      recurringbillingfrequency: 'weekly',
      hs_recurring_billing_start_date: '2026-01-05',
      billing_anchor_date: '2026-01-05',
      hs_recurring_billing_number_of_payments: '3',
      pagos_restantes: '3',
      momento_de_facturacion: 'fin_de_mes',
    },
  };
  const { dates } = buildDesiredDates(li, [], { overrideToday: '2026-01-01' });
  assert.deepEqual(dates, ['2026-01-05', '2026-01-12', '2026-01-19']);
});
