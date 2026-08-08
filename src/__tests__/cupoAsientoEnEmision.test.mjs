// src/__tests__/cupoAsientoEnEmision.test.mjs
//
// §1 del plan (decisión D2) — EL ASIENTO DEL CUPO SE MUEVE A LA EMISIÓN.
//
// Hoy `consumeCupoAfterInvoice` corre cuando se CREA la factura, que nace en
// etapa «Pendiente» y sin `id_factura_nodum`: el cupo se compromete contra una
// factura que todavía no existe para Nodum. Con
// CUPO_ASIENTO_EN_EMISION_ENABLED prendida el asiento pasa al momento en que la
// factura llega a «Emitida» o posterior — menos «Cancelada», que revierte.
//
// 🔴 ALCANCE: esta llave mueve el REGISTRO, no construye el freno. Verificado
// el 31-jul: hoy NO existe ningún chequeo que impida facturar por encima del
// cupo (createInvoiceFromTicket no tiene guard; al agotarse, `cupo_activo=false`
// sólo hace que las siguientes DEJEN DE CONSUMIR). Decisión de la usuaria:
// mover el asiento igual, el freno se trata aparte.
//
// Criterio de aceptación: con la llave apagada, todo idéntico a hoy.
//
// Correr con: node --test src/__tests__/cupoAsientoEnEmision.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@127.0.0.1:1/dummy';

const {
  cupoAsientoEnEmisionEnabled,
  esEtapaFacturaAsentable,
  cupoRevertOnCancelEnabled,
  cancelRevertFlowEnabled,
} = await import('../config/cancelRevertFlags.js');

const { calcularConsumoCupo } = await import('../services/cupo/consumeCupo.js');

const OFF = () => { delete process.env.CUPO_ASIENTO_EN_EMISION_ENABLED; };
const ON = () => { process.env.CUPO_ASIENTO_EN_EMISION_ENABLED = 'true'; };

// Las 6 etapas reales del objeto factura (api/invoice-editor/stageTransitions.js).
const ETAPAS = ['Pendiente', 'Emitida', 'Enviada', 'Paga', 'Atrasada', 'Cancelada'];

// ═════════════════════════════════════════════════════════════════════════════
// 1) La llave — default OFF y sin contagiar a las otras dos
// ═════════════════════════════════════════════════════════════════════════════

test('default: la llave está APAGADA (ausente = off)', () => {
  OFF();
  assert.equal(cupoAsientoEnEmisionEnabled(), false);
});

test('sólo prenden true/1/yes; el resto es off', () => {
  for (const v of ['true', 'TRUE', ' 1 ', 'yes', 'Yes']) {
    process.env.CUPO_ASIENTO_EN_EMISION_ENABLED = v;
    assert.equal(cupoAsientoEnEmisionEnabled(), true, `"${v}" debería prender`);
  }
  for (const v of ['false', '0', 'no', '', 'basura', 'si']) {
    process.env.CUPO_ASIENTO_EN_EMISION_ENABLED = v;
    assert.equal(cupoAsientoEnEmisionEnabled(), false, `"${v}" NO debería prender`);
  }
  OFF();
});

test('es INDEPENDIENTE de las llaves de cancelar/revertir', () => {
  OFF();
  delete process.env.CANCEL_REVERT_FLOW_ENABLED;
  delete process.env.CUPO_REVERT_ON_CANCEL_ENABLED;

  ON();
  // Prender el asiento no prende el flujo cancelar/revertir ni la reversión de cupo.
  assert.equal(cancelRevertFlowEnabled(), false);
  assert.equal(cupoRevertOnCancelEnabled(), false);
  OFF();
});

// ═════════════════════════════════════════════════════════════════════════════
// 2) Qué etapa asienta — «Emitida o posterior, menos Cancelada»
// ═════════════════════════════════════════════════════════════════════════════

test('Pendiente NO asienta — es el punto entero del cambio', () => {
  // La factura nace Pendiente y sin id_factura_nodum: no existe para Nodum.
  assert.equal(esEtapaFacturaAsentable('Pendiente'), false);
});

test('Cancelada NO asienta — esa rama REVIERTE, no consume', () => {
  assert.equal(esEtapaFacturaAsentable('Cancelada'), false);
});

test('Emitida y todas las posteriores SÍ asientan', () => {
  for (const etapa of ['Emitida', 'Enviada', 'Paga', 'Atrasada']) {
    assert.equal(esEtapaFacturaAsentable(etapa), true, `${etapa} debería asentar`);
  }
});

test('etapa vacía / ausente NO asienta', () => {
  for (const v of ['', '   ', null, undefined]) {
    assert.equal(esEtapaFacturaAsentable(v), false, `"${v}" no debería asentar`);
  }
});

test('es case- y espacio-insensible (el valor viene del CRM a mano)', () => {
  assert.equal(esEtapaFacturaAsentable('  emitida '), true);
  assert.equal(esEtapaFacturaAsentable('CANCELADA'), false);
  assert.equal(esEtapaFacturaAsentable(' Pendiente'), false);
});

test('una etapa NUEVA asienta — se define por complemento, no por whitelist', () => {
  // Si mañana agregan una etapa, va a ser posterior a Emitida. Con whitelist el
  // cupo dejaría de asentarse EN SILENCIO, que es el modo de fallar caro.
  assert.equal(esEtapaFacturaAsentable('Conciliada'), true);
});

test('las 6 etapas reales quedan partidas 4 vs 2', () => {
  const asientan = ETAPAS.filter(esEtapaFacturaAsentable);
  assert.deepEqual(asientan, ['Emitida', 'Enviada', 'Paga', 'Atrasada']);
});

// ═════════════════════════════════════════════════════════════════════════════
// 3) El cálculo del consumo no cambia — mover el CUÁNDO no toca el CUÁNTO
// ═════════════════════════════════════════════════════════════════════════════

test('Por Monto: el consumo sigue saliendo de subtotal_real', () => {
  const r = calcularConsumoCupo({
    tipoCupo: 'Por Monto',
    ticketProps: { subtotal_real: '1500' },
    dealProps: { cupo_total_monto: '10000', cupo_consumido: '2000' },
  });
  assert.equal(r.ok, true);
  assert.equal(r.consumo, 1500);
  assert.equal(r.cupoConsumidoNuevo, 3500);
  assert.equal(r.cupoRestanteNuevo, 6500);
});

test('Por Horas: sigue saliendo de las horas consumidas', () => {
  const r = calcularConsumoCupo({
    tipoCupo: 'Por Horas',
    ticketProps: { total_de_horas_consumidas: '8' },
    dealProps: { cupo_total: '100', cupo_consumido: '10' },
  });
  assert.equal(r.ok, true);
  assert.equal(r.consumo, 8);
  assert.equal(r.cupoRestanteNuevo, 82);
});

test('la NC sigue detectándose por SIGNO y devuelve cupo', () => {
  const r = calcularConsumoCupo({
    tipoCupo: 'Por Monto',
    ticketProps: { subtotal_real: '-500' },
    dealProps: { cupo_total_monto: '10000', cupo_consumido: '2000' },
  });
  assert.equal(r.ok, true);
  assert.equal(r.consumo, -500);
  assert.equal(r.cupoConsumidoNuevo, 1500);
});

test('el cupo agotado sigue marcándose para desactivar', () => {
  const r = calcularConsumoCupo({
    tipoCupo: 'Por Monto',
    ticketProps: { subtotal_real: '8000' },
    dealProps: { cupo_total_monto: '10000', cupo_consumido: '2000' },
  });
  assert.equal(r.cupoRestanteNuevo, 0);
  assert.equal(r.cupoDeactivated, true);
});

// ═════════════════════════════════════════════════════════════════════════════
// 4) LA REVERSIÓN con el asiento movido (decisión D3)
// ═════════════════════════════════════════════════════════════════════════════
//
// D3: «la reversión de cupo queda sólo para cuando se cancela la factura o
// entra una NC — no en la reversión-para-refacturar de una factura que nunca se
// asentó». No hizo falta código nuevo: `revertCupoForInvoice` YA actúa sólo si
// el ticket tiene el marker `cupo_consumo_invoice_id` de esa factura. Lo que
// cambia con el asiento movido es CUÁNDO existe ese marker — y estos tests
// fijan que las dos mitades (consumo y reversión) siguen cerrando.

const TICKET_ASENTADO = {
  cupo_consumo_invoice_id: 'INV-1',
  of_cupo_consumo_valor: '300',
  of_cupo_historial: '2026-07-01 | consumo | 300 | invoice INV-1',
  of_cupo_consumido: 'true',
};

const DEAL_CON_CUPO = {
  cupo_activo: 'true',
  tipo_de_cupo: 'Por Monto',
  cupo_consumido: '500',
  cupo_restante: '500',
  cupo_total: '',
  cupo_total_monto: '1000',
  cupo_umbral: '',
  cupo_estado: 'Ok',
};

function makeCtx({ ticketProps = {}, dealProps = {} } = {}) {
  const calls = [];
  const reports = [];
  const state = {
    ticketProps: { ...TICKET_ASENTADO, ...ticketProps },
    dealProps: { ...DEAL_CON_CUPO, ...dealProps },
  };
  const client = {
    crm: {
      tickets: {
        basicApi: {
          async getById(id) { return { id: String(id), properties: { ...state.ticketProps } }; },
          async update(id, { properties }) {
            calls.push({ type: 'ticket.update', properties });
            Object.assign(state.ticketProps, properties);
          },
        },
      },
      deals: {
        basicApi: {
          async getById(id) { return { id: String(id), properties: { ...state.dealProps } }; },
          async update(id, { properties }) {
            calls.push({ type: 'deal.update', properties });
            Object.assign(state.dealProps, properties);
          },
        },
      },
    },
  };
  return {
    deps: { client, reportFn: (r) => reports.push(r), todayYMDFn: () => '2026-08-01' },
    calls, reports, state,
  };
}

const { revertCupoForInvoice } = await import('../services/cupo/revertCupo.js');

test('D3: cancelar una factura que NUNCA se asentó es un no-op LEGÍTIMO, no un error', async () => {
  // Con el asiento en la emisión, una factura que se canceló estando «Pendiente»
  // nunca consumió cupo → el ticket no tiene marker. Antes esto revertía algo
  // que sí se había consumido al crearla; ahora no hay nada que revertir, y eso
  // NO se reporta como incidente.
  const { deps, calls, reports } = makeCtx({
    ticketProps: { cupo_consumo_invoice_id: '', of_cupo_consumo_valor: '', of_cupo_consumido: '' },
  });

  const r = await revertCupoForInvoice({ dealId: 'D1', ticketId: 'T1', invoiceId: 'INV-1' }, deps);

  assert.equal(r.reverted, false);
  assert.equal(r.reason, 'no_consumio_o_ya_revertido');
  assert.equal(calls.length, 0, 'no debe escribir nada');
  assert.equal(reports.length, 0, 'no debe reportarse como error');
});

test('el asiento en la emisión y la reversión cierran: lo consumido vuelve entero', async () => {
  // Factura Emitida que asentó 300 y después se cancela definitivamente.
  const { deps, state } = makeCtx();

  const r = await revertCupoForInvoice({ dealId: 'D1', ticketId: 'T1', invoiceId: 'INV-1' }, deps);

  assert.equal(r.reverted, true);
  assert.equal(state.dealProps.cupo_consumido, '200');   // 500 − 300
  assert.equal(state.dealProps.cupo_restante, '800');    // 500 + 300
  // El marker se limpia: una segunda cancelación no re-acredita.
  assert.equal(String(state.ticketProps.cupo_consumo_invoice_id || ''), '');
});

test('migración: una factura asentada con el esquema VIEJO se revierte igual', async () => {
  // Facturas creadas ANTES de prender la llave consumieron al crearse y dejaron
  // el marker. Al cancelarse después del cambio, la reversión las encuentra por
  // el marker igual que siempre — prender la llave no deja huérfanas a las viejas.
  const { deps, state } = makeCtx({
    ticketProps: { of_cupo_historial: '2026-06-15 | consumo | 300 | invoice INV-1' },
  });

  const r = await revertCupoForInvoice({ dealId: 'D1', ticketId: 'T1', invoiceId: 'INV-1' }, deps);

  assert.equal(r.reverted, true);
  assert.equal(state.dealProps.cupo_consumido, '200');
});
