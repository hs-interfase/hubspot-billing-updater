// src/__tests__/warnFacturacionDealNoGanado.test.mjs
//
// Prueba el aviso al vendedor cuando un negocio NO ganado (buckets 25/50/75)
// tiene un line item con fecha de facturación a ≤10 días o ya vencida.
// Escribe billing_error en el deal vía el collector (acá se inyecta un spy).
//
// Correr con:  node --test src/__tests__/warnFacturacionDealNoGanado.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { warnFacturacionDealNoGanado } from '../phases/phasep.js';

const TODAY = '2026-07-02';

function makeArgs(extra = {}) {
  const reported = [];
  return {
    args: {
      deal: { properties: { dealname: 'Negocio Test' } },
      dealId: '111',
      dealStage: 'contractsent', // bucket 75 → no ganado
      li: { id: '222', properties: { name: 'iSCert' } },
      dates: [],
      todayYmd: TODAY,
      report: (x) => reported.push(x),
      ...extra,
    },
    reported,
  };
}

test('fecha vencida en negocio no ganado → warn con mensaje de vencida', () => {
  const { args, reported } = makeArgs({ dates: ['2026-06-19', '2026-09-19'] });
  const msg = warnFacturacionDealNoGanado(args);
  assert.equal(reported.length, 1);
  assert.equal(reported[0].objectType, 'deal');
  assert.equal(reported[0].objectId, '111');
  assert.match(msg, /2026-06-19/);
  assert.match(msg, /ya llegó/);
  assert.match(msg, /no está en Cierre ganado/);
});

test('fecha a 10 días en negocio no ganado → warn con mensaje de próxima', () => {
  const { args, reported } = makeArgs({ dates: ['2026-07-12'] });
  const msg = warnFacturacionDealNoGanado(args);
  assert.equal(reported.length, 1);
  assert.match(msg, /2026-07-12/);
  assert.match(msg, /en 10 día/);
});

test('fecha a 11 días → sin aviso', () => {
  const { args, reported } = makeArgs({ dates: ['2026-07-13'] });
  const msg = warnFacturacionDealNoGanado(args);
  assert.equal(msg, null);
  assert.equal(reported.length, 0);
});

test('vencida tiene prioridad sobre próxima (un solo aviso por LI)', () => {
  const { args, reported } = makeArgs({ dates: ['2026-06-19', '2026-07-05'] });
  const msg = warnFacturacionDealNoGanado(args);
  assert.equal(reported.length, 1);
  assert.match(msg, /ya llegó/);
});

test('negocio ganado (closedwon, bucket 85) → sin aviso aunque haya vencidas', () => {
  const { args, reported } = makeArgs({ dealStage: 'closedwon', dates: ['2026-06-19'] });
  assert.equal(warnFacturacionDealNoGanado(args), null);
  assert.equal(reported.length, 0);
});

test('dealstage fuera de buckets de forecast → sin aviso', () => {
  const { args, reported } = makeArgs({ dealStage: 'closedlost', dates: ['2026-06-19'] });
  assert.equal(warnFacturacionDealNoGanado(args), null);
  assert.equal(reported.length, 0);
});

test('LI en pausa → sin aviso', () => {
  const { args, reported } = makeArgs({
    li: { id: '222', properties: { name: 'iSCert', pausa: 'true' } },
    dates: ['2026-06-19'],
  });
  assert.equal(warnFacturacionDealNoGanado(args), null);
  assert.equal(reported.length, 0);
});

test('sin fechas cercanas ni vencidas → sin aviso', () => {
  const { args, reported } = makeArgs({ dates: ['2026-12-01'] });
  assert.equal(warnFacturacionDealNoGanado(args), null);
  assert.equal(reported.length, 0);
});
