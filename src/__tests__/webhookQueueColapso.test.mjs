// src/__tests__/webhookQueueColapso.test.mjs
//
// Bug vivo en producción hasta el 1-ago-2026: `processNext` colapsaba los pending
// por `deal_id` + `action_type` sin mirar el objeto ni la propiedad. Como
// `li_prop_sync` se encola UNA VEZ POR PROPIEDAD y el worker sincroniza sólo esa,
// el job viejo quedaba `superseded` (un estado normal, sin error ni log de fallo)
// y esa edición nunca llegaba al ticket. El alcance era el NEGOCIO: también se
// comía la edición de otro line item del mismo deal.
//
// Correr con:  node --test src/__tests__/webhookQueueColapso.test.mjs
//
// No toca la base: todo lo que se prueba son funciones puras.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCollapseQuery,
  decideCollapse,
  collapsePolicyFor,
  COLLAPSE_NONE,
  COLLAPSE_BY_DEAL,
  COLLAPSE_BY_OBJECT_PROP,
} from '../utils/webhookQueueRules.js';

const SIN_ENV = {}; // sin el override WEBHOOK_QUEUE_COLLAPSE_BY_DEAL

let proximoId = 1;
function job({ actionType, dealId = '900', objectId = 'LI-1', propertyName = null }) {
  return {
    id: proximoId++,
    status: 'pending',
    deal_id: dealId,
    action_type: actionType,
    object_id: objectId,
    property_name: propertyName,
  };
}

/**
 * Espeja el WHERE del UPDATE que arma `buildCollapseQuery`, leyendo los params
 * por posición: si el query cambia de forma, esto rompe en vez de mentir.
 * Devuelve los ids que quedarían `superseded`.
 */
function colapsados(built, pendientes) {
  if (!built) return [];
  const [dealId, actionType, jobId, objectId, propertyName] = built.params;
  return pendientes
    .filter(r => r.status === 'pending')
    .filter(r => r.deal_id === dealId)
    .filter(r => r.action_type === actionType)
    .filter(r => r.id < jobId)
    .filter(r => built.scope !== COLLAPSE_BY_OBJECT_PROP || (
      // IS NOT DISTINCT FROM: null contra null matchea
      r.object_id === objectId && (r.property_name ?? null) === (propertyName ?? null)
    ))
    .map(r => r.id);
}

// ─── §6 · Los tres escenarios que cierran la tarea ───────────────────────────

test('REGRESIÓN (el bug): dos li_prop_sync del mismo LI con props distintas → NINGUNO se colapsa', () => {
  const viejo = job({ actionType: 'li_prop_sync', objectId: 'LI-1', propertyName: 'description' });
  const nuevo = job({ actionType: 'li_prop_sync', objectId: 'LI-1', propertyName: 'price' });

  const built = buildCollapseQuery(nuevo, SIN_ENV);
  assert.deepEqual(colapsados(built, [viejo]), [],
    'la edición de `description` tiene que sobrevivir: el worker sincroniza sólo `price`');
});

test('CROSS-LINE-ITEM: dos li_prop_sync del mismo negocio en LI distintos → NINGUNO se colapsa', () => {
  const viejo = job({ actionType: 'li_prop_sync', objectId: 'LI-1', propertyName: 'price' });
  const nuevo = job({ actionType: 'li_prop_sync', objectId: 'LI-2', propertyName: 'price' });

  const built = buildCollapseQuery(nuevo, SIN_ENV);
  assert.deepEqual(colapsados(built, [viejo]), [],
    'la clave era el NEGOCIO: el LI-1 se perdía aunque fuera otro objeto');
});

test('NO ROMPER LO QUE FUNCIONA: dos valor_recalc del mismo deal → el viejo SIGUE colapsando', () => {
  const viejo = job({ actionType: 'valor_recalc', objectId: 'LI-1', propertyName: 'recurringbillingfrequency' });
  const nuevo = job({ actionType: 'valor_recalc', objectId: 'LI-2', propertyName: 'hs_recurring_billing_number_of_payments' });

  const built = buildCollapseQuery(nuevo, SIN_ENV);
  assert.equal(built.scope, COLLAPSE_BY_DEAL);
  assert.deepEqual(colapsados(built, [viejo]), [viejo.id],
    'recalcValorTotal lee todo el deal: el último hace el trabajo de los dos');
});

// ─── li_prop_sync: lo que SÍ tiene que seguir colapsando ─────────────────────

test('mismo LI y MISMA prop editada dos veces → el viejo colapsa (el último valor es el bueno)', () => {
  const viejo = job({ actionType: 'li_prop_sync', objectId: 'LI-1', propertyName: 'price' });
  const nuevo = job({ actionType: 'li_prop_sync', objectId: 'LI-1', propertyName: 'price' });

  const built = buildCollapseQuery(nuevo, SIN_ENV);
  assert.deepEqual(colapsados(built, [viejo]), [viejo.id]);
});

test('con tres pendientes sólo colapsa el que comparte objeto Y propiedad', () => {
  const mismaProp = job({ actionType: 'li_prop_sync', objectId: 'LI-1', propertyName: 'price' });
  const otraProp  = job({ actionType: 'li_prop_sync', objectId: 'LI-1', propertyName: 'description' });
  const otroLi    = job({ actionType: 'li_prop_sync', objectId: 'LI-2', propertyName: 'price' });
  const nuevo     = job({ actionType: 'li_prop_sync', objectId: 'LI-1', propertyName: 'price' });

  const built = buildCollapseQuery(nuevo, SIN_ENV);
  assert.deepEqual(colapsados(built, [mismaProp, otraProp, otroLi]), [mismaProp.id]);
});

test('nunca colapsa un job MÁS NUEVO (id mayor) ni uno de otro negocio', () => {
  const otroDeal = job({ actionType: 'li_prop_sync', dealId: '901', objectId: 'LI-1', propertyName: 'price' });
  const nuevo    = job({ actionType: 'li_prop_sync', dealId: '900', objectId: 'LI-1', propertyName: 'price' });
  const posterior = job({ actionType: 'li_prop_sync', dealId: '900', objectId: 'LI-1', propertyName: 'price' });

  const built = buildCollapseQuery(nuevo, SIN_ENV);
  assert.deepEqual(colapsados(built, [otroDeal, posterior]), []);
});

// ─── product_reassign: tenía la MISMA trampa (verificado 1-ago contra main) ──

test('product_reassign de dos LI distintos del mismo negocio → NINGUNO se colapsa', () => {
  const viejo = job({ actionType: 'product_reassign', objectId: 'LI-1', propertyName: 'nombre_producto' });
  const nuevo = job({ actionType: 'product_reassign', objectId: 'LI-2', propertyName: 'nombre_producto' });

  const built = buildCollapseQuery(nuevo, SIN_ENV);
  assert.equal(built.scope, COLLAPSE_BY_OBJECT_PROP);
  assert.deepEqual(colapsados(built, [viejo]), [],
    'reassignLineItemProduct actúa sobre ESE line item con el valor del evento');
});

test('product_reassign del MISMO LI dos veces → el viejo colapsa (gana el último producto elegido)', () => {
  const viejo = job({ actionType: 'product_reassign', objectId: 'LI-1', propertyName: 'nombre_producto' });
  const nuevo = job({ actionType: 'product_reassign', objectId: 'LI-1', propertyName: 'nombre_producto' });

  assert.deepEqual(colapsados(buildCollapseQuery(nuevo, SIN_ENV), [viejo]), [viejo.id]);
});

// ─── Lo que NO está afectado: no romperlo al cambiar la clave ────────────────

test('cancelar/revertir van con deal_id null → siguen sin colapsarse (flujo del 30-jul intacto)', () => {
  for (const actionType of ['ticket_cancel_request', 'ticket_revert_request']) {
    const j = { ...job({ actionType }), deal_id: null };
    assert.equal(buildCollapseQuery(j, SIN_ENV), null, actionType);
    assert.equal(decideCollapse(j, SIN_ENV), null, actionType);
  }
});

test('los action_type de ticket NO colapsan por negocio ni aunque la fila trajera deal_id', () => {
  for (const actionType of ['urgent_ticket', 'ticket_update', 'ticket_cancel_request', 'ticket_revert_request']) {
    assert.equal(collapsePolicyFor(actionType, SIN_ENV), COLLAPSE_NONE, actionType);
    assert.equal(buildCollapseQuery(job({ actionType }), SIN_ENV), null, actionType);
  }
});

test('los derivados del estado conservan el colapso por negocio', () => {
  for (const actionType of ['recalc', 'valor_recalc', 'deal_cancel', 'ticket_label_sync', 'deal_prop_sync']) {
    assert.equal(collapsePolicyFor(actionType, SIN_ENV), COLLAPSE_BY_DEAL, actionType);
    assert.equal(buildCollapseQuery(job({ actionType }), SIN_ENV).params.length, 3, actionType);
  }
});

test('LISTA BLANCA: un action_type nuevo que nadie clasificó NO colapsa', () => {
  assert.equal(collapsePolicyFor('accion_del_futuro', SIN_ENV), COLLAPSE_NONE);
  assert.equal(buildCollapseQuery(job({ actionType: 'accion_del_futuro' }), SIN_ENV), null);
  assert.equal(collapsePolicyFor(undefined, SIN_ENV), COLLAPSE_NONE);
});

// ─── El query que se ejecuta de verdad ───────────────────────────────────────

test('específico del evento: el WHERE incluye object_id y property_name (IS NOT DISTINCT FROM)', () => {
  const j = job({ actionType: 'li_prop_sync', objectId: 'LI-7', propertyName: 'description' });
  const built = buildCollapseQuery(j, SIN_ENV);

  assert.match(built.text, /AND object_id = \$4/);
  assert.match(built.text, /AND property_name IS NOT DISTINCT FROM \$5/);
  assert.match(built.text, /SET status = 'superseded'/);
  assert.deepEqual(built.params, ['900', 'li_prop_sync', j.id, 'LI-7', 'description']);
});

test('derivado del estado: el WHERE NO menciona object_id ni property_name', () => {
  const j = job({ actionType: 'recalc', objectId: 'LI-7', propertyName: 'actualizar' });
  const built = buildCollapseQuery(j, SIN_ENV);

  assert.doesNotMatch(built.text, /object_id/);
  assert.doesNotMatch(built.text, /property_name/);
  assert.deepEqual(built.params, ['900', 'recalc', j.id]);
});

test('property_name null no rompe: colapsa contra otro null del mismo objeto', () => {
  const viejo = job({ actionType: 'li_prop_sync', objectId: 'LI-1', propertyName: null });
  const nuevo = job({ actionType: 'li_prop_sync', objectId: 'LI-1', propertyName: null });

  const built = buildCollapseQuery(nuevo, SIN_ENV);
  assert.equal(built.params[4], null);
  assert.deepEqual(colapsados(built, [viejo]), [viejo.id]);
});

// ─── La red de emergencia (env, no llave de encendido) ───────────────────────

test('WEBHOOK_QUEUE_COLLAPSE_BY_DEAL reemplaza el conjunto que colapsa por negocio', () => {
  const env = { WEBHOOK_QUEUE_COLLAPSE_BY_DEAL: 'recalc, li_prop_sync' };

  // li_prop_sync vuelve al comportamiento viejo (la válvula si la cola no da abasto)
  assert.equal(collapsePolicyFor('li_prop_sync', env), COLLAPSE_BY_DEAL);
  // y valor_recalc, que quedó fuera de la lista, deja de colapsar (lado seguro)
  assert.equal(collapsePolicyFor('valor_recalc', env), COLLAPSE_NONE);
  assert.equal(collapsePolicyFor('recalc', env), COLLAPSE_BY_DEAL);
});

test('el override no puede colar por negocio a un tipo específico del evento fuera de la lista', () => {
  const env = { WEBHOOK_QUEUE_COLLAPSE_BY_DEAL: 'recalc' };
  assert.equal(collapsePolicyFor('product_reassign', env), COLLAPSE_BY_OBJECT_PROP);
});

test('env vacía o ausente = la clasificación por defecto', () => {
  for (const env of [{}, { WEBHOOK_QUEUE_COLLAPSE_BY_DEAL: '' }, { WEBHOOK_QUEUE_COLLAPSE_BY_DEAL: '   ' }]) {
    assert.equal(collapsePolicyFor('li_prop_sync', env), COLLAPSE_BY_OBJECT_PROP);
    assert.equal(collapsePolicyFor('valor_recalc', env), COLLAPSE_BY_DEAL);
  }
});
