// src/__tests__/dealGanadoFrontera.test.mjs
//
// FRONTERA GANADO / NO GANADO (decisión usuaria 2-ago-2026).
//
// Lo que se protege acá:
//   1. isDealGanadoStage reconoce las TRES etapas del lado ganado que confirmó la
//      usuaria: «Cierre ganado», «En Ejecución» y «Finalizado».
//   2. Ninguna etapa PRE-ganado cuenta como ganada — es lo que habilita que Phase 1
//      derive costo/margen, área y emisora con la facturación apagada.
//   3. 🔴 El '' NO matchea. DEAL_STAGE_95/100 defaultean a '' si no están en el .env;
//      si el Set no filtrara, un deal SIN etapa daría "ganado" y quedaría bloqueado
//      exactamente igual que antes del arreglo — el bug se vería como "no cambió nada".
//      Es la misma trampa que ya documenta CANCELLED_DEAL_STAGES.
//
// ⚠️ constants.js lee process.env AL IMPORTAR → setear las envs ANTES del import.

import test from 'node:test';
import assert from 'node:assert/strict';

const EN_EJECUCION = 'en_ejecucion';
const FINALIZADO = 'finalizado';

process.env.DEAL_STAGE_95 = EN_EJECUCION;
process.env.DEAL_STAGE_100 = FINALIZADO;

const { isDealGanadoStage, WON_DEAL_STAGES } = await import('../config/constants.js');

test('las TRES etapas del lado ganado cuentan como ganado', () => {
  assert.equal(isDealGanadoStage('closedwon'), true);
  assert.equal(isDealGanadoStage(EN_EJECUCION), true);
  assert.equal(isDealGanadoStage(FINALIZADO), true);
  assert.equal(WON_DEAL_STAGES.size, 3);
});

test('ninguna etapa pre-ganado cuenta como ganado', () => {
  for (const s of [
    'appointmentscheduled',
    'qualifiedtobuy',
    'presentationscheduled',
    'decisionmakerboughtin', // la del seed de la prueba a mano
    'contractsent',
  ]) {
    assert.equal(isDealGanadoStage(s), false, `${s} no debería contar como ganado`);
  }
});

test('closedlost no cuenta como ganado', () => {
  assert.equal(isDealGanadoStage('closedlost'), false);
});

test('vacío / null / undefined NO matchean (si no, un deal sin etapa quedaría bloqueado)', () => {
  assert.equal(isDealGanadoStage(''), false);
  assert.equal(isDealGanadoStage(null), false);
  assert.equal(isDealGanadoStage(undefined), false);
});

test('el Set no arrastra cadenas vacías cuando las envs 95/100 no están', async () => {
  // Reimport aislado con las envs ausentes: el .filter(Boolean) tiene que dejar
  // el Set en 1 sola etapa ('closedwon'), no en 3 con dos '' adentro.
  const envAnterior = { s95: process.env.DEAL_STAGE_95, s100: process.env.DEAL_STAGE_100 };
  delete process.env.DEAL_STAGE_95;
  delete process.env.DEAL_STAGE_100;
  try {
    const mod = await import(`../config/constants.js?sinEnvs=${Date.now()}`);
    assert.equal(mod.WON_DEAL_STAGES.has(''), false);
    assert.equal(mod.isDealGanadoStage(''), false);
    assert.equal(mod.WON_DEAL_STAGES.size, 1);
    assert.equal(mod.isDealGanadoStage('closedwon'), true);
  } finally {
    process.env.DEAL_STAGE_95 = envAnterior.s95;
    process.env.DEAL_STAGE_100 = envAnterior.s100;
  }
});

// ── La regla de decisión del worker, tal como quedó en webhookQueue.js ──────────
// Se replica el predicado (no la función entera: executeJob toca red y DB) para
// dejar fijada la tabla de verdad que acordamos.
const seSalteaElJob = (dealstage, facturacionActiva) =>
  isDealGanadoStage(dealstage) && !facturacionActiva;

test('tabla de verdad de la frontera', () => {
  // NO ganado + facturación apagada → CORRE (esto es lo que arregla el bug)
  assert.equal(seSalteaElJob('decisionmakerboughtin', false), false);
  // NO ganado + facturación prendida → corre
  assert.equal(seSalteaElJob('decisionmakerboughtin', true), false);
  // Ganado + facturación prendida → corre (el guard nunca aplicó acá)
  assert.equal(seSalteaElJob('closedwon', true), false);
  // Ganado + facturación apagada → SE SALTEA (lo único que el guard protegía)
  assert.equal(seSalteaElJob('closedwon', false), true);
  assert.equal(seSalteaElJob(EN_EJECUCION, false), true);
  assert.equal(seSalteaElJob(FINALIZADO, false), true);
});
