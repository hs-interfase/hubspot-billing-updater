// src/__tests__/cancelTicketRequest.test.mjs
//
// Casilla cancelar_ticket — handler mínimo (26-jul).
// Todo con fakes inyectados (client / updateTicketFn / writeTicketErrorFn / reportFn):
// no toca HubSpot ni DB.
//
// Requiere DATABASE_URL dummy (el grafo de imports carga src/db.js).
//   DATABASE_URL='postgres://u:p@localhost:5432/x' node --test src/__tests__/cancelTicketRequest.test.mjs

process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/x';

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { processCancelTicketRequest } = await import('../services/tickets/cancelTicketRequest.js');

const PIPE_MANUAL = 'PIPE_MANUAL';
const PIPE_AUTO = 'PIPE_AUTO';
const STAGE_CANCEL_MANUAL = 'STAGE_CANCEL_MANUAL';
const STAGE_CANCEL_AUTO = 'STAGE_CANCEL_AUTO';
const STAGE_FORECAST = 'STAGE_FORECAST';

function makeCtx({ props, failStageWrite = false }) {
  const updateCalls = [];
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
      if (failStageWrite && patch.hs_pipeline_stage) throw new Error('boom stage write');
      updateCalls.push({ id: String(id), patch });
    },
    writeTicketErrorFn: async (id, msg) => { errores.push({ id: String(id), msg }); },
    reportFn: (arg) => { reports.push(arg); },
    automatedPipelineId: PIPE_AUTO,
    cancelledStageByPipeline: {
      [PIPE_MANUAL]: STAGE_CANCEL_MANUAL,
      [PIPE_AUTO]: STAGE_CANCEL_AUTO,
    },
    todayYMDFn: () => '2026-07-26',
  };

  return { deps, updateCalls, errores, reports };
}

const resetCalls = (updateCalls) =>
  updateCalls.filter(c => c.patch.cancelar_ticket === 'false');
const stageCalls = (updateCalls) =>
  updateCalls.filter(c => 'hs_pipeline_stage' in c.patch);

// ── 1. Automático ────────────────────────────────────────────────────────────
test('automático: aviso y reset, sin tocar stage', async () => {
  const { deps, updateCalls, errores } = makeCtx({
    props: {
      hs_pipeline: PIPE_AUTO, hs_pipeline_stage: STAGE_FORECAST,
      of_invoice_id: '', of_invoice_status: '', cancelar_ticket: 'true',
    },
  });

  const r = await processCancelTicketRequest('T1', deps);

  assert.equal(r.skipped, true);
  assert.equal(r.reason, 'automated_pipeline');
  assert.equal(errores.length, 1);
  assert.match(errores[0].msg, /automáticos no se cancelan/);
  assert.equal(stageCalls(updateCalls).length, 0);       // stage intacto
  assert.equal(resetCalls(updateCalls).length, 1);       // casilla reseteada
  assert.equal(updateCalls.length, 1);                   // solo el reset
});

// ── 2. Ya cancelado ──────────────────────────────────────────────────────────
test('ya en CANCELADO: solo reset de la casilla', async () => {
  const { deps, updateCalls, errores } = makeCtx({
    props: {
      hs_pipeline: PIPE_MANUAL, hs_pipeline_stage: STAGE_CANCEL_MANUAL,
      of_invoice_id: '', of_invoice_status: '', cancelar_ticket: 'true',
    },
  });

  const r = await processCancelTicketRequest('T1', deps);

  assert.equal(r.skipped, true);
  assert.equal(r.reason, 'already_cancelled');
  assert.equal(errores.length, 0);
  assert.equal(updateCalls.length, 1);
  assert.deepEqual(updateCalls[0].patch, { cancelar_ticket: 'false' });
});

// ── 3. Sin factura viva ──────────────────────────────────────────────────────
test('sin factura: mueve a CANCELADO con motivo (con fecha) + reset', async () => {
  const { deps, updateCalls, errores } = makeCtx({
    props: {
      hs_pipeline: PIPE_MANUAL, hs_pipeline_stage: STAGE_FORECAST,
      of_invoice_id: '', of_invoice_status: '', cancelar_ticket: 'true',
    },
  });

  const r = await processCancelTicketRequest('T1', deps);

  assert.equal(r.cancelled, true);
  assert.equal(r.stage, STAGE_CANCEL_MANUAL);
  assert.equal(errores.length, 0);

  const sc = stageCalls(updateCalls);
  assert.equal(sc.length, 1);
  assert.equal(sc[0].patch.hs_pipeline_stage, STAGE_CANCEL_MANUAL);
  assert.match(sc[0].patch.motivo_cancelacion_del_ticket, /Cancelado por el usuario \(casilla cancelar_ticket\)/);
  assert.match(sc[0].patch.motivo_cancelacion_del_ticket, /2026-07-26/);
  // Extracción quirúrgica: NO pisa of_ticket_key ni otras props
  assert.equal('of_ticket_key' in sc[0].patch, false);

  assert.equal(resetCalls(updateCalls).length, 1);
  assert.equal(updateCalls.length, 2);                   // stage+motivo y reset
});

test('factura Cancelada cuenta como sin factura viva: también cancela', async () => {
  const { deps, updateCalls } = makeCtx({
    props: {
      hs_pipeline: PIPE_MANUAL, hs_pipeline_stage: STAGE_FORECAST,
      of_invoice_id: 'INV-1', of_invoice_status: 'Cancelada', cancelar_ticket: 'true',
    },
  });

  const r = await processCancelTicketRequest('T1', deps);

  assert.equal(r.cancelled, true);
  assert.equal(stageCalls(updateCalls).length, 1);
  assert.equal(resetCalls(updateCalls).length, 1);
});

// ── 4. Con factura viva ──────────────────────────────────────────────────────
test('con factura viva: aviso y reset, sin tocar stage', async () => {
  const { deps, updateCalls, errores } = makeCtx({
    props: {
      hs_pipeline: PIPE_MANUAL, hs_pipeline_stage: STAGE_FORECAST,
      of_invoice_id: 'INV-9', of_invoice_status: 'Emitida', cancelar_ticket: 'true',
    },
  });

  const r = await processCancelTicketRequest('T1', deps);

  assert.equal(r.skipped, true);
  assert.equal(r.reason, 'invoice_alive');
  assert.equal(errores.length, 1);
  assert.match(errores[0].msg, /factura emitida/);
  assert.match(errores[0].msg, /cancelar\/revertir/);
  assert.equal(stageCalls(updateCalls).length, 0);
  assert.equal(resetCalls(updateCalls).length, 1);
  assert.equal(updateCalls.length, 1);
});

// ── 5. Reset incluso si falla la escritura del stage ─────────────────────────
test('si la escritura del stage falla, la casilla se resetea igual (y no lanza)', async () => {
  const { deps, updateCalls, reports } = makeCtx({
    props: {
      hs_pipeline: PIPE_MANUAL, hs_pipeline_stage: STAGE_FORECAST,
      of_invoice_id: '', of_invoice_status: '', cancelar_ticket: 'true',
    },
    failStageWrite: true,
  });

  const r = await processCancelTicketRequest('T1', deps);   // NO debe lanzar

  assert.equal(r.cancelled, false);
  assert.equal(r.reason, 'stage_update_failed');
  assert.equal(stageCalls(updateCalls).length, 0);          // el write falló
  assert.equal(resetCalls(updateCalls).length, 1);          // pero el reset pasó
  assert.equal(reports.length, 1);                          // y se reportó
});

// ── Guards adicionales ───────────────────────────────────────────────────────
test('casilla ya en false: skipped sin escribir nada', async () => {
  const { deps, updateCalls, errores } = makeCtx({
    props: {
      hs_pipeline: PIPE_MANUAL, hs_pipeline_stage: STAGE_FORECAST,
      of_invoice_id: '', of_invoice_status: '', cancelar_ticket: 'false',
    },
  });

  const r = await processCancelTicketRequest('T1', deps);

  assert.equal(r.skipped, true);
  assert.equal(r.reason, 'cancelar_ticket_false');
  assert.equal(updateCalls.length, 0);
  assert.equal(errores.length, 0);
});

test('pipeline desconocido sin fallback: reporta y solo resetea', async () => {
  const { deps, updateCalls, reports } = makeCtx({
    props: {
      hs_pipeline: 'PIPE_RARO', hs_pipeline_stage: STAGE_FORECAST,
      of_invoice_id: '', of_invoice_status: '', cancelar_ticket: 'true',
    },
  });
  // sin fallback manual (independiente del env)
  deps.cancelledStageByPipeline = {};
  deps.fallbackCancelledStage = '';

  const r = await processCancelTicketRequest('T1', deps);

  assert.equal(r.skipped, true);
  assert.equal(r.reason, 'unknown_cancel_stage');
  assert.equal(stageCalls(updateCalls).length, 0);
  assert.equal(resetCalls(updateCalls).length, 1);
  assert.equal(reports.length, 1);
});

test('GET inicial falla: el job lanza limpio (sin intentar resetear)', async () => {
  const { deps, updateCalls } = makeCtx({ props: {} });
  deps.client = {
    crm: { tickets: { basicApi: { async getById() { throw new Error('hubspot down'); } } } },
  };

  await assert.rejects(() => processCancelTicketRequest('T1', deps), /hubspot down/);
  assert.equal(updateCalls.length, 0);
});
