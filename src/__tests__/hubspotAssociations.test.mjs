// src/__tests__/hubspotAssociations.test.mjs
//
// Fase 3 — hardening de escala: al asociar TODO el cronograma forecast de un
// ganado, un deal puede superar los 100 tickets. Estos tests fijan el contrato
// del helper que pagina las asociaciones (getAllAssociatedIds) y trocea el batch
// read a <=100 (readTicketsInChunks), evitando el HTTP 400 de HubSpot.
//
// No tocan HubSpot ni la DB (client falso en memoria). Correr con:
//   node --test src/__tests__/hubspotAssociations.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getAllAssociatedIds, readTicketsInChunks } from '../utils/hubspotAssociations.js';

// ─────────────────────────────────────────────────────────────
// readTicketsInChunks
// ─────────────────────────────────────────────────────────────
test('readTicketsInChunks: trocea >100 ids en batches <=100 y concatena', async () => {
  const ids = Array.from({ length: 250 }, (_, i) => String(i + 1));
  const batchSizes = [];

  const client = {
    crm: {
      tickets: {
        batchApi: {
          read: async ({ inputs, properties }) => {
            batchSizes.push(inputs.length);
            assert.deepEqual(properties, ['of_ticket_key']);
            return { results: inputs.map(({ id }) => ({ id, properties: { of_ticket_key: `k${id}` } })) };
          },
        },
      },
    },
  };

  const out = await readTicketsInChunks(client, ids, ['of_ticket_key']);

  assert.deepEqual(batchSizes, [100, 100, 50], 'debe partir en chunks de 100');
  assert.equal(out.length, 250, 'concatena resultados de todos los chunks');
  assert.equal(out[0].id, '1');
  assert.equal(out[249].id, '250');
});

test('readTicketsInChunks: lista vacía no llama a la API', async () => {
  let called = false;
  const client = { crm: { tickets: { batchApi: { read: async () => { called = true; return { results: [] }; } } } } };

  const out = await readTicketsInChunks(client, [], ['x']);

  assert.deepEqual(out, []);
  assert.equal(called, false);
});

test('readTicketsInChunks: aplica el wrap opcional una vez por chunk', async () => {
  const ids = Array.from({ length: 120 }, (_, i) => String(i));
  let wraps = 0;
  const wrap = (fn) => { wraps++; return fn(); };
  const client = { crm: { tickets: { batchApi: { read: async ({ inputs }) => ({ results: inputs.map(({ id }) => ({ id })) }) } } } };

  await readTicketsInChunks(client, ids, ['x'], { wrap });

  assert.equal(wraps, 2, '120 ids => 2 chunks => 2 invocaciones del wrap');
});

// ─────────────────────────────────────────────────────────────
// getAllAssociatedIds
// ─────────────────────────────────────────────────────────────
test('getAllAssociatedIds: pagina con paging.next.after hasta agotar', async () => {
  // 230 asociaciones repartidas en páginas de 100
  const all = Array.from({ length: 230 }, (_, i) => ({ toObjectId: i + 1 }));
  const afters = [];

  const client = {
    crm: {
      associations: {
        v4: {
          basicApi: {
            getPage: async (fromType, fromId, toType, pageSize, after) => {
              assert.equal(fromType, 'deals');
              assert.equal(toType, 'tickets');
              afters.push(after);
              const start = after ? Number(after) : 0;
              const slice = all.slice(start, start + pageSize);
              const nextAfter = start + pageSize;
              return {
                results: slice,
                paging: nextAfter < all.length ? { next: { after: String(nextAfter) } } : undefined,
              };
            },
          },
        },
      },
    },
  };

  const ids = await getAllAssociatedIds(client, 'deals', '999', 'tickets');

  assert.equal(ids.length, 230);
  assert.equal(ids[0], '1');
  assert.equal(ids[229], '230');
  assert.deepEqual(afters, [undefined, '100', '200'], 'tres páginas: sin cursor, 100, 200');
  assert.equal(typeof ids[0], 'string', 'ids devueltos como string');
});

test('getAllAssociatedIds: aplica el wrap opcional por página', async () => {
  let wraps = 0;
  const wrap = (fn) => { wraps++; return fn(); };
  const client = {
    crm: {
      associations: {
        v4: {
          basicApi: {
            getPage: async () => ({ results: [{ toObjectId: 1 }], paging: undefined }),
          },
        },
      },
    },
  };

  await getAllAssociatedIds(client, 'deals', '1', 'tickets', { wrap });

  assert.equal(wraps, 1);
});
