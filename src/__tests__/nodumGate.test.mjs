// src/__tests__/nodumGate.test.mjs
//
// Gate Nodum del flujo cancelar/revertir (bloque 2).
// Todo con fakes inyectados (client): no toca HubSpot ni DB.
//
// Requiere DATABASE_URL dummy (por si el grafo de imports carga src/db.js).
//   DATABASE_URL='postgres://u:p@localhost:5432/x' node --test src/__tests__/nodumGate.test.mjs

process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/x';

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { checkInvoiceRevertible, buildNodumBlockMessage } =
  await import('../services/invoices/nodumGate.js');

// ── fakes ──

function fakeClientWithProps(properties) {
  return {
    crm: {
      objects: {
        basicApi: {
          getById: async (objectType, id, props) => {
            assert.equal(objectType, 'invoices');
            assert.deepEqual(props, ['id_factura_nodum']);
            return { id: String(id), properties };
          },
        },
      },
    },
  };
}

function fakeClientThatThrows() {
  return {
    crm: {
      objects: {
        basicApi: {
          getById: async () => { throw new Error('boom 500'); },
        },
      },
    },
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// checkInvoiceRevertible
// ═════════════════════════════════════════════════════════════════════════════

test('invoice CON id_factura_nodum → revertible:false + nodumId', async () => {
  const r = await checkInvoiceRevertible('111', {
    client: fakeClientWithProps({ id_factura_nodum: 'ND-4577' }),
  });
  assert.deepEqual(r, { revertible: false, nodumId: 'ND-4577' });
});

test('id_factura_nodum con espacios se trimea y bloquea igual', async () => {
  const r = await checkInvoiceRevertible('111', {
    client: fakeClientWithProps({ id_factura_nodum: '  ND-9  ' }),
  });
  assert.deepEqual(r, { revertible: false, nodumId: 'ND-9' });
});

test('invoice SIN id_factura_nodum → revertible:true', async () => {
  const r = await checkInvoiceRevertible('222', {
    client: fakeClientWithProps({}),
  });
  assert.deepEqual(r, { revertible: true, nodumId: null });
});

test('id_factura_nodum vacío o solo espacios → revertible:true', async () => {
  for (const v of ['', '   ', null, undefined]) {
    const r = await checkInvoiceRevertible('333', {
      client: fakeClientWithProps({ id_factura_nodum: v }),
    });
    assert.deepEqual(r, { revertible: true, nodumId: null }, `valor: ${JSON.stringify(v)}`);
  }
});

test('FAIL-CLOSED: lectura falla → revertible:false + error:true (no lanza)', async () => {
  const r = await checkInvoiceRevertible('444', { client: fakeClientThatThrows() });
  assert.deepEqual(r, { revertible: false, nodumId: null, error: true });
});

// ═════════════════════════════════════════════════════════════════════════════
// buildNodumBlockMessage (NC_TUTORIAL_URL se lee POR LLAMADA)
// ═════════════════════════════════════════════════════════════════════════════

const ORIGINAL_URL = process.env.NC_TUTORIAL_URL;

test('mensaje contiene el id de Nodum y la URL del tutorial (env)', () => {
  process.env.NC_TUTORIAL_URL = 'https://wiki.example.com/nc-tutorial';
  const msg = buildNodumBlockMessage('ND-4577');
  assert.match(msg, /asentada en Nodum \(id ND-4577\)/);
  assert.match(msg, /nota de crédito/);
  assert.match(msg, /Tutorial: https:\/\/wiki\.example\.com\/nc-tutorial/);
});

test('sin NC_TUTORIAL_URL (o vacía) → "(tutorial pendiente)"', () => {
  delete process.env.NC_TUTORIAL_URL;
  assert.match(buildNodumBlockMessage('ND-1'), /Tutorial: \(tutorial pendiente\)/);

  process.env.NC_TUTORIAL_URL = '   ';
  assert.match(buildNodumBlockMessage('ND-1'), /Tutorial: \(tutorial pendiente\)/);
});

test('restore NC_TUTORIAL_URL', () => {
  if (ORIGINAL_URL === undefined) delete process.env.NC_TUTORIAL_URL;
  else process.env.NC_TUTORIAL_URL = ORIGINAL_URL;
});
