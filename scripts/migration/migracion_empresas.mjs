#!/usr/bin/env node
// migracion_empresas.mjs
// Paso de empresas — Interfase -> HubSpot. De cero, blindado, dry-run por defecto.
// Zero-dependency (Node ESM). Código y logs en español.
//
// Lee el export de empresas con cabeceras canónicas (NombreFantasia, RazonSocial,
// IdFiscal, CodigoClienteNODUM, CodigoEmpresaContactos, GiroComercial, Pais,
// Estado-Depto, Ciudad, Direccion, CodigoPostal, Telefonos, WEB). Tolera valores
// formateados es ("1.308,00") y los limpia.
//
// Idempotencia y match por `codigo_empresa_contactos` (la MISMA clave con la que
// se asocia el negocio en únicos). Comportamiento UPSERT:
//   - existe y completa            -> saltear
//   - existe pero le faltan datos  -> PATCH (rellena SOLO campos vacíos; si estaba
//                                     datos_pendientes=true y se completó, lo apaga)
//   - no existe                    -> crear
//
// USO (PowerShell, parado en la raíz del repo con el .env):
//   1) Dry-run (no escribe; con token compara contra el portal y muestra el plan):
//        node scripts/migration/migracion_empresas.mjs <csv> <env>
//   2) Escritura real (crea props faltantes + upsert):
//        node scripts/migration/migracion_empresas.mjs <csv> <env> --write
//   3) DE CERO (borra TODAS las empresas del portal y recrea):
//        node scripts/migration/migracion_empresas.mjs <csv> sandbox --write --wipe --si-borrar-todo
//
//   <env> = sandbox | prod  ->  token desde HUBSPOT_PRIVATE_TOKEN / HUBSPOT_PROD_TOKEN (.env automático)

import fs from 'node:fs';

// ───────────────────────── args ─────────────────────────
const argv = process.argv.slice(2);
const flags = new Set(argv.filter(a => a.startsWith('--')));
const pos   = argv.filter(a => !a.startsWith('--'));
const DEFAULT_CSV = 'Contactos-Empresas_Con_Actividad-2026-06-02.csv';
const normEnv = v => { v = (v || '').toLowerCase(); return ['prod', 'produccion', 'production'].includes(v) ? 'prod' : v; };
let CSV, ENV;
if (pos.length === 1 && ['sandbox', 'prod'].includes(normEnv(pos[0]))) { CSV = DEFAULT_CSV; ENV = normEnv(pos[0]); }
else { CSV = pos[0]; ENV = normEnv(pos[1]); }
const WRITE = flags.has('--write');
const WIPE  = flags.has('--wipe');
const CREAR_TODO = WIPE || flags.has('--crear-todo'); // saltea el chequeo de existencia (post-wipe o borrado manual)

if (!CSV || !['sandbox', 'prod'].includes(ENV)) {
  console.error('Uso: node migracion_empresas.mjs [csv] <sandbox|prod|produccion> [--write] [--wipe --si-borrar-todo] [--crear-todo] [--recrear-rut] [--confirm-production]');
  console.error(`(si omitís el csv, usa "${DEFAULT_CSV}" en la carpeta actual)`);
  process.exit(1);
}

const BASE = 'https://api.hubapi.com';
const GRUPO_PROPS = 'companyinformation'; // grupo estándar; las props custom nuevas caen acá

// ───────────────────── parser CSV (RFC, zero-dep) ─────────────────────
function parseCSV(texto, sep = ';') {
  const filas = [];
  let campo = '', fila = [], enComillas = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (enComillas) {
      if (c === '"') { if (texto[i + 1] === '"') { campo += '"'; i++; } else enComillas = false; }
      else campo += c;
    } else {
      if (c === '"') enComillas = true;
      else if (c === sep) { fila.push(campo); campo = ''; }
      else if (c === '\n') { fila.push(campo); filas.push(fila); fila = []; campo = ''; }
      else if (c === '\r') { /* ignora CR */ }
      else campo += c;
    }
  }
  if (campo.length || fila.length) { fila.push(campo); filas.push(fila); }
  return filas.filter(f => f.length > 1 || (f.length === 1 && f[0] !== ''));
}

function leerOrigen(path) {
  const texto = fs.readFileSync(path, 'latin1');     // estos CSV son latin-1
  const filas = parseCSV(texto, ';');
  const header = filas[0].map(h => h.trim());
  return filas.slice(1).map(f => Object.fromEntries(header.map((h, i) => [h, (f[i] ?? '').trim()])));
}

// ───────────────────── limpieza de valores ─────────────────────
// Código: "1.308,00" -> "1308" ; "0002210" -> "0002210" (ya limpio) ; "" -> ""
function limpiarCodigo(v) {
  let s = String(v ?? '').trim();
  if (!s) return '';
  if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').split(',')[0];   // formato es: miles '.' + decimales ','
  return s.replace(/\D/g, '');                                       // solo dígitos (preserva ceros a la izquierda)
}
// Para COMPARAR códigos entre el CSV y el portal (sin ceros a la izquierda).
const normCode = (v) => String(v ?? '').replace(/\D/g, '').replace(/^0+/, '');
// Número formateado es (RUT/CP UY): "210.133.230.015,00" -> "210133230015". Si trae
// guión u otra cosa (RUT PY "80001788-9", CP no numérico) lo deja igual.
function desformatear(v) {
  const s = String(v ?? '').trim();
  if (/^[\d.]+,\d{1,2}$/.test(s)) return s.replace(/\./g, '').split(',')[0];
  return s;
}

// ───────────────────── normalización ─────────────────────
const PAIS_FIX = { 'URUGUAY': 'Uruguay', 'Gutemala': 'Guatemala' };
const PAISES_CONOCIDOS = new Set([
  'Uruguay', 'Paraguay', 'Argentina', 'Chile', 'Colombia', 'Bolivia', 'México',
  'Estados Unidos', 'Barbados', 'Honduras', 'República Dominicana', 'Jamaica', 'Guatemala',
]);
function normPais(v, anom) {
  let p = (v || '').trim();
  if (!p) return '';
  p = PAIS_FIX[p] || p;
  if (!PAISES_CONOCIDOS.has(p)) anom.push(`PAIS_REVISAR:${p}`);
  return p;
}
function splitTelefonos(v) { return (v || '').split(',').map(t => t.trim()).filter(Boolean); }
function dominioValido(d) {
  return /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i.test(d);
}
function extraerDominio(url) {
  if (!url) return '';
  let d = url.trim().replace(/^https?:\/\//i, '').replace(/^www\./i, '');
  d = d.split(/[\/?#,\s]/)[0].toLowerCase();
  return dominioValido(d) ? d : '';
}

function normalizarEmpresa(r) {
  const anom = [];
  const nombre = (r['NombreFantasia'] || '').trim() || (r['RazonSocial'] || '').trim();
  if (!nombre) anom.push('SIN_NOMBRE');

  const telefonos = splitTelefonos(r['Telefonos']);
  const props = {};
  const set = (k, v) => { if (v != null && String(v).trim() !== '') props[k] = String(v).trim(); };

  const codNodum = limpiarCodigo(r['CodigoClienteNODUM']);
  const codContactos = limpiarCodigo(r['CodigoEmpresaContactos']);

  set('name', nombre);
  set('razon_social', r['RazonSocial']);
  set('rut', desformatear(r['IdFiscal']));
  set('codigo_cliente_nodum', codNodum);
  set('codigo_empresa_contactos', codContactos);     // clave de idempotencia + match de deals
  set('giro_comercial', r['GiroComercial']);
  set('country', normPais(r['Pais'], anom));
  set('state', r['Estado-Depto']);
  set('city', r['Ciudad']);
  set('address', r['Direccion']);
  set('zip', desformatear(r['CodigoPostal']));
  const web = (r['WEB'] || '').trim();
  const dom = extraerDominio(web);
  set('domain', dom);
  if (dom) {
    const limpio = web.split(/[,\s]/)[0];
    set('website', /^https?:\/\//i.test(limpio) ? limpio : `https://${dom}`);
  }
  set('phone', telefonos[0]);
  telefonos.forEach((t, i) => set(`telefono_${i + 1}`, t));

  if (!codContactos) anom.push('SIN_CODIGO_EMPRESA_CONTACTOS');
  return { clave: normCode(codContactos), nombre, props, anomalias: anom, nTel: telefonos.length };
}

// ───────────────────── HubSpot API ─────────────────────
function cargarDotenv(path = '.env') {
  try {
    const buf = fs.readFileSync(path);
    let txt;
    if (buf[0] === 0xFF && buf[1] === 0xFE) txt = buf.toString('utf16le');
    else if (buf[0] === 0xFE && buf[1] === 0xFF) txt = buf.swap16().toString('utf16le');
    else txt = buf.toString('utf8');
    txt = txt.replace(/^﻿/, '');
    let n = 0;
    for (const linea of txt.split(/\r?\n/)) {
      const m = linea.match(/^\s*(?:export\s+)?([\w.-]+)\s*=\s*(.*)?$/);
      if (!m) continue;
      const k = m[1];
      const val = (m[2] || '').trim().replace(/^['"]|['"]$/g, '');
      if (!(k in process.env)) { process.env[k] = val; n++; }
    }
    return { encontrado: true, cargadas: n };
  } catch { return { encontrado: false, cargadas: 0 }; }
}

function resolverToken({ soft = false } = {}) {
  const info = cargarDotenv();
  const candidatos = ENV === 'prod'
    ? ['HUBSPOT_PROD_TOKEN', 'HUBSPOT_TOKEN', 'HUBSPOT_PRIVATE_TOKEN', 'HUBSPOT_ACCESS_TOKEN']
    : ['HUBSPOT_PRIVATE_TOKEN', 'HUBSPOT_SANDBOX_TOKEN', 'HUBSPOT_TOKEN', 'HUBSPOT_ACCESS_TOKEN', 'HUBSPOT_PRIVATE_APP_TOKEN'];
  for (const nombre of candidatos) {
    if (process.env[nombre]) { console.log(`  token tomado de: ${nombre}`); return process.env[nombre]; }
  }
  if (soft) { console.log('  (sin token; dry-run sin comparar contra el portal)'); return null; }
  console.error(`\nNo encontré el token. .env ${info.encontrado ? `leído (${info.cargadas} variables)` : 'NO está en la carpeta actual'}.`);
  const enEntorno = Object.keys(process.env).filter(k => /HUBSPOT|TOKEN/i.test(k));
  console.error('Variables que parecen de token:', enEntorno.length ? enEntorno.join(', ') : '(ninguna)');
  process.exit(1);
}
let TOKEN = null;

async function hs(path, { method = 'GET', body } = {}) {
  for (let intento = 0; intento < 5; intento++) {
    const res = await fetch(BASE + path, {
      method,
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429 || res.status >= 500) { await new Promise(r => setTimeout(r, 500 * (intento + 1))); continue; }
    const txt = await res.text();
    const data = txt ? JSON.parse(txt) : {};
    if (!res.ok) throw new Error(`HS ${res.status} ${path}: ${txt.slice(0, 300)}`);
    return data;
  }
  throw new Error(`HS reintentos agotados en ${path}`);
}

async function cargarPropsExistentes() {
  const schema = await hs('/crm/v3/properties/companies');
  return new Set(schema.results.map(p => p.name));
}

async function asegurarPropiedades(necesarias, existentes) {
  const aCrear = [...necesarias].filter(n => !existentes.has(n));
  for (const name of aCrear) {
    console.log(`  + creando propiedad faltante: ${name}`);
    await hs('/crm/v3/properties/companies', {
      method: 'POST',
      body: { name, label: name, type: 'string', fieldType: 'text', groupName: GRUPO_PROPS },
    });
    existentes.add(name);
  }
  if (!aCrear.length) console.log('  todas las propiedades necesarias ya existen.');
  return aCrear;
}

// Campos "rellenables" al completar incompletas (núcleo; no incluye telefono_N).
const FILL_PROPS = ['name', 'razon_social', 'rut', 'codigo_cliente_nodum', 'giro_comercial',
  'country', 'state', 'city', 'address', 'zip', 'domain', 'website', 'phone'];

// Trae TODAS las companies indexadas por codigo_empresa_contactos (normalizado).
async function cargarMapaEmpresas(propsExist) {
  const want = ['name', 'codigo_empresa_contactos', 'datos_pendientes', ...FILL_PROPS];
  const props = [...new Set(want)].filter(p => propsExist.has(p));
  const mapa = new Map();
  let after = null, guard = 0, total = 0, ambiguas = 0;
  do {
    const q = `/crm/v3/objects/companies?limit=100&properties=${props.join(',')}${after ? `&after=${after}` : ''}`;
    const data = await hs(q);
    for (const c of data.results || []) {
      total++;
      const k = normCode(c.properties?.codigo_empresa_contactos);
      if (!k) continue;
      if (mapa.has(k)) { ambiguas++; continue; }
      mapa.set(k, { id: c.id, props: c.properties || {} });
    }
    after = data.paging?.next?.after || null;
  } while (after && ++guard < 1000);
  return { mapa, total, ambiguas };
}

// Campos que faltan en la empresa existente y el CSV puede completar (solo vacíos).
function camposAFaltar(existProps, nuevos, propsExist) {
  const faltan = {};
  for (const k of FILL_PROPS) {
    if (!propsExist.has(k)) continue;                 // prop no existe en el portal → no la toco
    const nuevo = (nuevos[k] ?? '').toString().trim();
    if (!nuevo) continue;                             // el CSV no aporta ese dato
    const actual = (existProps[k] ?? '').toString().trim();
    if (actual === '') faltan[k] = nuevo;             // solo relleno vacíos (no piso datos existentes)
  }
  return faltan;
}

async function wipeTodas() {
  console.log('\n⚠️  WIPE — borrando TODAS las empresas del portal…');
  let after = null, ids = [];
  do {
    const q = `/crm/v3/objects/companies?limit=100${after ? `&after=${after}` : ''}`;
    const data = await hs(q);
    ids.push(...data.results.map(r => r.id));
    after = data.paging?.next?.after || null;
  } while (after);
  console.log(`  empresas a borrar: ${ids.length}`);
  for (let i = 0; i < ids.length; i += 100) {
    const lote = ids.slice(i, i + 100).map(id => ({ id }));
    await hs('/crm/v3/objects/companies/batch/archive', { method: 'POST', body: { inputs: lote } });
    console.log(`  borradas ${Math.min(i + 100, ids.length)}/${ids.length}`);
  }
}

// ───────────────────────── main ─────────────────────────
async function main() {
  console.log(`\n=== Paso empresas | env=${ENV} | ${WRITE ? 'ESCRITURA' : 'DRY-RUN'}${WIPE ? ' + WIPE' : ''} ===`);
  console.log(`CSV: ${CSV}\n`);

  const filas = leerOrigen(CSV);
  const empresas = filas.map(normalizarEmpresa);

  // dedup por codigo_empresa_contactos (normalizado)
  const vistos = new Set();
  const empresasUnicas = [];
  let colapsadas = 0;
  for (const e of empresas) {
    if (e.clave && vistos.has(e.clave)) { colapsadas++; continue; }
    if (e.clave) vistos.add(e.clave);
    empresasUnicas.push(e);
  }

  const conteoAnom = {};
  for (const e of empresasUnicas) for (const a of e.anomalias) {
    const k = a.split(':')[0]; conteoAnom[k] = (conteoAnom[k] || 0) + 1;
  }
  const maxTel = Math.max(0, ...empresasUnicas.map(e => e.nTel));
  const propsCustom = new Set([
    'razon_social', 'rut', 'codigo_cliente_nodum', 'codigo_empresa_contactos', 'giro_comercial',
    ...Array.from({ length: maxTel }, (_, i) => `telefono_${i + 1}`),
  ]);

  console.log(`Empresas leídas: ${empresas.length} (únicas por codigo_empresa_contactos: ${empresasUnicas.length}; ${colapsadas} duplicadas colapsadas)`);
  console.log(`Máximo de teléfonos en una empresa: ${maxTel} -> telefono_1..telefono_${maxTel}`);
  console.log('Anomalías:', Object.keys(conteoAnom).length ? conteoAnom : 'ninguna');

  fs.writeFileSync('empresas_objetos.json', JSON.stringify(empresasUnicas.map(e => ({ clave: e.clave, props: e.props })), null, 2));
  const md = ['# Anomalías empresas', '', ...empresasUnicas.filter(e => e.anomalias.length).map(e => `- ${e.clave} ${e.nombre} -> ${e.anomalias.join(', ')}`)];
  fs.writeFileSync('empresas_anomalias.md', md.join('\n'));
  console.log('Generado: empresas_objetos.json, empresas_anomalias.md\n');

  // ── token + estado del portal (para el plan upsert; en dry-run es opcional) ──
  TOKEN = resolverToken({ soft: !WRITE });
  let propsExist = null, mapaInfo = null;
  if (TOKEN && !CREAR_TODO) {
    propsExist = await cargarPropsExistentes();
    mapaInfo = await cargarMapaEmpresas(propsExist);
    console.log(`Empresas en el portal: ${mapaInfo.total} (con codigo_empresa_contactos: ${mapaInfo.mapa.size}${mapaInfo.ambiguas ? `, ${mapaInfo.ambiguas} claves repetidas` : ''})`);
  } else if (TOKEN && CREAR_TODO) {
    propsExist = await cargarPropsExistentes();
    console.log('Modo CREAR_TODO: no se chequea existencia (todo va a crear).');
  }

  // ── clasificar: crear / completar / saltear ──
  const planCrear = [], planCompletar = [], planSaltear = [], sinClave = [];
  for (const e of empresasUnicas) {
    if (!e.clave) { sinClave.push(e); continue; }
    if (CREAR_TODO || !mapaInfo) { planCrear.push(e); continue; }
    const ya = mapaInfo.mapa.get(e.clave);
    if (!ya) { planCrear.push(e); continue; }
    const faltan = camposAFaltar(ya.props, e.props, propsExist);
    const pend = String(ya.props.datos_pendientes).toLowerCase() === 'true';
    if (Object.keys(faltan).length) planCompletar.push({ e, id: ya.id, faltan, pend });
    else planSaltear.push(e);
  }

  if (TOKEN || CREAR_TODO) {
    console.log(`\n── Plan ── crear: ${planCrear.length} · completar: ${planCompletar.length} · saltear: ${planSaltear.length} · sin clave: ${sinClave.length}`);
    for (const x of planCompletar.slice(0, 8)) console.log(`  completar "${x.e.nombre}" (id ${x.id}): ${Object.keys(x.faltan).join(', ')}${x.pend ? '  [datos_pendientes→false]' : ''}`);
    if (planCompletar.length > 8) console.log(`  … y ${planCompletar.length - 8} más a completar`);
    for (const e of planCrear.slice(0, 8)) console.log(`  crear "${e.nombre}" (cod ${e.clave})`);
    if (planCrear.length > 8) console.log(`  … y ${planCrear.length - 8} más a crear`);
    if (sinClave.length) console.log(`  ⚠ ${sinClave.length} sin codigo_empresa_contactos → no se pueden ubicar (se saltean).`);
  }

  if (!WRITE) { console.log('\n[dry-run] No se escribió nada. Agregá --write para aplicar el plan.'); return; }

  // ── escritura real ──
  if (WIPE) {
    if (!flags.has('--si-borrar-todo')) { console.error('WIPE requiere --si-borrar-todo (doble confirmación).'); process.exit(1); }
    if (ENV === 'prod' && !flags.has('--confirm-production')) { console.error('WIPE en prod requiere --confirm-production.'); process.exit(1); }
    await wipeTodas();
  }
  if (flags.has('--recrear-rut')) {
    try { await hs('/crm/v3/properties/companies/rut', { method: 'DELETE' }); console.log('  propiedad rut borrada (se recreará como texto)'); }
    catch (e) { console.warn(`  no se pudo borrar rut: ${e.message}`); }
  }

  if (!propsExist) propsExist = await cargarPropsExistentes();
  await asegurarPropiedades(propsCustom, propsExist);

  let creadas = 0, completadas = 0, errores = 0;
  for (const e of planCrear) {
    try {
      if (!e.clave) continue;
      await hs('/crm/v3/objects/companies', { method: 'POST', body: { properties: e.props } });
      creadas++;
      if (creadas % 50 === 0) console.log(`  creadas ${creadas}…`);
    } catch (err) { errores++; console.error(`  ERROR crear ${e.clave} ${e.nombre}: ${err.message}`); }
  }
  for (const x of planCompletar) {
    try {
      const patch = { ...x.faltan };
      if (x.pend) patch.datos_pendientes = 'false';
      await hs(`/crm/v3/objects/companies/${x.id}`, { method: 'PATCH', body: { properties: patch } });
      completadas++;
      if (completadas % 50 === 0) console.log(`  completadas ${completadas}…`);
    } catch (err) { errores++; console.error(`  ERROR completar ${x.id} ${x.e.nombre}: ${err.message}`); }
  }
  console.log(`\nResultado: creadas=${creadas} completadas=${completadas} salteadas=${planSaltear.length} errores=${errores}`);
}

main().catch(e => { console.error(e); process.exit(1); });
