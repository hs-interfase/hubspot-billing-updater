// src/__tests__/mensajeFacturacionNC.test.mjs
//
// El mensaje de facturación a administración debe distinguir las NOTAS DE CRÉDITO:
// banner arriba + badge en el ítem. Se detectan por signo (cantidad/subtotal < 0),
// con el flag `nc` como respaldo. Función pura sobre tickets (no toca HubSpot).
//
// Correr con:  node --test src/__tests__/mensajeFacturacionNC.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMensajeFacturacion } from '../services/billing/buildMensajeFacturacion.js';

const ticketBase = (props) => ({ id: '123', properties: { of_producto_nombres: 'iSCert', of_moneda: 'USD', ...props } });

test('ticket con cantidad negativa → banner + badge NOTA DE CRÉDITO', () => {
  const html = buildMensajeFacturacion([ticketBase({ cantidad_real: '-10', subtotal_real: '-500' })], 'Negocio X');
  assert.match(html, /NOTA\(S\) DE CRÉDITO/); // banner
  assert.match(html, /↩️ NOTA DE CRÉDITO/);   // badge del ítem
});

test('ticket con subtotal negativo (cantidad no numérica) → es NC', () => {
  const html = buildMensajeFacturacion([ticketBase({ cantidad_real: '', subtotal_real: '-300' })], 'Negocio X');
  assert.match(html, /↩️ NOTA DE CRÉDITO/);
});

test('flag nc=true sin signo negativo → es NC (respaldo)', () => {
  const html = buildMensajeFacturacion([ticketBase({ cantidad_real: '5', subtotal_real: '500', nc: 'true' })], 'Negocio X');
  assert.match(html, /↩️ NOTA DE CRÉDITO/);
});

test('ticket normal (positivo, sin flag) → NO muestra NC', () => {
  const html = buildMensajeFacturacion([ticketBase({ cantidad_real: '10', subtotal_real: '500', nc: 'false' })], 'Negocio X');
  assert.doesNotMatch(html, /NOTA DE CRÉDITO/);
});

test('mezcla NC + normal → banner cuenta solo las NC', () => {
  const html = buildMensajeFacturacion([
    ticketBase({ cantidad_real: '-1', subtotal_real: '-100' }),
    ticketBase({ cantidad_real: '10', subtotal_real: '500' }),
  ], 'Negocio X');
  assert.match(html, /incluye 1 NOTA\(S\) DE CRÉDITO/);
});
