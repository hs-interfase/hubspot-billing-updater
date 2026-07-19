// src/__tests__/syncLineItemPropToTicket.test.mjs
//
// Tarea C — sync quirúrgico por-propiedad LI→ticket.
// Partes puras (exclusiones + mapeo) + el handler con un client FALSO in-memory
// (sin tocar HubSpot ni DB): se inyectan client / extractFn / updateTicketFn.
//
// Requiere DATABASE_URL dummy (el grafo de imports carga src/db.js).
//   DATABASE_URL='postgres://u:p@localhost:5432/x' node --test src/__tests__/syncLineItemPropToTicket.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isTransferableLiProp,
  pickAffectedTicketProps,
  syncLineItemPropToTickets,
  TRANSFER_EXCLUDED_LI_PROPS,
} from '../services/lineItems/syncLineItemPropToTicket.js';
import { TICKET_PIPELINE, PROXIMOS_A_FACTURAR_STAGE } from '../config/constants.js';

// ── Partes puras ─────────────────────────────────────────────────────────────
test('isTransferableLiProp: excluidas (Frecuencia/Término/NºPagos/Momento) → false', () => {
  for (const p of ['recurringbillingfrequency', 'hs_recurring_billing_period', 'hs_recurring_billing_number_of_payments', 'momento_de_facturacion']) {
    assert.equal(TRANSFER_EXCLUDED_LI_PROPS.has(p), true, `${p} debe estar excluida`);
    assert.equal(isTransferableLiProp(p), false, `${p} NO se transfiere`);
  }
});

test('isTransferableLiProp: mapeadas → true; desconocida/vacía → false', () => {
  for (const p of ['area', 'price', 'nc', 'empresa_que_factura', 'description']) {
    assert.equal(isTransferableLiProp(p), true, `${p} sí se transfiere`);
  }
  assert.equal(isTransferableLiProp('propiedad_inexistente'), false);
  assert.equal(isTransferableLiProp(''), false);
  assert.equal(isTransferableLiProp(undefined), false);
});

test('pickAffectedTicketProps: toma solo las claves de ticket influidas por la prop', () => {
  const snap = { monto_unitario_real: 100, of_costo: 40, of_margen: 60, area: 'Petróleo', nota: 'x' };
  // price influye monto + costo + margen
  assert.deepEqual(pickAffectedTicketProps(snap, 'price'), { monto_unitario_real: 100, of_costo: 40, of_margen: 60 });
  // area solo su homónima
  assert.deepEqual(pickAffectedTicketProps(snap, 'area'), { area: 'Petróleo' });
  // excluida → {}
  assert.deepEqual(pickAffectedTicketProps(snap, 'momento_de_facturacion'), {});
  // clave no presente en el snapshot no se inventa
  assert.deepEqual(pickAffectedTicketProps({ area: 'X' }, 'price'), {});
});

// ── Handler con client falso ─────────────────────────────────────────────────
// Target = "Próximos a Facturar" del pipeline MANUAL. Cualquier otra combinación se saltea.
const MANUAL = TICKET_PIPELINE;
const PROXIMOS = PROXIMOS_A_FACTURAR_STAGE;

function makeCtx({ tickets, mirror = null }) {
  const updateCalls = [];
  const avisos = [];
  const client = {
    crm: {
      lineItems: { basicApi: { async getById() { return { id: 'LI1', properties: { line_item_key: 'LIK1', area: 'Petróleo' } }; } } },
      deals: { basicApi: { async getById() { return { id: 'D1', properties: { deal_currency_code: 'USD' } }; } } },
      tickets: { searchApi: { async doSearch() { return { results: tickets }; } } },
    },
  };
  const extractFn = () => ({ area: 'Petróleo', of_producto_nombres: 'N' });
  const updateTicketFn = async (id, patch) => { updateCalls.push({ id: String(id), patch }); };
  const findMirrorFn = async () => mirror;                 // null = sin mirror
  const reportErrorFn = (arg) => { avisos.push(arg); };
  return { client, extractFn, updateTicketFn, findMirrorFn, reportErrorFn, updateCalls, avisos };
}

// tk(id, stage, pipeline, props) — por default pipeline MANUAL
const tk = (id, stage, pipeline = MANUAL, props = {}) => ({
  id: String(id),
  properties: { hs_pipeline: pipeline, hs_pipeline_stage: stage, of_line_item_key: 'LIK1', ...props },
});

test('excluida: no aplica, no busca ni escribe', async () => {
  const ctx = makeCtx({ tickets: [] });
  const r = await syncLineItemPropToTickets({ lineItemId: 'LI1', propertyName: 'momento_de_facturacion', dealId: 'D1', ...ctx });
  assert.equal(r.applies, false);
  assert.equal(r.reason, 'excluded');
  assert.equal(ctx.updateCalls.length, 0);
});

test('mapeada: actualiza SOLO "Próximos a Facturar" manual, saltea el resto, y solo si difiere', async () => {
  const tickets = [
    tk('T1', PROXIMOS, MANUAL, { area: 'Otra' }),          // target, difiere → update
    tk('T2', 'FORECAST_STAGE', MANUAL, { area: 'Otra' }),  // manual pero NO próximos → skip
    tk('T3', PROXIMOS, 'PIPE_AUTO', { area: 'Otra' }),     // próximos pero pipeline auto → skip
    tk('T4', PROXIMOS, MANUAL, { area: 'Petróleo' }),      // target pero igual → sin cambio
  ];
  const ctx = makeCtx({ tickets });
  const r = await syncLineItemPropToTickets({ lineItemId: 'LI1', propertyName: 'area', dealId: 'D1', ...ctx });

  assert.equal(r.applies, true);
  assert.deepEqual(r.keys, ['area']);
  assert.equal(r.ticketsScanned, 4);
  assert.equal(r.ticketsUpdated, 1);      // solo T1
  assert.equal(r.skipped, 2);             // T2 (stage) + T3 (pipeline)
  assert.equal(r.errors, 0);
  assert.equal(r.mirrorNotified, false);  // sin mirror

  assert.equal(ctx.updateCalls.length, 1);
  assert.equal(ctx.updateCalls[0].id, 'T1');
  assert.deepEqual(ctx.updateCalls[0].patch, { area: 'Petróleo' });
  assert.equal(ctx.avisos.length, 0);
});

test('aviso al mirror: si el original tiene mirror y se actualizó un ticket, avisa al deal UY', async () => {
  const tickets = [tk('T1', PROXIMOS, MANUAL, { area: 'Otra' })];
  const mirror = { mirrorDealId: 'DUY', mirrorLineItemId: 'LIUY', pyDealId: 'DPY' };
  const ctx = makeCtx({ tickets, mirror });
  const r = await syncLineItemPropToTickets({ lineItemId: 'LI1', propertyName: 'area', dealId: 'D1', ...ctx });

  assert.equal(r.ticketsUpdated, 1);
  assert.equal(r.mirrorNotified, true);
  assert.equal(ctx.avisos.length, 1);
  assert.equal(ctx.avisos[0].objectType, 'deal');
  assert.equal(ctx.avisos[0].objectId, 'DUY');
  assert.match(ctx.avisos[0].message, /area/);
});

test('aviso al mirror: NO se dispara si no se actualizó ningún ticket', async () => {
  const tickets = [tk('T1', PROXIMOS, MANUAL, { area: 'Petróleo' })]; // igual → sin cambio
  const mirror = { mirrorDealId: 'DUY', mirrorLineItemId: 'LIUY', pyDealId: 'DPY' };
  const ctx = makeCtx({ tickets, mirror });
  const r = await syncLineItemPropToTickets({ lineItemId: 'LI1', propertyName: 'area', dealId: 'D1', ...ctx });

  assert.equal(r.ticketsUpdated, 0);
  assert.equal(r.mirrorNotified, false);
  assert.equal(ctx.avisos.length, 0);
});

test('sin line_item_key: no hace nada', async () => {
  const ctx = makeCtx({ tickets: [] });
  const client = {
    crm: {
      lineItems: { basicApi: { async getById() { return { id: 'LI1', properties: {} }; } } },
      deals: { basicApi: { async getById() { return { properties: {} }; } } },
      tickets: { searchApi: { async doSearch() { return { results: [] }; } } },
    },
  };
  const r = await syncLineItemPropToTickets({ lineItemId: 'LI1', propertyName: 'area', dealId: 'D1', ...ctx, client });
  assert.equal(r.reason, 'sin_line_item_key');
  assert.equal(ctx.updateCalls.length, 0);
});
