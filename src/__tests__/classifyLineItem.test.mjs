// src/__tests__/classifyLineItem.test.mjs
//
// Prueba la clasificación de line items para el aviso Mantsoft.
// Foco: una línea en pausa SIEMPRE se clasifica como 'baja', nunca 'edicion'.
//
// Correr con:  node --test src/__tests__/classifyLineItem.test.mjs
//
// No toca HubSpot: classifyLineItem es una función pura sobre las properties.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyLineItem } from '../services/billing/buildMensajeMantsoft.js';

// Helper: arma un line item falso con las properties que le pasemos.
function makeLI(props) {
  return { id: '123', properties: props };
}

test('pausa = true → se clasifica como baja', () => {
  const li = makeLI({
    pausa: 'true',
    fecha_de_baja: '2026-06-10',
    es_definitivo: 'true',
    motivo_de_pausa: 'Cliente se da de baja',
  });
  const { tipo } = classifyLineItem(li);
  assert.equal(tipo, 'baja');
});

test('pausa = false con cambios → se clasifica como edicion', () => {
  // Snapshot previo con un precio distinto al actual → hay diff (edición).
  const li = makeLI({
    pausa: 'false',
    mansoft_tipo_aviso: 'edicion',
    price: '200',
    mansoft_ultimo_snapshot: JSON.stringify({ price: '100', pausa: 'false' }),
  });
  const { tipo } = classifyLineItem(li);
  assert.equal(tipo, 'edicion');
});

test('BUG arreglado: pausa = true pero etiqueta dice "edicion" → igual es baja', () => {
  // Este es el caso que se rompía antes: la etiqueta interna quedó en 'edicion'
  // pero la línea está pausada. Debe ganar el estado real (pausa) → baja.
  const li = makeLI({
    pausa: 'true',
    mansoft_tipo_aviso: 'edicion',
    price: '200',
    mansoft_ultimo_snapshot: JSON.stringify({ price: '100', pausa: 'true' }),
  });
  const { tipo } = classifyLineItem(li);
  assert.equal(tipo, 'baja');
});
