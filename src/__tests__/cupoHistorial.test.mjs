// src/__tests__/cupoHistorial.test.mjs
//
// Historial de eventos de cupo (of_cupo_historial): formato de línea,
// append tolerante a vacío y recorte de las líneas MÁS VIEJAS por tamaño.
//
//   node --test src/__tests__/cupoHistorial.test.mjs
//
// Helpers puros: no tocan HubSpot ni DB (no necesita DATABASE_URL).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCupoHistorialLine,
  appendHistorial,
  HISTORIAL_MAX_CHARS,
} from '../services/cupo/cupoHistorial.js';

// ---------- buildCupoHistorialLine ----------

test('línea de consumo: formato "fecha | tipo | valor | invoice id"', () => {
  const l = buildCupoHistorialLine({ fecha: '2026-08-12', tipo: 'consumo', valor: -300, invoiceId: '12345' });
  assert.equal(l, '2026-08-12 | consumo | -300 | invoice 12345');
});

test('línea de reversión con extra opcional al final', () => {
  const l = buildCupoHistorialLine({
    fecha: '2026-08-20', tipo: 'reversion', valor: 300, invoiceId: '12345', extra: 'por admin@x.com',
  });
  assert.equal(l, '2026-08-20 | reversion | 300 | invoice 12345 | por admin@x.com');
});

// ---------- appendHistorial ----------

test('append sobre historial vacío/undefined/null devuelve solo la línea', () => {
  const linea = '2026-08-12 | consumo | 300 | invoice 1';
  assert.equal(appendHistorial(undefined, linea), linea);
  assert.equal(appendHistorial(null, linea), linea);
  assert.equal(appendHistorial('', linea), linea);
});

test('append sobre historial existente concatena con \\n (la nueva queda última)', () => {
  const previo = 'l1\nl2';
  assert.equal(appendHistorial(previo, 'l3'), 'l1\nl2\nl3');
});

test('recorte por tamaño: caen las líneas MÁS VIEJAS y queda la nota de recorte', () => {
  // maxChars chico para no armar strings de 60k en el test.
  const lineas = ['vieja-1 xxxxxxxxxx', 'vieja-2 xxxxxxxxxx', 'media-3 xxxxxxxxxx', 'nueva-4 xxxxxxxxxx'];
  const previo = lineas.slice(0, 3).join('\n');   // 56 chars; con la nueva: 75 > 60
  const out = appendHistorial(previo, lineas[3], 60);

  assert.ok(out.length <= 60, `largo ${out.length} > 60`);
  assert.ok(out.startsWith('[historial recortado]\n'));
  assert.ok(out.endsWith('nueva-4 xxxxxxxxxx'));        // la línea nueva nunca se pierde
  assert.equal(out.includes('vieja-1'), false);         // la más vieja cayó primero
});

test('recorte: una nota de recorte previa no se duplica', () => {
  const previo = '[historial recortado]\n' + 'a'.repeat(60) + '\n' + 'b'.repeat(20);
  const out = appendHistorial(previo, 'c'.repeat(20), 80);

  const notas = out.split('\n').filter(l => l === '[historial recortado]');
  assert.equal(notas.length, 1);
  assert.ok(out.endsWith('c'.repeat(20)));
});

test('sin recorte mientras no se supera el tope default (~60000)', () => {
  const previo = 'x'.repeat(HISTORIAL_MAX_CHARS - 20);
  const out = appendHistorial(previo, 'y'.repeat(10));
  // 59980 + 1 + 10 = 59991 <= 60000 → intacto, sin nota.
  assert.equal(out.includes('[historial recortado]'), false);
  assert.equal(out, previo + '\n' + 'y'.repeat(10));
});
