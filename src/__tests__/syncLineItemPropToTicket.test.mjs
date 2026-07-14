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
import { TICKET_STAGES } from '../config/constants.js';

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
const PENDING = TICKET_STAGES.NEW;      // garantizado ∈ PENDING_STAGES
const EMITTED = 'ZZZ_STAGE_NO_PENDING'; // garantizado ∉ PENDING_STAGES

function makeCtx({ tickets }) {
  const updateCalls = [];
  const client = {
    crm: {
      lineItems: { basicApi: { async getById() { return { id: 'LI1', properties: { line_item_key: 'LIK1', area: 'Petróleo' } }; } } },
      deals: { basicApi: { async getById() { return { id: 'D1', properties: { deal_currency_code: 'USD' } }; } } },
      tickets: { searchApi: { async doSearch() { return { results: tickets }; } } },
    },
  };
  const extractFn = () => ({ area: 'Petróleo', of_producto_nombres: 'N' });
  const updateTicketFn = async (id, patch) => { updateCalls.push({ id: String(id), patch }); };
  return { client, extractFn, updateTicketFn, updateCalls };
}

const tk = (id, stage, props = {}) => ({ id: String(id), properties: { hs_pipeline_stage: stage, of_line_item_key: 'LIK1', ...props } });

test('excluida: no aplica, no busca ni escribe', async () => {
  const { client, extractFn, updateTicketFn, updateCalls } = makeCtx({ tickets: [] });
  const r = await syncLineItemPropToTickets({ lineItemId: 'LI1', propertyName: 'momento_de_facturacion', dealId: 'D1', client, extractFn, updateTicketFn });
  assert.equal(r.applies, false);
  assert.equal(r.reason, 'excluded');
  assert.equal(updateCalls.length, 0);
});

test('mapeada: actualiza tickets pendientes, saltea emitidos, y solo si el valor difiere', async () => {
  const tickets = [
    tk('T1', PENDING, { area: 'Otra' }),      // difiere → update
    tk('T2', EMITTED, { area: 'Otra' }),      // emitido → skip
    tk('T3', PENDING, { area: 'Petróleo' }),  // igual → sin cambio
  ];
  const { client, extractFn, updateTicketFn, updateCalls } = makeCtx({ tickets });
  const r = await syncLineItemPropToTickets({ lineItemId: 'LI1', propertyName: 'area', dealId: 'D1', client, extractFn, updateTicketFn });

  assert.equal(r.applies, true);
  assert.deepEqual(r.keys, ['area']);
  assert.equal(r.ticketsScanned, 3);
  assert.equal(r.ticketsUpdated, 1);      // solo T1
  assert.equal(r.skippedEmitted, 1);      // T2
  assert.equal(r.errors, 0);

  assert.equal(updateCalls.length, 1);
  assert.equal(updateCalls[0].id, 'T1');
  assert.deepEqual(updateCalls[0].patch, { area: 'Petróleo' });
});

test('sin line_item_key: no hace nada', async () => {
  const { extractFn, updateTicketFn, updateCalls } = makeCtx({ tickets: [] });
  const client = {
    crm: {
      lineItems: { basicApi: { async getById() { return { id: 'LI1', properties: {} }; } } },
      deals: { basicApi: { async getById() { return { properties: {} }; } } },
      tickets: { searchApi: { async doSearch() { return { results: [] }; } } },
    },
  };
  const r = await syncLineItemPropToTickets({ lineItemId: 'LI1', propertyName: 'area', dealId: 'D1', client, extractFn, updateTicketFn });
  assert.equal(r.reason, 'sin_line_item_key');
  assert.equal(updateCalls.length, 0);
});
