// src/__tests__/dealAlertsFlag.test.mjs
//
// Llave DEAL_ALERTS_ENABLED (usuaria 23-jul): con false, las tres alertas de
// dealAlerts se OMITEN (sin props billing_error ni correos) ANTES de tocar la red.
// Phase R / contadores no se ven afectados (la llave vive en dealAlerts, no ahí).
// Vacía o ausente = prendida — acá solo se protege el camino "apagada", porque el
// camino prendido pega a HubSpot real.

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DEAL_ALERTS_ENABLED = 'false';

const { alertPagosCompletos, alertDerivacionCompleta, alertFechasCompletas } =
  await import('../services/notifications/dealAlerts.js');

test('alertPagosCompletos con DEAL_ALERTS_ENABLED=false → skipped, sin red', async () => {
  const r = await alertPagosCompletos({ dealId: '1', lineItemId: '2', lineItemName: 'x' });
  assert.deepEqual(r, { skipped: true, reason: 'DEAL_ALERTS_ENABLED=false' });
});

test('alertDerivacionCompleta con DEAL_ALERTS_ENABLED=false → skipped, sin red', async () => {
  const r = await alertDerivacionCompleta({ dealId: '1', lineItemId: '2', lineItemName: 'x', lik: 'k' });
  assert.deepEqual(r, { skipped: true, reason: 'DEAL_ALERTS_ENABLED=false' });
});

test('alertFechasCompletas con DEAL_ALERTS_ENABLED=false → skipped, sin red', async () => {
  const r = await alertFechasCompletas({ dealId: '1', lineItemId: '2', lineItemName: 'x', lik: 'k' });
  assert.deepEqual(r, { skipped: true, reason: 'DEAL_ALERTS_ENABLED=false' });
});

test('valores 0/no también apagan', async () => {
  process.env.DEAL_ALERTS_ENABLED = '0';
  assert.equal((await alertPagosCompletos({ dealId: '1', lineItemId: '2' })).skipped, true);
  process.env.DEAL_ALERTS_ENABLED = 'no';
  assert.equal((await alertFechasCompletas({ dealId: '1', lineItemId: '2', lik: 'k' })).skipped, true);
  process.env.DEAL_ALERTS_ENABLED = 'false';
});
