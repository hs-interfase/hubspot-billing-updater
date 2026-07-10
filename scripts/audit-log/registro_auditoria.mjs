// scripts/audit-log/registro_auditoria.mjs
// AUDITORÍA READ-ONLY — no escribe NADA en HubSpot (solo GET).
//
// Registro de auditoría de UN registro (deal, ticket, line item o factura):
// todos los cambios de propiedades que HubSpot tiene versionados, con fecha,
// hora (Montevideo), valor anterior, valor nuevo, origen del cambio y usuario
// (cuando fue por UI).
//
// Uso (parado en la raíz del repo, que tiene el .env — ese token decide portal):
//   node scripts/audit-log/registro_auditoria.mjs --deal 62205651238
//   node scripts/audit-log/registro_auditoria.mjs --ticket 46664972958 --desde 2026-06-01 --hasta 2026-06-30
//   node scripts/audit-log/registro_auditoria.mjs --lineitem 56849265847
//   node scripts/audit-log/registro_auditoria.mjs --factura 568366981020
// Opcional:
//   --desde YYYY-MM-DD   (incluye ese día; hora Montevideo)
//   --hasta YYYY-MM-DD   (incluye ese día; hora Montevideo)
//   --todo               (incluye también props de sistema ruidosas y cambios calculados
//                         por HubSpot: hs_time_in_*, analytics, CALCULATED, etc.)
//
// Salida: scripts/audit-log/salidas/registro_auditoria_<objeto>_<id>_YYYY-MM-DD.csv (separador ;)
//         + detalle por consola en orden cronológico.
// Node 18+ (fetch nativo), ESM, sin dependencias.

import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));

// ── args ──
const args = process.argv.slice(2);
function argVal(name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; }

const OBJETOS = [
  { flag: '--deal', api: 'deals', es: 'negocio' },
  { flag: '--ticket', api: 'tickets', es: 'ticket' },
  { flag: '--lineitem', api: 'line_items', es: 'line_item' },
  { flag: '--factura', api: 'invoices', es: 'factura' },
];
const pedidos = OBJETOS.filter((o) => argVal(o.flag));
if (pedidos.length !== 1) {
  console.error('Uso: node scripts/audit-log/registro_auditoria.mjs (--deal|--ticket|--lineitem|--factura) <id> [--desde YYYY-MM-DD] [--hasta YYYY-MM-DD] [--todo]');
  process.exit(1);
}
const { api: OBJ, es: OBJ_ES, flag } = pedidos[0];
const REC_ID = argVal(flag);
const DESDE = argVal('--desde'); // YYYY-MM-DD
const HASTA = argVal('--hasta'); // YYYY-MM-DD
const INCLUIR_TODO = args.includes('--todo');
for (const d of [DESDE, HASTA]) {
  if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) { console.error(`❌ Fecha inválida "${d}" (formato YYYY-MM-DD)`); process.exit(1); }
}

// ── .env del directorio actual (mismo patrón que el resto de los scripts) ──
try {
  for (const raw of readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i === -1) continue;
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    if (k && !(k in process.env)) process.env[k] = v;
  }
} catch {}

const TOKEN =
  process.env.HUBSPOT_PRIVATE_TOKEN ||
  process.env.HUBSPOT_TOKEN ||
  process.env.HUBSPOT_SANDBOX_TOKEN ||
  process.env.HUBSPOT_ACCESS_TOKEN;
if (!TOKEN) { console.error('❌ Falta HUBSPOT_PRIVATE_TOKEN (correr parado en la raíz del repo con .env)'); process.exit(1); }

const API = 'https://api.hubapi.com';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function hs(path, opts = {}, attempt = 0) {
  const res = await fetch(API + path, {
    ...opts,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  if ((res.status === 429 || res.status >= 500) && attempt < 5) {
    const ra = Number(res.headers.get('retry-after')) || 0;
    await sleep(ra ? ra * 1000 + 100 : 500 * 2 ** attempt);
    return hs(path, opts, attempt + 1);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} ${path}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// ── fecha/hora en Montevideo ──
const fmtFecha = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Montevideo', year: 'numeric', month: '2-digit', day: '2-digit' });
const fmtHora = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Montevideo', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const fechaMvd = (iso) => fmtFecha.format(new Date(iso)); // YYYY-MM-DD
const horaMvd = (iso) => fmtHora.format(new Date(iso));   // HH:mm:ss

// ── props de sistema ruidosas (se omiten salvo --todo) ──
const RUIDO = [
  /^hs_time_in_/, /^hs_date_entered_/, /^hs_date_exited_/,
  /^hs_v2_date_entered_/, /^hs_v2_date_exited_/, /^hs_v2_cumulative_time_in_/, /^hs_v2_latest_time_in_/,
  /^hs_analytics_/, /^hs_predictive/, /^hs_deal_score/,
  /^hs_lastmodifieddate$/, /^hs_updated_by_user_id$/, /^hs_user_ids_of_all_/,
  /^hs_notes_last_/, /^notes_last_/, /^hs_lastactivitydate$/, /^hs_latest_/,
];
const esRuido = (name) => RUIDO.some((re) => re.test(name));

// ── 1. lista de propiedades del objeto (nombre + label) ──
console.log(`Registro de auditoría — ${OBJ_ES} ${REC_ID}${DESDE || HASTA ? ` (${DESDE || 'inicio'} → ${HASTA || 'hoy'})` : ' (historial completo)'}`);
const propsResp = await hs(`/crm/v3/properties/${OBJ}`);
const todasProps = (propsResp.results || []).map((p) => ({ name: p.name, label: p.label || p.name }));
const labelDe = new Map(todasProps.map((p) => [p.name, p.label]));
const propsAuditar = todasProps.map((p) => p.name).filter((n) => INCLUIR_TODO || !esRuido(n));
console.log(`Propiedades del objeto: ${todasProps.length} (auditando ${propsAuditar.length}${INCLUIR_TODO ? '' : ', sin props de sistema ruidosas; usar --todo para incluirlas'})`);

// ── 2. traer historial (GET por chunks de 50 props para no pasar el largo de URL) ──
const historia = new Map(); // propName -> versions[]
for (let i = 0; i < propsAuditar.length; i += 50) {
  const chunk = propsAuditar.slice(i, i + 50);
  const r = await hs(`/crm/v3/objects/${OBJ}/${REC_ID}?propertiesWithHistory=${chunk.join(',')}&archived=false`);
  for (const [name, versions] of Object.entries(r.propertiesWithHistory || {})) {
    if (Array.isArray(versions) && versions.length) historia.set(name, versions);
  }
  await sleep(80);
}
// nombre del registro = última versión de su prop de nombre (la API no devuelve
// el valor actual de props custom cuando se pide propertiesWithHistory)
const ultimo = (p) => (historia.get(p) || [])
  .reduce((a, v) => (!a || new Date(v.timestamp) > new Date(a.timestamp) ? v : a), null)?.value;
const nombreReg = ['dealname', 'subject', 'name', 'hs_title', 'hs_number', 'hs_invoice_number']
  .map(ultimo).find(Boolean) || '(sin nombre)';
console.log(`Registro: "${nombreReg}"`);

// ── 3. usuarios (owners: userId -> nombre) ──
const usuarios = new Map();
try {
  let after;
  do {
    const r = await hs(`/crm/v3/owners/?limit=500${after ? `&after=${after}` : ''}`);
    for (const o of r.results || []) {
      const nom = [o.firstName, o.lastName].filter(Boolean).join(' ') || o.email || `owner ${o.id}`;
      if (o.userId != null) usuarios.set(String(o.userId), nom);
    }
    after = r.paging?.next?.after;
  } while (after);
} catch (e) { console.warn(`⚠️  No pude cargar usuarios (owners): ${e.message} — se mostrarán IDs`); }

const ORIGEN_ES = {
  CRM_UI: 'Usuario (UI)', INTEGRATION: 'Integración/API', API: 'API', IMPORT: 'Import',
  AUTOMATION_PLATFORM: 'Workflow', WORKFLOWS: 'Workflow', CALCULATED: 'Calculada (sistema)',
  MIGRATION: 'Migración HubSpot', FORM: 'Formulario', EMAIL: 'Email', MOBILE_IOS: 'App móvil',
  MOBILE_ANDROID: 'App móvil', ASSOCIATIONS: 'Asociaciones (sistema)', BATCH_UPDATE: 'Actualización masiva',
  INTERNAL_PROCESSING: 'HubSpot (sistema)',
};
// cambios que hace HubSpot solo (recálculos): se omiten salvo --todo
const ORIGEN_SISTEMA = new Set(['CALCULATED', 'INTERNAL_PROCESSING']);

function quienYComo(v) {
  const origen = ORIGEN_ES[v.sourceType] || v.sourceType || '';
  const uid = v.updatedByUserId != null ? String(v.updatedByUserId)
    : (v.sourceType === 'CRM_UI' && /^\d+$/.test(String(v.sourceId || ''))) ? String(v.sourceId) : null;
  let usuario = uid ? (usuarios.get(uid) || `usuario ${uid}`) : '';
  if (!usuario && v.sourceType === 'INTEGRATION' && v.sourceId) usuario = `app ${v.sourceId}`;
  return { origen, usuario };
}

// ── 4. armar filas: cada versión = un cambio; anterior = versión previa ──
const filas = []; // {ts, fecha, hora, prop, label, anterior, nuevo, origen, usuario}
for (const [name, versions] of historia) {
  const asc = [...versions].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  for (let i = 0; i < asc.length; i++) {
    const v = asc[i];
    if (!INCLUIR_TODO && ORIGEN_SISTEMA.has(v.sourceType)) continue;
    const fecha = fechaMvd(v.timestamp);
    if (DESDE && fecha < DESDE) continue;
    if (HASTA && fecha > HASTA) continue;
    const { origen, usuario } = quienYComo(v);
    filas.push({
      ts: new Date(v.timestamp).getTime(),
      fecha, hora: horaMvd(v.timestamp),
      prop: name, label: labelDe.get(name) || name,
      anterior: i > 0 ? String(asc[i - 1].value ?? '') : '',
      nuevo: String(v.value ?? ''),
      origen, usuario,
    });
  }
}
filas.sort((a, b) => a.ts - b.ts || a.prop.localeCompare(b.prop));

// ── 5. salida ──
if (!filas.length) {
  console.log('\nSin cambios en el rango pedido.');
  process.exit(0);
}
const corto = (s, n = 60) => { s = String(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
console.log(`\n${filas.length} cambios:\n`);
for (const f of filas) {
  const quien = [f.origen, f.usuario].filter(Boolean).join(' — ');
  console.log(`${f.fecha} ${f.hora}  ${f.label} [${f.prop}]`);
  console.log(`    ${f.anterior === '' ? '(vacío)' : corto(f.anterior)}  →  ${f.nuevo === '' ? '(vacío)' : corto(f.nuevo)}   (${quien})`);
}

const esc = (s) => { s = String(s ?? ''); return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const ymd = fechaMvd(new Date().toISOString());
const outDir = join(__dir, 'salidas');
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, `registro_auditoria_${OBJ_ES}_${REC_ID}_${ymd}.csv`);
writeFileSync(outPath, [
  'fecha;hora;propiedad;etiqueta;valor_anterior;valor_nuevo;origen;usuario',
  ...filas.map((f) => [f.fecha, f.hora, f.prop, f.label, f.anterior, f.nuevo, f.origen, f.usuario].map(esc).join(';')),
].join('\r\n'), 'utf8');
console.log(`\nCSV: ${outPath}`);
