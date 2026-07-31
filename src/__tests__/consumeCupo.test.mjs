// src/__tests__/consumeCupo.test.mjs
//
// Prueba el cálculo puro de consumo de cupo, con foco en NOTAS DE CRÉDITO.
// Regla clave: una NC se detecta por el SIGNO NEGATIVO del consumo (no por la
// marca `nc`), y DEVUELVE cupo (resta a cupo_consumido, suma a cupo_restante).
//
// Correr con:  node --test src/__tests__/consumeCupo.test.mjs
//
// No toca HubSpot: calcularConsumoCupo es una función pura sobre properties.
// El último bloque prueba consumeCupoAfterInvoice con el hubspotClient
// parcheado en memoria (el SDK cachea crm/deals/basicApi, así que el patch
// pega) — tampoco toca HubSpot; requiere DATABASE_URL dummy porque el grafo
// de imports carga src/db.js.

process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/x';

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { calcularConsumoCupo, consumeCupoAfterInvoice } = await import('../services/cupo/consumeCupo.js');
const { hubspotClient } = await import('../hubspotClient.js');

// ---------- Cupo Por Monto ----------

test('Por Monto: consumo positivo resta del cupo restante', () => {
  const r = calcularConsumoCupo({
    tipoCupo: 'Por Monto',
    dealProps: { cupo_total_monto: '1000', cupo_consumido: '200' },
    ticketProps: { subtotal_real: '300' },
  });
  assert.equal(r.ok, true);
  assert.equal(r.consumo, 300);
  assert.equal(r.cupoConsumidoNuevo, 500);   // 200 + 300
  assert.equal(r.cupoRestanteNuevo, 500);    // 1000 - 500
  assert.equal(r.cupoDeactivated, false);
});

test('NC Por Monto: subtotal_real negativo DEVUELVE cupo (resta consumido)', () => {
  const r = calcularConsumoCupo({
    tipoCupo: 'Por Monto',
    dealProps: { cupo_total_monto: '1000', cupo_consumido: '500' },
    ticketProps: { subtotal_real: '-300' },   // nota de crédito
  });
  assert.equal(r.ok, true);
  assert.equal(r.consumo, -300);
  assert.equal(r.cupoConsumidoNuevo, 200);   // 500 + (-300) → devuelve 300
  assert.equal(r.cupoRestanteNuevo, 800);    // 1000 - 200
  assert.equal(r.cupoDeactivated, false);
});

// ---------- Cupo Por Horas ----------

test('Por Horas: usa total_de_horas_consumidas cuando la cantidad es positiva', () => {
  const r = calcularConsumoCupo({
    tipoCupo: 'Por Horas',
    dealProps: { cupo_total: '40', cupo_consumido: '10' },
    ticketProps: { total_de_horas_consumidas: '8', cantidad_real: '8' },
  });
  assert.equal(r.ok, true);
  assert.equal(r.consumo, 8);
  assert.equal(r.cupoConsumidoNuevo, 18);
  assert.equal(r.cupoRestanteNuevo, 22);
});

test('NC Por Horas: cantidad_real negativa manda aunque las horas vengan positivas', () => {
  // Escenario de edición manual: el ticket viejo trae horas=8 pero se corrige la
  // cantidad_real a -8 para acreditar. El signo negativo debe primar.
  const r = calcularConsumoCupo({
    tipoCupo: 'Por Horas',
    dealProps: { cupo_total: '40', cupo_consumido: '18' },
    ticketProps: { total_de_horas_consumidas: '8', cantidad_real: '-8' },
  });
  assert.equal(r.ok, true);
  assert.equal(r.consumo, -8);               // el negativo prima sobre las horas
  assert.equal(r.cupoConsumidoNuevo, 10);    // 18 + (-8)
  assert.equal(r.cupoRestanteNuevo, 30);     // 40 - 10
});

// ---------- Agotamiento / desactivación ----------

test('cupoDeactivated=true cuando el restante llega a 0 o menos', () => {
  const r = calcularConsumoCupo({
    tipoCupo: 'Por Monto',
    dealProps: { cupo_total_monto: '1000', cupo_consumido: '900' },
    ticketProps: { subtotal_real: '150' },   // 900 + 150 = 1050 > 1000
  });
  assert.equal(r.ok, true);
  assert.equal(r.cupoRestanteNuevo, -50);
  assert.equal(r.cupoDeactivated, true);
});

// ---------- Validaciones (consumo inválido) ----------

test('consumo 0 es inválido (no consume)', () => {
  const r = calcularConsumoCupo({
    tipoCupo: 'Por Monto',
    dealProps: { cupo_total_monto: '1000', cupo_consumido: '0' },
    ticketProps: { subtotal_real: '0' },
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /consumo inválido/);
});

test('tipo_de_cupo desconocido es rechazado', () => {
  const r = calcularConsumoCupo({
    tipoCupo: 'Por Banana',
    dealProps: {},
    ticketProps: {},
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /tipo_de_cupo desconocido/);
});

// ---------- SOBRE-CRÉDITO NC: valor fiel + señal (sin pisar) ----------

test('NC mayor a lo consumido: cupo_consumido queda negativo (fiel) y marca cupoSobreCredito', () => {
  // Sobre-crédito (acreditar más de lo consumido): el valor real es negativo y se
  // conserva TAL CUAL (es la evidencia y reconcilia si se corrige). Solo se señaliza
  // cupoSobreCredito para que el caller avise (probable error de carga de la NC).
  const r = calcularConsumoCupo({
    tipoCupo: 'Por Monto',
    dealProps: { cupo_total_monto: '1000', cupo_consumido: '100' },
    ticketProps: { subtotal_real: '-300' },   // acredita más de lo consumido
  });
  assert.equal(r.ok, true);
  assert.equal(r.cupoConsumidoNuevo, -200);  // 100 + (-300) → fiel, sin pisar
  assert.equal(r.cupoRestanteNuevo, 1200);   // 1000 - (-200)
  assert.equal(r.cupoSobreCredito, true);
});

test('NC dentro de lo consumido: sin sobre-crédito (cupoSobreCredito=false)', () => {
  const r = calcularConsumoCupo({
    tipoCupo: 'Por Monto',
    dealProps: { cupo_total_monto: '1000', cupo_consumido: '500' },
    ticketProps: { subtotal_real: '-300' },   // acredita menos de lo consumido
  });
  assert.equal(r.ok, true);
  assert.equal(r.cupoConsumidoNuevo, 200);   // 500 + (-300)
  assert.equal(r.cupoRestanteNuevo, 800);
  assert.equal(r.cupoSobreCredito, false);
});

// ---------- Historial (of_cupo_historial) en el update del ticket ----------

test('consumeCupoAfterInvoice: el update del ticket appendea la línea de consumo a of_cupo_historial', async () => {
  // Monkey-patch del singleton (el SDK cachea client.crm/.deals/.basicApi, y el
  // proxy de retry escribe/lee sobre esos objetos cacheados → el patch pega).
  const ticketUpdates = [];
  const dealUpdates = [];

  hubspotClient.crm.deals.basicApi.getById = async () => ({
    properties: {
      cupo_activo: 'true', tipo_de_cupo: 'Por Monto', cupo_consumido: '200',
      cupo_restante: '800', cupo_total: '', cupo_total_monto: '1000',
      cupo_umbral: '', cupo_estado: 'Ok',
    },
  });
  hubspotClient.crm.tickets.basicApi.getById = async () => ({
    properties: {
      subtotal_real: '300', cupo_consumo_invoice_id: '', of_cupo_consumido: '',
      of_cupo_historial: '2026-07-01 | consumo | 100 | invoice INV-0',
    },
  });
  hubspotClient.crm.lineItems.basicApi.getById = async () => ({
    properties: { parte_del_cupo: 'true' },
  });
  hubspotClient.crm.deals.basicApi.update = async (id, body) => { dealUpdates.push(body); };
  hubspotClient.crm.tickets.basicApi.update = async (id, body) => { ticketUpdates.push(body); };

  const r = await consumeCupoAfterInvoice({
    dealId: 'D1', ticketId: 'T1', lineItemId: 'LI1', invoiceId: 'INV-1',
  });

  assert.equal(r.consumed, true);
  assert.equal(r.consumo, 300);
  assert.equal(dealUpdates.length, 1);

  // El historial va DENTRO del mismo update existente del ticket (sin writes nuevos)
  // y NO cambia el resto de las props del consumo.
  assert.equal(ticketUpdates.length, 1);
  const props = ticketUpdates[0].properties;
  assert.equal(props.of_cupo_consumido, 'true');
  assert.equal(props.of_cupo_consumo_valor, '300');
  assert.equal(props.cupo_consumo_invoice_id, 'INV-1');

  const hist = props.of_cupo_historial;
  assert.match(hist, /^2026-07-01 \| consumo \| 100 \| invoice INV-0\n/);   // lo previo se conserva
  assert.match(hist, /\n\d{4}-\d{2}-\d{2} \| consumo \| 300 \| invoice INV-1$/); // la línea nueva, última
});
