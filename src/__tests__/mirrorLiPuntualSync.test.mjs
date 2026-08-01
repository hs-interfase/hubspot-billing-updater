// src/__tests__/mirrorLiPuntualSync.test.mjs
//
// TANDA D — el orquestador del espejo puntual (§3.1 / §3.2 del plan).
//
// Fija la regla entera: se COPIA puntual al line item espejo · se AVISA al
// ticket espejo · el aviso sale ANTES del cambio si la prop es sensible · el
// espejo sellado no se copia pero SÍ avisa · el anti-loop.
//
// PAR OFF/ON en el primer test: con la llave apagada no pasa NADA.
//
// Todo con fakes inyectados: no toca HubSpot ni Resend.
//
//   DATABASE_URL='postgres://u:p@localhost:5432/x' node --test src/__tests__/mirrorLiPuntualSync.test.mjs

process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/x';

import test from 'node:test';
import assert from 'node:assert/strict';

const { propagarCambioLiAlEspejo } = await import('../services/mirror/mirrorLiPuntualSync.js');

const MIRROR = { mirrorDealId: 'DUY', mirrorLineItemId: 'LIUY', pyDealId: 'DPY' };

/**
 * @param {Object} o
 * @param {Object} o.pyProps      props del LI ORIGINAL
 * @param {Object} o.uyProps      props del LI ESPEJO
 * @param {boolean} o.sellado     mig_espejo_independiente del deal espejo
 * @param {Object|null} o.mirror  resultado de findMirrorLineItem
 */
function makeDeps({ pyProps = {}, uyProps = {}, sellado = false, mirror = MIRROR } = {}) {
  const eventos = [];   // orden real de lo que pasó: 'aviso' | 'copia'
  const updates = [];
  const avisos = [];

  const client = {
    crm: {
      deals: {
        basicApi: {
          getById: async () => ({ properties: { mig_espejo_independiente: sellado ? 'true' : 'false' } }),
        },
      },
      lineItems: {
        basicApi: {
          getById: async (id) => ({
            id,
            properties: String(id) === 'LIUY' ? { line_item_key: 'LIK-UY', ...uyProps } : { ...pyProps },
          }),
          update: async (id, body) => {
            eventos.push('copia');
            updates.push({ id, props: body.properties });
            return { id };
          },
        },
      },
    },
  };

  return {
    eventos, updates, avisos,
    deps: {
      client,
      findMirrorFn: async () => mirror,
      avisarTicketFn: async (args) => {
        eventos.push('aviso');
        avisos.push(args);
        return { avisado: true, via: args.ymd ? 'ticket' : 'deal' };
      },
    },
  };
}

// ── PAR OFF / ON ────────────────────────────────────────────────────────────

test('FLAG OFF — no pasa nada (idéntico a hoy)', async () => {
  delete process.env.MIRROR_PUNTUAL_ENABLED;
  const m = makeDeps({ pyProps: { description: 'nueva' }, uyProps: { description: 'vieja' } });
  const r = await propagarCambioLiAlEspejo({ lineItemId: 'LIPY', propertyName: 'description' }, m.deps);
  assert.equal(r.applies, false);
  assert.equal(r.reason, 'MIRROR_PUNTUAL_ENABLED=false');
  assert.equal(m.updates.length, 0);
  assert.equal(m.avisos.length, 0);
});

test('FLAG ON — copia puntual al LI espejo + aviso', async () => {
  process.env.MIRROR_PUNTUAL_ENABLED = 'true';
  try {
    const m = makeDeps({
      pyProps: { description: 'descripción NUEVA', name: 'Producto', quantity: '2', costo_total_usd: '200' },
      uyProps: { description: 'descripción VIEJA', name: 'Producto', quantity: '2', price: '100' },
    });
    const r = await propagarCambioLiAlEspejo({ lineItemId: 'LIPY', propertyName: 'description' }, m.deps);
    assert.equal(r.applies, true);
    assert.equal(r.copiado, true);
    assert.equal(m.updates.length, 1);
    assert.equal(m.updates[0].id, 'LIUY');
    assert.deepEqual(m.updates[0].props, { description: 'descripción NUEVA' }, 'sólo la prop que cambió');
    assert.equal(r.avisos, 1);
  } finally {
    delete process.env.MIRROR_PUNTUAL_ENABLED;
  }
});

// ── EL ORDEN: sensible avisa ANTES ──────────────────────────────────────────

test('prop SENSIBLE (costo) — el aviso sale ANTES de tocar el espejo', async () => {
  process.env.MIRROR_PUNTUAL_ENABLED = 'true';
  try {
    const m = makeDeps({
      pyProps: { costo_total_usd: '500', quantity: '5' },
      uyProps: { price: '80', quantity: '5' },
    });
    await propagarCambioLiAlEspejo({ lineItemId: 'LIPY', propertyName: 'costo_total_usd' }, m.deps);
    assert.deepEqual(m.eventos, ['aviso', 'copia'], 'primero avisa, después copia');
    // costo del original → PRECIO del espejo: 500 ÷ 5 = 100
    assert.deepEqual(m.updates[0].props, { price: '100' });
  } finally {
    delete process.env.MIRROR_PUNTUAL_ENABLED;
  }
});

test('prop NO sensible (descripción) — primero copia, después avisa', async () => {
  process.env.MIRROR_PUNTUAL_ENABLED = 'true';
  try {
    const m = makeDeps({ pyProps: { description: 'nueva' }, uyProps: { description: 'vieja' } });
    await propagarCambioLiAlEspejo({ lineItemId: 'LIPY', propertyName: 'description' }, m.deps);
    assert.deepEqual(m.eventos, ['copia', 'aviso']);
  } finally {
    delete process.env.MIRROR_PUNTUAL_ENABLED;
  }
});

test('el PRECIO del original avisa pero NO copia nada al espejo', async () => {
  process.env.MIRROR_PUNTUAL_ENABLED = 'true';
  try {
    const m = makeDeps({ pyProps: { price: '9999', costo_total_usd: '200', quantity: '2' }, uyProps: { price: '100' } });
    const r = await propagarCambioLiAlEspejo({ lineItemId: 'LIPY', propertyName: 'price' }, m.deps);
    assert.equal(m.updates.length, 0, 'el espejo factura al COSTO del original, no a su precio');
    assert.equal(r.avisos, 1);
    assert.deepEqual(m.eventos, ['aviso']);
  } finally {
    delete process.env.MIRROR_PUNTUAL_ENABLED;
  }
});

// ── Espejo sellado ──────────────────────────────────────────────────────────

test('espejo SELLADO — no se copia, pero SÍ avisa', async () => {
  process.env.MIRROR_PUNTUAL_ENABLED = 'true';
  try {
    const m = makeDeps({
      sellado: true,
      pyProps: { costo_total_usd: '500', quantity: '5' },
      uyProps: { price: '80', quantity: '5' },
    });
    const r = await propagarCambioLiAlEspejo({ lineItemId: 'LIPY', propertyName: 'costo_total_usd' }, m.deps);
    assert.equal(r.sellado, true);
    assert.equal(r.copiado, false);
    assert.equal(m.updates.length, 0, 'las líneas históricas del migrado no se tocan');
    assert.equal(r.avisos, 1);
    assert.match(m.avisos[0].mensaje, /migrado independiente/);
  } finally {
    delete process.env.MIRROR_PUNTUAL_ENABLED;
  }
});

// ── A qué ticket va: un aviso por período ───────────────────────────────────

test('un aviso por PERÍODO alcanzado, con el antes y el después del original', async () => {
  process.env.MIRROR_PUNTUAL_ENABLED = 'true';
  try {
    const m = makeDeps({ pyProps: { quantity: '3', costo_total_usd: '300' }, uyProps: { quantity: '1', price: '100' } });
    const r = await propagarCambioLiAlEspejo(
      {
        lineItemId: 'LIPY',
        propertyName: 'quantity',
        cambiosPorPeriodo: [
          { ymd: '2026-08-31', antes: { cantidad_real: '1' }, despues: { cantidad_real: '3' } },
          { ymd: '2026-09-30', antes: { cantidad_real: '1' }, despues: { cantidad_real: '3' } },
        ],
      },
      m.deps
    );
    assert.equal(r.avisos, 2);
    assert.deepEqual(m.avisos.map((a) => a.ymd), ['2026-08-31', '2026-09-30']);
    assert.match(m.avisos[0].mensaje, /pasó de "1" a "3"/);
    assert.equal(m.avisos[0].mirrorLineItemKey, 'LIK-UY', 'la clave sale del LI ESPEJO');
  } finally {
    delete process.env.MIRROR_PUNTUAL_ENABLED;
  }
});

test('sin períodos — un solo aviso, sin ymd (cae al deal espejo)', async () => {
  process.env.MIRROR_PUNTUAL_ENABLED = 'true';
  try {
    const m = makeDeps({ pyProps: { description: 'nueva' }, uyProps: { description: 'vieja' } });
    const r = await propagarCambioLiAlEspejo({ lineItemId: 'LIPY', propertyName: 'description' }, m.deps);
    assert.equal(r.avisos, 1);
    assert.equal(m.avisos[0].ymd, '');
    assert.match(m.avisos[0].mensaje, /pasó de "vieja" a "nueva"/);
  } finally {
    delete process.env.MIRROR_PUNTUAL_ENABLED;
  }
});

// ── Anti-loop y bordes ──────────────────────────────────────────────────────

test('sin espejo (o el LI YA es de un deal espejo) → no hace nada', async () => {
  process.env.MIRROR_PUNTUAL_ENABLED = 'true';
  try {
    const m = makeDeps({ mirror: null });
    const r = await propagarCambioLiAlEspejo({ lineItemId: 'LIPY', propertyName: 'description' }, m.deps);
    assert.equal(r.applies, false);
    assert.equal(r.reason, 'sin_espejo');
    assert.equal(m.updates.length, 0);
    assert.equal(m.avisos.length, 0);
  } finally {
    delete process.env.MIRROR_PUNTUAL_ENABLED;
  }
});

test('prop que no se espeja → ni copia ni avisa', async () => {
  process.env.MIRROR_PUNTUAL_ENABLED = 'true';
  try {
    const m = makeDeps({});
    const r = await propagarCambioLiAlEspejo({ lineItemId: 'LIPY', propertyName: 'momento_de_facturacion' }, m.deps);
    assert.equal(r.reason, 'prop_no_espejada');
    assert.equal(m.avisos.length, 0);
  } finally {
    delete process.env.MIRROR_PUNTUAL_ENABLED;
  }
});

test('si el espejo ya tenía ese valor, no se escribe (pero avisa igual)', async () => {
  process.env.MIRROR_PUNTUAL_ENABLED = 'true';
  try {
    const m = makeDeps({ pyProps: { description: 'igual' }, uyProps: { description: 'igual' } });
    const r = await propagarCambioLiAlEspejo({ lineItemId: 'LIPY', propertyName: 'description' }, m.deps);
    assert.equal(m.updates.length, 0);
    assert.equal(r.copiado, false);
    assert.equal(r.avisos, 1);
  } finally {
    delete process.env.MIRROR_PUNTUAL_ENABLED;
  }
});

test('si la copia falla, el aviso de la prop sensible YA salió (y no lanza)', async () => {
  process.env.MIRROR_PUNTUAL_ENABLED = 'true';
  try {
    const m = makeDeps({ pyProps: { costo_total_usd: '500', quantity: '5' }, uyProps: { price: '80' } });
    m.deps.client.crm.lineItems.basicApi.update = async () => { throw new Error('boom'); };
    const r = await propagarCambioLiAlEspejo({ lineItemId: 'LIPY', propertyName: 'costo_total_usd' }, m.deps);
    assert.equal(r.copiado, false);
    assert.equal(r.avisos, 1, 'el aviso previo es justamente para esto');
  } finally {
    delete process.env.MIRROR_PUNTUAL_ENABLED;
  }
});

test('si no se puede leer el sello del deal espejo, se asume NO sellado (y copia)', async () => {
  process.env.MIRROR_PUNTUAL_ENABLED = 'true';
  try {
    const m = makeDeps({ pyProps: { description: 'nueva' }, uyProps: { description: 'vieja' } });
    m.deps.client.crm.deals.basicApi.getById = async () => { throw new Error('403'); };
    const r = await propagarCambioLiAlEspejo({ lineItemId: 'LIPY', propertyName: 'description' }, m.deps);
    assert.equal(r.sellado, false);
    assert.equal(r.copiado, true);
  } finally {
    delete process.env.MIRROR_PUNTUAL_ENABLED;
  }
});

test('nunca lanza aunque el lookup del espejo explote', async () => {
  process.env.MIRROR_PUNTUAL_ENABLED = 'true';
  try {
    const m = makeDeps({});
    m.deps.findMirrorFn = async () => { throw new Error('boom-lookup'); };
    const r = await propagarCambioLiAlEspejo({ lineItemId: 'LIPY', propertyName: 'description' }, m.deps);
    assert.equal(r.applies, false);
    assert.equal(r.reason, 'mirror_lookup_error');
  } finally {
    delete process.env.MIRROR_PUNTUAL_ENABLED;
  }
});
