// src/__tests__/collectCatalogTags.test.mjs
//
// Prueba la agregación (pura) de tags de catálogo del deal desde sus line items.
// No toca HubSpot: collectCatalogTags es una función pura.
//
// Correr con:  node --test src/__tests__/collectCatalogTags.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectCatalogTags } from '../services/deal/syncDealCatalogTags.js';

const makeLI = (props) => ({ id: String(Math.random()), properties: props });

test('unión sin repetir de rubro y unidad; producto resuelto por hs_product_id', () => {
  const productNameById = new Map([
    ['101', 'MiFactura'],
    ['102', 'Portal'],
  ]);
  const lineItems = [
    makeLI({ servicio: 'Licencias', unidad_de_negocio: 'Negocios Digitales', area: 'Payroll', hs_product_id: '101' }),
    makeLI({ servicio: 'Soporte', unidad_de_negocio: 'Negocios Digitales', area: 'Portal', hs_product_id: '102' }),
  ];

  const tags = collectCatalogTags(lineItems, { productNameById });

  assert.deepEqual(tags.rubro, ['Licencias', 'Soporte']);
  assert.deepEqual(tags.unidad_de_negocio, ['Negocios Digitales']); // dedup
  assert.deepEqual(tags.producto, ['MiFactura', 'Portal']);
  assert.deepEqual(tags.area, ['Payroll', 'Portal']); // unión de area de los LIs
});

test('dedup case/acentos: conserva el primer texto visto', () => {
  const lineItems = [
    makeLI({ servicio: 'Licencias' }),
    makeLI({ servicio: 'licencias' }),   // mismo rubro distinto case
    makeLI({ servicio: 'LICENCIAS' }),
  ];

  const tags = collectCatalogTags(lineItems);
  assert.deepEqual(tags.rubro, ['Licencias']);
});

test('ignora vacíos y product ids sin nombre resuelto', () => {
  const productNameById = new Map([['101', 'MiFactura']]);
  const lineItems = [
    makeLI({ servicio: '', unidad_de_negocio: '   ', hs_product_id: '999' }), // 999 sin nombre
    makeLI({ servicio: 'Otros', hs_product_id: '101' }),
    makeLI({}), // line item sin nada
  ];

  const tags = collectCatalogTags(lineItems, { productNameById });
  assert.deepEqual(tags.rubro, ['Otros']);
  assert.deepEqual(tags.unidad_de_negocio, []);
  assert.deepEqual(tags.producto, ['MiFactura']);
});

test('sin line items → todo vacío', () => {
  const tags = collectCatalogTags([]);
  assert.deepEqual(tags, { producto: [], rubro: [], unidad_de_negocio: [], area: [] });
});
