// src/__tests__/contadoresPorDato.test.mjs
//
// Contar por DATO en vez de por ETAPA — funciones puras de recalcContadores.
//
//   contarBases()      las dos bases sobre el MISMO conjunto de tickets
//   medirDivergencia() dónde no coinciden, y si el sello se adelantaría
//
// Nada de esto se ESCRIBE todavía (ver el docstring de contarBases): la base
// nueva sella `fechas_completas` antes, y sellar saca la línea de phase2/3, que
// son las que emiten. Primero se mide, después se decide.
//
// Correr con:  node --test src/__tests__/contadoresPorDato.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contarBases, medirDivergencia } from '../services/billing/recalcContadores.js';
import { INVOICED_STAGES, TICKET_STAGES } from '../config/constants.js';

// Las etapas reales salen de env y varían por portal. Para que el test sea
// determinístico se toma una etapa facturada real del set configurado; si el
// entorno no tiene ninguna, se usa un id cualquiera y los asserts que dependen
// de INVOICED_STAGES se ajustan solos (invoiced === 0).
const [UNA_FACTURADA] = [...INVOICED_STAGES];
const FACTURADA = UNA_FACTURADA || 'stage-facturada-inexistente';
const HAY_FACTURADAS = Boolean(UNA_FACTURADA);

// Una etapa que el motor NO maneja y que no es cancelado ⇒ cruzó la frontera.
const PASADO = 'stage-pasado-cualquiera';

function tk(props = {}) {
  return { properties: { of_ticket_key: 'LIK::2026-01-01', ...props } };
}

// ── contarBases ─────────────────────────────────────────────────────────────

test('un ticket pasado con ID de Nodum cuenta como consumido Y como emitido', () => {
  const r = contarBases([tk({ hs_pipeline_stage: PASADO, of_invoice_id: 'F-100' })]);
  assert.equal(r.consumidas, 1);
  assert.equal(r.emitidas, 1);
  assert.equal(r.notificadasPendientes, 0);
});

test('notificado SIN factura: consumido pero no emitido', () => {
  const r = contarBases([tk({ hs_pipeline_stage: PASADO })]);
  assert.equal(r.consumidas, 1);
  assert.equal(r.emitidas, 0);
  assert.equal(r.notificadasPendientes, 1);
});

test('emitidas es SIEMPRE un subconjunto de consumidas', () => {
  // Un ID de Nodum en un ticket que NO cruzó la frontera no infla emitidas:
  // si no cuenta como consumido, tampoco como emitido. Eso es lo que garantiza
  // que la ecuación total = emitidas + pendientes + restantes no se rompa.
  const r = contarBases([
    tk({ hs_pipeline_stage: PASADO, of_invoice_id: 'F-1' }),
    tk({ hs_pipeline_stage: '', of_invoice_id: 'F-2' }), // sin etapa ⇒ no cruzó
  ]);
  assert.ok(r.emitidas <= r.consumidas, `emitidas ${r.emitidas} > consumidas ${r.consumidas}`);
  assert.equal(r.emitidas, 1);
});

test('un ticket sin of_ticket_key no es una cuota del cronograma', () => {
  const r = contarBases([{ properties: { hs_pipeline_stage: PASADO, of_invoice_id: 'F-9' } }]);
  assert.equal(r.consumidas, 0);
  assert.equal(r.emitidas, 0);
});

test('cancelado SIN factura: ni consume ni emite (esa fecha se puede rearmar)', () => {
  const cancelada = TICKET_STAGES.CANCELLED;
  if (!cancelada) return; // portal sin la etapa mapeada
  const r = contarBases([tk({ hs_pipeline_stage: cancelada })]);
  assert.equal(r.consumidas, 0);
  assert.equal(r.emitidas, 0);
});

test('cancelado CON factura = período cerrado: consume y cuenta como emitida', () => {
  const cancelada = TICKET_STAGES.CANCELLED;
  if (!cancelada) return;
  const r = contarBases([tk({ hs_pipeline_stage: cancelada, of_invoice_id: 'F-ANULADA' })]);
  assert.equal(r.consumidas, 1);
  assert.equal(r.emitidas, 1);
  assert.equal(r.notificadasPendientes, 0);
});

test('la base vieja por etapa se sigue calculando igual', () => {
  const r = contarBases([tk({ hs_pipeline_stage: FACTURADA, of_invoice_id: 'F-1' })]);
  assert.equal(r.invoiced, HAY_FACTURADAS ? 1 : 0);
  assert.equal(r.total, 1);
});

test('lista vacía → todo en cero, sin romper', () => {
  const r = contarBases([]);
  assert.deepEqual(
    { c: r.consumidas, e: r.emitidas, p: r.notificadasPendientes, t: r.total },
    { c: 0, e: 0, p: 0, t: 0 }
  );
});

// ── medirDivergencia ────────────────────────────────────────────────────────

const COUNTS = (consumidas, emitidas) => ({
  invoiced: emitidas,
  consumidas,
  emitidas,
  notificadasPendientes: consumidas - emitidas,
});

test('sin divergencia → null (no se loguea nada)', () => {
  const want = { mode: 'PLAN_FIJO', total: 12, restantes: '9' };
  assert.equal(medirDivergencia(want, COUNTS(3, 3)), null);
});

test('con divergencia → devuelve las dos lecturas', () => {
  // 12 cuotas: 3 facturadas y 2 más notificadas sin facturar.
  const want = { mode: 'PLAN_FIJO', total: 12, restantes: '9' }; // por etapa
  const m = medirDivergencia(want, COUNTS(5, 3));
  assert.equal(m.restantesPorEtapa, 9);
  assert.equal(m.restantesPorDato, 7);
  assert.equal(m.emitidas, 3);
  assert.equal(m.notificadasPendientes, 2);
  assert.equal(m.sellariaAntes, false);
});

test('sellariaAntes marca el caso peligroso: la base nueva da 0 y la vieja no', () => {
  // La última cuota está notificada pero todavía sin facturar. Con la base
  // nueva la línea se sellaría y saldría de phase2/3 — que son las que emiten.
  const want = { mode: 'PLAN_FIJO', total: 6, restantes: '1' };
  const m = medirDivergencia(want, COUNTS(6, 5));
  assert.equal(m.restantesPorDato, 0);
  assert.equal(m.restantesPorEtapa, 1);
  assert.equal(m.sellariaAntes, true);
});

test('auto-renew y sin-total no se comparan (no hay plan contra el cual restar)', () => {
  assert.equal(medirDivergencia({ mode: 'AUTO_RENEW', restantes: '' }, COUNTS(3, 1)), null);
  assert.equal(medirDivergencia({ mode: 'SIN_TOTAL', restantes: '' }, COUNTS(3, 1)), null);
});

test('sin los conteos nuevos no se compara (compatibilidad con mocks viejos)', () => {
  const want = { mode: 'PLAN_FIJO', total: 12, restantes: '9' };
  assert.equal(medirDivergencia(want, { invoiced: 3 }), null);
});

test('restantesPorDato nunca es negativo', () => {
  const want = { mode: 'PLAN_FIJO', total: 3, restantes: '1' };
  const m = medirDivergencia(want, COUNTS(5, 5)); // más consumidas que el total
  assert.equal(m.restantesPorDato, 0);
});
