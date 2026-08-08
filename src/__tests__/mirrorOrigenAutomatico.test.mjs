// src/__tests__/mirrorOrigenAutomatico.test.mjs
//
// LA MARCA DEL ORIGEN — `of_origen_facturacion_automatica` (7-ago-2026).
//
// El espejo UY se fuerza a manual (dealMirroring.js: `facturacion_automatica =
// 'false'`), así que su propio checkbox ya no dice nada del original y sus
// tickets caían en la rama "manual = asociar todo". La marca sella cómo factura
// la línea PY de origen y recorre esta cadena:
//
//   LI PY  facturacion_automatica
//     → LI espejo  of_origen_facturacion_automatica   (dealMirroring)
//     → ticket     of_origen_facturacion_automatica   (snapshotService)
//     → regla de asociación                           (associateOnClosedWon)
//
// El último eslabón se prueba en associateOnClosedWon.test.mjs. Acá van los
// tres primeros: el sello, el paso al ticket y que la lectura del LI la pida.
//
//   DATABASE_URL='postgres://u:p@localhost:5432/x' node --test src/__tests__/mirrorOrigenAutomatico.test.mjs

process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/x';

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(import.meta.dirname, '..');

const { extractLineItemSnapshots } = await import('../services/snapshotService.js');

const li = (props = {}) => ({ id: 'LI1', properties: { quantity: '1', price: '10', ...props } });
const deal = (props = {}) => ({ id: 'D1', properties: { ...props } });

// ── Eslabón 2: LI espejo → ticket ───────────────────────────────────────────

test('el ticket hereda la marca del line item espejo', () => {
  const snap = extractLineItemSnapshots(
    li({ of_origen_facturacion_automatica: 'true', facturacion_automatica: 'false' }),
    deal({ es_mirror_de_py: 'true' })
  );
  assert.equal(snap.of_origen_facturacion_automatica, 'true');
  assert.equal(snap.facturacion_automatica, 'false', 'el espejo sigue siendo manual');
});

test('espejo de un MANUAL: la marca viaja en false', () => {
  const snap = extractLineItemSnapshots(
    li({ of_origen_facturacion_automatica: 'false', facturacion_automatica: 'false' }),
    deal({ es_mirror_de_py: 'true' })
  );
  assert.equal(snap.of_origen_facturacion_automatica, 'false');
});

test('line item que NO es espejo: la marca queda vacía', () => {
  const snap = extractLineItemSnapshots(
    li({ facturacion_automatica: 'true' }),
    deal()
  );
  assert.equal(snap.of_origen_facturacion_automatica, '');
  assert.equal(snap.facturacion_automatica, 'true', 'un automático normal no se toca');
});

test('la marca NO pisa facturacion_automatica del ticket', () => {
  // Un automático normal (no espejo) tiene que seguir naciendo automático,
  // aunque alguien deje la marca sucia en el line item.
  const snap = extractLineItemSnapshots(
    li({ facturacion_automatica: 'true', of_origen_facturacion_automatica: 'false' }),
    deal()
  );
  assert.equal(snap.facturacion_automatica, 'true');
  assert.equal(snap.of_origen_facturacion_automatica, 'false');
});

// ── Eslabón 1: el sello en dealMirroring ────────────────────────────────────
//
// mirrorDealToUruguay es una función con mucho I/O (crea el deal espejo, lee
// asociaciones, hace upsert de líneas); montarle un doble completo para
// verificar UNA prop cuesta más de lo que aporta. La prueba es estructural:
// que el sello esté escrito junto al forzado a manual, que salga del line item
// ORIGEN (srcPropsLi) y no del espejo, y que se normalice a 'true'/'false'.

const dealMirroringSrc = readFileSync(join(SRC, 'dealMirroring.js'), 'utf8');

test('dealMirroring sella la marca desde el line item ORIGEN', () => {
  assert.match(
    dealMirroringSrc,
    /props\.of_origen_facturacion_automatica\s*=[\s\S]{0,200}?srcPropsLi\.facturacion_automatica/,
    'el sello debe leer facturacion_automatica del LI de origen (srcPropsLi)'
  );
});

test('dealMirroring normaliza la marca a true/false, no copia el crudo', () => {
  const bloque = /props\.of_origen_facturacion_automatica\s*=([\s\S]{0,300}?);/.exec(dealMirroringSrc);
  assert.ok(bloque, 'no se encontró la asignación del sello');
  assert.match(bloque[1], /'true'/, "debe producir 'true'");
  assert.match(bloque[1], /'false'/, "debe producir 'false'");
});

test('dealMirroring sigue forzando el espejo a manual', () => {
  // Si esto se cayera, la marca sobraría y la regla de asociación cambiaría de
  // sentido: el espejo pasaría a ser automático de verdad.
  assert.match(
    dealMirroringSrc,
    /props\.facturacion_automatica\s*=\s*'false'/,
    'el espejo UY tiene que seguir naciendo manual'
  );
});

// ── Eslabón 0: la lectura del line item ─────────────────────────────────────

test('la marca se pide al leer los line items (si no, llega siempre vacía)', () => {
  const hubspotClientSrc = readFileSync(join(SRC, 'hubspotClient.js'), 'utf8');
  assert.match(hubspotClientSrc, /['"]of_origen_facturacion_automatica['"]/);
});

test('la marca se pide en el Search de tickets de la asociación', () => {
  const assocSrc = readFileSync(join(SRC, 'services/tickets/associateOnClosedWon.js'), 'utf8');
  const props = /properties:\s*\[([\s\S]*?)\]/.exec(assocSrc);
  assert.ok(props, 'no se encontró la lista de properties del Search');
  assert.match(props[1], /of_origen_facturacion_automatica/);
});

// ── condiciones_de_pago y tipo_de_venta: la cadena LI → ticket (8-ago) ───────
//
// Las dos son props REALES de los dos portales que el motor no estaba copiando:
//   · `condiciones_de_pago` — el código usaba el SINGULAR, que no existe en ningún
//     objeto. safeUpdateTicket borraba la prop desconocida del payload y reintentaba,
//     así que la escritura "andaba" y el valor nunca llegaba: la fila «Condición de
//     Pago» salía vacía en los dos mensajes.
//   · `tipo_de_venta` — se movió del negocio al line item el 7-ago; faltaba el
//     último tramo, que viaje al ticket como el resto.
// Ninguna de las dos estaba tampoco en la lista de lectura de line items, así que
// el snapshot las veía undefined aun con el nombre bien escrito.

test('el ticket hereda condiciones_de_pago del line item (PLURAL)', () => {
  const snap = extractLineItemSnapshots(
    li({ condiciones_de_pago: '30 días de fecha factura' }),
    deal()
  );
  assert.equal(snap.condiciones_de_pago, '30 días de fecha factura');
});

test('el ticket hereda tipo_de_venta del line item', () => {
  const snap = extractLineItemSnapshots(li({ tipo_de_venta: 'Cross Selling' }), deal());
  assert.equal(snap.tipo_de_venta, 'Cross Selling');
});

test('sin valor en el line item, las dos quedan vacías (no undefined)', () => {
  const snap = extractLineItemSnapshots(li(), deal());
  assert.equal(snap.condiciones_de_pago, '');
  assert.equal(snap.tipo_de_venta, '');
});

test('el snapshot ya NO produce la clave en singular', () => {
  const snap = extractLineItemSnapshots(
    li({ condiciones_de_pago: 'Contado', condicion_de_pago: 'basura vieja' }),
    deal()
  );
  assert.equal('condicion_de_pago' in snap, false, 'el singular no existe en ningún portal');
  assert.equal(snap.condiciones_de_pago, 'Contado');
});

test('las dos se piden al leer los line items', () => {
  const hubspotClientSrc = readFileSync(join(SRC, 'hubspotClient.js'), 'utf8');
  assert.match(hubspotClientSrc, /["']condiciones_de_pago["']/);
  assert.match(hubspotClientSrc, /["']tipo_de_venta["']/);
  assert.ok(
    !/["']condicion_de_pago["']/.test(hubspotClientSrc),
    'no debe quedar el singular en la lista de lectura'
  );
});

test('las dos están en el mapa de escucha LI→ticket, y el singular no', () => {
  const syncSrc = readFileSync(join(SRC, 'services/lineItems/syncLineItemPropToTicket.js'), 'utf8');
  assert.match(syncSrc, /condiciones_de_pago:\s*\['condiciones_de_pago'\]/);
  assert.match(syncSrc, /tipo_de_venta:\s*\['tipo_de_venta'\]/);
  assert.ok(
    !/\bcondicion_de_pago\b/.test(syncSrc),
    'no debe quedar ninguna referencia al singular'
  );
});

test('los dos mensajes leen la clave en plural', () => {
  for (const f of ['services/billing/buildMensajeFacturacion.js', 'services/billing/buildMensajeMantsoft.js']) {
    const src = readFileSync(join(SRC, f), 'utf8');
    assert.match(src, /condiciones_de_pago/, `${f} debe leer el plural`);
    assert.ok(!/\bcondicion_de_pago\b/.test(src), `${f} no debe leer el singular`);
  }
});
