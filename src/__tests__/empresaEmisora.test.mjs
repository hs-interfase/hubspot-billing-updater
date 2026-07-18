// src/__tests__/empresaEmisora.test.mjs
//
// Mapeo product_id → empresa emisora POR PORTAL (sandbox/prod).
//   DATABASE_URL='postgres://u:p@localhost:5432/x' node --test src/__tests__/empresaEmisora.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EMPRESA_EMISORA_MAP, EMPRESA_EMISORA_MAP_BY_ENV } from '../services/billing/empresaEmisora.js';
import { NOMBRE_PRODUCTO_TO_ID_BY_ENV } from '../services/billing/nombreProductoSelect.js';

test('ambos entornos tienen los mismos 11 productos con la misma empresa', () => {
  const prod = EMPRESA_EMISORA_MAP_BY_ENV.prod;
  const sandbox = EMPRESA_EMISORA_MAP_BY_ENV.sandbox;
  assert.equal(Object.keys(prod).length, 11);
  assert.equal(Object.keys(sandbox).length, 11);
  // multiconjunto de empresas idéntico entre entornos
  const bag = (m) => Object.values(m).sort();
  assert.deepEqual(bag(prod), bag(sandbox));
});

test('los IDs coinciden con el mapa por-portal de nombre_producto (misma fuente PRODUCTS)', () => {
  // ISCert ISA: prod y sandbox del emisora == los de nombre_producto, y ambos → ISA
  const isaIsaProd = NOMBRE_PRODUCTO_TO_ID_BY_ENV['ISCert ISA'].prod;
  const isaIsaSbx = NOMBRE_PRODUCTO_TO_ID_BY_ENV['ISCert ISA'].sandbox;
  assert.equal(EMPRESA_EMISORA_MAP_BY_ENV.prod[isaIsaProd], 'ISA');
  assert.equal(EMPRESA_EMISORA_MAP_BY_ENV.sandbox[isaIsaSbx], 'ISA');
  // iSCert (Interfase) por ambos entornos
  assert.equal(EMPRESA_EMISORA_MAP_BY_ENV.prod[NOMBRE_PRODUCTO_TO_ID_BY_ENV['ISCert'].prod], 'Interfase');
  assert.equal(EMPRESA_EMISORA_MAP_BY_ENV.sandbox[NOMBRE_PRODUCTO_TO_ID_BY_ENV['ISCert'].sandbox], 'Interfase');
});

test('EMPRESA_EMISORA_MAP resuelve exactamente a uno de los dos mapas por-entorno', () => {
  assert.ok(
    EMPRESA_EMISORA_MAP === EMPRESA_EMISORA_MAP_BY_ENV.prod ||
    EMPRESA_EMISORA_MAP === EMPRESA_EMISORA_MAP_BY_ENV.sandbox,
    'debe ser identidad con el mapa prod o sandbox'
  );
});
