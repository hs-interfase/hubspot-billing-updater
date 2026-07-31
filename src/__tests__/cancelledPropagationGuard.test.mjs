// src/__tests__/cancelledPropagationGuard.test.mjs
//
// Guardas de re-propagación de facturas canceladas (fix del 30-jul, salido de
// la prueba 7 en sandbox): resolveCancelledPropagationGuard, helper PURO de
// propagacion/invoice.js.
//
// Las 3 guardas y por qué existen:
//   A. periodo_cerrado  — el ticket ya está en CANCELADO (terminal): el sweep no
//      lo re-abre. Sin esto, la cancelación DEFINITIVA se deshacía en la pasada
//      siguiente y en el pipeline automático se RE-EMITÍA el período anulado.
//   B. factura_superada — el ticket apunta a otra factura: sólo la factura
//      vigente decide. Sin esto, la factura vieja cancelada le borraba al ticket
//      la referencia a la nueva (la refacturación se deshacía sola).
//   C. ya_limpio        — el ticket ya está en el estado post-reversión: no hay
//      nada que escribir (evita reescribir el aviso en cada pasada).
//
// Requiere DATABASE_URL dummy (el grafo de imports de propagacion/invoice.js
// carga src/db.js).

process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/x';

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { resolveCancelledPropagationGuard } = await import('../propagacion/invoice.js');

const CANCELADO   = '1311451813';
const FACTURABLE  = '1311451807';
const INV         = '575000000001';
const OTRA_INV    = '575000000002';

const base = {
  invoiceId: INV,
  cancelledStage: CANCELADO,
  facturableStage: FACTURABLE,
};

// ═════════════════════════════════════════════════════════════════════════════
// Acción deliberada: el intent manda, nunca se saltea
// ═════════════════════════════════════════════════════════════════════════════

test("cancelIntent 'cancel' → no se saltea aunque el ticket ya esté en CANCELADO", () => {
  const r = resolveCancelledPropagationGuard({
    ...base,
    cancelIntent: 'cancel',
    ticketProps: { hs_pipeline_stage: CANCELADO, of_invoice_id: INV },
  });
  assert.deepEqual(r, { skip: false });
});

test("cancelIntent 'revert' → no se saltea aunque el ticket apunte a otra factura", () => {
  const r = resolveCancelledPropagationGuard({
    ...base,
    cancelIntent: 'revert',
    ticketProps: { hs_pipeline_stage: FACTURABLE, of_invoice_id: OTRA_INV },
  });
  assert.deepEqual(r, { skip: false });
});

// ═════════════════════════════════════════════════════════════════════════════
// A. periodo_cerrado — CANCELADO es terminal
// ═════════════════════════════════════════════════════════════════════════════

test('A: ticket en CANCELADO + intent null → skip periodo_cerrado', () => {
  const r = resolveCancelledPropagationGuard({
    ...base,
    ticketProps: { hs_pipeline_stage: CANCELADO, of_invoice_id: INV, of_invoice_status: 'Cancelada' },
  });
  assert.deepEqual(r, { skip: true, reason: 'periodo_cerrado' });
});

test('A: gana sobre B — en CANCELADO no importa a qué factura apunte', () => {
  const r = resolveCancelledPropagationGuard({
    ...base,
    ticketProps: { hs_pipeline_stage: CANCELADO, of_invoice_id: OTRA_INV },
  });
  assert.deepEqual(r, { skip: true, reason: 'periodo_cerrado' });
});

test('A: sin cancelledStage conocido no se saltea (no se adivina la etapa)', () => {
  const r = resolveCancelledPropagationGuard({
    ...base,
    cancelledStage: '',
    ticketProps: { hs_pipeline_stage: CANCELADO, of_invoice_id: INV },
  });
  assert.deepEqual(r, { skip: false });
});

// ═════════════════════════════════════════════════════════════════════════════
// B. factura_superada — pide verificar la factura apuntada (IO en el caller)
// ═════════════════════════════════════════════════════════════════════════════

test('B: el ticket apunta a otra factura → devuelve checkPointedInvoice', () => {
  const r = resolveCancelledPropagationGuard({
    ...base,
    ticketProps: { hs_pipeline_stage: FACTURABLE, of_invoice_id: OTRA_INV },
  });
  assert.deepEqual(r, { skip: false, checkPointedInvoice: OTRA_INV });
});

test('B: el ticket apunta a ESTA factura → no hay nada que verificar', () => {
  const r = resolveCancelledPropagationGuard({
    ...base,
    ticketProps: { hs_pipeline_stage: FACTURABLE, of_invoice_id: INV, of_invoice_status: 'Cancelada' },
  });
  assert.deepEqual(r, { skip: false });
});

test('B: compara como string (invoiceId numérico no dispara falso positivo)', () => {
  const r = resolveCancelledPropagationGuard({
    ...base,
    invoiceId: Number(INV),
    ticketProps: { hs_pipeline_stage: FACTURABLE, of_invoice_id: INV },
  });
  assert.deepEqual(r, { skip: false });
});

// ═════════════════════════════════════════════════════════════════════════════
// C. ya_limpio — nada que escribir
// ═════════════════════════════════════════════════════════════════════════════

test('C: ticket ya limpio y en la etapa facturable → skip ya_limpio', () => {
  const r = resolveCancelledPropagationGuard({
    ...base,
    ticketProps: { hs_pipeline_stage: FACTURABLE, of_invoice_id: '', of_invoice_status: '' },
  });
  assert.deepEqual(r, { skip: true, reason: 'ya_limpio' });
});

test('C: limpio pero en OTRA etapa → se propaga (hay que moverlo)', () => {
  const r = resolveCancelledPropagationGuard({
    ...base,
    ticketProps: { hs_pipeline_stage: '1311451808', of_invoice_id: '', of_invoice_status: '' },
  });
  assert.deepEqual(r, { skip: false });
});

test('C: en la etapa facturable pero con of_invoice_status todavía puesto → se propaga', () => {
  const r = resolveCancelledPropagationGuard({
    ...base,
    ticketProps: { hs_pipeline_stage: FACTURABLE, of_invoice_id: '', of_invoice_status: 'Cancelada' },
  });
  assert.deepEqual(r, { skip: false });
});

// ═════════════════════════════════════════════════════════════════════════════
// El caso que tiene que seguir funcionando: cancelación nueva hecha a mano en
// HubSpot (etapa de la factura → Cancelada, sin intent). El ticket está emitido
// y apunta a esa factura → NO se saltea, se limpia como hoy.
// ═════════════════════════════════════════════════════════════════════════════

test('cancelación nueva sin intent sobre el ticket emitido → se propaga', () => {
  const r = resolveCancelledPropagationGuard({
    ...base,
    ticketProps: { hs_pipeline_stage: '1311451809', of_invoice_id: INV, of_invoice_status: 'Emitida' },
  });
  assert.deepEqual(r, { skip: false });
});

// ═════════════════════════════════════════════════════════════════════════════
// Robustez de entrada
// ═════════════════════════════════════════════════════════════════════════════

test('sin argumentos / props vacías → no se saltea (default seguro)', () => {
  assert.deepEqual(resolveCancelledPropagationGuard(), { skip: false });
  assert.deepEqual(resolveCancelledPropagationGuard({ ...base }), { skip: false });
  assert.deepEqual(
    resolveCancelledPropagationGuard({ ...base, ticketProps: null }),
    { skip: false }
  );
});

test('espacios alrededor de stages e ids no rompen la comparación', () => {
  assert.deepEqual(
    resolveCancelledPropagationGuard({
      ...base,
      cancelledStage: ` ${CANCELADO} `,
      ticketProps: { hs_pipeline_stage: ` ${CANCELADO} `, of_invoice_id: ` ${INV} ` },
    }),
    { skip: true, reason: 'periodo_cerrado' }
  );
  assert.deepEqual(
    resolveCancelledPropagationGuard({
      ...base,
      ticketProps: { hs_pipeline_stage: ` ${FACTURABLE} `, of_invoice_id: '   ', of_invoice_status: '  ' },
    }),
    { skip: true, reason: 'ya_limpio' }
  );
});
