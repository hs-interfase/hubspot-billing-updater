// src/__tests__/mirrorCancelRevertTicket.test.mjs
//
// TANDA D — §3.2 caso 5 + §3.3: ante una REVERSIÓN o CANCELACIÓN del ticket
// original, el aviso llega al TICKET del espejo (no sólo al deal). Es LO
// COMPROMETIDO POR CORREO el 29-jul (hilo "VALOR TOTAL - notas").
//
// PAR OFF/ON: con MIRROR_PUNTUAL_ENABLED apagada, el aviso va al deal espejo
// exactamente como hoy (eso ya lo cubre mirrorCancelRevertNotify.test.mjs;
// acá se re-verifica que la llave apagada no cambió nada).
//
//   DATABASE_URL='postgres://u:p@localhost:5432/x' node --test src/__tests__/mirrorCancelRevertTicket.test.mjs

process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/x';

import test from 'node:test';
import assert from 'node:assert/strict';

const { notifyMirrorDealOnCancelOrRevert } = await import('../services/mirrorUtils.js');

const MIRROR = { mirrorDealId: 'DUY', mirrorLineItemId: 'LIUY', pyDealId: 'DPY' };

function makeDeps({ ticketPyProps = { fecha_resolucion_esperada: '2026-08-31' }, uyLineItemKey = 'LIK-UY' } = {}) {
  const avisosTicket = [];
  const reportsDeal = [];
  const emails = [];

  const client = {
    crm: {
      tickets: { basicApi: { getById: async () => ({ properties: ticketPyProps }) } },
      lineItems: { basicApi: { getById: async () => ({ properties: { line_item_key: uyLineItemKey } }) } },
    },
  };

  return {
    avisosTicket, reportsDeal, emails,
    deps: {
      client,
      findMirrorLineItemFn: async () => MIRROR,
      reportFn: (a) => { reportsDeal.push(a); },
      emailFn: async (a) => { emails.push(a); },
      avisarTicketFn: async (a) => { avisosTicket.push(a); return { avisado: true, via: 'ticket' }; },
    },
  };
}

test('FLAG OFF — el aviso va al DEAL espejo (idéntico a hoy)', async () => {
  delete process.env.MIRROR_PUNTUAL_ENABLED;
  const m = makeDeps();
  await notifyMirrorDealOnCancelOrRevert('LIPY', { tipo: 'cancel', invoiceId: 'F1', ticketId: 'TKPY' }, m.deps);
  assert.equal(m.avisosTicket.length, 0);
  assert.equal(m.reportsDeal.length, 1);
  assert.equal(m.reportsDeal[0].objectType, 'deal');
  assert.equal(m.emails.length, 1);
});

test('FLAG ON — CANCELACIÓN: el aviso va al TICKET del espejo del mismo período', async () => {
  process.env.MIRROR_PUNTUAL_ENABLED = 'true';
  try {
    const m = makeDeps();
    await notifyMirrorDealOnCancelOrRevert('LIPY', { tipo: 'cancel', invoiceId: 'F1', ticketId: 'TKPY' }, m.deps);
    assert.equal(m.avisosTicket.length, 1);
    const a = m.avisosTicket[0];
    assert.equal(a.mirrorDealId, 'DUY');
    assert.equal(a.ymd, '2026-08-31', 'el período sale del ticket PY');
    assert.equal(a.mirrorLineItemKey, 'LIK-UY', 'la clave del ticket espejo sale del LI espejo');
    assert.match(a.mensaje, /cancelada DEFINITIVAMENTE/);
    assert.equal(m.reportsDeal.length, 0, 'no se duplica el aviso en el deal');
  } finally {
    delete process.env.MIRROR_PUNTUAL_ENABLED;
  }
});

test('FLAG ON — REVERSIÓN: mismo camino, con su propio texto', async () => {
  process.env.MIRROR_PUNTUAL_ENABLED = 'true';
  try {
    const m = makeDeps();
    await notifyMirrorDealOnCancelOrRevert('LIPY', { tipo: 'revert', invoiceId: 'F2', ticketId: 'TKPY' }, m.deps);
    assert.equal(m.avisosTicket.length, 1);
    assert.match(m.avisosTicket[0].mensaje, /revertida: el período se va a refacturar/);
    assert.equal(m.avisosTicket[0].meta.tipo, 'reversión para refacturar');
  } finally {
    delete process.env.MIRROR_PUNTUAL_ENABLED;
  }
});

test('FLAG ON — sin fecha en el ticket PY, el período sale de su CLAVE', async () => {
  process.env.MIRROR_PUNTUAL_ENABLED = 'true';
  try {
    const m = makeDeps({ ticketPyProps: { of_ticket_key: 'DPY::LIK:LIK-PY::2026-10-31' } });
    await notifyMirrorDealOnCancelOrRevert('LIPY', { tipo: 'cancel', invoiceId: 'F1', ticketId: 'TKPY' }, m.deps);
    assert.equal(m.avisosTicket[0].ymd, '2026-10-31');
  } finally {
    delete process.env.MIRROR_PUNTUAL_ENABLED;
  }
});

test('FLAG ON — sin ticket PY el aviso igual sale (sin período → cae al deal espejo)', async () => {
  process.env.MIRROR_PUNTUAL_ENABLED = 'true';
  try {
    const m = makeDeps();
    await notifyMirrorDealOnCancelOrRevert('LIPY', { tipo: 'cancel', invoiceId: 'F1' }, m.deps);
    assert.equal(m.avisosTicket.length, 1);
    assert.equal(m.avisosTicket[0].ymd, '');
  } finally {
    delete process.env.MIRROR_PUNTUAL_ENABLED;
  }
});

test('FLAG ON — sin espejo no avisa nada (anti-loop / deal sin mirror)', async () => {
  process.env.MIRROR_PUNTUAL_ENABLED = 'true';
  try {
    const m = makeDeps();
    m.deps.findMirrorLineItemFn = async () => null;
    await notifyMirrorDealOnCancelOrRevert('LIPY', { tipo: 'cancel', invoiceId: 'F1', ticketId: 'TKPY' }, m.deps);
    assert.equal(m.avisosTicket.length, 0);
    assert.equal(m.reportsDeal.length, 0);
  } finally {
    delete process.env.MIRROR_PUNTUAL_ENABLED;
  }
});

test('FLAG ON — tipo desconocido sigue sin notificar nada', async () => {
  process.env.MIRROR_PUNTUAL_ENABLED = 'true';
  try {
    const m = makeDeps();
    await notifyMirrorDealOnCancelOrRevert('LIPY', { tipo: 'otra_cosa', invoiceId: 'F1' }, m.deps);
    assert.equal(m.avisosTicket.length, 0);
    assert.equal(m.reportsDeal.length, 0);
  } finally {
    delete process.env.MIRROR_PUNTUAL_ENABLED;
  }
});
