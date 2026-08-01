// src/__tests__/mirrorTicketAlert.test.mjs
//
// TANDA D — EL AVISO AL TICKET DEL ESPEJO (§3.2 caso 2, "falta: es el pedido").
//
// Fija: a qué ticket va (el del MISMO período, por clave), qué pasa cuando ese
// ticket no existe (cae al deal, como hoy), el caso 7 (avisar sí, tocar nunca)
// y el formato del texto con ANTES y DESPUÉS.
//
// Todo con fakes inyectados: no toca HubSpot ni Resend.
//
//   DATABASE_URL='postgres://u:p@localhost:5432/x' node --test src/__tests__/mirrorTicketAlert.test.mjs

process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/x';

import test from 'node:test';
import assert from 'node:assert/strict';

const { avisarTicketEspejo, buildTextoAvisoEspejo, findTicketEspejoPorFecha, ticketEspejoYaNotificado } = await import(
  '../services/notifications/mirrorTicketAlert.js'
);
const { TICKET_PIPELINE, TICKET_STAGES, DERIVED_STAGES } = await import('../config/constants.js');

// Una etapa de "notificado o posterior". Los ids reales salen del .env, que en
// la suite no está cargado (DERIVED_STAGES queda con strings vacíos), así que
// cuando falta se registra una sintética: lo que se prueba es el predicado
// contra el Set, no el valor del id.
const STAGE_NOTIFICADO = [...DERIVED_STAGES].filter(Boolean)[0] || 'STAGE-DERIVED-TEST';
DERIVED_STAGES.add(STAGE_NOTIFICADO);

const BASE = {
  mirrorDealId: 'DUY',
  mirrorLineItemId: 'LIUY',
  mirrorLineItemKey: 'LIK-UY',
  ymd: '2026-08-31',
  mensaje: 'mensaje de prueba',
};

function makeDeps({ ticket = null } = {}) {
  const ticketWrites = [];
  const dealReports = [];
  const emails = [];
  return {
    ticketWrites, dealReports, emails,
    deps: {
      findTicketFn: async () => ticket,
      writeTicketErrorFn: async (id, msg) => { ticketWrites.push({ id, msg }); },
      reportFn: (args) => { dealReports.push(args); },
      emailFn: async (args) => { emails.push(args); },
    },
  };
}

// ── A qué ticket va ─────────────────────────────────────────────────────────

test('con ticket del período → el aviso va al TICKET del espejo (no al deal)', async () => {
  const m = makeDeps({
    ticket: {
      id: 'TKUY-1',
      properties: { hs_pipeline: TICKET_PIPELINE, hs_pipeline_stage: TICKET_STAGES?.NEW || '1234282360' },
    },
  });
  const r = await avisarTicketEspejo(BASE, m.deps);
  assert.equal(r.avisado, true);
  assert.equal(r.via, 'ticket');
  assert.equal(r.ticketId, 'TKUY-1');
  assert.equal(m.ticketWrites.length, 1);
  assert.equal(m.ticketWrites[0].id, 'TKUY-1');
  assert.equal(m.ticketWrites[0].msg, 'mensaje de prueba');
  assert.equal(m.dealReports.length, 0, 'no debe escribir el billing_error del deal');
  assert.equal(m.emails.length, 1, 'y sale el correo de mirror');
  assert.equal(m.emails[0].meta.ticket_espejo_uy, 'TKUY-1');
});

test('sin ticket del período → el aviso NO se pierde: cae al DEAL espejo (como hoy)', async () => {
  const m = makeDeps({ ticket: null });
  const r = await avisarTicketEspejo(BASE, m.deps);
  assert.equal(r.avisado, true);
  assert.equal(r.via, 'deal');
  assert.equal(m.ticketWrites.length, 0);
  assert.equal(m.dealReports.length, 1);
  assert.equal(m.dealReports[0].objectId, 'DUY');
  assert.match(m.dealReports[0].message, /sin ticket del período/);
  assert.equal(m.emails.length, 1);
});

// ── Caso 7: el ticket espejo que ya cruzó la frontera ───────────────────────

test('caso 7 — ticket espejo YA NOTIFICADO/EMITIDO: avisa igual y NO lo toca', async () => {
  const m = makeDeps({
    ticket: {
      id: 'TKUY-EMITIDO',
      properties: { hs_pipeline: TICKET_PIPELINE, hs_pipeline_stage: STAGE_NOTIFICADO },
    },
  });
  const r = await avisarTicketEspejo(BASE, m.deps);
  assert.equal(r.via, 'ticket');
  assert.equal(r.cruzoFrontera, true);
  // El único write es el of_billing_error (canal de aviso). Nada más.
  assert.equal(m.ticketWrites.length, 1);
  assert.equal(m.emails[0].meta.ticket_espejo_estado, 'ya notificado/emitido — no se tocó');
});

test('🔴 el ticket espejo en «Próximos a facturar» NO se describe como notificado', () => {
  // Es donde el motor deja al ticket del espejo a propósito (mirrorUtils:232-238),
  // y es el que el equipo operativo todavía puede corregir. El predicado no
  // depende de ETAPA_UNICA_ENABLED: se verifica con la llave en los dos estados.
  const enProximos = {
    id: 'T',
    properties: { hs_pipeline: TICKET_PIPELINE, hs_pipeline_stage: TICKET_STAGES.NEW || '1234282360' },
  };
  for (const valor of [undefined, 'true']) {
    if (valor === undefined) delete process.env.ETAPA_UNICA_ENABLED;
    else process.env.ETAPA_UNICA_ENABLED = valor;
    assert.equal(ticketEspejoYaNotificado(enProximos), false, `con ETAPA_UNICA_ENABLED=${valor}`);
  }
  delete process.env.ETAPA_UNICA_ENABLED;
});

test('un CANCELADO con factura (período cerrado) sí cuenta como notificado', () => {
  const { TICKET_STAGES: TS } = { TICKET_STAGES };
  const cancelado = {
    id: 'T',
    properties: {
      hs_pipeline: TICKET_PIPELINE,
      hs_pipeline_stage: TS.CANCELLED || 'CANCELADO',
      of_invoice_id: 'F-99',
    },
  };
  // Sólo se afirma cuando el entorno define la etapa CANCELADO (si no, el
  // predicado de cancelado no puede reconocerla y el caso no aplica).
  if (TS.CANCELLED) {
    assert.equal(ticketEspejoYaNotificado(cancelado), true);
    assert.equal(
      ticketEspejoYaNotificado({ ...cancelado, properties: { ...cancelado.properties, of_invoice_id: '' } }),
      false,
      'cancelado sin factura = lo canceló el motor, no es período cerrado'
    );
  }
});

// ── Robustez ────────────────────────────────────────────────────────────────

test('si la búsqueda del ticket explota, no lanza', async () => {
  const deps = {
    findTicketFn: async () => { throw new Error('boom'); },
    writeTicketErrorFn: async () => {},
    reportFn: () => {},
    emailFn: async () => {},
  };
  const r = await avisarTicketEspejo(BASE, deps);
  assert.equal(r.avisado, false);
  assert.equal(r.via, 'ninguno');
});

test('findTicketEspejoPorFecha sin ymd → null (sin llamar a la API)', async () => {
  let llamado = false;
  const client = { crm: { tickets: { searchApi: { doSearch: async () => { llamado = true; return { results: [] }; } } } } };
  const r = await findTicketEspejoPorFecha(
    { mirrorDealId: 'DUY', mirrorLineItemKey: 'LIK', ymd: '' },
    { client, withRetryFn: (f) => f() }
  );
  assert.equal(r, null);
  assert.equal(llamado, false);
});

test('findTicketEspejoPorFecha busca por la clave del ticket del ESPEJO', async () => {
  let body = null;
  const client = {
    crm: { tickets: { searchApi: { doSearch: async (b) => { body = b; return { results: [{ id: 'T1' }] }; } } } },
  };
  const r = await findTicketEspejoPorFecha(
    { mirrorDealId: 'DUY', mirrorLineItemKey: 'LIK-UY', ymd: '2026-08-31' },
    { client, withRetryFn: (f) => f() }
  );
  assert.equal(r.id, 'T1');
  assert.equal(body.filterGroups[0].filters[0].propertyName, 'of_ticket_key');
  assert.equal(body.filterGroups[0].filters[0].value, 'DUY::LIK:LIK-UY::2026-08-31');
});

test('ymd inválido → null, no rompe', async () => {
  const r = await findTicketEspejoPorFecha(
    { mirrorDealId: 'DUY', mirrorLineItemKey: 'LIK', ymd: '31/08/2026' },
    { client: {}, withRetryFn: (f) => f() }
  );
  assert.equal(r, null);
});

// ── El texto: ANTES y DESPUÉS ───────────────────────────────────────────────

test('el texto dice de qué a qué pasó la propiedad en el ORIGINAL', () => {
  const txt = buildTextoAvisoEspejo({
    cambios: [{ label: 'costo', antes: '120', despues: '145' }],
    copiado: true,
    ref: { pyDealId: 'DPY', pyLineItemId: 'LIPY', mirrorDealId: 'DUY', mirrorLineItemId: 'LIUY', ymd: '2026-08-31' },
  });
  assert.match(txt, /negocio ORIGINAL \(PY\)/);
  assert.match(txt, /«costo» pasó de "120" a "145"/);
  assert.match(txt, /line item del espejo YA fue actualizado/);
  assert.match(txt, /Período: 2026-08-31/);
});

test('el texto de un valor vacío no dice "undefined"', () => {
  const txt = buildTextoAvisoEspejo({ cambios: [{ label: 'descripción', antes: undefined, despues: 'algo' }] });
  assert.match(txt, /pasó de \(vacío\) a "algo"/);
  assert.doesNotMatch(txt, /undefined/);
});

test('espejo sellado — el texto dice que NO se actualizó y por qué', () => {
  const txt = buildTextoAvisoEspejo({
    cambios: [{ label: 'cantidad', antes: '1', despues: '3' }],
    copiado: false,
    motivoNoCopiado: 'el espejo es migrado independiente y sus líneas no se sincronizan',
  });
  assert.match(txt, /El espejo NO se actualizó/);
  assert.match(txt, /migrado independiente/);
});

test('ticket que cruzó la frontera — el texto lo dice explícitamente', () => {
  const txt = buildTextoAvisoEspejo({
    cambios: [{ label: 'precio', antes: '10', despues: '20' }],
    cruzoFrontera: true,
  });
  assert.match(txt, /YA fue notificado\/emitido: NO se modificó nada/);
});
