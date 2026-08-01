// src/__tests__/phasepEtapaUnica.test.mjs
//
// TANDA B — EL NÚCLEO (definitivos/PLAN_proximos_cambios_tickets_2026-07-29.md
// §2.3, los cuatro hallazgos rojos). Acá se prueban las cuatro piezas puras que
// deciden qué tickets existen y cuántos:
//
//   1. resolveForecastStage  — bajo la flag, los buckets 85/95/100 manuales
//      nacen en «Próximos a facturar» (etapa única).
//   2. resolveFloorSourceYmd — el PISO pasa a ser la última fecha NOTIFICADA
//      (hallazgo #1: hoy el ticket próximo a facturar queda debajo del piso y
//      el paso 7 lo borra).
//   3. buildDesiredDates     — CONSUMIDO es lo notificado (hallazgo #2: un plan
//      de 12 terminaba en 13).
//   4. resolveRetiroDeTicket / debeOmitirResnapshot / debeConservarEtapa —
//      el motor no borra, no reescribe el contenido y no baja de etapa
//      (hallazgos #3 y #4: migrados y espejo UY).
//
// Criterio de aceptación: con ETAPA_UNICA_ENABLED apagada, TODO se comporta
// exactamente como hoy. Sin red: son funciones puras.

import test from 'node:test';
import assert from 'node:assert/strict';

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
process.env.BILLING_TICKET_STAGE_ID_BILLED = 'EMITIDO';
process.env.BILLING_TICKET_STAGE_CANCELLED = 'CANCELADO';
process.env.BILLING_AUTOMATED_FORECAST = 'AF25';
process.env.BILLING_AUTOMATED_FORECAST_50 = 'AF50';
process.env.BILLING_AUTOMATED_FORECAST_75 = 'AF75';
process.env.BILLING_AUTOMATED_FORECAST_85 = 'AF85';
process.env.BILLING_AUTOMATED_FORECAST_95 = 'AF95';
process.env.BILLING_AUTOMATED_READY = 'AUTO_NOTIFICADO';
process.env.BILLING_AUTOMATED_CANCELLED = 'AUTO_CANCELADO';
process.env.DEAL_STAGE_95 = 'en_ejecucion';
process.env.DEAL_STAGE_100 = 'finalizado';

const {
  resolveForecastStage,
  resolveFloorSourceYmd,
  buildDesiredDates,
  resolveRetiroDeTicket,
  debeOmitirResnapshot,
  debeConservarEtapa,
} = await import('../phases/phasep.js');

const OFF = () => { delete process.env.ETAPA_UNICA_ENABLED; };
const ON = () => { process.env.ETAPA_UNICA_ENABLED = 'true'; };

function ticket(stage, fecha, extra = {}) {
  return {
    id: extra.id || 'T',
    properties: {
      hs_pipeline: extra.pipeline || 'PIPE_MANUAL',
      hs_pipeline_stage: stage,
      fecha_resolucion_esperada: fecha,
      of_ticket_key: extra.key ?? `D1::LIK:L1::${fecha}`,
      ...extra.props,
    },
  };
}

/** Line item plan fijo mensual, 12 cuotas desde 2026-01-31 (fin de mes). */
function liPlanFijo(props = {}) {
  return {
    id: 'LI1',
    properties: {
      line_item_key: 'L1',
      hs_recurring_billing_start_date: '2026-01-15',
      recurringbillingfrequency: 'monthly',
      hs_recurring_billing_number_of_payments: '12',
      ...props,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1) La etapa destino
// ─────────────────────────────────────────────────────────────────────────────

test('flag OFF: los buckets manuales 85/95/100 siguen yendo a sus etapas forecast', () => {
  OFF();
  assert.equal(resolveForecastStage({ dealStage: 'closedwon', automated: false }), 'F85');
  assert.equal(resolveForecastStage({ dealStage: 'en_ejecucion', automated: false }), 'F95');
  assert.equal(resolveForecastStage({ dealStage: 'finalizado', automated: false }), 'F95');
});

test('flag ON: los buckets manuales 85/95/100 nacen en «Próximos a facturar» (etapa única)', () => {
  ON();
  assert.equal(resolveForecastStage({ dealStage: 'closedwon', automated: false }), 'PROXIMOS');
  assert.equal(resolveForecastStage({ dealStage: 'en_ejecucion', automated: false }), 'PROXIMOS');
  assert.equal(resolveForecastStage({ dealStage: 'finalizado', automated: false }), 'PROXIMOS');
  OFF();
});

test('flag ON: los buckets 25/50/75 y TODO el pipeline automático no cambian', () => {
  ON();
  assert.equal(resolveForecastStage({ dealStage: 'qualifiedtobuy', automated: false }), 'F25');
  assert.equal(resolveForecastStage({ dealStage: 'decisionmakerboughtin', automated: false }), 'F50');
  assert.equal(resolveForecastStage({ dealStage: 'contractsent', automated: false }), 'F75');
  assert.equal(resolveForecastStage({ dealStage: 'closedwon', automated: true }), 'AF85');
  assert.equal(resolveForecastStage({ dealStage: 'en_ejecucion', automated: true }), 'AF95');
  OFF();
});

// ─────────────────────────────────────────────────────────────────────────────
// 2) EL PISO — hallazgo rojo #1
// ─────────────────────────────────────────────────────────────────────────────

test('flag OFF: el piso sale de last_ticketed_date, como siempre', () => {
  OFF();
  const p = { last_ticketed_date: '2026-05-31' };
  assert.equal(resolveFloorSourceYmd(p, [ticket('NOTIFICADO', '2026-03-31')]), '2026-05-31');
});

test('flag ON: el piso es la última fecha NOTIFICADA, no la del ticket en «Próximos»', () => {
  ON();
  // last_ticketed_date la calcula recalcFromTickets desde PROMOTED_STAGES, que
  // incluye «Próximos» → hoy diría 2026-06-30 y taparía ese mismo ticket.
  const p = { last_ticketed_date: '2026-06-30' };
  const tickets = [
    ticket('EMITIDO', '2026-04-30'),
    ticket('NOTIFICADO', '2026-05-31'),
    ticket('PROXIMOS', '2026-06-30'),
    ticket('F95', '2026-07-31'),
  ];
  assert.equal(resolveFloorSourceYmd(p, tickets), '2026-05-31');
  OFF();
});

test('flag ON: un período cerrado (cancelado CON factura) también levanta el piso', () => {
  ON();
  const tickets = [
    ticket('NOTIFICADO', '2026-05-31'),
    ticket('CANCELADO', '2026-06-30', { props: { of_invoice_id: '5749' } }),
  ];
  assert.equal(resolveFloorSourceYmd({}, tickets), '2026-06-30');
  OFF();
});

test('flag ON: un cancelado POR EL MOTOR no levanta el piso (esa fecha se puede rearmar)', () => {
  ON();
  const tickets = [
    ticket('NOTIFICADO', '2026-05-31'),
    ticket('CANCELADO', '2026-06-30'),
  ];
  assert.equal(resolveFloorSourceYmd({}, tickets), '2026-05-31');
  OFF();
});

test('flag ON: búsqueda de tickets vacía → red de seguridad, se usa last_ticketed_date', () => {
  ON();
  assert.equal(resolveFloorSourceYmd({ last_ticketed_date: '2026-05-31' }, []), '2026-05-31');
  OFF();
});

test('flag ON: sin nada notificado el piso queda vacío (arranca por el inicio del contrato)', () => {
  ON();
  assert.equal(resolveFloorSourceYmd({ last_ticketed_date: '2026-06-30' }, [ticket('PROXIMOS', '2026-06-30')]), '');
  OFF();
});

test('HALLAZGO #1: con la flag prendida, la fecha del ticket en «Próximos» sigue siendo deseada', () => {
  ON();
  const li = liPlanFijo({ last_ticketed_date: '2026-06-15' });
  const tickets = [
    ticket('NOTIFICADO', '2026-05-15'),
    ticket('PROXIMOS', '2026-06-15'),
  ];
  const { dates } = buildDesiredDates(li, tickets, { overrideToday: '2026-06-01' });
  assert.ok(dates.includes('2026-06-15'), `la fecha del ticket vivo debe estar en el cronograma: ${dates.join(',')}`);
  OFF();
});

test('flag OFF: ese mismo caso deja la fecha FUERA (es el bug que la flag corrige)', () => {
  OFF();
  const li = liPlanFijo({ last_ticketed_date: '2026-06-15' });
  const tickets = [
    ticket('NOTIFICADO', '2026-05-15'),
    ticket('PROXIMOS', '2026-06-15'),
  ];
  const { dates } = buildDesiredDates(li, tickets, { overrideToday: '2026-06-01' });
  assert.equal(dates.includes('2026-06-15'), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3) CONSUMIDOS — hallazgo rojo #2 (el plan de 12 que terminaba en 13)
// ─────────────────────────────────────────────────────────────────────────────

test('HALLAZGO #2: plan fijo de 12 — notificados + pendiente + futuras = 12, no 13', () => {
  ON();
  const li = liPlanFijo({ last_ticketed_date: '2026-04-15' });
  const tickets = [
    ticket('EMITIDO', '2026-01-15'),
    ticket('EMITIDO', '2026-02-15'),
    ticket('NOTIFICADO', '2026-03-15'),
    ticket('PROXIMOS', '2026-04-15'),   // no notificado: NO consume
  ];
  const { dates } = buildDesiredDates(li, tickets, { overrideToday: '2026-04-01' });
  // 3 consumidos ⇒ 9 fechas, la primera es la del ticket vivo (piso = 2026-03-15)
  assert.equal(dates.length, 9);
  assert.equal(dates[0], '2026-04-15');
  assert.equal(3 + dates.length, 12);
  OFF();
});

test('flag ON: un período cerrado por cancelación de factura SÍ consume su cuota', () => {
  ON();
  const li = liPlanFijo();
  const tickets = [
    ticket('EMITIDO', '2026-01-15'),
    ticket('CANCELADO', '2026-02-15', { props: { of_invoice_id: '5749' } }),
  ];
  const { dates } = buildDesiredDates(li, tickets, { overrideToday: '2026-02-20' });
  assert.equal(dates.length, 10); // 12 - 2
  OFF();
});

test('flag ON: un cancelado por el motor NO consume cuota', () => {
  ON();
  const li = liPlanFijo();
  const tickets = [
    ticket('EMITIDO', '2026-01-15'),
    ticket('CANCELADO', '2026-02-15'),
  ];
  const { dates } = buildDesiredDates(li, tickets, { overrideToday: '2026-02-20' });
  assert.equal(dates.length, 11); // 12 - 1
  OFF();
});

test('flag OFF: consumido sigue siendo "todo lo que no es forecast" (comportamiento actual)', () => {
  OFF();
  const li = liPlanFijo();
  const tickets = [
    ticket('EMITIDO', '2026-01-15'),
    ticket('PROXIMOS', '2026-02-15'),   // con la flag apagada esto SÍ consume
    ticket('CANCELADO', '2026-03-15'),  // y esto también
  ];
  const { dates } = buildDesiredDates(li, tickets, { overrideToday: '2026-01-01' });
  assert.equal(dates.length, 9); // 12 - 3
});

// ─────────────────────────────────────────────────────────────────────────────
// 4) EL MOTOR NO BORRA / NO REESCRIBE / NO BAJA DE ETAPA
// ─────────────────────────────────────────────────────────────────────────────

test('flag OFF: el sobrante se archiva, como siempre', () => {
  OFF();
  assert.deepEqual(resolveRetiroDeTicket(ticket('F85', '2026-05-15')), { modo: 'archivar' });
});

test('flag ON: el sobrante se CANCELA en la etapa CANCELADO de su pipeline', () => {
  ON();
  assert.deepEqual(
    resolveRetiroDeTicket(ticket('PROXIMOS', '2026-05-15')),
    { modo: 'cancelar', cancelledStage: 'CANCELADO' }
  );
  assert.deepEqual(
    resolveRetiroDeTicket({ properties: { hs_pipeline: 'PIPE_AUTO', hs_pipeline_stage: 'AF95' } }),
    { modo: 'cancelar', cancelledStage: 'AUTO_CANCELADO' }
  );
  OFF();
});

test('flag ON: pipeline desconocido → NO se toca el ticket (ante la duda, no perderlo)', () => {
  ON();
  assert.deepEqual(
    resolveRetiroDeTicket({ properties: { hs_pipeline: 'PIPE_RARO', hs_pipeline_stage: 'X' } }),
    { modo: 'omitir' }
  );
  OFF();
});

test('flag ON: el re-snapshot se omite en manuales no notificados y se mantiene en el resto', () => {
  ON();
  assert.equal(debeOmitirResnapshot(ticket('PROXIMOS', '2026-05-15')), true);
  assert.equal(debeOmitirResnapshot(ticket('F75', '2026-05-15')), true);
  assert.equal(debeOmitirResnapshot(ticket('NOTIFICADO', '2026-05-15')), false);
  assert.equal(
    debeOmitirResnapshot({ properties: { hs_pipeline: 'PIPE_AUTO', hs_pipeline_stage: 'AF95' } }),
    false,
    'el automático se sigue re-snapshoteando'
  );
  OFF();
});

test('flag OFF: el re-snapshot no se omite nunca (comportamiento actual)', () => {
  OFF();
  assert.equal(debeOmitirResnapshot(ticket('PROXIMOS', '2026-05-15')), false);
  assert.equal(debeOmitirResnapshot(ticket('F75', '2026-05-15')), false);
});

test('HALLAZGOS #3 y #4: la etapa NUNCA retrocede desde «Próximos» (migrados y espejo UY)', () => {
  ON();
  assert.equal(debeConservarEtapa(ticket('PROXIMOS', '2026-05-15')), true);
  assert.equal(debeConservarEtapa(ticket('F75', '2026-05-15')), false);
  OFF();
  assert.equal(debeConservarEtapa(ticket('PROXIMOS', '2026-05-15')), false);
});
