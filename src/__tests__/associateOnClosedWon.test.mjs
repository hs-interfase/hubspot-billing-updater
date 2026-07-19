// src/__tests__/associateOnClosedWon.test.mjs
//
// Fase 3 — asociación de tickets al negocio al cierre ganado.
// Ejercita associateAllTicketsOnClosedWon con un client FALSO (in-memory), sin
// tocar HubSpot ni la DB: se inyectan client / getDealCompaniesFn / getDealContactsFn.
// También cubre el fix del prerrequisito (createTicketAssociations no traga el
// fallo de la asociación ticket→deal).
//
// Requiere un DATABASE_URL dummy (el grafo de imports carga src/db.js, que
// resuelve la conexión en tiempo de import; el Pool no conecta si no se consulta).
// Para el filtro por pipeline manual, BILLING_TICKET_PIPELINE_ID debe estar seteado.
//
// Correr con:
//   DATABASE_URL='postgres://u:p@localhost:5432/x' BILLING_TICKET_PIPELINE_ID='PIPE_MANUAL' \
//     node --test src/__tests__/associateOnClosedWon.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { associateAllTicketsOnClosedWon } from '../services/tickets/associateOnClosedWon.js';
import { createTicketAssociations } from '../services/tickets/ticketService.js';
import { TICKET_PIPELINE } from '../config/constants.js';

// ─────────────────────────────────────────────────────────────
// Fake client: grafo de asociaciones en memoria.
//   assoc[fromKey][toType] = Set(toIds)   con fromKey = `${fromType}:${fromId}`
// Registra cada create para poder afirmar idempotencia (no re-crear existentes).
// ─────────────────────────────────────────────────────────────
function makeFakeClient({ tickets = [], failCreateFor = () => false } = {}) {
  const assoc = new Map();
  const createCalls = [];
  const key = (t, id) => `${t}:${id}`;

  function set(fromType, fromId, toType) {
    const k = key(fromType, fromId);
    if (!assoc.has(k)) assoc.set(k, new Map());
    const m = assoc.get(k);
    if (!m.has(toType)) m.set(toType, new Set());
    return m.get(toType);
  }

  // Precarga de asociaciones existentes (ticket→deal ya asociado, etc.)
  function seedAssoc(fromType, fromId, toType, toId) {
    set(fromType, fromId, toType).add(String(toId));
  }

  // Tickets ordenados por id numérico → paginación keyset como HubSpot Search.
  const sorted = [...tickets].sort((a, b) => Number(a.id) - Number(b.id));

  const client = {
    crm: {
      tickets: {
        searchApi: {
          async doSearch(body) {
            // Modela keyset: devuelve los tickets con id > lastId (hs_object_id GT).
            const filters = body?.filterGroups?.[0]?.filters || [];
            const gt = filters.find(f => f.propertyName === 'hs_object_id' && f.operator === 'GT');
            const lastId = Number(gt?.value ?? 0);
            const page = sorted.filter(t => Number(t.id) > lastId).slice(0, 100);
            return { results: page };
          },
        },
      },
      associations: {
        v4: {
          basicApi: {
            async getPage(fromType, fromId, toType /*, after, limit */) {
              const s = set(fromType, fromId, toType);
              return { results: [...s].map(toObjectId => ({ toObjectId })) };
            },
            async create(fromType, fromId, toType, toId) {
              createCalls.push({ fromType, fromId, toType, toId: String(toId) });
              if (failCreateFor({ fromType, fromId, toType, toId: String(toId) })) {
                const err = new Error('boom');
                err.response = { status: 500 };
                throw err;
              }
              set(fromType, fromId, toType).add(String(toId));
              return { ok: true };
            },
          },
        },
      },
    },
  };

  return { client, createCalls, seedAssoc };
}

const ticket = (id, pipeline = 'PIPE_AUTO') => ({
  id: String(id),
  properties: { of_deal_id: 'D1', hs_pipeline: pipeline },
});

// ─────────────────────────────────────────────────────────────
// Hook: gate por facturacion_activa
// ─────────────────────────────────────────────────────────────
test('gate: sin facturacion_activa NO hace nada (applies=false, cero llamadas)', async () => {
  const { client, createCalls } = makeFakeClient({ tickets: [ticket(1)] });
  const stats = await associateAllTicketsOnClosedWon({
    dealId: 'D1',
    dealProps: { facturacion_activa: 'false' },
    client,
    getDealCompaniesFn: async () => [],
    getDealContactsFn: async () => [],
  });
  assert.equal(stats.applies, false);
  assert.equal(stats.ticketsFound, 0);
  assert.equal(createCalls.length, 0);
});

// ─────────────────────────────────────────────────────────────
// Hook: happy path — asocia solo los faltantes + companies/contacts solo a los nuevos
// ─────────────────────────────────────────────────────────────
test('happy path: asocia faltantes al deal; ya-asociados no se re-crean', async () => {
  const { client, createCalls, seedAssoc } = makeFakeClient({
    // 3 tickets en una página, luego página vacía (fin de paginación)
    tickets: [ticket(1), ticket(2), ticket(3)],
  });
  // T2 ya está asociado al deal
  seedAssoc('tickets', '2', 'deals', 'D1');

  const stats = await associateAllTicketsOnClosedWon({
    dealId: 'D1',
    dealProps: { facturacion_activa: 'true' },
    onlyManualPipeline: false, // este test valida la mecánica, no el filtro de pipeline
    client,
    getDealCompaniesFn: async () => ['C10'],
    getDealContactsFn: async () => ['P20'],
  });

  assert.equal(stats.applies, true);
  assert.equal(stats.ticketsFound, 3);
  assert.equal(stats.considered, 3);
  assert.equal(stats.dealLinked, 2);      // T1 y T3
  assert.equal(stats.alreadyLinked, 1);   // T2
  assert.equal(stats.companyLinked, 2);   // company solo a los 2 nuevos
  assert.equal(stats.contactLinked, 2);   // contact solo a los 2 nuevos
  assert.equal(stats.errors, 0);

  // T2 (ya asociado) NO recibe create de deal/company/contact
  const t2Creates = createCalls.filter(c => c.fromId === '2');
  assert.equal(t2Creates.length, 0);
  // T1 recibe deal + company + contact
  const t1Creates = createCalls.filter(c => c.fromId === '1').map(c => c.toType).sort();
  assert.deepEqual(t1Creates, ['companies', 'contacts', 'deals']);
});

// ─────────────────────────────────────────────────────────────
// Hook: idempotencia — segunda corrida no crea nada nuevo
// ─────────────────────────────────────────────────────────────
test('idempotencia: segunda corrida no re-asocia (dealLinked=0)', async () => {
  const { client, createCalls } = makeFakeClient({
    tickets: [ticket(1), ticket(2)],
  });
  const args = {
    dealId: 'D1',
    dealProps: { facturacion_activa: 'true' },
    onlyManualPipeline: false, // valida idempotencia, no el filtro de pipeline
    client,
    getDealCompaniesFn: async () => [],
    getDealContactsFn: async () => [],
  };
  const first = await associateAllTicketsOnClosedWon(args);
  assert.equal(first.dealLinked, 2);

  const createsAfterFirst = createCalls.length;
  const second = await associateAllTicketsOnClosedWon(args);
  assert.equal(second.dealLinked, 0);
  assert.equal(second.alreadyLinked, 2);
  assert.equal(createCalls.length, createsAfterFirst); // no hubo nuevos creates
});

// ─────────────────────────────────────────────────────────────
// Hook: filtro por pipeline manual (requiere BILLING_TICKET_PIPELINE_ID seteado)
// ─────────────────────────────────────────────────────────────
test('filtro onlyManual: saltea tickets fuera del pipeline manual', { skip: !TICKET_PIPELINE }, async () => {
  const { client, createCalls } = makeFakeClient({
    tickets: [ticket(1, TICKET_PIPELINE), ticket(2, 'PIPE_AUTO')],
  });
  const stats = await associateAllTicketsOnClosedWon({
    dealId: 'D1',
    dealProps: { facturacion_activa: 'true' },
    onlyManualPipeline: true,
    client,
    getDealCompaniesFn: async () => [],
    getDealContactsFn: async () => [],
  });
  assert.equal(stats.considered, 1);          // solo el manual
  assert.equal(stats.skippedByPipeline, 1);   // el automático
  assert.equal(stats.dealLinked, 1);
  assert.ok(createCalls.every(c => c.fromId === '1'));
});

// ─────────────────────────────────────────────────────────────
// Hook: política resuelta 13-jul — el env ASSOC_CLOSEDWON_ONLY_MANUAL
// gobierna el default (sin pasar onlyManualPipeline explícito).
// ─────────────────────────────────────────────────────────────
test('política env: ASSOC_CLOSEDWON_ONLY_MANUAL=true saltea el pipeline automático (default)', { skip: !TICKET_PIPELINE }, async () => {
  const prev = process.env.ASSOC_CLOSEDWON_ONLY_MANUAL;
  process.env.ASSOC_CLOSEDWON_ONLY_MANUAL = 'true';
  try {
    const { client, createCalls } = makeFakeClient({
      tickets: [ticket(1, TICKET_PIPELINE), ticket(2, 'PIPE_AUTO')],
    });
    const stats = await associateAllTicketsOnClosedWon({
      dealId: 'D1',
      dealProps: { facturacion_activa: 'true' },
      // onlyManualPipeline NO se pasa → default toma el env
      client,
      getDealCompaniesFn: async () => [],
      getDealContactsFn: async () => [],
    });
    assert.equal(stats.considered, 1);          // solo el manual
    assert.equal(stats.skippedByPipeline, 1);   // el automático
    assert.equal(stats.dealLinked, 1);
    assert.ok(createCalls.every(c => c.fromId === '1'));
  } finally {
    if (prev === undefined) delete process.env.ASSOC_CLOSEDWON_ONLY_MANUAL;
    else process.env.ASSOC_CLOSEDWON_ONLY_MANUAL = prev;
  }
});

// ─────────────────────────────────────────────────────────────
// Hook: un error en un ticket no frena al resto
// ─────────────────────────────────────────────────────────────
test('resiliencia: falla la asociación de T1 pero T2 igual se asocia', async () => {
  const { client, createCalls } = makeFakeClient({
    tickets: [ticket(1), ticket(2)],
    failCreateFor: ({ fromId, toType }) => fromId === '1' && toType === 'deals',
  });
  const stats = await associateAllTicketsOnClosedWon({
    dealId: 'D1',
    dealProps: { facturacion_activa: 'true' },
    onlyManualPipeline: false, // valida resiliencia, no el filtro de pipeline
    client,
    getDealCompaniesFn: async () => [],
    getDealContactsFn: async () => [],
  });
  assert.equal(stats.errors, 1);
  assert.equal(stats.dealLinked, 1);   // T2
  assert.ok(createCalls.some(c => c.fromId === '2' && c.toType === 'deals'));
});

// ─────────────────────────────────────────────────────────────
// Fix prerrequisito: createTicketAssociations NO traga el fallo del deal
// ─────────────────────────────────────────────────────────────
test('createTicketAssociations: reporta y devuelve false si falla la asociación al deal', async () => {
  const { client } = makeFakeClient({
    failCreateFor: ({ toType }) => toType === 'deals',
  });
  let reported = null;
  const ok = await createTicketAssociations('T1', 'D1', 'LI1', [], [], {
    hubspotClient: client,
    reportIfActionable: (arg) => { reported = arg; },
    backoffsMs: [0, 0], // sin sleeps reales en el test
  });
  assert.equal(ok, false);
  assert.ok(reported, 'debe reportar accionable');
  assert.equal(reported.objectType, 'ticket');
  assert.equal(reported.objectId, 'T1');
});

test('createTicketAssociations: devuelve true y NO reporta cuando la asociación al deal anda', async () => {
  const { client } = makeFakeClient();
  let reported = null;
  const ok = await createTicketAssociations('T1', 'D1', 'LI1', ['C10'], ['P20'], {
    hubspotClient: client,
    reportIfActionable: (arg) => { reported = arg; },
    backoffsMs: [0],
  });
  assert.equal(ok, true);
  assert.equal(reported, null);
});
