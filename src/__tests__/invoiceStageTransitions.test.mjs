// src/__tests__/invoiceStageTransitions.test.mjs
//
// Matriz mínima de transiciones de etapa_de_la_factura (prep cancelar/revertir,
// hallazgo #4): Cancelada es terminal e irreversible; TODO lo demás sigue
// permitido como hoy. null/undefined → permitido (flujos que no mandan etapa).
//
// Helper puro, sin red ni DB. Correr con:
//   node --test src/__tests__/invoiceStageTransitions.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { esTransicionEtapaPermitida, ETAPA_CANCELADA } from '../../api/invoice-editor/stageTransitions.js';

const ETAPAS = ['Pendiente', 'Emitida', 'Enviada', 'Paga', 'Atrasada', 'Cancelada'];

test('constante exportada', () => {
  assert.equal(ETAPA_CANCELADA, 'Cancelada');
});

test('desde Cancelada: bloqueada hacia toda etapa != Cancelada', () => {
  for (const hacia of ETAPAS.filter(e => e !== 'Cancelada')) {
    assert.equal(esTransicionEtapaPermitida('Cancelada', hacia), false,
      `Cancelada → ${hacia} debe estar bloqueada`);
  }
});

test('Cancelada → Cancelada permitida (idempotente)', () => {
  assert.equal(esTransicionEtapaPermitida('Cancelada', 'Cancelada'), true);
});

test('hacia Cancelada: permitida desde toda etapa', () => {
  for (const desde of ETAPAS) {
    assert.equal(esTransicionEtapaPermitida(desde, 'Cancelada'), true,
      `${desde} → Cancelada debe estar permitida`);
  }
});

test('transiciones normales siguen permitidas como hoy', () => {
  assert.equal(esTransicionEtapaPermitida('Pendiente', 'Emitida'), true);
  assert.equal(esTransicionEtapaPermitida('Emitida', 'Enviada'), true);
  assert.equal(esTransicionEtapaPermitida('Enviada', 'Paga'), true);
  assert.equal(esTransicionEtapaPermitida('Paga', 'Atrasada'), true);   // retrocesos no-Cancelada: sin cambio de política
  assert.equal(esTransicionEtapaPermitida('Emitida', 'Pendiente'), true);
  assert.equal(esTransicionEtapaPermitida('Atrasada', 'Paga'), true);
});

test('null/undefined → permitido (no romper flujos que no mandan etapa)', () => {
  assert.equal(esTransicionEtapaPermitida(null, 'Emitida'), true);
  assert.equal(esTransicionEtapaPermitida(undefined, 'Emitida'), true);
  assert.equal(esTransicionEtapaPermitida('Cancelada', null), true);
  assert.equal(esTransicionEtapaPermitida('Cancelada', undefined), true);
  assert.equal(esTransicionEtapaPermitida(null, null), true);
  assert.equal(esTransicionEtapaPermitida(undefined, undefined), true);
});

test('strings vacíos o de espacios → permitido (factura sin etapa seteada)', () => {
  assert.equal(esTransicionEtapaPermitida('', 'Emitida'), true);
  assert.equal(esTransicionEtapaPermitida('  ', 'Emitida'), true);
  assert.equal(esTransicionEtapaPermitida('Cancelada', ''), true);
});

test('tolera espacios alrededor de la etapa', () => {
  assert.equal(esTransicionEtapaPermitida(' Cancelada ', 'Emitida'), false);
  assert.equal(esTransicionEtapaPermitida('Cancelada', ' Cancelada '), true);
});
