// Tests de deriveProductoTicket: deal.producto (checkbox múltiple "A;B") → ticket.of_producto.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { deriveProductoTicket } from '../services/snapshotService.js';

test('sin producto en el deal devuelve vacío', () => {
  assert.equal(deriveProductoTicket('', 'Licencias iGDoc'), '');
  assert.equal(deriveProductoTicket(null, 'Licencias iGDoc'), '');
  assert.equal(deriveProductoTicket(';;', 'Licencias iGDoc'), '');
});

test('un solo valor se usa directo, sin importar el nombre del LI', () => {
  assert.equal(deriveProductoTicket('iGDoc', 'Cualquier cosa'), 'iGDoc');
  assert.equal(deriveProductoTicket('NNDD Ops', ''), 'NNDD Ops');
});

test('multi-valor: matchea contra el nombre del line item (case-insensitive)', () => {
  assert.equal(deriveProductoTicket('iGDoc;PayRoll', 'Soporte PAYROLL mensual'), 'PayRoll');
  assert.equal(deriveProductoTicket('PayRoll;iGDoc', 'Licencias igdoc 2026'), 'iGDoc');
});

test('multi-valor sin match toma el primero', () => {
  assert.equal(deriveProductoTicket('iJServ;Portal', 'Horas de consultoría'), 'iJServ');
});

test('tolera espacios alrededor de los valores', () => {
  assert.equal(deriveProductoTicket(' iGDoc ; PayRoll ', 'soporte payroll'), 'PayRoll');
});
