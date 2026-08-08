// src/__tests__/billingErrorAcumulado.test.mjs
//
// of_billing_error acumula los avisos del MISMO DÍA en vez de pisarlos.
//
// El caso que motiva el cambio: el aviso al ticket espejo duraba ~5 segundos.
// La copia al LI espejo dispara un webhook por ese LI, cuyo li_prop_sync escribe
// el aviso al responsable en la MISMA propiedad — y con el comportamiento viejo
// lo tapaba. El aviso del espejo sobrevivía sólo cuando no había habido copia,
// o sea justo cuando menos falta hacía.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  acumularBillingError,
  parseEntradasBillingError,
  writeTicketBillingError,
} from '../services/notifications/dealAlerts.js';

const HOY = '2026-08-06';

// ── El acumulador puro ───────────────────────────────────────────────────────

test('propiedad vacía → queda sólo la entrada nueva', () => {
  const r = acumularBillingError('', '2026-08-06 12:00:00 — primero', HOY);
  assert.equal(r, '2026-08-06 12:00:00 — primero');
});

test('EL CASO DEL ESPEJO: el segundo aviso NO pisa al primero del mismo día', () => {
  const espejo = '2026-08-06 12:00:00 — Cambio en el negocio original PY — revisar el espejo UY';
  const r = acumularBillingError(espejo, '2026-08-06 12:00:05 — El vendedor modificó el elemento de pedido', HOY);

  assert.equal(
    r,
    '2026-08-06 12:00:05 — El vendedor modificó el elemento de pedido\n' +
    '2026-08-06 12:00:00 — Cambio en el negocio original PY — revisar el espejo UY'
  );
  // Lo que antes se perdía sigue estando:
  assert.ok(r.includes('revisar el espejo UY'));
});

test('el más nuevo va arriba, siempre', () => {
  let v = '';
  for (const t of ['12:00:00', '12:00:05', '12:00:09']) {
    v = acumularBillingError(v, `2026-08-06 ${t} — aviso ${t}`, HOY);
  }
  assert.deepEqual(v.split('\n').map((l) => l.slice(11, 19)), ['12:00:09', '12:00:05', '12:00:00']);
});

test('día nuevo → el bloque arranca limpio (no crece sin techo)', () => {
  const ayer =
    '2026-08-05 23:00:00 — aviso de ayer\n' +
    '2026-08-05 22:00:00 — otro de ayer';
  const r = acumularBillingError(ayer, '2026-08-06 09:00:00 — aviso de hoy', HOY);

  assert.equal(r, '2026-08-06 09:00:00 — aviso de hoy');
  assert.ok(!r.includes('ayer'));
});

test('mezcla de días → sobreviven sólo las de hoy', () => {
  const previo =
    '2026-08-06 09:00:00 — de hoy\n' +
    '2026-08-05 23:00:00 — de ayer';
  const r = acumularBillingError(previo, '2026-08-06 10:00:00 — nuevo', HOY);

  assert.equal(r, '2026-08-06 10:00:00 — nuevo\n2026-08-06 09:00:00 — de hoy');
});

test('tope de entradas: se quedan las N más nuevas', () => {
  let v = '';
  for (let i = 0; i < 25; i++) {
    v = acumularBillingError(v, `2026-08-06 12:00:${String(i).padStart(2, '0')} — aviso ${i}`, HOY);
  }
  const lineas = v.split('\n');
  assert.equal(lineas.length, 20);
  assert.ok(lineas[0].includes('aviso 24'));
  assert.ok(!v.includes('aviso 4 '));
});

// ── El parser ────────────────────────────────────────────────────────────────

test('el corte de día usa BILLING_TZ, no UTC', () => {
  // 2026-08-07 01:00 UTC son todavía las 22:00 del 6-ago en Montevideo (-3).
  const [e] = parseEntradasBillingError('2026-08-07 01:00:00 — tarde en Montevideo');
  assert.equal(e.ymd, '2026-08-06');

  // Y por lo tanto ese aviso se acumula con los del 6, no arranca bloque nuevo.
  const r = acumularBillingError('2026-08-07 01:00:00 — tarde en Montevideo', '2026-08-07 01:30:00 — otro', HOY);
  assert.equal(r.split('\n').length, 2);
});

test('un mensaje de varias líneas no se parte en entradas falsas', () => {
  const previo = '2026-08-06 12:00:00 — encabezado\n   detalle indentado\n   más detalle';
  const entradas = parseEntradasBillingError(previo);

  assert.equal(entradas.length, 1);
  assert.ok(entradas[0].texto.includes('más detalle'));
});

test('texto escrito a mano (sin timestamp) se conserva como entrada sin fecha', () => {
  const entradas = parseEntradasBillingError('esto lo escribió alguien a mano');
  assert.equal(entradas.length, 1);
  assert.equal(entradas[0].ymd, '');
});

test('texto sin timestamp NO sobrevive al corte de día (no tiene fecha que lo salve)', () => {
  const r = acumularBillingError('nota vieja a mano', '2026-08-06 12:00:00 — nuevo', HOY);
  assert.equal(r, '2026-08-06 12:00:00 — nuevo');
});

// ── writeTicketBillingError de punta a punta ─────────────────────────────────

test('writeTicketBillingError lee lo previo y escribe el acumulado', async () => {
  const escrito = [];
  await writeTicketBillingError('T1', 'aviso nuevo', {
    getTicketFn: async () => ({ properties: { of_billing_error: '2026-08-06 08:00:00 — aviso previo' } }),
    updateTicketFn: async (id, props) => escrito.push({ id, props }),
    hoyYMD: HOY,
  });

  assert.equal(escrito.length, 1);
  assert.equal(escrito[0].id, 'T1');
  assert.ok(escrito[0].props.of_billing_error.includes('aviso nuevo'));
  assert.ok(escrito[0].props.of_billing_error.includes('aviso previo'));
});

test('si la LECTURA falla, igual se escribe el aviso nuevo (no se pierde)', async () => {
  const escrito = [];
  await writeTicketBillingError('T2', 'aviso que no se puede perder', {
    getTicketFn: async () => { throw new Error('429 rate limit'); },
    updateTicketFn: async (id, props) => escrito.push({ id, props }),
    hoyYMD: HOY,
  });

  assert.equal(escrito.length, 1);
  assert.ok(escrito[0].props.of_billing_error.includes('aviso que no se puede perder'));
});

test('si la ESCRITURA falla, no lanza (fire-and-forget, no bloquea el sync)', async () => {
  await assert.doesNotReject(
    writeTicketBillingError('T3', 'x', {
      getTicketFn: async () => ({ properties: {} }),
      updateTicketFn: async () => { throw new Error('500'); },
      hoyYMD: HOY,
    })
  );
});

test('el valor SIEMPRE cambia → el workflow de HubSpot sigue disparando', async () => {
  // Mismo mensaje dos veces seguidas: el timestamp lo hace distinto igual.
  const escrito = [];
  const deps = {
    getTicketFn: async () => ({ properties: { of_billing_error: escrito.at(-1)?.props.of_billing_error || '' } }),
    updateTicketFn: async (id, props) => escrito.push({ id, props }),
    hoyYMD: HOY,
  };

  await writeTicketBillingError('T4', 'mensaje repetido', deps);
  await writeTicketBillingError('T4', 'mensaje repetido', deps);

  assert.equal(escrito.length, 2);
  assert.notEqual(escrito[0].props.of_billing_error, escrito[1].props.of_billing_error);
});
