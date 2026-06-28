// asignar_area.mjs
// Setea la propiedad `area` en los LINE ITEMS y TICKETS de los deals de la base
// de prueba, según un mapeo dealname → area provisto a mano (input del usuario).
//
// - Matchea el deal por id_crm_origen (del JSON); el dealname solo se usa para el
//   mapeo de área (normalizado: sin acentos, minúsculas, espacios colapsados).
// - Resuelve el valor contra las OPCIONES reales del select `area` (por label o
//   value) para no romper con INVALID_OPTION.
// - Dry-run por defecto. Escribir: $env:ESCRIBIR="true".
//
// Uso (raíz del repo):
//   node scripts/migration/asignar_area.mjs scripts/migration/pruebas_unicos.json scripts/migration/pruebas_mansoft.json sandbox
import { readFileSync } from 'node:fs';

try {
  for (const raw of readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const l = raw.trim(); if (!l || l.startsWith('#')) continue;
    const i = l.indexOf('='); if (i === -1) continue;
    const k = l.slice(0, i).trim(); const v = l.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    if (k && !(k in process.env)) process.env[k] = v;
  }
} catch {}
const TOKEN = process.env.HUBSPOT_PRIVATE_TOKEN || process.env.HUBSPOT_TOKEN || process.env.HUBSPOT_ACCESS_TOKEN;
const ESCRIBIR = (process.env.ESCRIBIR || '').toLowerCase() === 'true';
const API = 'https://api.hubapi.com';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

// ── Mapeo manual dealname → area (input del usuario) ──
const AREA_POR_DEALNAME_RAW = {
  // ÚNICOS
  'Horas adicionales': 'Payroll',
  'OC W926631001 Ampliacion CD - Serv Drupal': 'Portal',
  'C947271001 Ampliacion compra Drupal': 'Portal',
  'ID 443630 -Portal Liferay': 'ISA PY',
  'MiRecibo': 'ISA PY',
  'Licenciamiento Payroll 2025': 'Payroll',           // ambos splits (USD y UYU)
  // MANSOFT
  'Serv. Soporte Especializado - OC N° 31920 - CD N° 28796': 'Portal',
  'ASIST TEC URG METRO Y SURT': 'Petróleo',
  'Suscripcion y Soporte MIFACTURA (On Premise)': 'ISA PY',
  'Suscripcion y Soporte Anual MIFACTURA Alta Disponibilidad': 'ISA PY',
  'Suscripcion y Soporte MIFACTURA EXPRESS': 'ISA PY',
  'IJSERV CFE - eFACTURA': 'Petróleo',
};
const AREA_POR_DEALNAME = new Map(Object.entries(AREA_POR_DEALNAME_RAW).map(([k, v]) => [norm(k), v]));

async function hs(path, opts = {}) {
  await sleep(120);
  const res = await fetch(API + path, { ...opts, headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  const t = await res.text(); let j = {}; try { j = t ? JSON.parse(t) : {}; } catch { j = { raw: t }; }
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(j).slice(0, 200)}`);
  return j;
}
async function buscarDeal(idOrigen) {
  const r = await hs('/crm/v3/objects/deals/search', {
    method: 'POST',
    body: JSON.stringify({ filterGroups: [{ filters: [{ propertyName: 'id_crm_origen', operator: 'EQ', value: String(idOrigen) }] }], properties: ['dealname'], limit: 2 }),
  });
  return (r.results || []).map(d => String(d.id));
}
async function asociados(dealId, tipo) {
  const r = await hs(`/crm/v4/objects/deals/${dealId}/associations/${tipo}?limit=500`);
  return (r.results || []).map(x => String(x.toObjectId || x.id)).filter(Boolean);
}
async function opcionesArea(objeto) {
  try {
    const r = await hs(`/crm/v3/properties/${objeto}/area`);
    return (r.options || []).map(o => ({ label: o.label, value: o.value }));
  } catch { return null; } // la prop no existe en ese objeto
}
function hacerResolver(opciones) {
  const m = new Map();
  for (const o of opciones) { m.set(norm(o.label), o.value); m.set(norm(o.value), o.value); }
  return (area) => (m.has(norm(area)) ? m.get(norm(area)) : null);
}

async function main() {
  const archivos = process.argv.slice(2).filter(a => a.endsWith('.json'));
  if (!TOKEN) { console.error('Falta HUBSPOT_PRIVATE_TOKEN.'); process.exit(1); }
  if (!archivos.length) { console.error('Pasá los JSON (unicos/mansoft).'); process.exit(1); }

  console.log(`=== Asignar área a LIs + tickets · ${ESCRIBIR ? 'ESCRIBE' : 'DRY-RUN'} ===\n`);

  // Opciones del select `area` en cada objeto
  const optLI = await opcionesArea('line_items');
  const optTK = await opcionesArea('tickets');
  if (!optLI) console.warn('⚠ line_items no tiene propiedad `area` → no se podrá setear en LIs.');
  if (!optTK) console.warn('⚠ tickets no tiene propiedad `area` → no se podrá setear en tickets.');
  const resolveLI = optLI ? hacerResolver(optLI) : () => null;
  const resolveTK = optTK ? hacerResolver(optTK) : () => null;
  if (optLI) console.log(`Opciones area (line_items): ${optLI.map(o => o.label).join(' | ')}`);
  console.log('');

  const stats = { deals: 0, lis: 0, tickets: 0, sinMapeo: 0, sinOpcion: 0, errores: 0 };

  for (const ruta of archivos) {
    const data = JSON.parse(readFileSync(ruta, 'utf8'));
    for (const d of (data.deals || [])) {
      const idOrigen = d._key || d.deal?.id_crm_origen || d.idOrigen;
      const dealname = d.dealname || d.deal?.dealname || d.caso || '';
      const area = AREA_POR_DEALNAME.get(norm(dealname));
      if (!area) { console.warn(`• "${dealname}": sin área en el mapeo → salteo.`); stats.sinMapeo++; continue; }

      let dealIds;
      try { dealIds = await buscarDeal(idOrigen); }
      catch (e) { console.warn(`• "${dealname}": error buscando deal (${e.message})`); stats.errores++; continue; }
      if (!dealIds.length) { console.warn(`• "${dealname}": deal no encontrado (id_crm_origen=${idOrigen})`); stats.errores++; continue; }

      for (const dealId of dealIds) {
        stats.deals++;
        const valLI = resolveLI(area);
        const valTK = resolveTK(area);
        if (optLI && valLI == null) console.warn(`  ⚠ área "${area}" no es opción válida en line_items.area`);
        if (optTK && valTK == null) console.warn(`  ⚠ área "${area}" no es opción válida en tickets.area`);

        const liIds = optLI && valLI != null ? await asociados(dealId, 'line_items') : [];
        const tkIds = optTK && valTK != null ? await asociados(dealId, 'tickets') : [];
        console.log(`• "${dealname}" (deal ${dealId}) → area="${area}"${valLI != null && valLI !== area ? ` (value ${valLI})` : ''} · ${liIds.length} LIs · ${tkIds.length} tickets`);

        if (ESCRIBIR) {
          for (const id of liIds) {
            try { await hs(`/crm/v3/objects/line_items/${id}`, { method: 'PATCH', body: JSON.stringify({ properties: { area: valLI } }) }); stats.lis++; }
            catch (e) { console.warn(`    ✖ LI ${id}: ${e.message}`); stats.errores++; }
          }
          for (const id of tkIds) {
            try { await hs(`/crm/v3/objects/tickets/${id}`, { method: 'PATCH', body: JSON.stringify({ properties: { area: valTK } }) }); stats.tickets++; }
            catch (e) { console.warn(`    ✖ ticket ${id}: ${e.message}`); stats.errores++; }
          }
        } else {
          stats.lis += liIds.length; stats.tickets += tkIds.length;
        }
      }
    }
  }

  console.log(`\n── Resumen ── deals: ${stats.deals} · LIs: ${stats.lis} · tickets: ${stats.tickets} · sin mapeo: ${stats.sinMapeo} · errores: ${stats.errores}`);
  if (!ESCRIBIR) console.log('(DRY-RUN — no se escribió nada. $env:ESCRIBIR="true" para aplicar.)');
}
main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
