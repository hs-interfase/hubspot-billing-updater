// src/__tests__/resolveOwnerEmail.test.mjs
//
// Regresión del bug encontrado en la ronda de sandbox B+C (1-ago-2026):
// `dealAlerts.resolveOwnerEmail` llamaba a `hubspotClient.crm.owners.defaultApi`,
// que en esta versión del SDK es `undefined`. El TypeError caía en el catch y la
// función devolvía SIEMPRE null — con lo cual los tres avisos de dealAlerts,
// `ticketCancelledByEngineAlert` (§2.4, "el motor no borra: cancela y avisa") y
// `ticketKeptAliveAlert` cortaban en "sin destinatarios" y no le llegaban a nadie.
//
// Venía desde e1e315e (18-may-2026) y nadie lo notó porque el catch lo silenciaba
// y ningún test miraba el accessor. Este test mira exactamente eso.

import test from 'node:test';
import assert from 'node:assert/strict';
import { hubspotClient } from '../hubspotClient.js';

test('el SDK expone crm.owners.ownersApi.getById (y NO defaultApi)', () => {
  assert.ok(
    hubspotClient?.crm?.owners,
    'hubspotClient.crm.owners no existe — cambió la forma del SDK'
  );
  assert.equal(
    typeof hubspotClient.crm.owners.ownersApi?.getById,
    'function',
    'crm.owners.ownersApi.getById tiene que ser una función: es la que usa resolveOwnerEmail'
  );
  assert.equal(
    hubspotClient.crm.owners.defaultApi,
    undefined,
    'crm.owners.defaultApi sigue sin existir; si algún día aparece, revisar resolveOwnerEmail'
  );
});

test('resolveOwnerEmail devuelve null sin ownerId, sin tocar la red', async () => {
  const { resolveOwnerEmail } = await import('../services/notifications/dealAlerts.js');
  assert.equal(await resolveOwnerEmail(null), null);
  assert.equal(await resolveOwnerEmail(undefined), null);
  assert.equal(await resolveOwnerEmail(''), null);
});
