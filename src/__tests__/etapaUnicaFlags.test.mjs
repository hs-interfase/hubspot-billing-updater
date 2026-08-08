// src/__tests__/etapaUnicaFlags.test.mjs
//
// Llave ETAPA_UNICA_ENABLED (TANDA A, 30-jul): default OFF, sólo 'true'/'1'/'yes'
// prenden (misma semántica que cancelRevertFlags.js). Ver
// definitivos/PLAN_proximos_cambios_tickets_2026-07-29.md §2.

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@127.0.0.1:1/dummy';

// constants.js lee process.env a nivel de módulo (una sola vez, al importar):
// si el .env real no está cargado en este proceso de test, las 5 props de
// forecast pueden venir todas vacías y colapsar en el mismo valor ''. Se
// fuerzan acá, ANTES del import, para que el test no dependa de si el .env
// está presente.
process.env.BILLING_TICKET_FORECAST = process.env.BILLING_TICKET_FORECAST || 'test-forecast-25';
process.env.BILLING_TICKET_FORECAST_50 = process.env.BILLING_TICKET_FORECAST_50 || 'test-forecast-50';
process.env.BILLING_TICKET_FORECAST_75 = process.env.BILLING_TICKET_FORECAST_75 || 'test-forecast-75';
process.env.BILLING_TICKET_FORECAST_85 = process.env.BILLING_TICKET_FORECAST_85 || 'test-forecast-85';
process.env.BILLING_TICKET_FORECAST_95 = process.env.BILLING_TICKET_FORECAST_95 || 'test-forecast-95';

const { etapaUnicaEnabled } = await import('../config/etapaUnicaFlags.js');
const {
  FORECAST_MANUAL_STAGES,
  FORECAST_MANUAL_STAGES_UP_TO_75,
} = await import('../config/constants.js');

const ORIGINAL = process.env.ETAPA_UNICA_ENABLED;

test('ausente/vacía/false/basura → apagada (default seguro)', () => {
  for (const v of [undefined, '', 'false', '0', 'no', 'banana']) {
    if (v === undefined) delete process.env.ETAPA_UNICA_ENABLED;
    else process.env.ETAPA_UNICA_ENABLED = v;
    assert.equal(etapaUnicaEnabled(), false, `esperaba OFF para ${JSON.stringify(v)}`);
  }
});

test("'true' / '1' / 'yes' (case-insensitive, con espacios) → prendida", () => {
  for (const v of ['true', 'TRUE', ' true ', '1', 'yes', 'YES']) {
    process.env.ETAPA_UNICA_ENABLED = v;
    assert.equal(etapaUnicaEnabled(), true, `esperaba ON para ${JSON.stringify(v)}`);
  }
});

test('FORECAST_MANUAL_STAGES_UP_TO_75 excluye 85/95; FORECAST_MANUAL_STAGES los sigue incluyendo', () => {
  assert.equal(FORECAST_MANUAL_STAGES_UP_TO_75.size, 3);
  assert.equal(FORECAST_MANUAL_STAGES.size, 5);
  for (const s of FORECAST_MANUAL_STAGES_UP_TO_75) {
    assert.equal(FORECAST_MANUAL_STAGES.has(s), true, `${s} debería seguir en el set completo`);
  }
  // Los 2 stages exclusivos del set completo (85/95) no están en el recortado.
  const exclusivos = [...FORECAST_MANUAL_STAGES].filter(s => !FORECAST_MANUAL_STAGES_UP_TO_75.has(s));
  assert.equal(exclusivos.length, 2);

  if (ORIGINAL === undefined) delete process.env.ETAPA_UNICA_ENABLED;
  else process.env.ETAPA_UNICA_ENABLED = ORIGINAL;
});
