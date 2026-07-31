// src/__tests__/mirrorCancelRevertNotify.test.mjs
//
// Aviso al deal espejo UY cuando la factura de un ticket PY se cancela
// definitivamente o se revierte para refacturar (Bloque 4, cancelar/revertir).
// Todo con fakes inyectados (findMirrorLineItemFn / reportFn / emailFn):
// no toca HubSpot ni DB ni Resend.
//
// Requiere DATABASE_URL dummy (el grafo de imports carga src/db.js).
//   DATABASE_URL='postgres://u:p@localhost:5432/x' node --test src/__tests__/mirrorCancelRevertNotify.test.mjs

process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/x';

import test from 'node:test';
import assert from 'node:assert/strict';

const { notifyMirrorDealOnCancelOrRevert } = await import('../services/mirrorUtils.js');

const MIRROR = { mirrorDealId: 'DUY', mirrorLineItemId: 'LIUY', pyDealId: 'DPY' };

function makeDeps({ mirrorInfo = MIRROR, findThrows = false, emailThrows = false } = {}) {
  const reports = [];
  const emails = [];
  return {
    reports,
    emails,
    deps: {
      findMirrorLineItemFn: async () => {
        if (findThrows) throw new Error('boom-lookup');
        return mirrorInfo;
      },
      reportFn: (args) => { reports.push(args); },
      emailFn: async (args) => {
        if (emailThrows) throw new Error('boom-email');
        emails.push(args);
      },
    },
  };
}

test('sin espejo → return silencioso, sin report ni email', async () => {
  const { reports, emails, deps } = makeDeps({ mirrorInfo: null });
  await notifyMirrorDealOnCancelOrRevert('LIPY', { tipo: 'revert', invoiceId: 'F1', ticketId: 'T1' }, deps);
  assert.equal(reports.length, 0);
  assert.equal(emails.length, 0);
});

test("tipo 'cancel' → billing_error al deal UY + email con texto de cancelación definitiva", async () => {
  const { reports, emails, deps } = makeDeps();
  await notifyMirrorDealOnCancelOrRevert('LIPY', { tipo: 'cancel', invoiceId: 'F1', ticketId: 'T1' }, deps);

  assert.equal(reports.length, 1);
  assert.equal(reports[0].objectType, 'deal');
  assert.equal(reports[0].objectId, 'DUY');
  assert.match(reports[0].message, /Factura F1 del negocio original PY cancelada DEFINITIVAMENTE \(período cerrado, no se refactura\)/);
  assert.match(reports[0].message, /La promoción del ticket UY NO se deshace — verificar el ticket UY manualmente/);
  assert.match(reports[0].message, /Deal PY: DPY \| LI PY: LIPY → LI UY: LIUY \| Ticket PY: T1/);

  assert.equal(emails.length, 1);
  assert.equal(emails[0].mirrorDealId, 'DUY');
  assert.equal(emails[0].title, 'Factura PY cancelada definitivamente — verificar ticket UY');
  // el email lleva EXACTAMENTE el mismo texto que el billing_error
  assert.equal(emails[0].message, reports[0].message);
  assert.equal(emails[0].meta.invoice_py, 'F1');
  assert.equal(emails[0].meta.ticket_py, 'T1');
  assert.equal(emails[0].meta.tipo, 'cancelación definitiva');
});

test("tipo 'revert' → billing_error + email con texto de reversión (se refactura)", async () => {
  const { reports, emails, deps } = makeDeps();
  await notifyMirrorDealOnCancelOrRevert('LIPY', { tipo: 'revert', invoiceId: 'F2' }, deps);

  assert.equal(reports.length, 1);
  assert.match(reports[0].message, /Factura F2 del negocio original PY revertida: el período se va a refacturar/);
  assert.match(reports[0].message, /Verificar el ticket UY manualmente/);
  assert.doesNotMatch(reports[0].message, /Ticket PY:/); // sin ticketId no se cita

  assert.equal(emails.length, 1);
  assert.equal(emails[0].title, 'Factura PY revertida (se refactura) — verificar ticket UY');
  assert.equal(emails[0].message, reports[0].message);
  assert.equal(emails[0].meta.tipo, 'reversión para refacturar');
  assert.equal('ticket_py' in emails[0].meta, false);
});

test('tipo desconocido → no notifica nada', async () => {
  const { reports, emails, deps } = makeDeps();
  await notifyMirrorDealOnCancelOrRevert('LIPY', { tipo: 'banana', invoiceId: 'F1' }, deps);
  assert.equal(reports.length, 0);
  assert.equal(emails.length, 0);
});

test('lookup del espejo que lanza → NO lanza, sin efectos', async () => {
  const { reports, emails, deps } = makeDeps({ findThrows: true });
  await notifyMirrorDealOnCancelOrRevert('LIPY', { tipo: 'revert', invoiceId: 'F1' }, deps);
  assert.equal(reports.length, 0);
  assert.equal(emails.length, 0);
});

test('email que lanza → NO lanza (el billing_error ya quedó escrito)', async () => {
  const { reports, emails, deps } = makeDeps({ emailThrows: true });
  await notifyMirrorDealOnCancelOrRevert('LIPY', { tipo: 'cancel', invoiceId: 'F1' }, deps);
  assert.equal(reports.length, 1);
  assert.equal(emails.length, 0);
});
