// src/__tests__/mirrorAvisosMaria.test.mjs
//
// Los avisos al espejo tienen que cubrir lo que María pidió POR ESCRITO en el
// correo del 6-jul-2026 ("Notificaciones PY + Lógica edición de ticket"):
//
//   Line item — avisar cuando cambien:
//     · Monto y costo de PY
//     · Fecha de facturación esperada
//     · Campo UY (si un line item pasa a formar parte de UY o si deja de serlo)
//
// Al cerrar la TANDA D la lista tenía sólo costo · precio · cantidad, o sea que
// faltaban las dos últimas. Este test fija las tres.
//
// Correr con:  node --test src/__tests__/mirrorAvisosMaria.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MIRROR_SENSITIVE_LI_PROPS,
  esPropSensible,
  isMirrorableLiProp,
  labelDeProp,
} from '../services/mirror/mirrorLiPropMap.js';
import { isTransferableLiProp } from '../services/lineItems/syncLineItemPropToTicket.js';

test('monto y costo de PY avisan (lo que ya estaba)', () => {
  for (const p of ['price', 'quantity', 'hs_cost_of_goods_sold', 'costo_total_usd']) {
    assert.ok(esPropSensible(p), `${p} tiene que avisar al espejo`);
  }
});

test('la fecha de facturación esperada avisa, con sus dos nombres', () => {
  assert.ok(esPropSensible('hs_recurring_billing_start_date'));
  assert.ok(esPropSensible('fecha_inicio_de_facturacion'));
});

test('el campo UY avisa — entrar o salir del espejo es justo lo que María quiere saber', () => {
  assert.ok(esPropSensible('uy'), 'uy tiene que avisar');
  assert.ok(isMirrorableLiProp('uy'), 'y tiene que pasar el filtro del espejo');
});

test('`uy` NO se transfiere al ticket: sólo avisa', () => {
  assert.equal(
    isTransferableLiProp('uy'),
    false,
    'el espejo ES el lado UY — copiar el campo no tendría sentido'
  );
});

test('billing_next_date NO avisa: la recalcula el motor y sería ruido', () => {
  assert.equal(esPropSensible('billing_next_date'), false);
});

test('las props nuevas tienen etiqueta legible para el texto del aviso', () => {
  assert.equal(labelDeProp('uy'), 'campo UY');
  assert.equal(labelDeProp('hs_recurring_billing_start_date'), 'fecha de facturación esperada');
  assert.equal(labelDeProp('fecha_inicio_de_facturacion'), 'fecha de facturación esperada');
});

test('la lista sensible quedó con las 7 props esperadas, ni una de más', () => {
  assert.deepEqual(
    [...MIRROR_SENSITIVE_LI_PROPS].sort(),
    [
      'costo_total_usd',
      'fecha_inicio_de_facturacion',
      'hs_cost_of_goods_sold',
      'hs_recurring_billing_start_date',
      'price',
      'quantity',
      'uy',
    ].sort()
  );
});
