// node --test src/__tests__/parametricaConteoPeriodos.test.mjs
//
// Qué tickets cuentan como "factura que ya salió al precio viejo".
// Es el corazón de la regla que definió la usuaria: el ticket ES la factura,
// así que el momento de facturación (el 1° vs fin de mes) ya está en su fecha
// y no hay que recalcular ningún calendario.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { hubspotClient } from '../hubspotClient.js';
import { contarPeriodosFacturados } from '../services/parametrica/parametricaService.js';

// Stages de mentira: el set real sale del .env, acá se inyecta.
const FACTURADOS = new Set(['FACTURADA', 'PAGA']);
const ticket = (stage, fecha, extra = {}) => ({
  properties: { hs_pipeline_stage: stage, fecha_resolucion_esperada: fecha, ...extra },
});

function stubTickets(porLineItem) {
  return mock.method(hubspotClient.crm.tickets.searchApi, 'doSearch', async (body) => {
    const filtro = body.filterGroups[0].filters.find(f => f.propertyName === 'of_line_item_ids');
    return { results: porLineItem[filtro.value] || [] };
  });
}

test('cuenta sólo los tickets que llegaron a facturarse', async (t) => {
  const stub = stubTickets({
    LI1: [
      ticket('FACTURADA', '2026-07-01'),
      ticket('PAGA', '2026-08-01'),
      ticket('PROXIMOS', '2026-09-01'),   // todavía no salió → no cuenta
    ],
  });
  t.after(() => stub.mock.restore());

  const out = await contarPeriodosFacturados(['LI1'], '2026-07-01', '2026-08-04', FACTURADOS);
  assert.equal(out.get('LI1').facturados, 2);
  assert.equal(out.get('LI1').pendientes, 1);
});

test('EJEMPLO mensual el 1°: ajuste de julio, hoy 4-ago → 2 períodos', async (t) => {
  const stub = stubTickets({ LI1: [ticket('FACTURADA', '2026-07-01'), ticket('FACTURADA', '2026-08-01')] });
  t.after(() => stub.mock.restore());

  const out = await contarPeriodosFacturados(['LI1'], '2026-07-01', '2026-08-04', FACTURADOS);
  assert.equal(out.get('LI1').facturados, 2, 'el de agosto ya salió al precio viejo');
});

test('EJEMPLO fin de mes: ajuste de junio, hoy mitad de agosto → 2 períodos', async (t) => {
  // El de agosto (31-ago) todavía no salió y va a salir ya ajustado.
  const stub = stubTickets({
    LI1: [ticket('FACTURADA', '2026-06-30'), ticket('FACTURADA', '2026-07-31'), ticket('PROXIMOS', '2026-08-31')],
  });
  t.after(() => stub.mock.restore());

  const out = await contarPeriodosFacturados(['LI1'], '2026-06-01', '2026-08-15', FACTURADOS);
  assert.equal(out.get('LI1').facturados, 2);
});

test('las notas de crédito no cuentan como factura del período', async (t) => {
  const stub = stubTickets({
    LI1: [ticket('FACTURADA', '2026-07-01'), ticket('FACTURADA', '2026-07-15', { nc: 'true' })],
  });
  t.after(() => stub.mock.restore());

  const out = await contarPeriodosFacturados(['LI1'], '2026-07-01', '2026-08-04', FACTURADOS);
  assert.equal(out.get('LI1').facturados, 1);
});

test('un line item sin tickets en el período da 0 y no rompe', async (t) => {
  const stub = stubTickets({});
  t.after(() => stub.mock.restore());

  const out = await contarPeriodosFacturados(['LI9'], '2026-07-01', '2026-08-04', FACTURADOS);
  assert.deepEqual(out.get('LI9'), { facturados: 0, pendientes: 0 });
});

test('la ventana se pide a HubSpot como GTE/LTE sobre la fecha de facturación', async (t) => {
  const stub = stubTickets({ LI1: [] });
  t.after(() => stub.mock.restore());

  await contarPeriodosFacturados(['LI1'], '2026-07-01', '2026-08-04', FACTURADOS);
  const filtros = stub.mock.calls[0].arguments[0].filterGroups[0].filters;
  assert.deepEqual(
    filtros.filter(f => f.propertyName === 'fecha_resolucion_esperada'),
    [
      { propertyName: 'fecha_resolucion_esperada', operator: 'GTE', value: '2026-07-01' },
      { propertyName: 'fecha_resolucion_esperada', operator: 'LTE', value: '2026-08-04' },
    ]
  );
});

test('si HubSpot falla, ese line item queda sin retroactivo en vez de romper el lote', async (t) => {
  const stub = mock.method(hubspotClient.crm.tickets.searchApi, 'doSearch', async () => {
    throw new Error('429 rate limit');
  });
  t.after(() => stub.mock.restore());

  const out = await contarPeriodosFacturados(['LI1'], '2026-07-01', '2026-08-04', FACTURADOS);
  assert.equal(out.get('LI1').facturados, 0);
  assert.match(out.get('LI1').error, /429/);
});
