// src/__tests__/etapaDepositoAuto.test.mjs
//
// ETAPA DEPÓSITO DEL PIPELINE AUTOMÁTICO (pedido usuaria 2026-08-07).
//
// El automático tenía DOS etapas entre «75% Forecast» y «notificado»
// (BILLING_AUTOMATED_FORECAST_85 y _95, repartidas por bucket del negocio).
// Pedido: UNA SOLA — el depósito donde esperan todos los tickets aún no
// notificados de un negocio ganado o en ejecución, igual que «Próximos a
// facturar» del lado manual.
//
// Se reusa una etapa existente: queda la 85 y se retira la 95. No se crea
// ninguna etapa en el portal, y el id de la 95 sigue reconocido como "no
// notificado" (FORECAST_AUTO_STAGES / PENDING_STAGES) para que los tickets
// parados ahí se sigan contando y el motor los reubique solo.
//
// Criterio de aceptación: con ETAPA_UNICA_AUTO_ENABLED apagada, TODO se
// comporta exactamente como hoy. Sin red: resolveForecastStage es pura.
//
// Correr con:
//   node --test src/__tests__/etapaDepositoAuto.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@127.0.0.1:1/dummy';

process.env.BILLING_TICKET_PIPELINE_ID = 'PIPE_MANUAL';
process.env.BILLING_AUTOMATED_PIPELINE_ID = 'PIPE_AUTO';
process.env.BILLING_TICKET_FORECAST = 'F25';
process.env.BILLING_TICKET_FORECAST_50 = 'F50';
process.env.BILLING_TICKET_FORECAST_75 = 'F75';
process.env.BILLING_TICKET_FORECAST_85 = 'F85';
process.env.BILLING_TICKET_FORECAST_95 = 'F95';
process.env.BILLING_TICKET_STAGE_ID = 'PROXIMOS';
process.env.BILLING_TICKET_STAGE_READY = 'NOTIFICADO';
process.env.BILLING_AUTOMATED_FORECAST = 'AF25';
process.env.BILLING_AUTOMATED_FORECAST_50 = 'AF50';
process.env.BILLING_AUTOMATED_FORECAST_75 = 'AF75';
process.env.BILLING_AUTOMATED_FORECAST_85 = 'AF85';   // ← el DEPÓSITO
process.env.BILLING_AUTOMATED_FORECAST_95 = 'AF95';   // ← la que se retira
process.env.BILLING_AUTOMATED_READY = 'AUTO_NOTIFICADO';
process.env.DEAL_STAGE_95 = 'en_ejecucion';
process.env.DEAL_STAGE_100 = 'finalizado';

const { resolveForecastStage } = await import('../phases/phasep.js');
const { etapaUnicaAutoEnabled } = await import('../config/etapaUnicaFlags.js');

const OFF = () => { delete process.env.ETAPA_UNICA_AUTO_ENABLED; };
const ON = () => { process.env.ETAPA_UNICA_AUTO_ENABLED = 'true'; };

const auto = (dealStage) => resolveForecastStage({ dealStage, automated: true });
const manual = (dealStage) => resolveForecastStage({ dealStage, automated: false });

// ─────────────────────────────────────────────────────────────
// La llave
// ─────────────────────────────────────────────────────────────
test('llave: sólo true/1/yes prenden; ausente, vacía o basura = OFF', () => {
  OFF();
  assert.equal(etapaUnicaAutoEnabled(), false, 'ausente = OFF');
  for (const v of ['', ' ', 'false', 'no', '0', 'basura']) {
    process.env.ETAPA_UNICA_AUTO_ENABLED = v;
    assert.equal(etapaUnicaAutoEnabled(), false, `"${v}" no debe prender`);
  }
  for (const v of ['true', 'TRUE', ' 1 ', 'yes', 'Yes']) {
    process.env.ETAPA_UNICA_AUTO_ENABLED = v;
    assert.equal(etapaUnicaAutoEnabled(), true, `"${v}" debe prender`);
  }
  OFF();
});

test('llave: es independiente de ETAPA_UNICA_ENABLED (la del manual)', () => {
  OFF();
  const prevManual = process.env.ETAPA_UNICA_ENABLED;
  process.env.ETAPA_UNICA_ENABLED = 'true';
  try {
    assert.equal(etapaUnicaAutoEnabled(), false, 'prender la manual NO prende la automática');
    assert.equal(auto('closedwon'), 'AF85');
    assert.equal(auto('en_ejecucion'), 'AF95', 'con la automática apagada, el 95 sigue yendo a AF95');
  } finally {
    if (prevManual === undefined) delete process.env.ETAPA_UNICA_ENABLED;
    else process.env.ETAPA_UNICA_ENABLED = prevManual;
  }
});

// ─────────────────────────────────────────────────────────────
// OFF: idéntico a hoy
// ─────────────────────────────────────────────────────────────
test('OFF: los buckets automáticos van a sus etapas de siempre', () => {
  OFF();
  assert.equal(auto('appointmentscheduled'), 'AF25');
  assert.equal(auto('decisionmakerboughtin'), 'AF50');
  assert.equal(auto('contractsent'), 'AF75');
  assert.equal(auto('closedwon'), 'AF85');
  assert.equal(auto('en_ejecucion'), 'AF95');
  assert.equal(auto('finalizado'), 'AF95');
});

// ─────────────────────────────────────────────────────────────
// ON: 85 / 95 / 100 caen todos en el depósito
// ─────────────────────────────────────────────────────────────
test('ON: cierre ganado, en ejecución y finalizado van todos a la MISMA etapa depósito', () => {
  ON();
  try {
    assert.equal(auto('closedwon'), 'AF85');
    assert.equal(auto('en_ejecucion'), 'AF85', 'el 95 pasa al depósito');
    assert.equal(auto('finalizado'), 'AF85', 'el 100 pasa al depósito');
    assert.equal(auto('en_ejecucion'), auto('closedwon'));
  } finally { OFF(); }
});

test('ON: la etapa 95 automática queda RETIRADA (ningún bucket la devuelve)', () => {
  ON();
  try {
    const destinos = [
      'appointmentscheduled', 'qualifiedtobuy', 'presentationscheduled',
      'decisionmakerboughtin', 'contractsent', 'closedwon',
      'en_ejecucion', 'finalizado',
    ].map(auto);
    assert.ok(!destinos.includes('AF95'), `AF95 no debe ser destino de nadie: ${destinos.join(',')}`);
  } finally { OFF(); }
});

test('ON: los buckets ANTERIORES al depósito no se tocan', () => {
  ON();
  try {
    assert.equal(auto('appointmentscheduled'), 'AF25');
    assert.equal(auto('qualifiedtobuy'), 'AF25');
    assert.equal(auto('presentationscheduled'), 'AF25');
    assert.equal(auto('decisionmakerboughtin'), 'AF50');
    assert.equal(auto('contractsent'), 'AF75', 'el 75 sigue siendo el escalón previo al depósito');
  } finally { OFF(); }
});

test('ON: el pipeline MANUAL no se ve afectado', () => {
  ON();
  const prevManual = process.env.ETAPA_UNICA_ENABLED;
  delete process.env.ETAPA_UNICA_ENABLED;
  try {
    assert.equal(manual('closedwon'), 'F85');
    assert.equal(manual('en_ejecucion'), 'F95');
    assert.equal(manual('contractsent'), 'F75');
  } finally {
    OFF();
    if (prevManual === undefined) delete process.env.ETAPA_UNICA_ENABLED;
    else process.env.ETAPA_UNICA_ENABLED = prevManual;
  }
});

test('ON: negocio perdido / etapa desconocida sigue devolviendo null', () => {
  ON();
  try {
    assert.equal(auto('closedlost'), null);
    assert.equal(auto('etapa_que_no_existe'), null);
    assert.equal(auto(''), null);
  } finally { OFF(); }
});

// ─────────────────────────────────────────────────────────────
// Guarda: sin la etapa 85 configurada, la llave no rompe nada
// ─────────────────────────────────────────────────────────────
test('ON sin BILLING_AUTOMATED_FORECAST_85 configurada: cae al comportamiento viejo', () => {
  // constants.js resuelve los ids de etapa EN TIEMPO DE IMPORT, así que un
  // re-import no alcanza (el módulo queda cacheado): hay que arrancar un proceso
  // limpio con la env del depósito vacía.
  const script = `
    const { resolveForecastStage } = await import('${
      pathToFileURL(join(import.meta.dirname, '../phases/phasep.js')).href
    }');
    // Marcador: el motor loguea a stdout, así que hay que poder aislar el valor.
    process.stdout.write('<<<' + String(resolveForecastStage({ dealStage: 'en_ejecucion', automated: true })) + '>>>');
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ETAPA_UNICA_AUTO_ENABLED: 'true',
      BILLING_AUTOMATED_FORECAST_85: '',   // depósito NO configurado
      BILLING_AUTOMATED_FORECAST_95: 'AF95',
      DEAL_STAGE_95: 'en_ejecucion',
      DATABASE_URL: 'postgresql://test:test@127.0.0.1:1/dummy',
    },
  });
  assert.equal(r.status, 0, `el proceso hijo falló: ${r.stderr}`);
  const m = /<<<(.*?)>>>/.exec(r.stdout || '');
  assert.ok(m, `no se encontró el marcador en la salida del hijo: ${r.stdout}`);
  assert.equal(
    m[1],
    'AF95',
    'sin depósito configurado el 95 NO se redirige a una etapa vacía'
  );
});
