// src/__tests__/revertCupo.test.mjs
//
// Reversión idempotente de cupo (bloque 1 de cancelar/revertir).
// Todo con fakes inyectados (client / reportFn / todayYMDFn): no toca HubSpot ni DB.
//
// Requiere DATABASE_URL dummy (el grafo de imports carga src/db.js).
//   DATABASE_URL='postgres://u:p@localhost:5432/x' node --test src/__tests__/revertCupo.test.mjs

process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/x';

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { calcularReversionCupo, revertCupoForInvoice } = await import('../services/cupo/revertCupo.js');
const { calcularConsumoCupo } = await import('../services/cupo/consumeCupo.js');

// ═════════════════════════════════════════════════════════════════════════════
// CÁLCULO PURO — calcularReversionCupo
// ═════════════════════════════════════════════════════════════════════════════

test('puro: crédito normal es el inverso exacto de calcularConsumoCupo (roundtrip)', () => {
  // Consumo: total 1000, consumido 200, subtotal 300 → consumido 500, restante 500
  const consumo = calcularConsumoCupo({
    tipoCupo: 'Por Monto',
    dealProps: { cupo_total_monto: '1000', cupo_consumido: '200' },
    ticketProps: { subtotal_real: '300' },
  });
  assert.equal(consumo.ok, true);
  assert.equal(consumo.cupoConsumidoNuevo, 500);
  assert.equal(consumo.cupoRestanteNuevo, 500);

  // Reversión sobre el estado POST-consumo → vuelve al estado PRE-consumo.
  const r = calcularReversionCupo({
    valorConsumido: String(consumo.consumo),   // of_cupo_consumo_valor = '300'
    dealProps: {
      cupo_total_monto: '1000',
      cupo_consumido: String(consumo.cupoConsumidoNuevo),
      cupo_restante: String(consumo.cupoRestanteNuevo),
      cupo_activo: 'true',
      cupo_estado: 'Ok',
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.credito, 300);
  assert.equal(r.cupoConsumidoNuevo, 200);   // 500 - 300 (estado pre-consumo)
  assert.equal(r.cupoRestanteNuevo, 800);    // 500 + 300 (1000 - 200)
  assert.equal(r.cupoReactivable, false);    // ya estaba activo
  assert.equal(r.cupoEstadoNuevo, 'Ok');     // 200 + 800 = 1000, restante > 0
  assert.equal(r.inconsistente, false);
});

test('puro: NC re-débito — revertir un consumo negativo VUELVE A DEBITAR por aritmética', () => {
  // El consumo de la NC quedó registrado como -300 (devolvió cupo).
  // Revertirlo: consumido 200 - (-300) = 500, restante 800 + (-300) = 500.
  const r = calcularReversionCupo({
    valorConsumido: '-300',
    dealProps: {
      cupo_total_monto: '1000', cupo_consumido: '200', cupo_restante: '800',
      cupo_activo: 'true', cupo_estado: 'Ok',
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.credito, -300);
  assert.equal(r.cupoConsumidoNuevo, 500);
  assert.equal(r.cupoRestanteNuevo, 500);
  assert.equal(r.inconsistente, false);
});

test('puro: reactivable cuando el motor lo apagó (Agotado) y vuelve a haber restante', () => {
  const r = calcularReversionCupo({
    valorConsumido: '300',
    dealProps: {
      cupo_total_monto: '1000', cupo_consumido: '1000', cupo_restante: '0',
      cupo_activo: 'false', cupo_estado: 'Agotado',
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.cupoConsumidoNuevo, 700);
  assert.equal(r.cupoRestanteNuevo, 300);
  assert.equal(r.cupoReactivable, true);
  assert.equal(r.cupoEstadoNuevo, 'Ok');     // se calcula con cupo_activo='true'
});

test('puro: reactivable también desde Pasado (restante negativo que vuelve a positivo)', () => {
  const r = calcularReversionCupo({
    valorConsumido: '300',
    dealProps: {
      cupo_total_monto: '1000', cupo_consumido: '1100', cupo_restante: '-100',
      cupo_activo: 'false', cupo_estado: 'Pasado',
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.cupoRestanteNuevo, 200);
  assert.equal(r.cupoReactivable, true);
});

test('puro: NO reactivable si el apagado fue humano (Desactivado)', () => {
  const r = calcularReversionCupo({
    valorConsumido: '300',
    dealProps: {
      cupo_total_monto: '1000', cupo_consumido: '500', cupo_restante: '500',
      cupo_activo: 'false', cupo_estado: 'Desactivado',
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.cupoRestanteNuevo, 800);
  assert.equal(r.cupoReactivable, false);           // no tocar apagado humano
  assert.equal(r.cupoEstadoNuevo, 'Desactivado');   // activo sigue en false
});

test('puro: NO reactivable si el restante nuevo queda <= 0 (reversión de NC en cupo agotado)', () => {
  // Revertir una NC (-200) sobre un cupo agotado empeora el restante: 0 + (-200) = -200.
  const r = calcularReversionCupo({
    valorConsumido: '-200',
    dealProps: {
      cupo_total_monto: '1000', cupo_consumido: '1000', cupo_restante: '0',
      cupo_activo: 'false', cupo_estado: 'Agotado',
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.cupoConsumidoNuevo, 1200);
  assert.equal(r.cupoRestanteNuevo, -200);
  assert.equal(r.cupoReactivable, false);
  assert.equal(r.cupoEstadoNuevo, 'Pasado');
  assert.equal(r.inconsistente, false);
});

test('puro: números que no cierran → ok:true igual (dato fiel) + inconsistente:true', () => {
  // 500 + 100 != 1000 ya venía roto; tras revertir 300: 200 + 400 = 600 != 1000.
  const r = calcularReversionCupo({
    valorConsumido: '300',
    dealProps: {
      cupo_total_monto: '1000', cupo_consumido: '500', cupo_restante: '100',
      cupo_activo: 'true', cupo_estado: 'Ok',
    },
  });
  assert.equal(r.ok, true);                         // el dato fiel manda
  assert.equal(r.cupoConsumidoNuevo, 200);
  assert.equal(r.cupoRestanteNuevo, 400);
  assert.equal(r.cupoEstadoNuevo, 'Inconsistente');
  assert.equal(r.inconsistente, true);
});

test('puro: consumido nuevo negativo → inconsistente:true aunque el estado dé Ok', () => {
  // 100 - 300 = -200; -200 + 1200 = 1000 (consistente para calculateCupoEstado).
  const r = calcularReversionCupo({
    valorConsumido: '300',
    dealProps: {
      cupo_total_monto: '1000', cupo_consumido: '100', cupo_restante: '900',
      cupo_activo: 'true', cupo_estado: 'Ok',
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.cupoConsumidoNuevo, -200);
  assert.equal(r.cupoEstadoNuevo, 'Ok');
  assert.equal(r.inconsistente, true);
});

test('puro: sin_valor_registrado con valor vacío, null o no numérico', () => {
  for (const valorConsumido of ['', null, undefined, 'abc']) {
    const r = calcularReversionCupo({ valorConsumido, dealProps: { cupo_consumido: '500' } });
    assert.equal(r.ok, false, `valor ${JSON.stringify(valorConsumido)} debería fallar`);
    assert.equal(r.reason, 'sin_valor_registrado');
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// ORQUESTACIÓN — revertCupoForInvoice (fakes DI)
// ═════════════════════════════════════════════════════════════════════════════

const TICKET_BASE = {
  cupo_consumo_invoice_id: 'INV-1',
  of_cupo_consumo_invoice_id: '',
  of_cupo_consumo_valor: '300',
  of_cupo_historial: '2026-07-01 | consumo | 300 | invoice INV-1',
  of_cupo_consumido: 'true',
};

const DEAL_BASE = {
  cupo_activo: 'true',
  tipo_de_cupo: 'Por Monto',
  cupo_consumido: '500',
  cupo_restante: '500',
  cupo_total: '',
  cupo_total_monto: '1000',
  cupo_umbral: '',
  cupo_estado: 'Ok',
};

function makeCtx({ ticketProps = {}, dealProps = {}, failTicketWrite = false, failDealWrite = false } = {}) {
  const calls = [];
  const reports = [];
  const state = {
    ticketProps: { ...TICKET_BASE, ...ticketProps },
    dealProps: { ...DEAL_BASE, ...dealProps },
  };

  const client = {
    crm: {
      tickets: {
        basicApi: {
          async getById(id) {
            calls.push({ type: 'ticket.get', id: String(id) });
            return { id: String(id), properties: { ...state.ticketProps } };
          },
          async update(id, { properties }) {
            if (failTicketWrite) throw new Error('boom ticket write');
            calls.push({ type: 'ticket.update', id: String(id), properties });
            Object.assign(state.ticketProps, properties);
          },
        },
      },
      deals: {
        basicApi: {
          async getById(id) {
            calls.push({ type: 'deal.get', id: String(id) });
            return { id: String(id), properties: { ...state.dealProps } };
          },
          async update(id, { properties }) {
            if (failDealWrite) throw new Error('boom deal write');
            calls.push({ type: 'deal.update', id: String(id), properties });
            Object.assign(state.dealProps, properties);
          },
        },
      },
    },
  };

  const deps = {
    client,
    reportFn: (r) => { reports.push(r); },
    todayYMDFn: () => '2026-07-26',
  };

  return { deps, calls, reports, state };
}

const writes = (calls) => calls.filter(c => c.type === 'ticket.update' || c.type === 'deal.update');

test('orquestación: marker distinto → skip sin ninguna escritura', async () => {
  const { deps, calls, reports } = makeCtx({ ticketProps: { cupo_consumo_invoice_id: 'INV-OTRA' } });

  const r = await revertCupoForInvoice({ dealId: 'D1', ticketId: 'T1', invoiceId: 'INV-1' }, deps);

  assert.equal(r.reverted, false);
  assert.equal(r.reason, 'no_consumio_o_ya_revertido');
  assert.equal(writes(calls).length, 0);
  assert.equal(reports.length, 0);
});

test('orquestación: sin valor registrado → skip + reportFn con ticket e invoice, sin escrituras', async () => {
  const { deps, calls, reports } = makeCtx({ ticketProps: { of_cupo_consumo_valor: '' } });

  const r = await revertCupoForInvoice({ dealId: 'D1', ticketId: 'T1', invoiceId: 'INV-1' }, deps);

  assert.equal(r.reverted, false);
  assert.equal(r.reason, 'sin_valor_registrado');
  assert.equal(writes(calls).length, 0);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].level, 'error');
  assert.equal(reports[0].objectId, 'D1');
  assert.match(reports[0].message, /ticket T1/);
  assert.match(reports[0].message, /INV-1/);
  assert.match(reports[0].message, /[Rr]econciliar a mano/);
});

test('orquestación: falla el write del ticket → aborta SIN tocar el deal (nunca doble crédito)', async () => {
  const { deps, calls, reports } = makeCtx({ failTicketWrite: true });

  const r = await revertCupoForInvoice({ dealId: 'D1', ticketId: 'T1', invoiceId: 'INV-1' }, deps);

  assert.equal(r.reverted, false);
  assert.equal(r.reason, 'ticket_write_failed');
  assert.equal(calls.filter(c => c.type === 'deal.update').length, 0);   // deal intacto
  assert.equal(reports.length, 1);
  assert.equal(reports[0].objectType, 'ticket');
});

test('orquestación: falla el write del deal → reason + reportFn error con la instrucción exacta', async () => {
  const { deps, calls, reports } = makeCtx({ failDealWrite: true });

  const r = await revertCupoForInvoice({ dealId: 'D1', ticketId: 'T1', invoiceId: 'INV-1' }, deps);

  assert.equal(r.reverted, false);
  assert.equal(r.reason, 'deal_write_failed');
  assert.equal(calls.filter(c => c.type === 'ticket.update').length, 1); // marker ya limpio
  assert.equal(reports.length, 1);
  assert.equal(reports[0].level, 'error');
  assert.match(reports[0].message, /sumar 300 a cupo_restante y restarlo de cupo_consumido del deal D1/);
  assert.match(reports[0].message, /invoice INV-1, ticket T1/);
});

test('orquestación: camino feliz — orden ticket→deal, props y resultado', async () => {
  const { deps, calls, reports } = makeCtx({});

  const r = await revertCupoForInvoice({ dealId: 'D1', ticketId: 'T1', invoiceId: 'INV-1' }, deps);

  // Orden fail-closed: PRIMERO el ticket (marker), DESPUÉS el deal.
  const w = writes(calls);
  assert.deepEqual(w.map(c => c.type), ['ticket.update', 'deal.update']);

  // Ticket: marker limpio + historial appendeado (of_cupo_consumo_valor NO se pisa).
  const tProps = w[0].properties;
  assert.equal(tProps.cupo_consumo_invoice_id, '');
  assert.equal(tProps.of_cupo_consumido, 'false');
  assert.equal('of_cupo_consumo_valor' in tProps, false);
  assert.equal(
    tProps.of_cupo_historial,
    '2026-07-01 | consumo | 300 | invoice INV-1\n2026-07-26 | reversion | 300 | invoice INV-1'
  );

  // Deal: un solo update con los números inversos y sin reactivación (ya activo).
  const dProps = w[1].properties;
  assert.deepEqual(dProps, {
    cupo_consumido: '200',
    cupo_restante: '800',
    cupo_estado: 'Ok',
    cupo_ultima_actualizacion: '2026-07-26',
  });
  assert.equal('cupo_activo' in dProps, false);

  assert.deepEqual(r, {
    reverted: true,
    credito: 300,
    cupoRestanteNuevo: 800,
    cupoReactivado: false,
    inconsistente: false,
  });
  assert.equal(reports.length, 0);
});

test('orquestación: reactivación — Agotado por el motor vuelve a cupo_activo=true', async () => {
  const { deps, calls } = makeCtx({
    dealProps: { cupo_activo: 'false', cupo_estado: 'Agotado', cupo_consumido: '1000', cupo_restante: '0' },
  });

  const r = await revertCupoForInvoice({ dealId: 'D1', ticketId: 'T1', invoiceId: 'INV-1' }, deps);

  assert.equal(r.reverted, true);
  assert.equal(r.cupoReactivado, true);
  const dealUpdate = calls.find(c => c.type === 'deal.update');
  assert.equal(dealUpdate.properties.cupo_activo, 'true');
  assert.equal(dealUpdate.properties.cupo_restante, '300');
  assert.equal(dealUpdate.properties.cupo_estado, 'Ok');
});

test('orquestación: usuario opcional queda en la línea del historial', async () => {
  const { deps, calls } = makeCtx({});

  await revertCupoForInvoice({ dealId: 'D1', ticketId: 'T1', invoiceId: 'INV-1', usuario: 'admin@x.com' }, deps);

  const tProps = calls.find(c => c.type === 'ticket.update').properties;
  assert.match(tProps.of_cupo_historial, /\n2026-07-26 \| reversion \| 300 \| invoice INV-1 \| por admin@x\.com$/);
});

test('orquestación: doble llamada — la segunda ve el marker limpio y no re-acredita', async () => {
  const { deps, calls } = makeCtx({});

  const r1 = await revertCupoForInvoice({ dealId: 'D1', ticketId: 'T1', invoiceId: 'INV-1' }, deps);
  assert.equal(r1.reverted, true);
  const writesAfterFirst = writes(calls).length;
  assert.equal(writesAfterFirst, 2);

  const r2 = await revertCupoForInvoice({ dealId: 'D1', ticketId: 'T1', invoiceId: 'INV-1' }, deps);
  assert.equal(r2.reverted, false);
  assert.equal(r2.reason, 'no_consumio_o_ya_revertido');
  assert.equal(writes(calls).length, writesAfterFirst);   // cero escrituras nuevas
});

test('orquestación: reversión inconsistente se aplica igual y avisa con warn', async () => {
  const { deps, calls, reports } = makeCtx({
    dealProps: { cupo_consumido: '500', cupo_restante: '100' },   // 600 != 1000
  });

  const r = await revertCupoForInvoice({ dealId: 'D1', ticketId: 'T1', invoiceId: 'INV-1' }, deps);

  assert.equal(r.reverted, true);
  assert.equal(r.inconsistente, true);
  assert.equal(writes(calls).length, 2);                   // se escribió igual
  assert.equal(reports.length, 1);
  assert.equal(reports[0].level, 'warn');
  assert.match(reports[0].message, /inconsistentes/);
});

test('orquestación: NUNCA lanza — GET que explota devuelve reason error + reportFn', async () => {
  const { deps, reports } = makeCtx({});
  deps.client = {
    crm: { tickets: { basicApi: { async getById() { throw new Error('hubspot down'); } } } },
  };

  const r = await revertCupoForInvoice({ dealId: 'D1', ticketId: 'T1', invoiceId: 'INV-1' }, deps);

  assert.equal(r.reverted, false);
  assert.equal(r.reason, 'error');
  assert.equal(reports.length, 1);
  assert.match(reports[0].message, /hubspot down/);
});
