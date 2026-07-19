// src/__tests__/webhookQueueReaper.test.mjs
//
// Prueba las reglas del reaper de webhook_queue (#8 del reporte de robustez).
//
// Un job que queda en 'processing' cuando el worker muere (redeploy de Railway)
// antes quedaba huérfano para siempre: el facturar_ahora se perdía sin factura
// y sin alerta. El reaper lo devuelve a 'pending', y tras N rescates lo abandona
// como 'failed' en vez de reintentar en loop.
//
// Correr con:  node --test src/__tests__/webhookQueueReaper.test.mjs
//
// No toca la base: ambas funciones son puras.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideReapAction, esFacturacionUrgentePerdida } from '../utils/webhookQueueRules.js';

const MAX = 3;

// ─── decideReapAction ────────────────────────────────────────────────────────

test('primer rescate → vuelve a pending con attempts=1', () => {
  assert.deepEqual(decideReapAction({ attempts: 0 }, MAX), { status: 'pending', attempts: 1 });
});

test('segundo rescate → sigue reintentando', () => {
  assert.deepEqual(decideReapAction({ attempts: 1 }, MAX), { status: 'pending', attempts: 2 });
});

test('al llegar al máximo → failed (no reintenta en loop infinito)', () => {
  assert.deepEqual(decideReapAction({ attempts: 2 }, MAX), { status: 'failed', attempts: 3 });
});

test('attempts nulo o ausente cuenta como 0 (filas previas a la migración)', () => {
  assert.deepEqual(decideReapAction({}, MAX), { status: 'pending', attempts: 1 });
  assert.deepEqual(decideReapAction({ attempts: null }, MAX), { status: 'pending', attempts: 1 });
});

test('maxAttempts=1 abandona en el primer rescate', () => {
  assert.deepEqual(decideReapAction({ attempts: 0 }, 1), { status: 'failed', attempts: 1 });
});

// ─── esFacturacionUrgentePerdida ─────────────────────────────────────────────
//
// El caso que importa: el job rescatado se re-ejecuta, pero facturar_ahora ya
// fue reseteado a false por la corrida que murió → el re-run solo skipea.
// Sin este aviso el job termina en 'done' y la pérdida queda invisible.

const SKIP_FLAG = { skipped: true, reason: 'facturar_ahora_false' };

test('job rescatado + urgente + flag ya consumido → avisa', () => {
  const job = { action_type: 'urgent_line_item', reaped_at: new Date(), attempts: 1 };
  assert.equal(esFacturacionUrgentePerdida(job, SKIP_FLAG), true);
});

test('lo mismo para urgent_ticket', () => {
  const job = { action_type: 'urgent_ticket', reaped_at: new Date(), attempts: 1 };
  assert.equal(esFacturacionUrgentePerdida(job, SKIP_FLAG), true);
});

test('job nunca rescatado que skipea es normal (el usuario destildó el flag) → NO avisa', () => {
  const job = { action_type: 'urgent_line_item', reaped_at: null, attempts: 0 };
  assert.equal(esFacturacionUrgentePerdida(job, SKIP_FLAG), false);
});

test('job rescatado que SÍ facturó → NO avisa', () => {
  const job = { action_type: 'urgent_line_item', reaped_at: new Date(), attempts: 1 };
  assert.equal(esFacturacionUrgentePerdida(job, { invoiceId: '999' }), false);
});

test('job rescatado que skipea por otro motivo → NO avisa (no hubo pérdida)', () => {
  const job = { action_type: 'urgent_line_item', reaped_at: new Date(), attempts: 1 };
  const otroSkip = { skipped: true, reason: 'facturacion_inactiva' };
  assert.equal(esFacturacionUrgentePerdida(job, otroSkip), false);
});

test('action_type no urgente (recalc) → NO avisa, no hay plata en juego', () => {
  const job = { action_type: 'recalc', reaped_at: new Date(), attempts: 1 };
  assert.equal(esFacturacionUrgentePerdida(job, SKIP_FLAG), false);
});

test('jobResult undefined (job sin retorno) no rompe', () => {
  const job = { action_type: 'urgent_line_item', reaped_at: new Date(), attempts: 1 };
  assert.equal(esFacturacionUrgentePerdida(job, undefined), false);
});
