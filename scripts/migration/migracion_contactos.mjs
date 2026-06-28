#!/usr/bin/env node
// migracion_contactos.mjs
// Paso CONTACTOS (personas) — Interfase -> HubSpot. Zero-dependency (Node ESM). Dry-run por defecto.
// Migra las PERSONAS (PER_*) como contactos de HubSpot, asociadas a su(s) empresa(s) por
// codigo_empresa_contactos. Idempotente por mig_per_codigo (PER_Codigo); si una fila no trae
// PER_Codigo, cae a EMAIL como clave (todas las sin-código del origen traen email).
// Una persona en varias empresas = 1 contacto asociado a TODAS sus empresas (multi-company).
//
// USO (PowerShell, parado en la RAÍZ del repo, con .env sandbox):
//   1) Dry-run (NO escribe, NO necesita token):
//        node scripts/migration/migracion_contactos.mjs <csv_personas> <sandbox|prod>
//   2) Escritura real (crea mig_per_codigo si falta + crea contactos + asocia a empresas):
//        node scripts/migration/migracion_contactos.mjs <csv_personas> <sandbox|prod> --write
//
//   <csv_personas> = ...\3_DATOS\Contactos-Contactos_De_Empresas_Con_Actividad-2026-06-02.csv
//   token: HUBSPOT_PRIVATE_TOKEN (sandbox) / HUBSPOT_PROD_TOKEN (prod), leído del .env.

import fs from 'node:fs';

// ───────────────────────── args ─────────────────────────
const argv = process.argv.slice(2);
const flags = new Set(argv.filter(a => a.startsWith('--')));
const pos = argv.filter(a => !a.startsWith('--'));
const normEnv = v => { v = (v || '').toLowerCase(); return ['prod', 'produccion', 'production'].includes(v) ? 'prod' : v; };
const CSV = pos[0];
const ENV = normEnv(pos[1]);
const WRITE = flags.has('--write');

if (!CSV || !['sandbox', 'prod'].includes(ENV)) {
  console.error('Uso: node scripts/migration/migracion_contactos.mjs <csv_personas> <sandbox|prod> [--write]');
  process.exit(1);
}

const BASE = 'https://api.hubapi.com';
const GRUPO_PROPS = 'contactinformation'; // grupo estándar de contactos

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
  const texto = fs.readFileSync(path, 'latin1');   // estos CSV son latin-1, sep ';'
  const filas = parseCSV(texto, ';');
  const header = filas[0].map(h => h.trim());
  return filas.slice(1).map(f => Object.fromEntries(header.map((h, i) => [h, (f[i] ?? '').trim()])));
}

// ───────────────────── normalización persona → contacto ─────────────────────
// PER_Mails / PER_Tels: el origen trae uno por fila, pero por las dudas tomamos el primer valor.
function primerValor(v) { return (v || '').split(/[,;/\s]+/).map(s => s.trim()).filter(Boolean)[0] || ''; }

function normalizarContacto(r) {
  const anom = [];
  const props = {};
  const set = (k, v) => { if (v != null && String(v).trim() !== '') props[k] = String(v).trim(); };

  const codigo = (r['PER_Codigo'] || '').trim();
  const nom = (r['PER_Nom'] || '').trim();
  const ape = (r['PER_Ape'] || '').trim();
  if (!nom && !ape) anom.push('SIN_NOMBRE');

  const email = primerValor(r['PER_Mails']);
  if (!codigo && !email) anom.push('SIN_CLAVE');              // sin código NI email → no se puede idempotenciar
  else if (!codigo) anom.push('SIN_PER_CODIGO_USA_EMAIL');    // informativo: cae a email como clave

  const empCodigo = (r['EMP_CodigoEmpresaContactos'] || '').trim();

  set('mig_per_codigo', codigo);   // solo si hay código
  set('firstname', nom);
  set('lastname', ape);
  set('jobtitle', r['PER_Cargo']);
  set('email', email);
  set('phone', primerValor(r['PER_Tels']));

  // clave de agrupación/idempotencia: PER_Codigo si hay; si no, el email (en minúscula).
  const groupKey = codigo ? `cod:${codigo}` : (email ? `mail:${email.toLowerCase()}` : '');
  return { groupKey, codigo, email, empCodigo, nombre: `${nom} ${ape}`.trim(), props, anomalias: anom };
}

// ───────────────────── .env + token (zero-dep) ─────────────────────
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
      const val = (m[2] || '').trim().replace(/^['"]|['"]$/g, '');
      if (!(m[1] in process.env)) { process.env[m[1]] = val; n++; }
    }
    return { encontrado: true, cargadas: n };
  } catch { return { encontrado: false, cargadas: 0 }; }
}

function resolverToken() {
  cargarDotenv();
  const candidatos = ENV === 'prod'
    ? ['HUBSPOT_PROD_TOKEN', 'HUBSPOT_TOKEN', 'HUBSPOT_PRIVATE_TOKEN', 'HUBSPOT_ACCESS_TOKEN']
    : ['HUBSPOT_PRIVATE_TOKEN', 'HUBSPOT_SANDBOX_TOKEN', 'HUBSPOT_TOKEN', 'HUBSPOT_ACCESS_TOKEN'];
  for (const nombre of candidatos) {
    if (process.env[nombre]) { console.log(`  token tomado de: ${nombre}`); return process.env[nombre]; }
  }
  console.error('\nNo encontré el token en el .env. Definí HUBSPOT_PRIVATE_TOKEN (sandbox) / HUBSPOT_PROD_TOKEN (prod).');
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

async function asegurarPropiedades(necesarias) {
  const schema = await hs('/crm/v3/properties/contacts');
  const existentes = new Set(schema.results.map(p => p.name));
  const aCrear = [...necesarias].filter(n => !existentes.has(n));
  for (const name of aCrear) {
    console.log(`  + creando propiedad faltante en contacts: ${name}`);
    await hs('/crm/v3/properties/contacts', {
      method: 'POST',
      body: { name, label: name, type: 'string', fieldType: 'text', groupName: GRUPO_PROPS },
    });
  }
  if (!aCrear.length) console.log('  todas las propiedades necesarias ya existen.');
  return aCrear;
}

// Índice de empresas: codigo_empresa_contactos -> companyId (1 lectura paginada, evita 1 search por contacto).
async function indexarEmpresas() {
  const idx = new Map();
  let after = null, total = 0;
  do {
    const q = `/crm/v3/objects/companies?limit=100&properties=codigo_empresa_contactos${after ? `&after=${after}` : ''}`;
    const data = await hs(q);
    for (const c of data.results) {
      const cod = (c.properties?.codigo_empresa_contactos || '').trim();
      if (cod && !idx.has(cod)) idx.set(cod, c.id);
      total++;
    }
    after = data.paging?.next?.after || null;
  } while (after);
  console.log(`  empresas indexadas: ${idx.size} (de ${total} leídas)`);
  return idx;
}

// Idempotencia: por mig_per_codigo si hay código; si no, por email.
async function buscarContacto(c) {
  const filtro = c.codigo
    ? { propertyName: 'mig_per_codigo', operator: 'EQ', value: c.codigo }
    : { propertyName: 'email', operator: 'EQ', value: c.email };
  const data = await hs('/crm/v3/objects/contacts/search', {
    method: 'POST',
    body: { filterGroups: [{ filters: [filtro] }], properties: ['mig_per_codigo', 'email'], limit: 1 },
  });
  return data.results?.[0] || null;
}

// Asociación v4 "default" contacto → empresa (no requiere typeId numérico).
async function asociarEmpresa(contactId, companyId) {
  await hs(`/crm/v4/objects/contacts/${contactId}/associations/default/companies/${companyId}`, { method: 'PUT', body: [] });
}

// ───────────────────────── main ─────────────────────────
async function main() {
  console.log(`\n=== Paso contactos | env=${ENV} | ${WRITE ? 'ESCRITURA' : 'DRY-RUN'} ===\n`);

  const filas = leerOrigen(CSV);
  const contactos = filas.map(normalizarContacto);

  // dedup por clave (código o email), UNIENDO todas las empresas de la persona (multi-company).
  const porClave = new Map();
  let colapsados = 0, sinClave = 0;
  for (const c of contactos) {
    if (!c.groupKey) { sinClave++; continue; }           // sin código ni email → no migrable
    const ex = porClave.get(c.groupKey);
    if (ex) { if (c.empCodigo) ex.empCodigos.add(c.empCodigo); colapsados++; }
    else { c.empCodigos = new Set(c.empCodigo ? [c.empCodigo] : []); porClave.set(c.groupKey, c); }
  }
  const unicos = [...porClave.values()];

  const conteoAnom = {};
  for (const c of unicos) for (const a of c.anomalias) conteoAnom[a] = (conteoAnom[a] || 0) + 1;
  const multiEmpresa = unicos.filter(c => c.empCodigos.size > 1).length;
  const porEmail = unicos.filter(c => !c.codigo).length;

  console.log(`Personas leídas: ${contactos.length} → contactos únicos: ${unicos.length} (${colapsados} filas colapsadas; ${sinClave} sin clave descartadas)`);
  console.log(`  · por código: ${unicos.length - porEmail} · por email (fallback): ${porEmail} · multi-empresa: ${multiEmpresa}`);
  console.log('Anomalías:', Object.keys(conteoAnom).length ? conteoAnom : 'ninguna');

  fs.writeFileSync('contactos_objetos.json', JSON.stringify(
    unicos.map(c => ({ codigo: c.codigo, email: c.email, empresas: [...c.empCodigos], props: c.props })), null, 2));
  const md = ['# Anomalías contactos', '', ...unicos.filter(c => c.anomalias.length)
    .map(c => `- ${c.codigo || c.email} ${c.nombre} -> ${c.anomalias.join(', ')}`)];
  fs.writeFileSync('contactos_anomalias.md', md.join('\n'));
  console.log('\nGenerado: contactos_objetos.json, contactos_anomalias.md');

  console.log('\nMuestra (primeras 2 normalizadas):');
  for (const c of unicos.slice(0, 2)) console.log(JSON.stringify({ ...c.props, _empresas: [...c.empCodigos] }, null, 2));

  if (!WRITE) { console.log('\n[dry-run] No se escribió nada. Agregá --write para escribir.'); return; }

  // ── escritura real ──
  TOKEN = resolverToken();
  await asegurarPropiedades(new Set(['mig_per_codigo']));
  const empIdx = await indexarEmpresas();

  let creados = 0, saltados = 0, asociaciones = 0, sinEmpresa = 0, errores = 0;
  for (const c of unicos) {
    try {
      const ya = await buscarContacto(c);
      if (ya) { saltados++; continue; }                          // idempotencia

      const creado = await hs('/crm/v3/objects/contacts', { method: 'POST', body: { properties: c.props } });
      creados++;

      // asociar a TODAS sus empresas (multi-company)
      let asociado = 0;
      for (const cod of c.empCodigos) {
        const companyId = empIdx.get(cod);
        if (companyId) { await asociarEmpresa(creado.id, companyId); asociado++; asociaciones++; }
        else console.warn(`  ⚠ ${c.codigo || c.email} ${c.nombre}: empresa ${cod} no encontrada en el portal`);
      }
      if (!asociado) sinEmpresa++;

      if (creados % 50 === 0) console.log(`  creados ${creados}…`);
    } catch (err) { errores++; console.error(`  ERROR ${c.codigo || c.email} ${c.nombre}: ${err.message}`); }
  }
  console.log(`\nResultado: creados=${creados} saltados=${saltados} asociaciones=${asociaciones} contactosSinEmpresa=${sinEmpresa} errores=${errores}`);
}

main().catch(e => { console.error(e); process.exit(1); });
