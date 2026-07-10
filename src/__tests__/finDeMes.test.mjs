// src/__tests__/finDeMes.test.mjs
//
// Prueba el momento de facturación "fin_de_mes": cada período recurrente cae en
// el ÚLTIMO DÍA HÁBIL (lunes-viernes) del mes, retrocediendo si cae sábado/domingo.
// Se ejercita de punta a punta vía getNextBillingDateForLineItem (función pura:
// recibe el line item + una fecha "hoy" fija, no toca HubSpot).
//
// Fechas de referencia (2026, año NO bisiesto; 2026-01-01 = jueves):
//   - 2026-08-31 = lunes    → último día hábil = 2026-08-31 (sin retroceso)
//   - 2026-05-31 = domingo  → último día hábil = 2026-05-29 (viernes, -2)
//   - 2026-02-28 = sábado   → último día hábil = 2026-02-27 (viernes, -1)
//
// Correr con:  node --test src/__tests__/finDeMes.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getNextBillingDateForLineItem } from '../billingEngine.js';
import { formatDateISO } from '../utils/dateUtils.js';

// Line item recurrente mensual. `anchor`/`start` fijan el ancla; `momento` decide
// si se snapea a fin de mes. Sin contadores ni last_ticketed para no interferir.
const makeLI = ({ start, momento }) => ({
  id: 'LI-test',
  properties: {
    recurringbillingfrequency: 'monthly',
    hs_recurring_billing_start_date: start,
    billing_anchor_date: start,
    ...(momento ? { momento_de_facturacion: momento } : {}),
  },
});

const ymd = (li, today) => formatDateISO(getNextBillingDateForLineItem(li, today));

test('fin_de_mes: mes que termina LUNES no retrocede (2026-08-31)', () => {
  const li = makeLI({ start: '2026-08-15', momento: 'fin_de_mes' });
  assert.equal(ymd(li, new Date(2026, 7, 1)), '2026-08-31'); // 1-ago-2026
});

test('fin_de_mes: mes que termina DOMINGO retrocede a viernes (2026-05-31 → 05-29)', () => {
  const li = makeLI({ start: '2026-05-10', momento: 'fin_de_mes' });
  assert.equal(ymd(li, new Date(2026, 4, 1)), '2026-05-29'); // 1-may-2026
});

test('fin_de_mes: mes que termina SÁBADO retrocede a viernes (2026-02-28 → 02-27)', () => {
  const li = makeLI({ start: '2026-02-05', momento: 'fin_de_mes' });
  assert.equal(ymd(li, new Date(2026, 1, 1)), '2026-02-27'); // 1-feb-2026
});

test('SIN fin_de_mes: se respeta el día del ancla, sin snap a fin de mes', () => {
  const li = makeLI({ start: '2026-08-15' }); // momento ausente
  assert.equal(ymd(li, new Date(2026, 7, 1)), '2026-08-15');
});

test('fin_de_mes: el snap a fin de mes también aplica al período SIGUIENTE', () => {
  // "hoy" cae después del fin de agosto → la próxima factura es fin de septiembre.
  // 2026-09-30 = miércoles (día hábil) → sin retroceso.
  const li = makeLI({ start: '2026-08-15', momento: 'fin_de_mes' });
  assert.equal(ymd(li, new Date(2026, 8, 1)), '2026-09-30'); // 1-sep-2026
});
