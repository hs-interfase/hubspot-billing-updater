// src/__tests__/liSyncTicketAlert.test.mjs
//
// Aviso al responsable del ticket por sync quirúrgico LI→ticket.
// SIN correo (decisión usuaria 25-jul): solo of_billing_error del ticket
// (dispara el workflow de HubSpot que crea la tarea al owner).
// Todo con deps FAKES inyectadas — nada toca HubSpot.
//
// Llave LI_SYNC_OWNER_ALERT_ENABLED: misma semántica que DEAL_ALERTS_ENABLED
// (ausente/vacía = prendida; 'false'/'0'/'no' = apagada), evaluada por llamada.
//
// Requiere DATABASE_URL dummy (el grafo de imports puede cargar src/db.js).
//   DATABASE_URL='postgres://u:p@localhost:5432/x' node --test src/__tests__/liSyncTicketAlert.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@127.0.0.1:1/dummy';

const { avisarResponsableTicketPorSyncLI, liSyncAlertasApagadas } =
  await import('../services/notifications/liSyncTicketAlert.js');

function makeDeps({ writeThrows = false } = {}) {
  const writes = [];
  return {
    writes,
    deps: {
      writeTicketErrorFn: async (ticketId, msg) => {
        if (writeThrows) throw new Error('boom-write');
        writes.push({ ticketId, msg });
      },
    },
  };
}

const BASE = {
  ticketId: 'T1',
  ticketOwnerId: 'OWN1',
  lineItemId: 'LI9',
  lineItemName: 'Servicio X',
  propertyName: 'price',
  patch: { monto_unitario_real: 100, of_margen: 60 },
  dealId: 'D7',
};

test('flag off (false/0/no) → skipped sin llamadas de red', async () => {
  for (const v of ['false', '0', 'no']) {
    process.env.LI_SYNC_OWNER_ALERT_ENABLED = v;
    const { writes, deps } = makeDeps();
    const r = await avisarResponsableTicketPorSyncLI(BASE, deps);
    assert.deepEqual(r, { notified: false, reason: 'LI_SYNC_OWNER_ALERT_ENABLED=false' });
    assert.equal(writes.length, 0);
    assert.equal(liSyncAlertasApagadas('test'), true);
  }
  process.env.LI_SYNC_OWNER_ALERT_ENABLED = '';
});

test('flag ausente/vacía = prendida (no apagar por accidente)', () => {
  delete process.env.LI_SYNC_OWNER_ALERT_ENABLED;
  assert.equal(liSyncAlertasApagadas('test'), false);
  process.env.LI_SYNC_OWNER_ALERT_ENABLED = '';
  assert.equal(liSyncAlertasApagadas('test'), false);
});

test('camino feliz: escribe of_billing_error del ticket con el mensaje completo', async () => {
  delete process.env.LI_SYNC_OWNER_ALERT_ENABLED;
  const { writes, deps } = makeDeps();
  const r = await avisarResponsableTicketPorSyncLI(BASE, deps);

  assert.deepEqual(r, { notified: true });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].ticketId, 'T1');
  assert.match(writes[0].msg, /El vendedor modificó el elemento de pedido "Servicio X" \(LI9\)/);
  assert.match(writes[0].msg, /propiedad price/);
  assert.match(writes[0].msg, /monto_unitario_real="100", of_margen="60"/);
  assert.match(writes[0].msg, /Verificá los datos antes de facturar\./);
});

test('sin owner: escribe la prop igual (el workflow resuelve el owner), no lanza', async () => {
  delete process.env.LI_SYNC_OWNER_ALERT_ENABLED;
  const { writes, deps } = makeDeps();
  const r = await avisarResponsableTicketPorSyncLI({ ...BASE, ticketOwnerId: null }, deps);

  assert.deepEqual(r, { notified: true });
  assert.equal(writes.length, 1);
});

test('writeTicketErrorFn que lanza: NO lanza, devuelve reason=error', async () => {
  delete process.env.LI_SYNC_OWNER_ALERT_ENABLED;
  const { deps } = makeDeps({ writeThrows: true });
  const r = await avisarResponsableTicketPorSyncLI(BASE, deps);

  assert.deepEqual(r, { notified: false, reason: 'error' });
});

test('lineItemName ausente: usa el id como nombre', async () => {
  delete process.env.LI_SYNC_OWNER_ALERT_ENABLED;
  const { writes, deps } = makeDeps();
  const r = await avisarResponsableTicketPorSyncLI({ ...BASE, lineItemName: null }, deps);

  assert.equal(r.notified, true);
  assert.match(writes[0].msg, /elemento de pedido "LI9" \(LI9\)/);
});
