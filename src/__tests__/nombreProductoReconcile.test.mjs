// src/__tests__/nombreProductoReconcile.test.mjs
//
// Reconciliación producto ↔ nombre_producto (definición usuaria 14-jul):
//   nombre_producto es la FUENTE DE VERDAD; el id la sigue (salvo nombre vacío → id gana).
//
//   DATABASE_URL='postgres://u:p@localhost:5432/x' node --test src/__tests__/nombreProductoReconcile.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideProductoReconciliation,
  reconcileLineItemsProducto,
  NOMBRE_PRODUCTO_TO_ID,
  NOMBRE_PRODUCTO_TO_ID_BY_ENV,
} from '../services/billing/nombreProductoSelect.js';

// ── Mapa de IDs por portal (fuente: PRODUCTS de la migración) ────────────────
test('IDs por portal: iSCert ISA sandbox/prod correctos; 13 productos con ambos entornos', () => {
  assert.deepEqual(NOMBRE_PRODUCTO_TO_ID_BY_ENV['ISCert ISA'], { sandbox: '46035551908', prod: '46035674794' });
  assert.deepEqual(NOMBRE_PRODUCTO_TO_ID_BY_ENV['ISCert'], { sandbox: '41948442381', prod: '33688819740' });
  const all = Object.values(NOMBRE_PRODUCTO_TO_ID_BY_ENV);
  assert.equal(all.length, 13);
  assert.ok(all.every(x => x.sandbox && x.prod), 'cada producto tiene sandbox y prod');
});

const ID_ISCERT = NOMBRE_PRODUCTO_TO_ID['ISCert'];        // 33688819740
const ID_ISCERT_ISA = NOMBRE_PRODUCTO_TO_ID['ISCert ISA']; // 46035674794

// ── Decisión pura ────────────────────────────────────────────────────────────
test('nombre no vacío y difiere del id → set_product_id (nombre gana)', () => {
  const d = decideProductoReconciliation({ productId: ID_ISCERT, nombre: 'ISCert ISA' });
  assert.deepEqual(d, { op: 'set_product_id', productId: ID_ISCERT_ISA, nombre: 'ISCert ISA' });
});

test('nombre no vacío y ya coincide → none', () => {
  const d = decideProductoReconciliation({ productId: ID_ISCERT_ISA, nombre: 'ISCert ISA' });
  assert.equal(d.op, 'none');
  assert.equal(d.reason, 'ya_coincide');
});

test('nombre vacío + id seteado → set_nombre (id gana como fallback)', () => {
  const d = decideProductoReconciliation({ productId: ID_ISCERT, nombre: '' });
  assert.deepEqual(d, { op: 'set_nombre', nombre: 'ISCert' });
});

test('nombre no mapeado → none/unmapped (no se toca el id)', () => {
  const d = decideProductoReconciliation({ productId: ID_ISCERT, nombre: 'ProductoInventado' });
  assert.equal(d.op, 'none');
  assert.equal(d.reason, 'nombre_no_mapeado');
});

test('todo vacío → none', () => {
  assert.equal(decideProductoReconciliation({ productId: '', nombre: '' }).op, 'none');
  assert.equal(decideProductoReconciliation({}).op, 'none');
});

// ── Runner con client falso ──────────────────────────────────────────────────
function fakeClient() {
  const updates = [];
  const client = { crm: { lineItems: { basicApi: { async update(id, body) { updates.push({ id: String(id), props: body.properties }); } } } } };
  return { client, updates };
}
const li = (id, props) => ({ id: String(id), properties: props });

test('reconcile: reasigna id (nombre gana), rellena vacío, y cuenta ok/unmapped', async () => {
  const { client, updates } = fakeClient();
  const items = [
    li('A', { hs_product_id: ID_ISCERT, nombre_producto: 'ISCert ISA' }), // reasigna id → ISA
    li('B', { hs_product_id: ID_ISCERT, nombre_producto: '' }),           // rellena nombre = ISCert
    li('C', { hs_product_id: ID_ISCERT_ISA, nombre_producto: 'ISCert ISA' }), // ok, no toca
    li('D', { hs_product_id: ID_ISCERT, nombre_producto: 'Inexistente' }), // unmapped, no toca
  ];
  const s = await reconcileLineItemsProducto(items, { client });

  assert.equal(s.reassignedId, 1);
  assert.equal(s.filledNombre, 1);
  assert.equal(s.ok, 1);
  assert.equal(s.unmapped, 1);
  assert.equal(s.errors, 0);

  assert.equal(updates.length, 2);
  const a = updates.find(u => u.id === 'A');
  assert.deepEqual(a.props, { hs_product_id: ID_ISCERT_ISA });   // nombre ganó
  const b = updates.find(u => u.id === 'B');
  assert.deepEqual(b.props, { nombre_producto: 'ISCert' });      // id rellenó el vacío
});
