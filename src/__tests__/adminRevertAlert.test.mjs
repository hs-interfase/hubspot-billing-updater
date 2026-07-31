// src/__tests__/adminRevertAlert.test.mjs
//
// Email a administración cuando se REVIERTE una factura para refacturar
// (Bloque 4 del flujo cancelar/revertir). Con sendAlertFn/sendAlertToFn FAKE —
// nada toca Resend.
//
// Llave: DEAL_ALERTS_ENABLED (mismo parser que mirrorAlert: ausente = ON).
// Umbral: REBILL_ALERT_THRESHOLD (default 2; '0' o vacía = sin refuerzo).
//
// Requiere DATABASE_URL dummy (el grafo de imports puede cargar src/db.js).
//   DATABASE_URL='postgres://u:p@localhost:5432/x' node --test src/__tests__/adminRevertAlert.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@127.0.0.1:1/dummy';

const { notifyAdminOnRevert, adminRevertEmailApagado, rebillAlertThreshold, buildRevertAlertTitle } =
  await import('../services/notifications/adminRevertAlert.js');

const ORIGINAL_FLAG = process.env.DEAL_ALERTS_ENABLED;
const ORIGINAL_THRESHOLD = process.env.REBILL_ALERT_THRESHOLD;
// los tests de default no deben ver un destino dedicado del entorno
delete process.env.ADMIN_ALERT_TO_EMAIL;
delete process.env.REBILL_ALERT_THRESHOLD;

const BASE = { dealId: 'D1', ticketId: 'T1', invoiceId: 'F1', contador: 1 };

test('DEAL_ALERTS_ENABLED=false/0/no → email omitido, sin llamadas', async () => {
  for (const v of ['false', '0', 'no']) {
    process.env.DEAL_ALERTS_ENABLED = v;
    const calls = [];
    const r = await notifyAdminOnRevert(BASE, {
      sendAlertFn: async (...a) => { calls.push(a); },
      sendAlertToFn: async (...a) => { calls.push(a); },
    });
    assert.deepEqual(r, { emailed: false, reason: 'DEAL_ALERTS_ENABLED=false' });
    assert.equal(calls.length, 0);
    assert.equal(adminRevertEmailApagado('test'), true);
  }
  delete process.env.DEAL_ALERTS_ENABLED;
  assert.equal(adminRevertEmailApagado('test'), false);
});

test('ADMIN_ALERT_TO_EMAIL seteada → sendAlertTo con ese destinatario (no el default)', async () => {
  delete process.env.DEAL_ALERTS_ENABLED;
  process.env.ADMIN_ALERT_TO_EMAIL = 'admin@ejemplo.com';
  const toCalls = [];
  const defaultCalls = [];
  const r = await notifyAdminOnRevert(
    { ...BASE, motivo: 'cliente pidió corregir monto', cupoResult: { reverted: true, credito: 3, cupoRestanteNuevo: 7 } },
    {
      sendAlertFn: async (...a) => { defaultCalls.push(a); },
      sendAlertToFn: async (args) => { toCalls.push(args); },
    }
  );
  assert.deepEqual(r, { emailed: true });
  assert.equal(defaultCalls.length, 0);
  assert.equal(toCalls.length, 1);
  assert.deepEqual(toCalls[0].to, ['admin@ejemplo.com']);
  assert.equal(toCalls[0].level, 'warning');
  assert.equal(toCalls[0].title, 'Factura revertida para refacturar');
  assert.equal(toCalls[0].meta.negocio, 'D1');
  assert.equal(toCalls[0].meta.ticket, 'T1');
  assert.equal(toCalls[0].meta.invoice, 'F1');
  assert.equal(toCalls[0].meta.motivo, 'cliente pidió corregir monto');
  assert.equal(toCalls[0].meta['refacturación'], 'N° 1');
  assert.equal(toCalls[0].meta.cupo, 're-acreditado +3 (restante 7)');
  delete process.env.ADMIN_ALERT_TO_EMAIL;
});

test('ADMIN_ALERT_TO_EMAIL vacía/ausente → fallback al destino operativo default (sendAlert)', async () => {
  delete process.env.DEAL_ALERTS_ENABLED;
  process.env.ADMIN_ALERT_TO_EMAIL = '   ';
  const toCalls = [];
  const defaultCalls = [];
  const r = await notifyAdminOnRevert(
    { ...BASE, cupoResult: { reverted: false, reason: 'sin_deal_id' } },
    {
      sendAlertFn: async (level, title, meta) => { defaultCalls.push({ level, title, meta }); },
      sendAlertToFn: async (args) => { toCalls.push(args); },
    }
  );
  assert.deepEqual(r, { emailed: true });
  assert.equal(toCalls.length, 0);
  assert.equal(defaultCalls.length, 1);
  assert.equal(defaultCalls[0].level, 'warning');
  assert.equal(defaultCalls[0].meta.cupo, 'no se pudo re-acreditar: sin_deal_id');
  // sin motivo → la clave no aparece en la meta
  assert.equal('motivo' in defaultCalls[0].meta, false);
  delete process.env.ADMIN_ALERT_TO_EMAIL;
});

test('umbral default (2): contador 1 → título normal; contador 2 → título de atención', async () => {
  delete process.env.DEAL_ALERTS_ENABLED;
  delete process.env.REBILL_ALERT_THRESHOLD; // ausente = default 2
  assert.equal(rebillAlertThreshold(), 2);

  const titles = [];
  const deps = { sendAlertFn: async (level, title) => { titles.push(title); } };

  await notifyAdminOnRevert({ ...BASE, contador: 1 }, deps);
  await notifyAdminOnRevert({ ...BASE, contador: 2 }, deps);
  await notifyAdminOnRevert({ ...BASE, contador: 3 }, deps);

  assert.deepEqual(titles, [
    'Factura revertida para refacturar',
    '⚠️ Período refacturado 2 veces',
    '⚠️ Período refacturado 3 veces',
  ]);
});

test("REBILL_ALERT_THRESHOLD='0' o vacía → sin refuerzo, título normal siempre", async () => {
  delete process.env.DEAL_ALERTS_ENABLED;
  for (const v of ['0', '', '   ']) {
    process.env.REBILL_ALERT_THRESHOLD = v;
    assert.equal(rebillAlertThreshold(), 0);
    const titles = [];
    await notifyAdminOnRevert(
      { ...BASE, contador: 99 },
      { sendAlertFn: async (level, title) => { titles.push(title); } }
    );
    assert.deepEqual(titles, ['Factura revertida para refacturar']);
  }
  // basura → vuelve al default seguro (2)
  process.env.REBILL_ALERT_THRESHOLD = 'banana';
  assert.equal(rebillAlertThreshold(), 2);
  assert.equal(buildRevertAlertTitle(5), '⚠️ Período refacturado 5 veces');
  delete process.env.REBILL_ALERT_THRESHOLD;
});

test('send que lanza: NO lanza, devuelve reason=error', async () => {
  delete process.env.DEAL_ALERTS_ENABLED;
  const r = await notifyAdminOnRevert(BASE, {
    sendAlertFn: async () => { throw new Error('boom-resend'); },
  });
  assert.deepEqual(r, { emailed: false, reason: 'error' });

  // restaurar el entorno para no ensuciar otros tests del proceso
  if (ORIGINAL_FLAG === undefined) delete process.env.DEAL_ALERTS_ENABLED;
  else process.env.DEAL_ALERTS_ENABLED = ORIGINAL_FLAG;
  if (ORIGINAL_THRESHOLD === undefined) delete process.env.REBILL_ALERT_THRESHOLD;
  else process.env.REBILL_ALERT_THRESHOLD = ORIGINAL_THRESHOLD;
});
