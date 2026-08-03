// src/__tests__/resolverEntidadFacturadora.test.mjs
//
// Regla de dos niveles de la entidad facturadora (usuaria 23-jul):
// PY → ISA PY · UY → producto con área de desempate iSCert · Mixto/otro → ''.
//   node --test src/__tests__/resolverEntidadFacturadora.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolverEntidadFacturadora } from '../services/billing/resolverEntidadFacturadora.js';
import { EMPRESA_EMISORA_MAP, EMPRESA_EMISORA_MAP_BY_ENV } from '../services/billing/empresaEmisora.js';

// IDs del entorno RESUELTO (el mismo que usa el resolver vía EMPRESA_EMISORA_MAP).
const idDe = (empresa) => Object.keys(EMPRESA_EMISORA_MAP).find(k => EMPRESA_EMISORA_MAP[k] === empresa);

test('país Paraguay → ISA PY sin importar producto ni área', () => {
  const r = resolverEntidadFacturadora({ paisOperativo: 'Paraguay', productId: idDe('Interfase'), area: 'Payroll' });
  assert.deepEqual(r, { valor: 'ISA PY', metodo: 'pais' });
});

test('país Uruguay + producto ISA → ISA UY (vocabulario del SELECT, no del mensaje)', () => {
  const r = resolverEntidadFacturadora({ paisOperativo: 'Uruguay', productId: idDe('ISA'), area: '' });
  assert.deepEqual(r, { valor: 'ISA UY', metodo: 'producto' });
});

test('país Uruguay + producto Interfase → Interfase UY', () => {
  const r = resolverEntidadFacturadora({ paisOperativo: 'Uruguay', productId: idDe('Interfase'), area: null });
  assert.deepEqual(r, { valor: 'Interfase UY', metodo: 'producto' });
});

test('desempate iSCert: área iSCert ISA gana al producto iSCert (Interfase)', () => {
  // LI viejo apuntando al producto iSCert (Interfase) pero con área iSCert ISA → ISA UY.
  const productoIscertInterfase = Object.keys(EMPRESA_EMISORA_MAP_BY_ENV.prod)
    .find(k => EMPRESA_EMISORA_MAP_BY_ENV.prod[k] === 'Interfase' && k !== idDe('Interfase'));
  const r = resolverEntidadFacturadora({
    paisOperativo: 'Uruguay',
    productId: EMPRESA_EMISORA_MAP === EMPRESA_EMISORA_MAP_BY_ENV.prod ? productoIscertInterfase : idDe('Interfase'),
    area: 'iSCert ISA',
  });
  assert.equal(r.valor, 'ISA UY');
  assert.ok(['area', 'area_gana_a_producto'].includes(r.metodo));
});

test('área iSCert sola (sin producto) → Interfase UY', () => {
  const r = resolverEntidadFacturadora({ paisOperativo: 'Uruguay', productId: '', area: 'iSCert' });
  assert.deepEqual(r, { valor: 'Interfase UY', metodo: 'area' });
});

// 🔴 CAMBIO DE REGLA (usuaria, 2-ago-2026): la emisora es LÍMITE DURO y sale del ÁREA
// ASIGNADA. AREA_TO_ENTIDAD pasó de 2 entradas (sólo el desempate iSCert) a las 8 áreas.
// Este test afirmaba lo contrario —que el área 'Portal' NO definía emisora y el caso
// quedaba sin resolver— así que se REESCRIBE, no se ajusta: la regla que protegía ya no
// es la vigente.
test('el ÁREA resuelve sola, aunque el producto no esté mapeado (regla 2-ago)', () => {
  const r = resolverEntidadFacturadora({ paisOperativo: 'Uruguay', productId: '999', area: 'Portal' });
  assert.deepEqual(r, { valor: 'ISA UY', metodo: 'area' });
});

test('las 8 áreas resuelven emisora — ninguna queda sin definir', () => {
  const esperado = {
    'iGDoc': 'ISA UY', 'Portal': 'ISA UY', 'NNDD Ops': 'ISA UY', 'Petróleo': 'ISA UY',
    'iSCert ISA': 'ISA UY', 'iSCert': 'Interfase UY', 'Payroll': 'Interfase UY',
    'Paraguay': 'ISA PY',
  };
  for (const [area, valor] of Object.entries(esperado)) {
    const r = resolverEntidadFacturadora({ paisOperativo: 'Uruguay', productId: '', area });
    assert.deepEqual(r, { valor, metodo: 'area' }, `área ${area}`);
  }
});

test('Petróleo es área COMPARTIDA (iJServ + Flota) y aun así no es ambigua: las dos son ISA', () => {
  for (const p of ['iJServ', 'Flota']) {
    const productId = Object.keys(EMPRESA_EMISORA_MAP).find(k => EMPRESA_EMISORA_MAP[k] === 'ISA');
    const r = resolverEntidadFacturadora({ paisOperativo: 'Uruguay', productId, area: 'Petróleo' });
    assert.equal(r.valor, 'ISA UY', `producto ${p}`);
  }
});

test('sin área NI producto mapeado → sigue sin resolverse (no se inventa emisora)', () => {
  const r = resolverEntidadFacturadora({ paisOperativo: 'Uruguay', productId: '999', area: '' });
  assert.deepEqual(r, { valor: '', metodo: 'sin_producto_ni_area' });
});

test('Mixto / vacío → no se resuelve (no tocar)', () => {
  assert.deepEqual(resolverEntidadFacturadora({ paisOperativo: 'Mixto', productId: idDe('ISA') }),
    { valor: '', metodo: 'pais_no_resuelto' });
  assert.deepEqual(resolverEntidadFacturadora({}),
    { valor: '', metodo: 'pais_no_resuelto' });
});
