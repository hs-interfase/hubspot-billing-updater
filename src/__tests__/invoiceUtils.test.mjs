// src/__tests__/invoiceUtils.test.mjs
//
// countActivePlanInvoices endurecido (prep cancelar/revertir, §6 del control de
// cambios): dedupe por of_invoice_key (una refacturación del mismo período no
// cuenta doble), paginación del search y error → null ("desconocido", el caller
// decide; phase3/sweepAutoBacklog hace fail-closed).
//
// No toca HubSpot ni la DB (client falso inyectado). Requiere DATABASE_URL dummy
// (el grafo de imports carga src/db.js vía hubspotClient). Correr con:
//   DATABASE_URL='postgres://u:p@localhost:5432/x' node --test src/__tests__/invoiceUtils.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@127.0.0.1:1/dummy';

const { countActivePlanInvoices } = await import('../utils/invoiceUtils.js');

function fakeClient(pages, { onCall } = {}) {
  // pages: array de respuestas doSearch (se sirven en orden)
  let call = 0;
  return {
    crm: {
      objects: {
        searchApi: {
          doSearch: async (objectType, body) => {
            assert.equal(objectType, 'invoices');
            if (onCall) onCall(call, body);
            const resp = pages[Math.min(call, pages.length - 1)];
            call++;
            return resp;
          },
        },
      },
    },
  };
}

const inv = (etapa, key) => ({ properties: { etapa_de_la_factura: etapa, of_invoice_key: key } });

test('dedupe por of_invoice_key: refacturación del mismo período cuenta una vez', async () => {
  const client = fakeClient([{
    results: [
      inv('Emitida', 'D1::LIK::2026-07-01'),
      inv('Pendiente', 'D1::LIK::2026-07-01'), // refacturada, misma key
      inv('Paga', 'D1::LIK::2026-06-01'),
      inv('Cancelada', 'D1::LIK::2026-05-01'), // cancelada no cuenta
    ],
  }]);

  const count = await countActivePlanInvoices('LIK', { client });
  assert.equal(count, 2, 'dos keys únicas activas (la cancelada no cuenta)');
});

test('facturas sin of_invoice_key cuentan individualmente', async () => {
  const client = fakeClient([{
    results: [
      inv('Emitida', ''),          // sin key
      inv('Emitida', undefined),   // sin key
      inv('Emitida', '  '),        // key vacía tras trim
      inv('Emitida', 'K1'),
      inv('Enviada', 'K1'),        // dup de K1
    ],
  }]);

  const count = await countActivePlanInvoices('LIK', { client });
  assert.equal(count, 4, '3 sin key (individuales) + 1 key única');
});

test('pagina con paging.next.after y dedupea entre páginas', async () => {
  const page1 = {
    results: [
      ...Array.from({ length: 99 }, (_, i) => inv('Emitida', `K${i}`)),
      inv('Emitida', 'REPETIDA'),
    ],
    paging: { next: { after: '100' } },
  };
  const page2 = {
    results: [
      inv('Emitida', 'REPETIDA'), // misma key que en página 1
      inv('Cancelada', 'K-CANC'),
      inv('Paga', 'K-NUEVA'),
    ],
    // sin paging → fin
  };

  const bodies = [];
  const client = fakeClient([page1, page2], { onCall: (i, body) => bodies.push(body) });

  const count = await countActivePlanInvoices('LIK', { client });

  assert.equal(bodies.length, 2, 'dos llamadas al search');
  assert.equal(bodies[0].after, undefined, 'primera página sin cursor');
  assert.equal(bodies[1].after, '100', 'segunda página con after de la primera');
  assert.equal(bodies[0].limit, 100);
  // 99 K-únicas + REPETIDA (1 sola vez) + K-NUEVA; la cancelada no cuenta
  assert.equal(count, 101);
});

test('error del search → null (desconocido, el caller decide)', async () => {
  const client = {
    crm: { objects: { searchApi: { doSearch: async () => { throw new Error('boom 502'); } } } },
  };

  const count = await countActivePlanInvoices('LIK', { client });
  assert.equal(count, null);
});

test('sin resultados → 0', async () => {
  const client = fakeClient([{ results: [] }]);
  assert.equal(await countActivePlanInvoices('LIK', { client }), 0);
});
