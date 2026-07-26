// src/__tests__/webhookRouteRules.test.mjs
//
// Reglas de ruteo ticket.propertyChange → valor_recalc (RUTA 5b, semana tickets fase 1).
//
// Lo que se protege acá:
//   1. esEventoTicketValor: SOLO las 4 props de montos del ticket (monto_unitario_real,
//      cantidad_real, of_costo_usd, dolar) y SOLO con objectType 'ticket'.
//   2. esTicketEditableParaValor (guard anti-tormenta): el motor escribe esas props en
//      los tickets FORECAST durante el re-snapshot de phasep → solo es editable un
//      ticket del pipeline MANUAL en etapa NO forecast. undefined/null → false.
//   3. Normalización String: HubSpot puede devolver pipeline/stage como number.
//
// ⚠️ constants.js lee process.env AL IMPORTAR → setear las envs ANTES del import dinámico.

import test from 'node:test';
import assert from 'node:assert/strict';

const PIPELINE_MANUAL = '101';
const PIPELINE_AUTO = '202';
const STAGE_FORECAST = '11';
const STAGE_FORECAST_50 = '12';
const STAGE_FORECAST_75 = '13';
const STAGE_FORECAST_85 = '14';
const STAGE_FORECAST_95 = '15';
const STAGE_PROXIMOS = '21'; // "Próximos a Facturar" (NEW)
const STAGE_LISTO = '22';    // "Listo para Facturar" (READY)

process.env.BILLING_TICKET_PIPELINE_ID = PIPELINE_MANUAL;
process.env.BILLING_AUTOMATED_PIPELINE_ID = PIPELINE_AUTO;
process.env.BILLING_TICKET_FORECAST = STAGE_FORECAST;
process.env.BILLING_TICKET_FORECAST_50 = STAGE_FORECAST_50;
process.env.BILLING_TICKET_FORECAST_75 = STAGE_FORECAST_75;
process.env.BILLING_TICKET_FORECAST_85 = STAGE_FORECAST_85;
process.env.BILLING_TICKET_FORECAST_95 = STAGE_FORECAST_95;
process.env.BILLING_TICKET_STAGE_ID = STAGE_PROXIMOS;
process.env.BILLING_TICKET_STAGE_READY = STAGE_LISTO;

const { TICKET_VALOR_RECALC_PROPS, esEventoTicketValor, esTicketEditableParaValor } =
  await import('../utils/webhookRouteRules.js');

// ───────────────────────────── esEventoTicketValor ─────────────────────────────

test('las 4 props de montos con objectType ticket → true', () => {
  for (const prop of ['monto_unitario_real', 'cantidad_real', 'of_costo_usd', 'dolar']) {
    assert.equal(esEventoTicketValor('ticket', prop), true, prop);
    assert.equal(TICKET_VALOR_RECALC_PROPS.has(prop), true, prop);
  }
});

test('prop del set con objectType line_item → false', () => {
  assert.equal(esEventoTicketValor('line_item', 'monto_unitario_real'), false);
  assert.equal(esEventoTicketValor('line_item', 'dolar'), false);
});

test('prop fuera del set → false', () => {
  assert.equal(esEventoTicketValor('ticket', 'subtotal_real'), false); // la escribe el motor
  assert.equal(esEventoTicketValor('ticket', 'subject'), false);
  assert.equal(esEventoTicketValor('ticket', undefined), false);
});

// ─────────────────────────── esTicketEditableParaValor ───────────────────────────

test('pipeline manual + etapa Próximos/Listo (no forecast) → true', () => {
  assert.equal(esTicketEditableParaValor({ pipeline: PIPELINE_MANUAL, stage: STAGE_PROXIMOS }), true);
  assert.equal(esTicketEditableParaValor({ pipeline: PIPELINE_MANUAL, stage: STAGE_LISTO }), true);
});

test('pipeline manual + cada etapa forecast → false (guard anti-tormenta)', () => {
  for (const stage of [STAGE_FORECAST, STAGE_FORECAST_50, STAGE_FORECAST_75, STAGE_FORECAST_85, STAGE_FORECAST_95]) {
    assert.equal(esTicketEditableParaValor({ pipeline: PIPELINE_MANUAL, stage }), false, `stage ${stage}`);
  }
});

test('pipeline automático → false, en cualquier etapa', () => {
  assert.equal(esTicketEditableParaValor({ pipeline: PIPELINE_AUTO, stage: STAGE_PROXIMOS }), false);
  assert.equal(esTicketEditableParaValor({ pipeline: PIPELINE_AUTO, stage: '999' }), false);
});

test('pipeline/stage undefined o null → false', () => {
  assert.equal(esTicketEditableParaValor({}), false);
  assert.equal(esTicketEditableParaValor({ pipeline: PIPELINE_MANUAL }), false);
  assert.equal(esTicketEditableParaValor({ stage: STAGE_PROXIMOS }), false);
  assert.equal(esTicketEditableParaValor({ pipeline: null, stage: null }), false);
  assert.equal(esTicketEditableParaValor({ pipeline: PIPELINE_MANUAL, stage: null }), false);
  assert.equal(esTicketEditableParaValor(), false);
});

test('numbers vs strings: se normaliza con String', () => {
  // HubSpot puede devolver ids numéricos; las constantes vienen de env (string)
  assert.equal(esTicketEditableParaValor({ pipeline: 101, stage: 21 }), true);
  assert.equal(esTicketEditableParaValor({ pipeline: 101, stage: 11 }), false); // forecast como number
  assert.equal(esTicketEditableParaValor({ pipeline: 202, stage: 21 }), false); // auto como number
});
