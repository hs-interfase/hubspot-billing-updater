// src/__tests__/detectIVA.test.mjs
//
// Regresión #4 (auditoría 2026-07-18, D3·Q4): detectIVA mapea el tax group contra
// IVA_UY/PY/EXENTO_TAX_GROUP_ID. Un tax group NO reconocido → of_iva="" (comportamiento
// MANTENIDO por decisión de la usuaria) + aviso. Lo crítico a probar acá:
//   1) el mapeo sigue devolviendo el valor correcto para los IDs conocidos,
//   2) un ID desconocido o vacío devuelve "" y NO lanza (el aviso nunca rompe el snapshot).
//
// Las vars se setean ANTES del import dinámico (config/constants las lee del env al cargar).
//
// Correr con:  node --test src/__tests__/detectIVA.test.mjs

process.env.IVA_UY_TAX_GROUP_ID = 'TG_UY';
process.env.IVA_PY_TAX_GROUP_ID = 'TG_PY';
process.env.IVA_EXENTO_TAX_GROUP_ID = 'TG_EXENTO'; // OJO: la env var lleva prefijo IVA_

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { detectIVA } = await import('../services/snapshotService.js');

const li = (taxGroupId) => ({ id: 'LI-1', properties: { hs_tax_rate_group_id: taxGroupId } });

test('tax group UY reconocido → of_iva "true"', () => {
  assert.equal(detectIVA(li('TG_UY')), 'true');
});

test('tax group PY reconocido → of_iva "true"', () => {
  assert.equal(detectIVA(li('TG_PY')), 'true');
});

test('tax group EXENTO reconocido → of_iva "false"', () => {
  assert.equal(detectIVA(li('TG_EXENTO')), 'false');
});

test('tax group DESCONOCIDO → of_iva "" (comportamiento mantenido) y NO lanza', () => {
  assert.doesNotThrow(() => {
    assert.equal(detectIVA(li('TG_NUEVO_SIN_MAPEAR')), '');
  });
});

test('SIN tax group → of_iva "" y NO lanza', () => {
  assert.doesNotThrow(() => {
    assert.equal(detectIVA(li('')), '');
    assert.equal(detectIVA({ id: 'LI-2', properties: {} }), '');
  });
});
