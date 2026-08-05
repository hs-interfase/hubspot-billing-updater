// node --test src/__tests__/parametricaConteoPeriodos.test.mjs
//
// Qué pagos cuentan como "ya salieron al precio viejo".
//
// La regla es POR FECHA (definición de la usuaria, 4-ago-2026): el ticket ES
// la factura, así que el momento de facturación ya está en su fecha.
//   · adelantado / mes vencido caen el 1° → el mes en curso SIEMPRE cuenta.
//   · fin de mes es el único relativo → cuenta sólo si ese día ya pasó.
// Comparar la fecha del ticket con hoy resuelve los dos casos.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { hubspotClient } from '../hubspotClient.js';
import { contarPagosDelPeriodo, mesesDesde } from '../services/parametrica/parametricaService.js';

// Stages de mentira: los reales salen del .env, acá se inyectan.
const FACTURADOS = new Set(['FACTURADA', 'PAGA']);
const CANCELADO = 'CANCELADO';
const deps = { stagesFacturados: FACTURADOS, esCancelado: (s) => s === CANCELADO };

const ticket = (stage, fecha, extra = {}) => ({
  properties: { hs_pipeline_stage: stage, fecha_resolucion_esperada: fecha, ...extra },
});

/**
 * Simula el search de HubSpot: además de filtrar por line item, APLICA la
 * ventana de fechas del request. Sin eso el stub devolvería tickets que el
 * backend real nunca ve, y los ejemplos de fin de mes no probarían nada.
 */
function stubTickets(porLineItem) {
  return mock.method(hubspotClient.crm.tickets.searchApi, 'doSearch', async (body) => {
    const filtros = body.filterGroups[0].filters;
    const val = (op) => filtros.find(f => f.propertyName === 'fecha_resolucion_esperada' && f.operator === op)?.value;
    const desde = val('GTE');
    const hasta = val('LTE');
    const liId = filtros.find(f => f.propertyName === 'of_line_item_ids').value;

    const results = (porLineItem[liId] || []).filter(t => {
      const f = t.properties.fecha_resolucion_esperada;
      return (!desde || f >= desde) && (!hasta || f <= hasta);
    });
    return { results };
  });
}

test('EJEMPLO mensual el 1°: ajuste de julio, hoy 4-ago → 2 pagos', async (t) => {
  const stub = stubTickets({ LI1: [ticket('FACTURADA', '2026-07-01'), ticket('FACTURADA', '2026-08-01')] });
  t.after(() => stub.mock.restore());

  const out = await contarPagosDelPeriodo(['LI1'], '2026-07-01', '2026-08-04', deps);
  assert.equal(out.get('LI1').pagos, 2, 'el de agosto ya salió al precio viejo');
});

test('EJEMPLO mensual el 1°: cuenta el mes en curso AUNQUE hoy sea el 1°', async (t) => {
  const stub = stubTickets({ LI1: [ticket('FACTURADA', '2026-07-01'), ticket('PROXIMOS', '2026-08-01')] });
  t.after(() => stub.mock.restore());

  // Hoy ES el 1-ago: el ticket de agosto ya está y cuenta como retroactivo,
  // esté o no marcado como facturado todavía.
  const out = await contarPagosDelPeriodo(['LI1'], '2026-07-01', '2026-08-01', deps);
  assert.equal(out.get('LI1').pagos, 2);
  assert.equal(out.get('LI1').sinFacturar, 1, 'se informa que uno todavía no facturó');
});

test('EJEMPLO fin de mes: a mitad de agosto el de agosto NO cuenta', async (t) => {
  const stub = stubTickets({
    LI1: [ticket('FACTURADA', '2026-06-30'), ticket('FACTURADA', '2026-07-31'), ticket('PROXIMOS', '2026-08-31')],
  });
  t.after(() => stub.mock.restore());

  // El de 31-ago queda fuera de la ventana [desde, hoy]: va a salir ya ajustado.
  const out = await contarPagosDelPeriodo(['LI1'], '2026-06-01', '2026-08-15', deps);
  assert.equal(out.get('LI1').pagos, 2);
});

test('fin de mes: pasado el día de facturación, ese mes SÍ cuenta', async (t) => {
  const stub = stubTickets({ LI1: [ticket('FACTURADA', '2026-07-31'), ticket('FACTURADA', '2026-08-31')] });
  t.after(() => stub.mock.restore());

  const out = await contarPagosDelPeriodo(['LI1'], '2026-07-01', '2026-09-02', deps);
  assert.equal(out.get('LI1').pagos, 2);
});

test('los cancelados no cuentan: no hubo factura', async (t) => {
  const stub = stubTickets({ LI1: [ticket('FACTURADA', '2026-07-01'), ticket(CANCELADO, '2026-08-01')] });
  t.after(() => stub.mock.restore());

  const out = await contarPagosDelPeriodo(['LI1'], '2026-07-01', '2026-08-04', deps);
  assert.equal(out.get('LI1').pagos, 1);
});

test('las notas de crédito tampoco cuentan', async (t) => {
  const stub = stubTickets({
    LI1: [ticket('FACTURADA', '2026-07-01'), ticket('FACTURADA', '2026-07-15', { nc: 'true' })],
  });
  t.after(() => stub.mock.restore());

  const out = await contarPagosDelPeriodo(['LI1'], '2026-07-01', '2026-08-04', deps);
  assert.equal(out.get('LI1').pagos, 1);
});

test('un line item sin tickets en el período da 0 y no rompe', async (t) => {
  const stub = stubTickets({});
  t.after(() => stub.mock.restore());

  const out = await contarPagosDelPeriodo(['LI9'], '2026-07-01', '2026-08-04', deps);
  assert.deepEqual(out.get('LI9'), { pagos: 0, sinFacturar: 0 });
});

test('la ventana se pide a HubSpot como GTE/LTE sobre la fecha de facturación', async (t) => {
  const stub = stubTickets({ LI1: [] });
  t.after(() => stub.mock.restore());

  await contarPagosDelPeriodo(['LI1'], '2026-07-01', '2026-08-04', deps);
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

  const out = await contarPagosDelPeriodo(['LI1'], '2026-07-01', '2026-08-04', deps);
  assert.equal(out.get('LI1').pagos, 0);
  assert.match(out.get('LI1').error, /429/);
});

// ── Meses sin ajustar ────────────────────────────────────────

test('mesesDesde cuenta meses ENTEROS', () => {
  assert.equal(mesesDesde('2026-02-10', '2026-08-04'), 5);   // todavía no se cumplieron los 6
  assert.equal(mesesDesde('2026-02-04', '2026-08-04'), 6);
  assert.equal(mesesDesde('2026-02-01', '2026-08-04'), 6);
  assert.equal(mesesDesde('2025-08-04', '2026-08-04'), 12);
  assert.equal(mesesDesde('2026-08-04', '2026-08-04'), 0);
});

test('mesesDesde devuelve null si no hay fecha de ajuste', () => {
  assert.equal(mesesDesde(null, '2026-08-04'), null);
  assert.equal(mesesDesde('', '2026-08-04'), null);
  assert.equal(mesesDesde('cualquier cosa', '2026-08-04'), null);
});

test('mesesDesde tolera fechas con hora', () => {
  assert.equal(mesesDesde('2026-02-04T00:00:00Z', '2026-08-04'), 6);
});
