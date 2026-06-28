// verificar_tickets.mjs (READ-ONLY)
// Por cada deal de los JSON de prueba: busca el deal en HubSpot por id_crm_origen,
// lista sus line items y sus tickets, y matchea tickets↔LI por line_item_key.
// Reporta, para los LI MANUALES (facturacion_automatica != true), si tienen la
// cantidad de tickets esperada (1 por LI de pago único).
//
// Uso: node scripts/migration/verificar_tickets.mjs scripts/migration/pruebas_unicos.json [scripts/migration/pruebas_mansoft.json]
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
const API = 'https://api.hubapi.com';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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
    body: JSON.stringify({
      filterGroups: [{ filters: [{ propertyName: 'id_crm_origen', operator: 'EQ', value: String(idOrigen) }] }],
      properties: ['dealname', 'id_crm_origen'], limit: 2,
    }),
  });
  return r.results || [];
}
async function asociados(dealId, tipo) {
  const r = await hs(`/crm/v4/objects/deals/${dealId}/associations/${tipo}?limit=500`);
  return (r.results || []).map(x => String(x.toObjectId || x.id)).filter(Boolean);
}
async function leerLIs(ids) {
  if (!ids.length) return [];
  const r = await hs('/crm/v3/objects/line_items/batch/read', {
    method: 'POST',
    body: JSON.stringify({ properties: ['line_item_key', 'mig_line_item_key', 'facturacion_automatica', 'name'], inputs: ids.map(id => ({ id })) }),
  });
  return r.results || [];
}
async function leerTickets(ids) {
  if (!ids.length) return [];
  const r = await hs('/crm/v3/objects/tickets/batch/read', {
    method: 'POST',
    body: JSON.stringify({ properties: ['of_line_item_key', 'hs_pipeline_stage', 'of_ticket_key'], inputs: ids.map(id => ({ id })) }),
  });
  return r.results || [];
}

const archivos = process.argv.slice(2);
if (!archivos.length) { console.error('Pasá al menos un JSON.'); process.exit(1); }

let totalManual = 0, manualOK = 0;
const problemas = [];

for (const ruta of archivos) {
  const data = JSON.parse(readFileSync(ruta, 'utf8'));
  const deals = data.deals || [];
  const esMansoft = deals[0] && deals[0]._key !== undefined;
  console.log(`\n=== ${ruta} (${esMansoft ? 'mansoft/auto' : 'únicos/manual'}) — ${deals.length} deals ===`);

  for (const d of deals) {
    const idOrigen = esMansoft ? d._key : (d.deal?.id_crm_origen || d.idOrigen);
    const caso = d.caso || d.dealname || idOrigen;
    let found;
    try { found = await buscarDeal(idOrigen); }
    catch (e) { console.log(`• ${caso}: ✖ error buscando deal (${e.message})`); continue; }
    if (!found.length) { console.log(`• ${caso}: ✖ deal no encontrado`); continue; }
    if (found.length > 1) console.log(`• ${caso}: ⚠ ${found.length} deals con ese id_crm_origen`);
    const dealId = found[0].id;

    let lis = [], tks = [];
    try {
      lis = await leerLIs(await asociados(dealId, 'line_items'));
      tks = await leerTickets(await asociados(dealId, 'tickets'));
    } catch (e) { console.log(`• ${caso}: ✖ error leyendo LIs/tickets (${e.message})`); continue; }

    // index tickets por of_line_item_key
    const porLik = new Map();
    for (const t of tks) {
      const k = String(t.properties?.of_line_item_key || '').trim();
      if (!k) continue;
      porLik.set(k, (porLik.get(k) || 0) + 1);
    }

    console.log(`• ${caso}  (deal ${dealId}) — ${lis.length} LI · ${tks.length} tickets`);
    for (const li of lis) {
      const lp = li.properties || {};
      const lik = String(lp.line_item_key || '').trim();
      const auto = String(lp.facturacion_automatica || '').toLowerCase() === 'true';
      const n = lik ? (porLik.get(lik) || 0) : 0;
      const tag = auto ? 'auto ' : 'MANUAL';
      let flag = '';
      if (!auto) {
        totalManual++;
        if (n === 1) { manualOK++; flag = '✓'; }
        else { flag = `✖ esperaba 1, hay ${n}`; problemas.push({ caso, dealId, lineItemId: li.id, lik, n }); }
      }
      console.log(`    [${tag}] ${lp.name || ''} · lik=${lik || '(vacío)'} · tickets=${n} ${flag}`);
    }
  }
}

console.log(`\n── Verificación LI manuales ── ${manualOK}/${totalManual} con exactamente 1 ticket`);
if (problemas.length) {
  console.log('Problemas:');
  for (const p of problemas) console.log(`  ${p.caso} (deal ${p.dealId}) lik=${p.lik}: ${p.n} tickets`);
} else if (totalManual) {
  console.log('✅ Todos los LI manuales tienen exactamente 1 ticket.');
}
