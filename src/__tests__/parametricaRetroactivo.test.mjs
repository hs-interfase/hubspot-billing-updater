// node --test src/__tests__/parametricaRetroactivo.test.mjs
//
// Ajuste retroactivo de pago único: parseo del mes, cálculo del importe y
// cuándo NO corresponde. Los ejemplos de la usuaria (4-ago-2026) están abajo
// como casos con nombre.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMesAjuste, etiquetaMes, mesesEntre, calcularRetroactivo,
  evaluarRetroactivo, descripcionRetro, NOMBRE_LI_RETRO,
} from '../services/parametrica/retroactivo.js';

const HOY = '2026-08-04';

// ── Parseo del mes ───────────────────────────────────────────

test('acepta las formas en que la gente escribe el mes', () => {
  for (const txt of ['julio 2026', 'Julio 2026', 'jul 2026', 'julio de 2026',
    '07/2026', '7-2026', '2026-07', '2026/07']) {
    const r = parseMesAjuste(txt, HOY);
    assert.ok(r.ok, `no parseó "${txt}": ${r.error}`);
    assert.equal(r.ym, '2026-07', `mal parseado "${txt}"`);
    assert.equal(r.desde, '2026-07-01');
  }
});

test('setiembre y septiembre son lo mismo', () => {
  assert.equal(parseMesAjuste('setiembre 2025', HOY).ym, '2025-09');
  assert.equal(parseMesAjuste('septiembre 2025', HOY).ym, '2025-09');
});

test('el mes en curso vale — es el caso de "ya salió la factura de este mes"', () => {
  const r = parseMesAjuste('agosto 2026', HOY);
  assert.ok(r.ok);
  assert.equal(r.ym, '2026-08');
});

test('un mes futuro se rechaza', () => {
  const r = parseMesAjuste('setiembre 2026', HOY);
  assert.equal(r.ok, false);
  assert.match(r.error, /futuro/);
});

test('un mes demasiado viejo se rechaza (freno al dedazo en el año)', () => {
  assert.equal(parseMesAjuste('julio 2020', HOY).ok, false);
  assert.equal(parseMesAjuste('julio 2025', HOY, 24).ok, true);   // 13 meses, entra
});

test('basura y vacío se rechazan con un mensaje entendible', () => {
  assert.equal(parseMesAjuste('', HOY).ok, false);
  assert.equal(parseMesAjuste(null, HOY).ok, false);
  assert.match(parseMesAjuste('cualquier cosa', HOY).error, /escribí el mes y el año/);
  assert.equal(parseMesAjuste('13/2026', HOY).ok, false);
});

test('etiquetaMes devuelve el mes en castellano', () => {
  assert.equal(etiquetaMes('2026-07'), 'julio 2026');
  assert.equal(etiquetaMes('2026-01'), 'enero 2026');
  assert.equal(etiquetaMes('2026-09'), 'setiembre 2026');
});

test('mesesEntre cruza el fin de año', () => {
  assert.equal(mesesEntre('2025-11', '2026-02'), 3);
  assert.equal(mesesEntre('2026-08', '2026-08'), 0);
});

// ── Importe ──────────────────────────────────────────────────

test('el puntual conserva la cantidad y acumula la diferencia en el precio', () => {
  // 5000 → 5021,32 (+0,4264%, el ejemplo real de Petróleo), 3 unidades, 2 períodos
  const r = calcularRetroactivo({ priceViejo: 5000, priceNuevo: 5021.32, cantidad: 3, periodos: 2 });
  assert.equal(r.deltaUnitario, 21.32);
  assert.equal(r.precio, 42.64);      // 21,32 × 2 períodos
  assert.equal(r.importe, 127.92);    // × 3 unidades
});

test('sin períodos no hay importe', () => {
  const r = calcularRetroactivo({ priceViejo: 100, priceNuevo: 110, cantidad: 2, periodos: 0 });
  assert.equal(r.precio, 0);
  assert.equal(r.importe, 0);
});

test('un ajuste negativo devuelve plata (importe negativo)', () => {
  const r = calcularRetroactivo({ priceViejo: 100, priceNuevo: 88, cantidad: 1, periodos: 3 });
  assert.equal(r.deltaUnitario, -12);
  assert.equal(r.importe, -36);
});

test('redondea a 2 decimales y no arrastra el error', () => {
  const r = calcularRetroactivo({ priceViejo: 33.33, priceNuevo: 35.92, cantidad: 7, periodos: 3 });
  assert.equal(r.deltaUnitario, 2.59);
  assert.equal(r.precio, 7.77);
  assert.equal(r.importe, 54.39);
});

test('cantidad ausente o cero cuenta como 1', () => {
  assert.equal(calcularRetroactivo({ priceViejo: 100, priceNuevo: 110, periodos: 1 }).importe, 10);
  assert.equal(calcularRetroactivo({ priceViejo: 100, priceNuevo: 110, cantidad: 0, periodos: 1 }).importe, 10);
});

// ── Cuándo corresponde ───────────────────────────────────────

test('corresponde cuando hay períodos, diferencia y próxima fecha', () => {
  assert.deepEqual(
    evaluarRetroactivo({ periodos: 2, proximaFecha: '2026-09-01', deltaUnitario: 21.32 }),
    { aplica: true }
  );
});

test('no corresponde si no salió ninguna factura en el período', () => {
  const r = evaluarRetroactivo({ periodos: 0, proximaFecha: '2026-09-01', deltaUnitario: 21.32 });
  assert.equal(r.aplica, false);
  assert.equal(r.motivo, 'sin_facturas_en_el_periodo');
});

test('no corresponde si el line item no tiene próxima fecha a la que engancharse', () => {
  const r = evaluarRetroactivo({ periodos: 2, proximaFecha: null, deltaUnitario: 21.32 });
  assert.equal(r.aplica, false);
  assert.equal(r.motivo, 'sin_proxima_fecha');
});

test('no corresponde si el ajuste no mueve el precio', () => {
  const r = evaluarRetroactivo({ periodos: 2, proximaFecha: '2026-09-01', deltaUnitario: 0 });
  assert.equal(r.aplica, false);
  assert.equal(r.motivo, 'sin_diferencia');
});

// ── Descripción ──────────────────────────────────────────────

test('la descripción se explica sola en la factura', () => {
  const d = descripcionRetro({
    servicio: 'Capacidad', mesLabel: 'julio 2026', periodos: 2,
    deltaUnitario: 21.32, moneda: 'UYU',
  });
  assert.match(d, /desde julio 2026/);
  assert.match(d, /2 períodos/);
  assert.match(d, /Capacidad/);
  assert.match(d, /\+UYU 21,32/);
});

test('un período va en singular y el signo negativo se ve', () => {
  const d = descripcionRetro({ servicio: 'Capacidad', mesLabel: 'julio 2026', periodos: 1, deltaUnitario: -5, moneda: '' });
  assert.match(d, /1 período /);
  assert.match(d, /−5,00/);
});

test('el nombre del line item es el que pidió la usuaria', () => {
  assert.equal(NOMBRE_LI_RETRO, 'Ajuste retroactivo de pago único');
});
