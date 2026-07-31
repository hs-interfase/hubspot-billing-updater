// src/__tests__/editorCancelMode.test.mjs
//
// Cancelar vs Revertir en el EDITOR de facturas (definición usuaria 30-jul):
// el nombre dice lo que le pasa al ticket.
//   - CANCELAR → factura Cancelada + ticket CANCELADO (período cerrado).
//   - REVERTIR → factura Cancelada + ticket facturable, y SÓLO MANUALES.
//
// Revertir un automático re-arma el cron (lo re-emite solo en el próximo ciclo),
// así que ahí las operaciones válidas son cancelar o corregir (editar la factura
// / nota de crédito). Es la misma regla que ya aplican las casillas del ticket.
//
// resolveEditorCancelMode es el helper PURO que decide; el IO (resolver el
// pipeline del ticket) queda en la ruta.
//
// Requiere DATABASE_URL dummy (el grafo de imports carga Db.js / src/db.js).

process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/x';

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { resolveEditorCancelMode } = await import('../../api/invoice-editor/invoices.js');

// ═════════════════════════════════════════════════════════════════════════════
// Llave apagada → neutralidad total (el modo se ignora, como siempre)
// ═════════════════════════════════════════════════════════════════════════════

test('flag OFF: el modo se ignora y no hay intent (comportamiento actual)', () => {
  for (const modo of [undefined, null, 'cancelar', 'revertir', 'basura']) {
    assert.deepEqual(
      resolveEditorCancelMode({ modo, flowEnabled: false, isAutomated: true }),
      { mode: 'revertir', intent: null },
      `modo=${modo}`
    );
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// Default: el endpoint se llama /cancelar → cancela
// ═════════════════════════════════════════════════════════════════════════════

test('sin modo → cancelar (cierra el período), manual', () => {
  assert.deepEqual(
    resolveEditorCancelMode({ flowEnabled: true, isAutomated: false }),
    { mode: 'cancelar', intent: 'cancel' }
  );
});

test('sin modo → cancelar también en automáticos (cancelar sí aplica a los dos)', () => {
  assert.deepEqual(
    resolveEditorCancelMode({ flowEnabled: true, isAutomated: true }),
    { mode: 'cancelar', intent: 'cancel' }
  );
});

test("modo 'cancelar' explícito → intent cancel", () => {
  assert.deepEqual(
    resolveEditorCancelMode({ modo: 'cancelar', flowEnabled: true, isAutomated: true }),
    { mode: 'cancelar', intent: 'cancel' }
  );
});

// ═════════════════════════════════════════════════════════════════════════════
// Revertir: sólo manuales
// ═════════════════════════════════════════════════════════════════════════════

test("modo 'revertir' en MANUAL → intent revert", () => {
  assert.deepEqual(
    resolveEditorCancelMode({ modo: 'revertir', flowEnabled: true, isAutomated: false }),
    { mode: 'revertir', intent: 'revert' }
  );
});

test("modo 'revertir' en AUTOMÁTICO → 409 con el mensaje de nota de crédito", () => {
  const r = resolveEditorCancelMode({ modo: 'revertir', flowEnabled: true, isAutomated: true });
  assert.equal(r.status, 409);
  assert.equal(r.reason, 'automatica_no_revierte');
  assert.match(r.error, /sólo para facturas MANUALES/);
  assert.match(r.error, /nota de crédito/);
  assert.equal(r.intent, undefined, 'no debe devolver intent cuando rechaza');
});

test('revertir sin poder determinar el pipeline → 409 fail-closed', () => {
  for (const isAutomated of [null, undefined]) {
    const r = resolveEditorCancelMode({ modo: 'revertir', flowEnabled: true, isAutomated });
    assert.equal(r.status, 409, `isAutomated=${isAutomated}`);
    assert.equal(r.reason, 'pipeline_indeterminado');
    assert.match(r.error, /No se pudo verificar/);
  }
});

test('cancelar NO necesita saber el pipeline (no falla si es indeterminado)', () => {
  assert.deepEqual(
    resolveEditorCancelMode({ modo: 'cancelar', flowEnabled: true, isAutomated: null }),
    { mode: 'cancelar', intent: 'cancel' }
  );
});

// ═════════════════════════════════════════════════════════════════════════════
// Validación de entrada
// ═════════════════════════════════════════════════════════════════════════════

test('modo inválido → 400', () => {
  for (const modo of ['CANCELAR', 'revert', 'anular', '']) {
    const r = resolveEditorCancelMode({ modo, flowEnabled: true, isAutomated: false });
    assert.equal(r.status, 400, `modo=${JSON.stringify(modo)}`);
    assert.equal(r.reason, 'modo_invalido');
  }
});

test('sin argumentos no explota', () => {
  const r = resolveEditorCancelMode();
  assert.deepEqual(r, { mode: 'revertir', intent: null }); // flowEnabled undefined = off
});
