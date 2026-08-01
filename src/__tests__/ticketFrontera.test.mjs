// src/__tests__/ticketFrontera.test.mjs
//
// TANDA B (definitivos/PLAN_proximos_cambios_tickets_2026-07-29.md §2.0/§2.4):
// LA FRONTERA ES LA NOTIFICACIÓN. Estos son los predicados de los que dependen
// Phase P (qué existe, en qué fecha, qué se cancela), cancelForecastTickets y
// el sync quirúrgico — si alguno se corre de lugar, el motor borra tickets
// migrados o factura una cuota de más.
//
// Criterio de aceptación de la tanda: con ETAPA_UNICA_ENABLED apagada, TODO
// esto se comporta exactamente como hoy.
//
// Sin red: son funciones puras.

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@127.0.0.1:1/dummy';

// constants.js lee process.env a nivel de módulo → se fuerza ANTES de importar.
process.env.BILLING_TICKET_PIPELINE_ID = 'PIPE_MANUAL';
process.env.BILLING_AUTOMATED_PIPELINE_ID = 'PIPE_AUTO';
process.env.BILLING_TICKET_FORECAST = 'F25';
process.env.BILLING_TICKET_FORECAST_50 = 'F50';
process.env.BILLING_TICKET_FORECAST_75 = 'F75';
process.env.BILLING_TICKET_FORECAST_85 = 'F85';       // PROD: «Backlog cierre ganado»
process.env.BILLING_TICKET_FORECAST_95 = 'F95';       // PROD: «Backlog avanzado»
process.env.BILLING_TICKET_STAGE_ID = 'PROXIMOS';
process.env.BILLING_TICKET_STAGE_READY = 'NOTIFICADO';
process.env.BILLING_TICKET_STAGE_ID_BILLED = 'EMITIDO';
process.env.BILLING_TICKET_STAGE_CANCELLED = 'CANCELADO';
process.env.BILLING_AUTOMATED_FORECAST = 'AF25';
process.env.BILLING_AUTOMATED_FORECAST_95 = 'AF95';
process.env.BILLING_AUTOMATED_READY = 'AUTO_NOTIFICADO';
process.env.BILLING_AUTOMATED_CANCELLED = 'AUTO_CANCELADO';

const {
  isTicketEngineManaged,
  isTicketProtegido,
  hasTicketCrossedFrontier,
  isTicketPeriodoCerrado,
  isTicketCanceladoSinFactura,
  esTicketManual,
  fechaDelTicket,
} = await import('../utils/ticketFrontera.js');

const {
  isEngineManagedStage,
  isPastFrontierStage,
  isCancelledTicketStage,
  isForecastStage,
} = await import('../config/constants.js');

function t(stage, extra = {}) {
  return { id: 'T1', properties: { hs_pipeline: 'PIPE_MANUAL', hs_pipeline_stage: stage, ...extra } };
}

// ─────────────────────────────────────────────────────────────────────────────
// FLAG APAGADA — todo idéntico a hoy
// ─────────────────────────────────────────────────────────────────────────────

test('flag OFF: el motor maneja exactamente los forecast (igual que isForecastStage)', () => {
  delete process.env.ETAPA_UNICA_ENABLED;

  for (const s of ['F25', 'F50', 'F75', 'F85', 'F95', 'AF25', 'AF95']) {
    assert.equal(isEngineManagedStage(s), true, `${s} debería estar manejado`);
    assert.equal(isEngineManagedStage(s), isForecastStage(s), `${s}: debe coincidir con isForecastStage`);
  }
  for (const s of ['PROXIMOS', 'NOTIFICADO', 'EMITIDO', 'CANCELADO', 'AUTO_NOTIFICADO']) {
    assert.equal(isEngineManagedStage(s), false, `${s} NO debería estar manejado con la flag apagada`);
  }
});

test('flag OFF: «Próximos a facturar» protege su clave y cruzó la frontera (comportamiento actual)', () => {
  delete process.env.ETAPA_UNICA_ENABLED;

  assert.equal(isTicketEngineManaged(t('PROXIMOS')), false);
  assert.equal(hasTicketCrossedFrontier(t('PROXIMOS')), true);
  assert.equal(isTicketProtegido(t('PROXIMOS')), true);
});

// ─────────────────────────────────────────────────────────────────────────────
// FLAG PRENDIDA — la etapa única entra del lado del motor
// ─────────────────────────────────────────────────────────────────────────────

test('flag ON: «Próximos a facturar» pasa a estar del lado del motor', () => {
  process.env.ETAPA_UNICA_ENABLED = 'true';

  assert.equal(isEngineManagedStage('PROXIMOS'), true);
  assert.equal(isTicketEngineManaged(t('PROXIMOS')), true);
  assert.equal(hasTicketCrossedFrontier(t('PROXIMOS')), false);
  assert.equal(isTicketProtegido(t('PROXIMOS')), false);

  delete process.env.ETAPA_UNICA_ENABLED;
});

test('flag ON: los ids viejos de 85/95 (Backlog en PROD) SIGUEN manejados — hay tickets parados ahí', () => {
  process.env.ETAPA_UNICA_ENABLED = 'true';

  assert.equal(isEngineManagedStage('F85'), true);
  assert.equal(isEngineManagedStage('F95'), true);

  delete process.env.ETAPA_UNICA_ENABLED;
});

test('flag ON: de «Notificado» en adelante es pasado — intocable', () => {
  process.env.ETAPA_UNICA_ENABLED = 'true';

  for (const s of ['NOTIFICADO', 'EMITIDO', 'AUTO_NOTIFICADO']) {
    assert.equal(isEngineManagedStage(s), false, `${s} no lo maneja el motor`);
    assert.equal(isPastFrontierStage(s), true, `${s} ya cruzó la frontera`);
    assert.equal(hasTicketCrossedFrontier(t(s)), true);
    assert.equal(isTicketProtegido(t(s)), true);
  }

  delete process.env.ETAPA_UNICA_ENABLED;
});

test('una etapa sin mapear cae del lado seguro: cruzó la frontera, protege y no la maneja el motor', () => {
  process.env.ETAPA_UNICA_ENABLED = 'true';

  // «Cobrado» manual, que en el sandbox no está en ningún env (1311451812).
  assert.equal(isEngineManagedStage('STAGE_SIN_MAPEAR'), false);
  assert.equal(hasTicketCrossedFrontier(t('STAGE_SIN_MAPEAR')), true);
  assert.equal(isTicketProtegido(t('STAGE_SIN_MAPEAR')), true);

  delete process.env.ETAPA_UNICA_ENABLED;
});

// ─────────────────────────────────────────────────────────────────────────────
// LOS DOS CANCELADOS — la distinción que evita perder plata (§2.4)
// ─────────────────────────────────────────────────────────────────────────────

test('cancelado CON factura = período cerrado: protege su fecha y cuenta como consumido', () => {
  process.env.ETAPA_UNICA_ENABLED = 'true';

  const cerrado = t('CANCELADO', { of_invoice_id: '574967680541' });
  assert.equal(isTicketPeriodoCerrado(cerrado), true);
  assert.equal(isTicketCanceladoSinFactura(cerrado), false);
  assert.equal(hasTicketCrossedFrontier(cerrado), true);
  assert.equal(isTicketProtegido(cerrado), true);
  assert.equal(isTicketEngineManaged(cerrado), false);

  delete process.env.ETAPA_UNICA_ENABLED;
});

test('cancelado SIN factura (lo canceló el motor): ni protege ni consume — esa fecha se puede rearmar', () => {
  process.env.ETAPA_UNICA_ENABLED = 'true';

  const porElMotor = t('CANCELADO', { motivo_cancelacion_del_ticket: 'El cronograma se rearmó' });
  assert.equal(isTicketPeriodoCerrado(porElMotor), false);
  assert.equal(isTicketCanceladoSinFactura(porElMotor), true);
  assert.equal(hasTicketCrossedFrontier(porElMotor), false);
  assert.equal(isTicketProtegido(porElMotor), false);
  assert.equal(isTicketEngineManaged(porElMotor), false);

  delete process.env.ETAPA_UNICA_ENABLED;
});

test('el cancelado del pipeline automático se reconoce igual', () => {
  process.env.ETAPA_UNICA_ENABLED = 'true';

  assert.equal(isCancelledTicketStage('AUTO_CANCELADO'), true);
  const auto = { properties: { hs_pipeline: 'PIPE_AUTO', hs_pipeline_stage: 'AUTO_CANCELADO', of_invoice_id: '99' } };
  assert.equal(isTicketPeriodoCerrado(auto), true);

  delete process.env.ETAPA_UNICA_ENABLED;
});

// ─────────────────────────────────────────────────────────────────────────────
// Auxiliares
// ─────────────────────────────────────────────────────────────────────────────

test('esTicketManual distingue pipelines; sin pipeline es false', () => {
  assert.equal(esTicketManual(t('PROXIMOS')), true);
  assert.equal(esTicketManual({ properties: { hs_pipeline: 'PIPE_AUTO', hs_pipeline_stage: 'AF25' } }), false);
  assert.equal(esTicketManual({ properties: {} }), false);
});

test('fechaDelTicket usa fecha_resolucion_esperada y cae al of_ticket_key', () => {
  assert.equal(fechaDelTicket(t('PROXIMOS', { fecha_resolucion_esperada: '2026-03-15T00:00:00Z' })), '2026-03-15');
  assert.equal(fechaDelTicket(t('PROXIMOS', { of_ticket_key: 'D1::LIK:ABC::2026-04-30' })), '2026-04-30');
  assert.equal(fechaDelTicket(t('PROXIMOS')), '');
});

test('stage vacío nunca es manejado ni cruzó la frontera (ante la duda, no se toca)', () => {
  process.env.ETAPA_UNICA_ENABLED = 'true';

  assert.equal(isTicketEngineManaged(t('')), false);
  assert.equal(hasTicketCrossedFrontier(t('')), false);

  delete process.env.ETAPA_UNICA_ENABLED;
});
