// src/__tests__/mirrorUpsertPuntual.test.mjs
//
// TANDA D — la CORRECCIÓN del §3.1: el UPDATE del line item espejo deja de
// reescribir la hoja entera en cada corrida del cron y pasa a escribir sólo lo
// que difiere. Sin esto, la copia puntual del camino reactivo se pierde en la
// pasada siguiente.
//
// PAR OFF/ON: con MIRROR_PUNTUAL_ENABLED apagada el comportamiento es
// EXACTAMENTE el de hoy (update completo, siempre).
//
// Todo con deps inyectadas (client / getAssocIdsFn): no toca HubSpot.
//
//   DATABASE_URL='postgres://u:p@localhost:5432/x' node --test src/__tests__/mirrorUpsertPuntual.test.mjs

process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/x';

import test from 'node:test';
import assert from 'node:assert/strict';

const { upsertUyLineItem } = await import('../services/mirrorLineItemsUyUpsert.js');

const ESPEJO_ID = 'LIUY-1';
const PY_ID = 'LIPY-9';

const PROPS_DESEADAS = {
  name: 'Producto X',
  description: 'descripción NUEVA',
  quantity: '2',
  price: '100',
  uy: 'true',
};

/**
 * Fake del client: el deal espejo tiene un line item con `actuales` como estado.
 * `origen` permite simular que el LI del espejo viene de OTRO PY (→ create).
 */
function makeDeps({ actuales = {}, origen = PY_ID, ids = [ESPEJO_ID] } = {}) {
  const updates = [];
  const creates = [];
  const lecturas = [];
  const asociaciones = [];

  const client = {
    crm: {
      lineItems: {
        basicApi: {
          update: async (id, body) => { updates.push({ id, props: body.properties }); return { id }; },
          create: async (body) => { creates.push(body); return { id: 'NUEVO' }; },
        },
        batchApi: {
          read: async ({ properties }) => {
            lecturas.push(properties);
            return { results: [{ id: ESPEJO_ID, properties: { of_line_item_py_origen_id: origen, ...actuales } }] };
          },
        },
      },
      associations: {
        v4: { basicApi: { create: async (...args) => { asociaciones.push(args); return {}; } } },
      },
    },
  };

  return {
    updates, creates, lecturas, asociaciones,
    deps: { client, getAssocIdsFn: async () => ids },
  };
}

test('FLAG OFF — el update reescribe la hoja entera (comportamiento de hoy)', async () => {
  delete process.env.MIRROR_PUNTUAL_ENABLED;
  const m = makeDeps({
    actuales: { name: 'Producto X', description: 'descripción VIEJA', quantity: '2', price: '100', uy: 'true' },
  });
  const r = await upsertUyLineItem('DUY', { id: PY_ID }, () => PROPS_DESEADAS, m.deps);
  assert.equal(r.action, 'updated');
  assert.equal(m.updates.length, 1);
  assert.deepEqual(m.updates[0].props, PROPS_DESEADAS, 'sin la llave se manda TODO');
});

test('FLAG OFF — sin diferencias igual escribe (hoy no compara nada)', async () => {
  delete process.env.MIRROR_PUNTUAL_ENABLED;
  const m = makeDeps({ actuales: { ...PROPS_DESEADAS } });
  const r = await upsertUyLineItem('DUY', { id: PY_ID }, () => PROPS_DESEADAS, m.deps);
  assert.equal(r.action, 'updated');
  assert.equal(m.updates.length, 1);
});

test('FLAG ON — sólo se escribe la prop que difiere', async () => {
  process.env.MIRROR_PUNTUAL_ENABLED = 'true';
  try {
    const m = makeDeps({
      actuales: { name: 'Producto X', description: 'descripción VIEJA', quantity: '2', price: '100', uy: 'true' },
    });
    const r = await upsertUyLineItem('DUY', { id: PY_ID }, () => PROPS_DESEADAS, m.deps);
    assert.equal(r.action, 'updated');
    assert.equal(m.updates.length, 1);
    assert.deepEqual(m.updates[0].props, { description: 'descripción NUEVA' });
  } finally {
    delete process.env.MIRROR_PUNTUAL_ENABLED;
  }
});

test('FLAG ON — 🔴 lo editado a mano en el espejo NO se pisa', async () => {
  process.env.MIRROR_PUNTUAL_ENABLED = 'true';
  try {
    // El equipo operativo dejó otra descripción y otro nombre en el espejo, y el
    // original sólo cambió la cantidad.
    const m = makeDeps({
      actuales: { name: 'Nombre UY editado a mano', description: 'texto propio de UY', quantity: '1', price: '100', uy: 'true' },
    });
    const deseadas = { ...PROPS_DESEADAS, name: 'Nombre UY editado a mano', description: 'texto propio de UY', quantity: '2' };
    await upsertUyLineItem('DUY', { id: PY_ID }, () => deseadas, m.deps);
    assert.deepEqual(m.updates[0].props, { quantity: '2' }, 'sólo la cantidad, el resto intacto');
  } finally {
    delete process.env.MIRROR_PUNTUAL_ENABLED;
  }
});

test('FLAG ON — sin diferencias NO se llama a la API (action: unchanged)', async () => {
  process.env.MIRROR_PUNTUAL_ENABLED = 'true';
  try {
    const m = makeDeps({ actuales: { ...PROPS_DESEADAS } });
    const r = await upsertUyLineItem('DUY', { id: PY_ID }, () => PROPS_DESEADAS, m.deps);
    assert.equal(r.action, 'unchanged');
    assert.equal(r.id, ESPEJO_ID);
    assert.equal(m.updates.length, 0, 'no debe escribir nada');
  } finally {
    delete process.env.MIRROR_PUNTUAL_ENABLED;
  }
});

test('FLAG ON — el batch read pide también las props que se van a comparar', async () => {
  process.env.MIRROR_PUNTUAL_ENABLED = 'true';
  try {
    const m = makeDeps({ actuales: { ...PROPS_DESEADAS } });
    await upsertUyLineItem('DUY', { id: PY_ID }, () => PROPS_DESEADAS, m.deps);
    const pedidas = m.lecturas[0];
    for (const k of Object.keys(PROPS_DESEADAS)) {
      assert.ok(pedidas.includes(k), `falta ${k} en el batch read`);
    }
    assert.ok(pedidas.includes('of_line_item_py_origen_id'), 'sigue trayendo la clave de espejado');
  } finally {
    delete process.env.MIRROR_PUNTUAL_ENABLED;
  }
});

test('FLAG OFF — el batch read pide sólo las props base (idéntico a hoy)', async () => {
  delete process.env.MIRROR_PUNTUAL_ENABLED;
  const m = makeDeps({ actuales: { ...PROPS_DESEADAS } });
  await upsertUyLineItem('DUY', { id: PY_ID }, () => PROPS_DESEADAS, m.deps);
  assert.deepEqual(m.lecturas[0], ['hs_object_id', 'of_line_item_py_origen_id', 'pais_operativo', 'uy', 'name']);
});

test('FLAG ON — el ALTA sigue escribiendo la hoja completa', async () => {
  process.env.MIRROR_PUNTUAL_ENABLED = 'true';
  try {
    // El espejo tiene un LI, pero de OTRO origen → no matchea → CREATE.
    const m = makeDeps({ actuales: {}, origen: 'OTRO-PY' });
    const r = await upsertUyLineItem('DUY', { id: PY_ID }, () => PROPS_DESEADAS, m.deps);
    assert.equal(r.action, 'created');
    assert.deepEqual(m.creates[0].properties, PROPS_DESEADAS);
    assert.equal(m.updates.length, 0);
    assert.equal(m.asociaciones.length, 1, 'el LI nuevo se asocia al deal espejo');
  } finally {
    delete process.env.MIRROR_PUNTUAL_ENABLED;
  }
});

test('FLAG ON — primer sync (espejo sin líneas) crea con la hoja completa', async () => {
  process.env.MIRROR_PUNTUAL_ENABLED = 'true';
  try {
    const m = makeDeps({ ids: [] });
    const r = await upsertUyLineItem('DUY', { id: PY_ID }, () => PROPS_DESEADAS, m.deps);
    assert.equal(r.action, 'created');
    assert.deepEqual(m.creates[0].properties, PROPS_DESEADAS);
  } finally {
    delete process.env.MIRROR_PUNTUAL_ENABLED;
  }
});
