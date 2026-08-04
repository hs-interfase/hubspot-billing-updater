// node --test src/__tests__/parametricaSeleccion.test.mjs
//
// Buscador y elección de la empresa que factura en la pantalla de paramétricas.
// El buscador corre EN EL NAVEGADOR con este mismo módulo (el router lo sirve
// en /parametrica/api/filtros.js), así que lo que se prueba acá es lo que ve
// la usuaria.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizar, filaMatchea, filtrarFilas } from '../services/parametrica/filtros.js';
import { elegirCompanyFactura } from '../services/parametrica/empresaLookup.js';

const fila = (over = {}) => ({
  lineItemId: '1', clienteFactura: 'ANTEL S.A.', empresa: 'ANTEL', dealName: 'ANTEL — iJServ 2026',
  codigoEmpresa: '0001185', codigoContacto: '0001185', numeroContrato: 'C-1042', ...over,
});

test('normalizar: saca acentos, espacios y mayúsculas', () => {
  assert.equal(normalizar('  Petróleo ÁÉÍÓÚ Ñ  '), 'petroleo aeiou n');
  assert.equal(normalizar(null), '');
  assert.equal(normalizar(undefined), '');
});

test('nombre de empresa: subcadena, sin importar acentos ni mayúsculas', () => {
  assert.ok(filaMatchea(fila(), { nombreEmpresa: 'tel' }));
  assert.ok(filaMatchea(fila(), { nombreEmpresa: 'ANTEL' }));
  assert.ok(filaMatchea(fila({ clienteFactura: 'Petróleo del Sur' }), { nombreEmpresa: 'petroleo' }));
  assert.ok(!filaMatchea(fila(), { nombreEmpresa: 'ancap' }));
});

test('nombre de empresa: el nombre del NEGOCIO no cuenta', () => {
  // Si no, buscar "tel" traería un negocio llamado "Hotel …" de otro cliente.
  const f = fila({ clienteFactura: 'ANCAP', empresa: 'ANCAP', dealName: 'Hotel Carrasco — iJServ' });
  assert.ok(!filaMatchea(f, { nombreEmpresa: 'tel' }));
});

test('nombre de empresa: si no hay cliente factura, vale nombre_empresa del LI', () => {
  const f = fila({ clienteFactura: '', empresa: 'TELECOM' });
  assert.ok(filaMatchea(f, { nombreEmpresa: 'telecom' }));
});

test('código de empresa: con y sin los ceros a la izquierda', () => {
  assert.ok(filaMatchea(fila(), { codigoEmpresa: '0001185' }));
  assert.ok(filaMatchea(fila(), { codigoEmpresa: '1185' }));
  assert.ok(!filaMatchea(fila(), { codigoEmpresa: '9999' }));
});

test('código: el Codigo Contacto también matchea (comparten rango numérico)', () => {
  // BCP: nodum 0003137, contactos 0003828. Quien busca puede tener el otro.
  const bcp = fila({ codigoEmpresa: '0003137', codigoContacto: '0003828' });
  assert.ok(filaMatchea(bcp, { codigoEmpresa: '3137' }));
  assert.ok(filaMatchea(bcp, { codigoEmpresa: '3828' }));
});

test('número de contrato', () => {
  assert.ok(filaMatchea(fila(), { numeroContrato: '1042' }));
  assert.ok(filaMatchea(fila(), { numeroContrato: 'c-1042' }));
  assert.ok(!filaMatchea(fila(), { numeroContrato: '9999' }));
  // Sin la propiedad todavía creada, el campo no matchea nada.
  assert.ok(!filaMatchea(fila({ numeroContrato: '' }), { numeroContrato: '1' }));
});

test('los criterios se combinan con Y', () => {
  const f = fila();
  assert.ok(filaMatchea(f, { nombreEmpresa: 'antel', numeroContrato: '1042' }));
  assert.ok(!filaMatchea(f, { nombreEmpresa: 'antel', numeroContrato: '9999' }));
});

test('un criterio vacío o con espacios no filtra', () => {
  const filas = [fila(), fila({
    lineItemId: '2', clienteFactura: 'ANCAP', empresa: 'ANCAP',
    dealName: 'ANCAP — iJServ', codigoEmpresa: '0002', numeroContrato: '',
  })];
  assert.equal(filtrarFilas(filas, {}).length, 2);
  assert.equal(filtrarFilas(filas, { nombreEmpresa: '   ' }).length, 2);
  assert.equal(filtrarFilas(filas, { nombreEmpresa: 'tel' }).length, 1);
});

// ── Cliente factura ──────────────────────────────────────────

test('gana la etiqueta «Empresa Factura» sobre la company principal', () => {
  const tos = [
    { toObjectId: 111, associationTypes: [{ typeId: 5 }] },              // principal
    { toObjectId: 222, associationTypes: [{ typeId: 2 }] },              // empresa factura (default)
  ];
  assert.equal(elegirCompanyFactura(tos), '222');
});

test('sin etiqueta de factura cae a la company principal', () => {
  const tos = [
    { toObjectId: 111, associationTypes: [{ typeId: 5 }] },
    { toObjectId: 333, associationTypes: [{ typeId: 99 }] },
  ];
  assert.equal(elegirCompanyFactura(tos), '111');
});

test('sin etiquetas conocidas cae a la primera company', () => {
  assert.equal(elegirCompanyFactura([{ toObjectId: 777, associationTypes: [{ typeId: 99 }] }]), '777');
});

test('sin companies asociadas devuelve null', () => {
  assert.equal(elegirCompanyFactura([]), null);
  assert.equal(elegirCompanyFactura(), null);
});

test('tolera la forma associationSpec / associationTypeId de la v4', () => {
  const tos = [
    { toObjectId: 111, associationSpec: { associationTypeId: 5 } },
    { toObjectId: 222, associationSpec: { associationTypeId: 2 } },
  ];
  assert.equal(elegirCompanyFactura(tos), '222');
});
