// node --test src/__tests__/updateLineItemScheduleBuffer.test.mjs
//
// PARIDAD flag OFF vs flag ON del buffer en updateLineItemSchedule (billingEngine):
// por cada rama disparable por props, se corre la función dos veces sobre line items
// idénticos — una con buffer enabled:false (modo inmediato = comportamiento previo)
// y otra con enabled:true + flush — y se comparan las props escritas por LI y la
// mutación en memoria. Deben ser idénticas.
//
// Los clientes son fakes inyectados al buffer: nada toca la red.

// billingEngine importa hubspotClient → db.js, que exige DATABASE_URL al cargar.
// Dummy que jamás se conecta (ningún camino de este test toca el client global).
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@127.0.0.1:1/dummy';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLineItemWriteBuffer } from '../services/lineItems/lineItemWriteBuffer.js';

const { updateLineItemSchedule } = await import('../billingEngine.js');

function makeFakeClient() {
  const calls = { basic: [], batch: [] };
  return {
    calls,
    crm: {
      lineItems: {
        basicApi: {
          async update(id, body) {
            calls.basic.push({ id: String(id), properties: body.properties });
            return {};
          },
        },
        batchApi: {
          async update(body) {
            calls.batch.push(body.inputs.map(i => ({ id: String(i.id), properties: i.properties })));
            return {};
          },
        },
      },
    },
  };
}

// Consolida lo escrito por LI (merge en orden), sin importar el transporte.
function writtenById(fake) {
  const out = new Map();
  for (const c of fake.calls.basic) {
    out.set(c.id, { ...(out.get(c.id) || {}), ...c.properties });
  }
  for (const chunk of fake.calls.batch) {
    for (const c of chunk) {
      out.set(c.id, { ...(out.get(c.id) || {}), ...c.properties });
    }
  }
  return Object.fromEntries(out);
}

async function runParity(name, buildLineItem) {
  const fakeOff = makeFakeClient();
  const fakeOn = makeFakeClient();

  const liOff = buildLineItem();
  const liOn = buildLineItem();

  const bufOff = createLineItemWriteBuffer({ hubspotClient: fakeOff, enabled: false });
  const bufOn = createLineItemWriteBuffer({ hubspotClient: fakeOn, enabled: true });

  await updateLineItemSchedule(liOff, { dealId: 'D1', dealName: 'Deal Test', writeBuffer: bufOff });
  await updateLineItemSchedule(liOn, { dealId: 'D1', dealName: 'Deal Test', writeBuffer: bufOn });
  await bufOn.flush();

  const writtenOff = writtenById(fakeOff);
  const writtenOn = writtenById(fakeOn);

  assert.deepEqual(writtenOn, writtenOff, `${name}: props escritas difieren entre flag on y off`);
  assert.deepEqual(liOn.properties, liOff.properties, `${name}: mutación en memoria difiere`);
  assert.ok(Object.keys(writtenOff).length > 0, `${name}: la rama no escribió nada (test mal armado)`);

  return { writtenOff, writtenOn };
}

test('paridad: rama fechas_completas=true → billing_next_date vacío', async () => {
  const { writtenOff } = await runParity('fechas_completas', () => ({
    id: '101',
    properties: {
      fechas_completas: 'true',
      billing_next_date: '2026-09-01',
    },
  }));
  assert.deepEqual(writtenOff['101'], { billing_next_date: '' });
});

test('paridad: rama irregular puntual → set billing_next_date + limpia billing_error', async () => {
  const { writtenOff } = await runParity('irregular_puntual', () => ({
    id: '102',
    properties: {
      irregular: 'true',
      fecha_irregular_puntual: '2026-03-15',
      billing_error: 'algo viejo',
    },
  }));
  assert.deepEqual(writtenOff['102'], { billing_next_date: '2026-03-15', billing_error: '' });
});

test('paridad: rama pago único con startDate', async () => {
  const { writtenOff } = await runParity('pago_unico', () => ({
    id: '103',
    properties: {
      hs_recurring_billing_start_date: '2026-05-10',
      // sin frecuencia → pago único
    },
  }));
  const w = writtenOff['103'];
  assert.equal(w.recurringbillingstartdate, '2026-05-10');
  assert.equal(w.billing_next_date, '2026-05-10');
  assert.equal(w.billing_error, '');
});

test('paridad: rama recurrente anchor-based (monthly)', async () => {
  const { writtenOff } = await runParity('recurrente_anchor', () => ({
    id: '104',
    properties: {
      recurringbillingfrequency: 'monthly',
      hs_recurring_billing_start_date: '2026-01-15',
    },
  }));
  const w = writtenOff['104'];
  // Props estructurales de la rama (el valor exacto de next depende de "hoy",
  // pero la paridad on/off ya se assertó en runParity con el mismo "hoy").
  assert.equal(w.billing_error, '');
  assert.equal(w.recurringbillingstartdate, '2026-01-15');
  assert.equal(w.billing_anchor_date, '2026-01-15');
  assert.ok('billing_next_date' in w, 'debe calcular billing_next_date');
});

test('paridad: dos LIs seguidos con flag on → 1 solo batch con ambos', async () => {
  const fake = makeFakeClient();
  const buf = createLineItemWriteBuffer({ hubspotClient: fake, enabled: true });

  const li1 = { id: '201', properties: { fechas_completas: 'true', billing_next_date: 'x' } };
  const li2 = { id: '202', properties: { irregular: 'true', fecha_irregular_puntual: '2026-04-01' } };

  await updateLineItemSchedule(li1, { dealId: 'D1', writeBuffer: buf });
  await updateLineItemSchedule(li2, { dealId: 'D1', writeBuffer: buf });

  assert.equal(fake.calls.basic.length, 0);
  await buf.flush();

  assert.equal(fake.calls.batch.length, 1, 'los 2 LIs deben salir en un único request batch');
  assert.equal(fake.calls.batch[0].length, 2);
});

// NOTA (sin test): el default defensivo "sin writeBuffer en dealContext → modo
// inmediato aunque la env flag esté prendida" está garantizado por construcción
// en billingEngine.js (dealContext.writeBuffer ?? createLineItemWriteBuffer({enabled:false})).
// No se testea acá porque ejercitarlo requeriría el hubspotClient global real
// (= tráfico de red desde el test).
