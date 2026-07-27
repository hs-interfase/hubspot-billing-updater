// src/__tests__/revertTicketInvoiceRequest.test.mjs
//
// Casilla revertir_factura — Bloque 3 del flujo cancelar/revertir.
// Todo con fakes inyectados (client / updateTicketFn / updateInvoiceFn /
// writeTicketErrorFn / reportFn / flowEnabledFn / checkRevertibleFn /
// propagateFn): no toca HubSpot ni DB.
//
// Requiere DATABASE_URL dummy (el grafo de imports carga src/db.js).
//   DATABASE_URL='postgres://u:p@localhost:5432/x' node --test src/__tests__/revertTicketInvoiceRequest.test.mjs

process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/x';

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { processRevertTicketRequest } = await import('../services/tickets/revertTicketInvoiceRequest.js');

const PIPE_MANUAL = 'PIPE_MANUAL';
const PIPE_AUTO = 'PIPE_AUTO';
const EPOCH_HOY = 1753488000000;

function makeCtx({
  props,
  gate = { revertible: true, nodumId: null },
  flowOn = true,
  failInvoicePatch = false,
  failPropagate = false,
  failReset = false,
}) {
  const calls = [];      // registro ORDENADO de efectos (invoice_patch / propagate / ticket_update / gate)
  const errores = [];
  const reports = [];

  const client = {
    crm: {
      tickets: {
        basicApi: {
          async getById() {
            return { id: 'T1', properties: props };
          },
        },
      },
    },
  };

  const deps = {
    client,
    updateTicketFn: async (id, patch) => {
      if (failReset && patch.revertir_factura === 'false') throw new Error('boom reset');
      calls.push({ type: 'ticket_update', id: String(id), patch });
    },
    updateInvoiceFn: async (id, patch) => {
      if (failInvoicePatch) throw new Error('boom invoice patch');
      calls.push({ type: 'invoice_patch', id: String(id), patch });
    },
    writeTicketErrorFn: async (id, msg) => { errores.push({ id: String(id), msg }); },
    reportFn: (arg) => { reports.push(arg); },
    flowEnabledFn: () => flowOn,
    checkRevertibleFn: async (id) => {
      calls.push({ type: 'gate', id: String(id) });
      return gate;
    },
    nodumBlockMessageFn: (nodumId) => `NODUM_BLOCK ${nodumId}`,
    propagateFn: async (id, opts) => {
      if (failPropagate) throw new Error('boom propagate');
      calls.push({ type: 'propagate', id: String(id), opts });
    },
    automatedPipelineId: PIPE_AUTO,
    todayEpochFn: () => EPOCH_HOY,
  };

  return { deps, calls, errores, reports };
}

const baseProps = (extra = {}) => ({
  hs_pipeline: PIPE_MANUAL, hs_pipeline_stage: 'STAGE_X',
  of_invoice_id: 'INV-9', of_invoice_status: 'Emitida',
  of_deal_id: 'D1', revertir_factura: 'true',
  ...extra,
});

const resetCalls = (calls) =>
  calls.filter(c => c.type === 'ticket_update' && c.patch.revertir_factura === 'false');
const invoicePatches = (calls) => calls.filter(c => c.type === 'invoice_patch');
const propagates = (calls) => calls.filter(c => c.type === 'propagate');

// ── 1. Guard de intención ────────────────────────────────────────────────────
test('casilla ya en false: skipped sin escribir nada', async () => {
  const { deps, calls, errores } = makeCtx({ props: baseProps({ revertir_factura: 'false' }) });

  const r = await processRevertTicketRequest('T1', deps);

  assert.equal(r.skipped, true);
  assert.equal(r.reason, 'revertir_factura_false');
  assert.equal(calls.length, 0);
  assert.equal(errores.length, 0);
});

// ── 2. Llave maestra apagada ─────────────────────────────────────────────────
test('flag off: aviso de no habilitado + reset, sin tocar la factura', async () => {
  const { deps, calls, errores } = makeCtx({ props: baseProps(), flowOn: false });

  const r = await processRevertTicketRequest('T1', deps);

  assert.equal(r.skipped, true);
  assert.equal(r.reason, 'flow_disabled');
  assert.equal(errores.length, 1);
  assert.match(errores[0].msg, /todavía no está habilitada/);
  assert.equal(invoicePatches(calls).length, 0);
  assert.equal(propagates(calls).length, 0);
  assert.equal(resetCalls(calls).length, 1);
});

// ── 3. Pipeline automático ───────────────────────────────────────────────────
test('automático: aviso (con tutorial NC) + reset, sin tocar la factura', async () => {
  process.env.NC_TUTORIAL_URL = 'https://tuto.example/nc';
  try {
    const { deps, calls, errores } = makeCtx({ props: baseProps({ hs_pipeline: PIPE_AUTO }) });

    const r = await processRevertTicketRequest('T1', deps);

    assert.equal(r.skipped, true);
    assert.equal(r.reason, 'automated_pipeline');
    assert.equal(errores.length, 1);
    assert.match(errores[0].msg, /automáticos no se revierten/);
    assert.match(errores[0].msg, /https:\/\/tuto\.example\/nc/);
    assert.equal(invoicePatches(calls).length, 0);
    assert.equal(propagates(calls).length, 0);
    assert.equal(resetCalls(calls).length, 1);
  } finally {
    delete process.env.NC_TUTORIAL_URL;
  }
});

// ── 4. Sin factura viva ──────────────────────────────────────────────────────
test('sin factura (of_invoice_id vacío): aviso + reset', async () => {
  const { deps, calls, errores } = makeCtx({
    props: baseProps({ of_invoice_id: '', of_invoice_status: '' }),
  });

  const r = await processRevertTicketRequest('T1', deps);

  assert.equal(r.skipped, true);
  assert.equal(r.reason, 'no_live_invoice');
  assert.equal(errores.length, 1);
  assert.match(errores[0].msg, /No hay factura emitida/);
  assert.equal(invoicePatches(calls).length, 0);
  assert.equal(resetCalls(calls).length, 1);
});

test('factura ya Cancelada cuenta como sin factura viva: aviso + reset', async () => {
  const { deps, calls, errores } = makeCtx({
    props: baseProps({ of_invoice_status: 'Cancelada' }),
  });

  const r = await processRevertTicketRequest('T1', deps);

  assert.equal(r.skipped, true);
  assert.equal(r.reason, 'no_live_invoice');
  assert.equal(errores.length, 1);
  assert.equal(invoicePatches(calls).length, 0);
  assert.equal(resetCalls(calls).length, 1);
});

// ── 5. Gate Nodum ────────────────────────────────────────────────────────────
test('Nodum bloquea (asentada): aviso de nota de crédito + reset, factura intacta', async () => {
  const { deps, calls, errores } = makeCtx({
    props: baseProps(),
    gate: { revertible: false, nodumId: 'N-77' },
  });

  const r = await processRevertTicketRequest('T1', deps);

  assert.equal(r.skipped, true);
  assert.equal(r.reason, 'nodum_asentada');
  assert.equal(errores.length, 1);
  assert.equal(errores[0].msg, 'NODUM_BLOCK N-77');
  assert.equal(invoicePatches(calls).length, 0);
  assert.equal(propagates(calls).length, 0);
  assert.equal(resetCalls(calls).length, 1);
});

test('Nodum con error de verificación (fail-closed): aviso de verificación + reset', async () => {
  const { deps, calls, errores } = makeCtx({
    props: baseProps(),
    gate: { revertible: false, nodumId: null, error: true },
  });

  const r = await processRevertTicketRequest('T1', deps);

  assert.equal(r.skipped, true);
  assert.equal(r.reason, 'nodum_gate_error');
  assert.equal(errores.length, 1);
  assert.match(errores[0].msg, /No se pudo verificar/);
  assert.equal(invoicePatches(calls).length, 0);
  assert.equal(resetCalls(calls).length, 1);
});

// ── 6. Camino feliz ──────────────────────────────────────────────────────────
test('feliz: PATCH invoice → propagate con intent revert (en ese orden) + reset', async () => {
  const { deps, calls, errores, reports } = makeCtx({ props: baseProps() });

  const r = await processRevertTicketRequest('T1', deps);

  assert.equal(r.reverted, true);
  assert.equal(r.invoiceId, 'INV-9');
  assert.equal(errores.length, 0);
  assert.equal(reports.length, 0);

  // Orden exacto de efectos: gate → PATCH invoice → propagate → reset
  assert.deepEqual(calls.map(c => c.type), ['gate', 'invoice_patch', 'propagate', 'ticket_update']);

  const patch = invoicePatches(calls)[0];
  assert.equal(patch.id, 'INV-9');
  assert.deepEqual(patch.patch, {
    etapa_de_la_factura: 'Cancelada',
    fecha_de_cancelacion: String(EPOCH_HOY),
  });

  const prop = propagates(calls)[0];
  assert.equal(prop.id, 'INV-9');
  assert.deepEqual(prop.opts, { cancelIntent: 'revert' });

  assert.equal(resetCalls(calls).length, 1);
});

// ── 7. Fallos parciales ──────────────────────────────────────────────────────
test('PATCH de la invoice falla: reportFn + reset, NO propaga y no lanza', async () => {
  const { deps, calls, reports } = makeCtx({ props: baseProps(), failInvoicePatch: true });

  const r = await processRevertTicketRequest('T1', deps);   // NO debe lanzar

  assert.equal(r.reverted, false);
  assert.equal(r.reason, 'invoice_patch_failed');
  assert.equal(propagates(calls).length, 0);
  assert.equal(reports.length, 1);
  assert.equal(resetCalls(calls).length, 1);
});

test('propagate falla: reportFn + reset, no lanza (la factura ya quedó cancelada)', async () => {
  const { deps, calls, reports } = makeCtx({ props: baseProps(), failPropagate: true });

  const r = await processRevertTicketRequest('T1', deps);   // NO debe lanzar

  assert.equal(r.reverted, false);
  assert.equal(r.reason, 'propagate_failed');
  assert.equal(invoicePatches(calls).length, 1);            // el PATCH sí pasó
  assert.equal(reports.length, 1);
  assert.equal(resetCalls(calls).length, 1);
});

// ── 8. Reset a prueba de todo ────────────────────────────────────────────────
test('reset corre aunque todo falle (PATCH y reset fallan): no lanza y reporta ambos', async () => {
  const { deps, calls, reports } = makeCtx({
    props: baseProps(),
    failInvoicePatch: true,
    failReset: true,
  });

  const r = await processRevertTicketRequest('T1', deps);   // NO debe lanzar

  assert.equal(r.reverted, false);
  assert.equal(r.reason, 'invoice_patch_failed');
  assert.equal(propagates(calls).length, 0);
  assert.equal(reports.length, 2);                          // fallo del PATCH + fallo del reset
  assert.match(String(reports[1].message), /reseteando casilla revertir_factura/);
});

// ── 9. GET inicial ───────────────────────────────────────────────────────────
test('GET inicial falla: el job lanza limpio (sin intentar resetear)', async () => {
  const { deps, calls } = makeCtx({ props: {} });
  deps.client = {
    crm: { tickets: { basicApi: { async getById() { throw new Error('hubspot down'); } } } },
  };

  await assert.rejects(() => processRevertTicketRequest('T1', deps), /hubspot down/);
  assert.equal(calls.length, 0);
});
