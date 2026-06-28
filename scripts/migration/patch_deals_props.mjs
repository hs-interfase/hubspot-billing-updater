// patch_deals_props.mjs
// PATCH de `deal_props` en los deals de la base de prueba, desde un manifest JSON.
// Matchea el deal por id_crm_origen. Convierte fechas YYYY-MM-DD → epoch ms (UTC).
// Filtra por el schema de deals (reporta props inexistentes; nada silencioso).
// (El `area` de los LINE ITEMS lo setea asignar_area.mjs, no este script.)
//
// Dry-run por defecto. Escribir: $env:ESCRIBIR="true".
//   node scripts/migration/patch_deals_props.mjs scripts/migration/patch_pruebas_deals.json sandbox
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

// Convierte según el tipo de la prop en el portal:
//  date/datetime: "YYYY-MM-DD" → epoch ms (UTC). number: "20.000,00" → 20000. resto: tal cual.
function conv(v, tipo) {
  if (tipo === 'date' || tipo === 'datetime') {
    const s = String(v ?? '');
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); }
    return v;
  }
  if (tipo === 'number') {
    if (typeof v === 'number') return v;
    const n = parseFloat(String(v).trim().replace(/\./g, '').replace(',', '.'));
    return Number.isFinite(n) ? n : v;
  }
  return v;
}

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
async function propsDeals() {
  const r = await hs('/crm/v3/properties/deals');
  const m = new Map();
  for (const p of (r.results || [])) m.set(p.name, p.type);
  return m;
}

async function main() {
  const archivo = process.argv.slice(2).find(a => a.endsWith('.json'));
  if (!TOKEN) { console.error('Falta HUBSPOT_PRIVATE_TOKEN.'); process.exit(1); }
  if (!archivo) { console.error('Pasá el manifest JSON.'); process.exit(1); }

  console.log(`=== Patch deal_props · ${ESCRIBIR ? 'ESCRIBE' : 'DRY-RUN'} ===\n`);
  const data = JSON.parse(readFileSync(archivo, 'utf8'));
  const tipos = await propsDeals();

  const stats = { patched: 0, sinProps: 0, noEncontrado: 0, errores: 0 };
  const dropeadasGlobal = new Set();

  for (const d of (data.deals || [])) {
    const idOrigen = d.id_crm_origen;
    const dealname = d.dealname || idOrigen;
    const src = d.deal_props || {};
    if (!Object.keys(src).length) { console.log(`• "${dealname}": sin deal_props → salteo.`); stats.sinProps++; continue; }

    // build props + filtro por schema (loud)
    const props = {}; const dropped = [];
    for (const [k, v] of Object.entries(src)) {
      if (!tipos.has(k)) { dropped.push(k); dropeadasGlobal.add(k); continue; }
      let val = conv(v, tipos.get(k));
      // hs_forecast_probability es 0..1 en HubSpot; el JSON viene en % (95 → 0.95)
      if (k === 'hs_forecast_probability' && typeof val === 'number' && val > 1) val = val / 100;
      props[k] = val;
    }

    let ids;
    try { ids = await buscarDeal(idOrigen); }
    catch (e) { console.warn(`• "${dealname}": error buscando (${e.message})`); stats.errores++; continue; }
    if (!ids.length) { console.warn(`• "${dealname}": deal no encontrado (id_crm_origen=${idOrigen})`); stats.noEncontrado++; continue; }

    for (const dealId of ids) {
      console.log(`• "${dealname}" (deal ${dealId}): ${Object.keys(props).length} props${dropped.length ? ` · omitidas: ${dropped.join(', ')}` : ''}`);
      console.log(`    ${JSON.stringify(props)}`);
      if (ESCRIBIR) {
        try { await hs(`/crm/v3/objects/deals/${dealId}`, { method: 'PATCH', body: JSON.stringify({ properties: props }) }); stats.patched++; }
        catch (e) { console.warn(`    ✖ ${e.message}`); stats.errores++; }
      } else stats.patched++;
    }
  }

  console.log(`\n── Resumen ── deals patcheados: ${stats.patched} · sin props: ${stats.sinProps} · no encontrados: ${stats.noEncontrado} · errores: ${stats.errores}`);
  if (dropeadasGlobal.size) console.log(`⚠ props inexistentes en deals (se omitieron): ${[...dropeadasGlobal].join(', ')}`);
  if (!ESCRIBIR) console.log('(DRY-RUN — no se escribió nada.)');
}
main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
