// migracion_pasoD_facturas.mjs
//
// Paso D — Pasada 3: finaliza las facturas historicas que dejo Paso C.
// Por cada deal migrado:
//   1) lee sus tickets por asociacion deal->tickets (sin Search API)
//   2) toma los que tienen mig_emision_historica='true'
//   3) encuentra su Invoice (deal->invoices, match por ticket_id / of_invoice_key)
//   4) PATCH a la factura:  id_factura_nodum (desde el JSON de migracion, por of_line_item_key)
//                           + etapa_de_la_factura='Emitida'
//                           + fecha_de_emision / hs_invoice_date = fecha de la OF (del JSON)
//                           + hs_due_date = vencimiento (si hay) | emision + 10 dias
//   5) runInvoiceNodumPipeline(invoiceId)  -> proceso COMPLETO factura->ticket
//      (sync nodum->numero_de_factura, propaga estado/fechas/stage, avanza deal)
//   6) apaga mig_emision_historica='false' en el ticket
//
// ⚠️ El id Nodum y la fecha historica salen del JSON de Paso A (historicalTickets),
//    NO del ticket. Paso C nunca escribe el id Nodum (es la unica prop que no toca).
//    El match JSON<->ticket es por of_line_item_key (el snapshot del motor lo propaga
//    al ticket; si en sandbox sale vacio, el match falla -> se avisa).
//
// NO re-emite a Nodum. Idempotente: si la Invoice ya esta Emitida y el flag en
// false, saltea.
//
// ⚠️ Ya NO es zero-dep: importa el motor (runInvoiceNodumPipeline). Correlo desde
//    la raiz del repo, con node_modules y .env del proyecto.
//
// Uso (dry-run):  node migracion_pasoD_facturas.mjs <dryrun_objetos.json> sandbox
// Uso (escribe):  $env:ESCRIBIR="true"; node migracion_pasoD_facturas.mjs <dryrun_objetos.json> sandbox
//   - El .json DEBE ser el de Paso A (con historicalTickets): se usa para (a) sacar
//     los dealIds y (b) armar el indice id Nodum + fecha por of_line_item_key.
//     Si no se pasa, busca los deals por el tag de importacion, pero entonces NO hay
//     indice historico -> id Nodum y fecha quedan vacios (solo sirve para re-correr
//     finalizaciones idempotentes, no para la primera emision).
//   - prod requiere ademas: $env:CONFIRMO_PROD="true".

import { readFileSync, existsSync } from 'node:fs';

// -- carga .env (zero-dep) ----------------------------------------
function loadEnv(path = '.env') {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if (/^".*"$/.test(v) || /^'.*'$/.test(v)) v = v.slice(1, -1);
    if (!(m[1] in process.env)) process.env[m[1]] = v;
  }
}
loadEnv();

// -- CONFIG · AJUSTAR / CONFIRMAR ---------------------------------
const TOKEN = process.env.HUBSPOT_PRIVATE_TOKEN;
const ESCRIBIR = process.env.ESCRIBIR === 'true';
const IMPORT_TAG = process.env.IMPORT_TAG || 'CRM_Activos';                               // tag que Paso B pone en los deals
const HIST_DATE_FIELD = process.env.HIST_DATE_FIELD || 'mig_of_fecha_facturacion_real';   // fallback en el ticket si el JSON no trae fecha
const DUE_DATE_FIELD = process.env.DUE_DATE_FIELD || 'of_fecha_de_vencimiento';           // ⚠️ confirmar nombre real; si no hay -> emision + N dias
const DUE_FALLBACK_DAYS = Number(process.env.DUE_FALLBACK_DAYS || 10);
const PIPELINE_PATH = process.env.PIPELINE_PATH || '../../src/services/invoiceNodumPipeline.js'; // relativa a ESTE módulo (scripts/migration/)
const BASE = 'https://api.hubapi.com';
// -----------------------------------------------------------------

const TICKET_PROPS = [
  'hs_object_id', 'mig_emision_historica', 'facturar_ahora',
  'of_invoice_id', 'of_invoice_key', 'of_ticket_key', 'of_line_item_key', 'mig_line_item_key',
  'numero_de_factura', 'id_factura_nodum',
  'of_fecha_de_facturacion', 'fecha_real_de_facturacion', HIST_DATE_FIELD, DUE_DATE_FIELD,
];
const INVOICE_PROPS = [
  'hs_object_id', 'etapa_de_la_factura', 'ticket_id', 'of_invoice_key',
  'line_item_key', 'id_factura_nodum', 'numero_de_factura',
  'hs_invoice_date', 'fecha_de_emision', 'hs_due_date',
];

const DAY_MS = 86400000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function hs(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`${method} ${path} -> ${res.status} ${t.slice(0, 300)}`);
  }
  return res.status === 204 ? null : res.json();
}

// fecha -> epoch ms a medianoche UTC (formato date de HubSpot)
function toHubSpotDateOnly(v) {
  if (v == null || v === '') return null;
  if (/^\d{10,}$/.test(String(v))) return Number(v); // ya es epoch ms
  const s = String(v);
  const d = new Date(s.length <= 10 ? `${s}T00:00:00Z` : s);
  if (isNaN(d)) return null;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

async function assoc(dealId, toType) {
  const r = await hs('GET', `/crm/v4/objects/deals/${dealId}/associations/${toType}?limit=100`);
  return (r?.results || []).map((x) => String(x.toObjectId));
}

async function batchRead(objType, ids, properties) {
  const out = [];
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const r = await hs('POST', `/crm/v3/objects/${objType}/batch/read`, {
      inputs: chunk.map((id) => ({ id })),
      properties,
    });
    out.push(...(r?.results || []));
  }
  return out;
}

async function searchDealsByTag(tag) {
  const ids = [];
  let after;
  do {
    const r = await hs('POST', '/crm/v3/objects/deals/search', {
      filterGroups: [{ filters: [{ propertyName: 'archivo_de_importacion', operator: 'EQ', value: tag }] }],
      properties: ['hs_object_id'],
      limit: 100,
      ...(after ? { after } : {}),
    });
    for (const d of (r?.results || [])) ids.push(String(d.id));
    after = r?.paging?.next?.after;
    if (after) await sleep(250);
  } while (after);
  return ids;
}

function dealIdsFromManifest(path) {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const arr = Array.isArray(raw) ? raw : (raw.deals || raw.results || []);
  return arr
    .map((x) => (typeof x === 'string' || typeof x === 'number'
      ? String(x)
      : String(x.hubspotDealId || x.dealId || x.id || '')))
    .filter(Boolean);
}

// Resuelve los HS deal ids del manifest. Si la entrada ya trae un id de HubSpot
// lo usa; si no (JSON de Paso A con id_crm_origen), lo busca por id_crm_origen.
async function resolverDealIdsDesdeManifest(path) {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const arr = Array.isArray(raw) ? raw : (raw.deals || raw.results || []);
  const ids = [];
  for (const x of arr) {
    const direct = (typeof x === 'string' || typeof x === 'number')
      ? String(x)
      : String(x.hubspotDealId || x.dealId || x.id || '').trim();
    if (direct) { ids.push(direct); continue; }
    const origen = String(x.deal?.id_crm_origen || x.idOrigen || '').trim();
    if (!origen) continue;
    try {
      const r = await hs('POST', '/crm/v3/objects/deals/search', {
        filterGroups: [{ filters: [{ propertyName: 'id_crm_origen', operator: 'EQ', value: origen }] }],
        properties: ['hs_object_id'], limit: 2,
      });
      const found = (r?.results || []).map((d) => String(d.id));
      if (found.length) ids.push(found[0]);
      else console.warn(`  ⚠️ id_crm_origen=${origen}: deal no encontrado en HubSpot`);
    } catch (e) {
      console.warn(`  ⚠️ búsqueda falló para id_crm_origen=${origen}: ${e.message}`);
    }
    await sleep(150);
  }
  return ids;
}

// Índice de datos históricos del JSON de Paso A, por of_line_item_key (UPPER).
// El id Nodum (numero_de_factura) y la fecha real viven acá, NO en el ticket.
function cargarIndiceHistorico(path) {
  const idx = new Map(); // LIK -> { numero_de_factura, of_fecha_facturacion_real }
  if (!path) return idx;
  let raw;
  try { raw = JSON.parse(readFileSync(path, 'utf8')); } catch { return idx; }
  const deals = Array.isArray(raw) ? raw : (raw.deals || []);
  for (const d of deals) {
    for (const h of (d.historicalTickets || [])) {
      const lik = String(h.mig_line_item_key || '').trim().toUpperCase();
      if (!lik) continue;
      idx.set(lik, {
        numero_de_factura: (h.numero_de_factura || '').toString().trim() || null,
        of_fecha_facturacion_real: h.of_fecha_facturacion_real || null,
      });
    }
  }
  return idx;
}

// Agrega al índice los historicalTickets de los TWINS (mirrors), por mig_line_item_key.
function agregarTwinsAlIndice(path, idx) {
  if (!path) return;
  let raw;
  try { raw = JSON.parse(readFileSync(path, 'utf8')); } catch { return; }
  for (const t of (raw.twinsApartados || [])) {
    for (const h of (t.historicalTickets || [])) {
      const lik = String(h.mig_line_item_key || '').trim().toUpperCase();
      if (!lik) continue;
      idx.set(lik, {
        numero_de_factura: (h.numero_de_factura || '').toString().trim() || null,
        of_fecha_facturacion_real: h.of_fecha_facturacion_real || null,
      });
    }
  }
}

// Ramas PY candidatas del twin: la lista que persiste Paso A (twin.ramasPY) + fallback.
function ramaCandidates(twin) {
  const set = new Set();
  if (Array.isArray(twin.ramasPY)) for (const r of twin.ramasPY) if (r) set.add(String(r));
  if (twin.origenPY) {
    set.add(String(twin.origenPY));
    const base = String(twin.origenPY).split('#')[0];
    set.add(base);
    for (const cur of ['USD', 'PYG', 'UYU', 'ARS', 'BRL', 'EUR']) set.add(`${base}#${cur}`);
  }
  return [...set];
}

// Resuelve los HS deal ids de los MIRRORS con histórico. El twin es el lado costo del negocio PY
// COMPLETO (USD+PYG) → un mirror POR RAMA: se resuelven TODAS las ramas (ramasPY), no solo origenPY,
// para finalizar las facturas de ambos mirrors. origenPY → PY.deal_uy_mirror_id (fallback search).
async function resolverMirrorDealIds(path) {
  if (!path) return [];
  let raw;
  try { raw = JSON.parse(readFileSync(path, 'utf8')); } catch { return []; }
  const seen = new Set();
  for (const t of (raw.twinsApartados || [])) {
    if (!(t.historicalTickets || []).length) continue; // solo los que tienen histórico
    for (const origen of ramaCandidates(t)) {
      try {
        const rPy = await hs('POST', '/crm/v3/objects/deals/search', {
          filterGroups: [{ filters: [{ propertyName: 'id_crm_origen', operator: 'EQ', value: origen }] }],
          properties: ['hs_object_id', 'deal_uy_mirror_id'], limit: 2,
        });
        const py = (rPy?.results || [])[0];
        if (!py) continue;
        let mirrorId = String(py.properties?.deal_uy_mirror_id || '').trim() || null;
        if (!mirrorId) {
          const rM = await hs('POST', '/crm/v3/objects/deals/search', {
            filterGroups: [{ filters: [
              { propertyName: 'es_mirror_de_py', operator: 'EQ', value: 'true' },
              { propertyName: 'deal_py_origen_id', operator: 'EQ', value: String(py.id) },
            ] }],
            properties: ['hs_object_id'], limit: 2,
          });
          mirrorId = String((rM?.results || [])[0]?.id || '') || null;
        }
        if (mirrorId) seen.add(String(mirrorId));
      } catch (e) {
        console.warn(`  ⚠️ búsqueda mirror falló (origen=${origen}): ${e.message}`);
      }
      await sleep(150);
    }
  }
  return [...seen];
}

async function finalizeDeal(dealId, acc, pipeline, idx) {
  const ticketIds = await assoc(dealId, 'tickets');
  const tickets = await batchRead('tickets', ticketIds, TICKET_PROPS);
  const historicos = tickets.filter((t) => String(t.properties?.mig_emision_historica).trim() === 'true');
  if (!historicos.length) { acc.deals_sin_historicos++; return; }

  const invoiceIds = await assoc(dealId, 'invoices');
  const invoices = await batchRead('invoices', invoiceIds, INVOICE_PROPS);

  // Mapa canónico→mig leyendo los LIs (el snapshot del motor aún no propaga
  // mig_line_item_key al ticket — §0 pendiente). Permite recuperar el id Nodum.
  const liIds = await assoc(dealId, 'line_items');
  const lis = await batchRead('line_items', liIds, ['line_item_key', 'mig_line_item_key']);
  const migPorCanon = new Map();
  for (const li of lis) {
    const canon = String(li.properties?.line_item_key || '').trim().toUpperCase();
    const mig = String(li.properties?.mig_line_item_key || '').trim().toUpperCase();
    if (canon && mig) migPorCanon.set(canon, mig);
  }

  for (const t of historicos) {
    const tid = String(t.id);
    const tp = t.properties || {};

    let inv = invoices.find((i) => String(i.properties?.ticket_id) === tid);
    if (!inv && tp.of_invoice_key) inv = invoices.find((i) => i.properties?.of_invoice_key === tp.of_invoice_key);
    if (!inv && tp.of_invoice_id) inv = invoices.find((i) => String(i.id) === String(tp.of_invoice_id));

    if (!inv) {
      acc.sin_invoice++;
      console.warn(`  ⚠️ deal ${dealId} ticket ${tid}: sin Invoice asociada (¿lag de webhook? reintentar luego)`);
      continue;
    }

    // ── id Nodum + fecha histórica desde el JSON de migración (no del ticket) ──
    // mig_line_item_key: del ticket si está; si no, se recupera por of_line_item_key → LI.
    const canonKey = String(tp.of_line_item_key || '').trim().toUpperCase();
    const lik = String(tp.mig_line_item_key || '').trim().toUpperCase() || migPorCanon.get(canonKey) || '';
    const histInfo = lik ? (idx.get(lik) || {}) : {};
    if (!lik) {
      console.warn(`  ⚠️ deal ${dealId} ticket ${tid}: no pude resolver mig_line_item_key (ni en ticket ni por LI) → id Nodum vacío.`);
    } else if (!idx.has(lik)) {
      console.warn(`  ⚠️ deal ${dealId} ticket ${tid}: mig_line_item_key=${lik} no está en el JSON de migración → id Nodum/fecha vacíos.`);
    }

    const nodumId = histInfo.numero_de_factura || null;

    const yaEmitida = String(inv.properties?.etapa_de_la_factura).trim() === 'Emitida';
    const flagPrendido = String(tp.mig_emision_historica).trim() === 'true';
    if (yaEmitida && !flagPrendido) { acc.ya_listo++; continue; }

    // Fecha histórica: primero del JSON; fallback a props del ticket si el JSON no la trae.
    const histMs = toHubSpotDateOnly(
      histInfo.of_fecha_facturacion_real || tp[HIST_DATE_FIELD] || tp.of_fecha_de_facturacion || null
    );
    let dueMs = toHubSpotDateOnly(tp[DUE_DATE_FIELD] || null);
    if (dueMs == null && histMs != null) dueMs = histMs + DUE_FALLBACK_DAYS * DAY_MS;

    const invPatch = { etapa_de_la_factura: 'Emitida' };
    if (nodumId) invPatch.id_factura_nodum = nodumId;
    if (histMs != null) { invPatch.fecha_de_emision = histMs; invPatch.hs_invoice_date = histMs; }
    if (dueMs != null) invPatch.hs_due_date = dueMs;

    const fechaTxt = histMs != null ? new Date(histMs).toISOString().slice(0, 10) : '∅';
    const vencTxt = dueMs != null ? new Date(dueMs).toISOString().slice(0, 10) : '∅';
    console.log(
      `  deal ${dealId} · ticket ${tid} · inv ${inv.id}: -> Emitida | ` +
      `nodum=${nodumId || '∅'} | emision=${fechaTxt} | venc=${vencTxt}`
    );

    if (ESCRIBIR) {
      await hs('PATCH', `/crm/v3/objects/invoices/${inv.id}`, { properties: invPatch });
      // proceso COMPLETO factura->ticket (sync + propagacion + avance de deal)
      await pipeline(String(inv.id), nodumId ? { id_factura_nodum: nodumId } : null);
      // apagar el flag de migracion (el pipeline no lo toca)
      await hs('PATCH', `/crm/v3/objects/tickets/${tid}`, { properties: { mig_emision_historica: 'false' } });
    }
    acc.emitidas++;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const env = args.find((a) => a === 'sandbox' || a === 'prod') || null;
  const manifest = args.find((a) => a.endsWith('.json') && !a.startsWith('TWINS=')) || null;
  // Opcional: mirrors. TWINS=<pruebas_twins.json> → también finaliza las facturas de los mirrors
  // (id Nodum desde los twins; deal resuelto por origenPY → PY.deal_uy_mirror_id).
  const TWINS = (args.find((a) => a.startsWith('TWINS=')) || '').slice('TWINS='.length) || null;

  if (!env) { console.error('Uso: node migracion_pasoD_facturas.mjs <dryrun_objetos.json> <sandbox|prod>'); process.exit(1); }
  if (!TOKEN) { console.error('Falta HUBSPOT_PRIVATE_TOKEN en .env'); process.exit(1); }
  if (env === 'prod' && process.env.CONFIRMO_PROD !== 'true') {
    console.error('PROD bloqueado: exportá CONFIRMO_PROD=true para confirmar.'); process.exit(1);
  }

  console.log(`\n=== Paso D · finalizar facturas (${env}) — ${ESCRIBIR ? 'ESCRIBE' : 'DRY-RUN'} ===\n`);

  // Índice histórico (id Nodum + fecha) desde el JSON de Paso A (+ twins si se pasó TWINS=).
  const idx = cargarIndiceHistorico(manifest);
  if (TWINS) agregarTwinsAlIndice(TWINS, idx);
  console.log(`Índice histórico (id Nodum/fecha por LIK): ${idx.size} entradas` +
    (manifest ? ` (de ${manifest}${TWINS ? ` + ${TWINS}` : ''})` : ' (sin manifest → vacío)'));
  if (idx.size === 0 && manifest) {
    console.warn('⚠️ El manifest no trae historicalTickets con of_line_item_key → no habrá id Nodum/fecha. ' +
      '¿Le pasaste el dryrun_objetos.json de Paso A?');
  }

  // El pipeline solo se necesita si vamos a escribir. Import dinamico DESPUES de loadEnv()
  // para que hubspotClient lea el token correcto.
  let pipeline = null;
  if (ESCRIBIR) {
    try {
      ({ runInvoiceNodumPipeline: pipeline } = await import(PIPELINE_PATH));
    } catch (e) {
      console.error(`No pude importar runInvoiceNodumPipeline desde ${PIPELINE_PATH}: ${e.message}`);
      console.error('Ajustá PIPELINE_PATH a la ruta relativa al script (corré desde la raíz del repo).');
      process.exit(1);
    }
    if (typeof pipeline !== 'function') {
      console.error(`El módulo ${PIPELINE_PATH} no exporta runInvoiceNodumPipeline.`); process.exit(1);
    }
  }

  let dealIds;
  if (manifest) {
    dealIds = await resolverDealIdsDesdeManifest(manifest);
    console.log(`Deals desde manifest ${manifest}: ${dealIds.length}`);
  } else {
    console.log(`Buscando deals por tag archivo_de_importacion='${IMPORT_TAG}'...`);
    dealIds = await searchDealsByTag(IMPORT_TAG);
    console.log(`Encontrados: ${dealIds.length}`);
  }
  if (TWINS) {
    const mIds = await resolverMirrorDealIds(TWINS);
    console.log(`Mirrors (twins) con histórico: ${mIds.length}`);
    dealIds = (dealIds || []).concat(mIds);
  }

  const acc = { emitidas: 0, sin_invoice: 0, ya_listo: 0, deals_sin_historicos: 0, errores: 0 };
  for (const id of dealIds) {
    try { await finalizeDeal(id, acc, pipeline, idx); }
    catch (e) { acc.errores++; console.warn(`  ⚠️ deal ${id}: ${e.message}`); }
    await sleep(200); // anti rate-limit
  }

  console.log(
    `\n=== Resumen ===\n` +
    `  Facturas emitidas:        ${acc.emitidas}\n` +
    `  Sin invoice (lag/pend.):  ${acc.sin_invoice}\n` +
    `  Ya estaban listas:        ${acc.ya_listo}\n` +
    `  Deals sin históricos:     ${acc.deals_sin_historicos}\n` +
    `  Errores:                  ${acc.errores}\n` +
    `  ${ESCRIBIR ? '(cambios escritos)' : '(DRY-RUN: no se escribió nada — corré con ESCRIBIR=true)'}\n`
  );
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
