// migracion_pasoC_editar_tickets.mjs
//
// PASO C — Editar el ticket que generó el motor con los datos de la OF y disparar
//          `facturar_ahora`. Es el "Pasada 2" del flujo de tickets históricos (§3.6).
//
// PRECONDICIÓN (no la verifica este script): ya corriste
//   1) Pasada 1 (Paso B): deals + LIs + company creados; el LI lleva `line_item_key`.
//   2) El MOTOR: Phase P creó el ticket forecast y Phase 2 lo promovió a
//      "Próximos a Facturar" (queda asociado al deal y protegido — Phase P no lo re-snapshotea).
//
// QUÉ HACE, por cada deal de `result.deals` del JSON de Paso A:
//   1) Entra al negocio buscándolo por `id_crm_origen` (Search en deals; sin lag: es de la Pasada 1).
//   2) Lista los tickets ASOCIADOS al deal (v4 associations) — los forecast no se asocian,
//      así que solo aparecen los promovidos. No usa Search de tickets (esquiva el lag de indexado).
//   3) Por cada `historicalTicket` (keyado por `of_line_item_key`), matchea el ticket cuyo
//      `of_line_item_key` coincide Y está en una etapa editable pre-emisión
//      (Próximos a Facturar, o Listo para Facturar si el catch-up lo movió → avisa).
//   4) Escribe SOLO lo propio de la OF (la plata) + mig_emision_historica=true:
//      monto_unitario_real, cantidad_real=1, dolar, of_costo, mig_monto_usd.
//      ⚠️ Todo lo demás (of_rubro/servicio, of_descripcion, of_codigo_rubro,
//      mig_id_crm_origen, mig_id_cliente_nodum) llega al ticket por el snapshot
//      de buildTicketFullProps — Paso C NO lo toca.
//   5) FREEZE RULE: tras el PATCH, re-lee el ticket hasta que `total_real_a_facturar` (read-only,
//      lo calcula HubSpot) refleje el monto nuevo, y RECIÉN AHÍ prende `facturar_ahora`.
//
// QUÉ NO HACE:
//   - No escribe `numero_de_factura` (eso es Paso D, al editar la Invoice).
//   - No consume cupo (los LIs únicos NO son parte_del_cupo; el cupo viene precargado).
//   - No re-emite a Nodum (el path manual solo crea la Invoice en HubSpot; el id Nodum lo pone Paso D).
//   - Mirrors: si se pasa TWINS=<pruebas_twins.json>, también procesa los tickets de los
//     mirrors (se ubican por origenPY → PY.deal_uy_mirror_id; el puente mig_line_item_key lo
//     dejó B' sobre los LIs del mirror). Sin TWINS=, los mirrors se saltean.
//
// IDEMPOTENCIA: si el ticket ya tiene of_invoice_id o ya tiene facturar_ahora=true, lo saltea.
//
// Uso (PowerShell):
//   Dry-run:  node migracion_pasoC_editar_tickets.mjs dryrun_objetos.json sandbox
//   Escribir: node migracion_pasoC_editar_tickets.mjs dryrun_objetos.json sandbox ESCRIBIR
//   Acotar:   ... ESCRIBIR SOLO=ABC123...      (idOrigen del deal)
//             ... ESCRIBIR SOLO=ABC123...-FE2   (un of_line_item_key puntual)
//             ... ESCRIBIR LIMITE=3             (procesa solo N deals)
//
// Variables de entorno:
//   HUBSPOT_TOKEN              token de la Private App (o HUBSPOT_TOKEN_SANDBOX / _PROD, o HUBSPOT_PRIVATE_TOKEN)
//   BILLING_TICKET_STAGE_ID    stage "Próximos a Facturar" (manual)         ← requerido
//   BILLING_TICKET_STAGE_READY stage "Listo para Facturar" (manual)         ← opcional (se acepta como editable)
//   PROP_MONTO_USD_CALC        nombre interno de la prop CALCULADA "monto en dólares" del ticket
//                              (si está, se valida contra mig_monto_usd y se avisa si difiere)

import { readFileSync, writeFileSync } from 'node:fs';

// ── Carga .env del directorio actual (sin dependencias) ──
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

// ───────────────────────── args ─────────────────────────
const JSON_PATH = process.argv[2];
const ENV = (process.argv[3] || 'sandbox').toLowerCase(); // 'sandbox' | 'prod'
const FLAGS = process.argv.slice(4);

const ESCRIBIR = FLAGS.includes('ESCRIBIR');
const SOLO = (FLAGS.find((f) => f.startsWith('SOLO=')) || '').slice('SOLO='.length).toUpperCase() || null;
const LIMITE = parseInt((FLAGS.find((f) => f.startsWith('LIMITE=')) || '').slice('LIMITE='.length), 10) || null;
// Opcional: archivo de twins (mirrors). Si se pasa, también se procesan los mirrors
// (se ubican por origenPY → PY.deal_uy_mirror_id; el puente mig_line_item_key lo dejó B').
const TWINS = (FLAGS.find((f) => f.startsWith('TWINS=')) || '').slice('TWINS='.length) || null;

if (!JSON_PATH) {
  console.error('Uso: node migracion_pasoC_editar_tickets.mjs <dryrun_objetos.json> [sandbox|prod] [ESCRIBIR] [SOLO=<id|LIK>] [LIMITE=<n>]');
  process.exit(1);
}
if (!['sandbox', 'prod'].includes(ENV)) {
  console.error(`Entorno inválido: ${ENV}. Usar sandbox o prod.`);
  process.exit(1);
}

// ───────────────────────── config ─────────────────────────
const API = 'https://api.hubapi.com';
const TOKEN =
  process.env[`HUBSPOT_TOKEN_${ENV.toUpperCase()}`] ||
  process.env.HUBSPOT_TOKEN ||
  process.env.HUBSPOT_PRIVATE_TOKEN ||
  '';

const STAGE_PROXIMOS = (process.env.BILLING_TICKET_STAGE_ID || '').trim();   // "Próximos a Facturar"
const STAGE_LISTO    = (process.env.BILLING_TICKET_STAGE_READY || '').trim(); // "Listo para Facturar" (catch-up)
const PROP_MONTO_USD_CALC = (process.env.PROP_MONTO_USD_CALC || '').trim();   // prop calculada, opcional

// Etapas editables pre-emisión donde puede estar el ticket histórico.
const STAGES_EDITABLES = [STAGE_PROXIMOS, STAGE_LISTO].filter(Boolean);

// Tasa de IVA por tax group (cálculo inverso: el monto de la OF viene BRUTO).
const TASA_POR_TAX_GROUP = {};
if (process.env.IVA_UY_TAX_GROUP_ID) TASA_POR_TAX_GROUP[process.env.IVA_UY_TAX_GROUP_ID.trim()] = 0.22;
if (process.env.IVA_PY_TAX_GROUP_ID) TASA_POR_TAX_GROUP[process.env.IVA_PY_TAX_GROUP_ID.trim()] = 0.10;
if (process.env.IVA_EXENTO_TAX_GROUP_ID) TASA_POR_TAX_GROUP[process.env.IVA_EXENTO_TAX_GROUP_ID.trim()] = 0;
function tasaIva(taxGroupId) {
  const k = String(taxGroupId || '').trim();
  return Object.prototype.hasOwnProperty.call(TASA_POR_TAX_GROUP, k) ? TASA_POR_TAX_GROUP[k] : 0;
}
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// FREEZE: cuántas veces re-leer y cada cuánto, esperando que total_real_a_facturar refleje el monto nuevo.
const FREEZE_INTENTOS = 8;
const FREEZE_DELAY_MS = 1500;

// Ritmo entre operaciones (HubSpot Private App: 100 req / 10 s). Base de prueba chica → suave.
const PACE_MS = 180;

// Tolerancia para comparar montos calculados (absoluta + relativa).
const TOL_ABS = 0.02;
const TOL_REL = 0.005;

if (!TOKEN) {
  console.error('Falta el token. Definí HUBSPOT_TOKEN (o HUBSPOT_TOKEN_' + ENV.toUpperCase() + ' / HUBSPOT_PRIVATE_TOKEN).');
  process.exit(1);
}
if (!STAGE_PROXIMOS) {
  console.error('Falta BILLING_TICKET_STAGE_ID (stage "Próximos a Facturar").');
  process.exit(1);
}

// ───────────────────────── helpers ─────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function casiIgual(a, b) {
  const x = Number(a), y = Number(b);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  const diff = Math.abs(x - y);
  return diff <= TOL_ABS || diff <= Math.abs(y) * TOL_REL;
}

// fetch con auth + reintento básico ante 429 / 5xx.
async function hsFetch(path, { method = 'GET', body = null } = {}, intento = 0) {
  await sleep(PACE_MS);
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if ((res.status === 429 || res.status >= 500) && intento < 5) {
    const retryAfter = parseInt(res.headers.get('Retry-After') || '0', 10);
    const wait = retryAfter > 0 ? retryAfter * 1000 : 1500 * (intento + 1);
    console.warn(`   ↻ HubSpot ${res.status} en ${path} → reintento ${intento + 1} en ${wait}ms`);
    await sleep(wait);
    return hsFetch(path, { method, body }, intento + 1);
  }
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    const msg = data?.message || text || `HTTP ${res.status}`;
    throw new Error(`${method} ${path} → ${res.status}: ${msg}`);
  }
  return data;
}

// Busca el deal por id_crm_origen. Devuelve dealId o null.
async function buscarDealPorCrmOrigen(idOrigen) {
  const data = await hsFetch('/crm/v3/objects/deals/search', {
    method: 'POST',
    body: {
      filterGroups: [{ filters: [{ propertyName: 'id_crm_origen', operator: 'EQ', value: idOrigen }] }],
      properties: ['hs_object_id', 'id_crm_origen', 'dealname', 'facturacion_activa', 'deal_uy_mirror_id'],
      limit: 10,
    },
  });
  const results = data?.results || [];
  if (results.length === 0) return null;
  if (results.length > 1) {
    console.warn(`   ⚠️  ${results.length} deals con id_crm_origen=${idOrigen}; uso el primero (${results[0].id}). Revisar duplicados.`);
  }
  return { id: results[0].id, props: results[0].properties || {} };
}

// El twin es el lado costo del negocio PY COMPLETO (USD+PYG): el motor crea UN MIRROR POR RAMA.
// Por eso se resuelven TODOS los mirrors del base (vía twin.ramasPY que persiste Paso A, + fallback),
// no uno solo. Cada origen PY → PY.deal_uy_mirror_id (fallback: search es_mirror_de_py + deal_py_origen_id).
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

async function buscarMirrorsPorTwin(twin) {
  const seen = new Set(), mirrors = [];
  for (const origen of ramaCandidates(twin)) {
    const py = await buscarDealPorCrmOrigen(origen);
    if (!py) continue;
    let mirrorId = (py.props?.deal_uy_mirror_id || '').trim() || null;
    if (!mirrorId) {
      const data = await hsFetch('/crm/v3/objects/deals/search', {
        method: 'POST',
        body: {
          filterGroups: [{ filters: [
            { propertyName: 'es_mirror_de_py', operator: 'EQ', value: 'true' },
            { propertyName: 'deal_py_origen_id', operator: 'EQ', value: String(py.id) },
          ] }],
          properties: ['hs_object_id', 'dealname', 'facturacion_activa'],
          limit: 5,
        },
      });
      const r = data?.results || [];
      if (r.length > 1) console.warn(`   ⚠️  ${r.length} mirrors para PY ${py.id}; uso el primero.`);
      if (r.length) mirrorId = String(r[0].id);
    }
    if (mirrorId && !seen.has(String(mirrorId))) {
      seen.add(String(mirrorId));
      const m = await hsFetch(`/crm/v3/objects/deals/${mirrorId}?properties=facturacion_activa,dealname`);
      mirrors.push({ id: String(mirrorId), props: m?.properties || {} });
    }
  }
  return mirrors;
}

const PROPS_LI = ['hs_object_id', 'line_item_key', 'mig_line_item_key', 'hs_tax_rate_group_id'];

// Line items asociados al deal (v4) → ids.
async function lineItemsAsociadosAlDeal(dealId) {
  const data = await hsFetch(`/crm/v4/objects/deals/${dealId}/associations/line_items?limit=500`);
  return (data?.results || []).map((r) => String(r.toObjectId || r.id)).filter(Boolean);
}

async function leerLineItems(ids) {
  if (!ids.length) return [];
  const data = await hsFetch('/crm/v3/objects/line_items/batch/read', {
    method: 'POST',
    body: { properties: PROPS_LI, inputs: ids.map((id) => ({ id: String(id) })) },
  });
  return data?.results || [];
}

// Tickets asociados al deal (v4). Los forecast NO se asocian → solo vuelven los promovidos.
async function ticketsAsociadosAlDeal(dealId) {
  const data = await hsFetch(`/crm/v4/objects/deals/${dealId}/associations/tickets?limit=500`);
  return (data?.results || []).map((r) => String(r.toObjectId || r.id)).filter(Boolean);
}

const PROPS_TICKET = [
  'hs_object_id', 'of_line_item_key', 'hs_pipeline', 'hs_pipeline_stage',
  'total_real_a_facturar', 'monto_unitario_real', 'cantidad_real', 'dolar',
  'of_costo', 'mig_total', 'of_invoice_id', 'facturar_ahora',
  ...(PROP_MONTO_USD_CALC ? [PROP_MONTO_USD_CALC] : []),
];

// Lee varios tickets (batch read por ids).
async function leerTickets(ids) {
  if (!ids.length) return [];
  const data = await hsFetch('/crm/v3/objects/tickets/batch/read', {
    method: 'POST',
    body: { properties: PROPS_TICKET, inputs: ids.map((id) => ({ id: String(id) })) },
  });
  return data?.results || [];
}

async function leerTicket(id) {
  const data = await hsFetch(`/crm/v3/objects/tickets/${id}?properties=${PROPS_TICKET.join(',')}`);
  return data;
}

async function patchTicket(id, properties) {
  return hsFetch(`/crm/v3/objects/tickets/${id}`, { method: 'PATCH', body: { properties } });
}

// FREEZE: re-lee hasta que total_real_a_facturar ≈ esperado. Devuelve { ok, total, intentos, ticket }.
async function esperarFreeze(ticketId, totalEsperado) {
  for (let i = 1; i <= FREEZE_INTENTOS; i++) {
    await sleep(FREEZE_DELAY_MS);
    const t = await leerTicket(ticketId);
    const total = Number(t?.properties?.total_real_a_facturar);
    if (casiIgual(total, totalEsperado)) return { ok: true, total, intentos: i, ticket: t };
  }
  const t = await leerTicket(ticketId);
  return { ok: false, total: Number(t?.properties?.total_real_a_facturar), intentos: FREEZE_INTENTOS, ticket: t };
}

// ───────────────────────── carga JSON ─────────────────────────
let result;
try {
  result = JSON.parse(readFileSync(JSON_PATH, 'utf8'));
} catch (e) {
  console.error(`No pude leer/parsear ${JSON_PATH}: ${e.message}`);
  process.exit(1);
}
let deals = Array.isArray(result?.deals) ? result.deals : [];

// Mirrors (twins): si se pasó TWINS=, se agregan marcados con _esMirror para procesarlos.
if (TWINS) {
  try {
    const tw = JSON.parse(readFileSync(TWINS, 'utf8'));
    const twins = (tw.twinsApartados || []).map((t) => ({ ...t, _esMirror: true }));
    deals = deals.concat(twins);
    console.log(`Mirrors (twins) cargados de ${TWINS}: ${twins.length}`);
  } catch (e) {
    console.error(`No pude leer/parsear TWINS=${TWINS}: ${e.message}`);
    process.exit(1);
  }
}

// Filtros opcionales
if (SOLO) {
  deals = deals.filter((d) => {
    const idMatch = String(d.idOrigen || '').toUpperCase() === SOLO;
    const likMatch = (d.historicalTickets || []).some((h) => String(h.mig_line_item_key || '').toUpperCase() === SOLO);
    return idMatch || likMatch;
  });
}
// Guard: los mirrors del JSON principal (no marcados _esMirror) se saltean; los twins
// cargados vía TWINS= (con _esMirror=true) SÍ se procesan.
deals = deals.filter((d) => {
  if (d._esMirror) return true;
  const dp = d.deal || {};
  if (dp.es_mirror_de_py === 'true' || dp.deal_py_origen_id) {
    console.log(`   ⏭️  ${d.caso}: mirror sin TWINS= → saltado.`);
    return false;
  }
  return true;
});
if (LIMITE) deals = deals.slice(0, LIMITE);

console.log(`\n=== PASO C ${ESCRIBIR ? '(ESCRIBIR)' : '(dry-run)'} · ${ENV} ===`);
console.log(`JSON: ${JSON_PATH} · deals a procesar: ${deals.length}` + (SOLO ? ` · SOLO=${SOLO}` : '') + (LIMITE ? ` · LIMITE=${LIMITE}` : ''));
console.log(`Stages editables: Próximos=${STAGE_PROXIMOS}${STAGE_LISTO ? ` · Listo=${STAGE_LISTO}` : ''}`);
if (!PROP_MONTO_USD_CALC) console.log('ℹ️  PROP_MONTO_USD_CALC sin definir → no se valida el "monto en dólares" calculado.');
console.log('');

// ───────────────────────── proceso por deal ─────────────────────────
const reporte = [];
const stats = { editados: 0, freezeFalla: 0, yaFacturados: 0, yaEnVuelo: 0, sinMatch: 0, ambiguos: 0, sinMonto: 0, sinLiCanonico: 0, dealNoEncontrado: 0, errores: 0 };

function registrar(o) { reporte.push(o); }

for (const d of deals) {
  const caso = d.caso || d.idOrigen;
  const esMirror = !!d._esMirror;
  const idOrigen = String(d.deal?.id_crm_origen || d.idOrigen || '').toUpperCase();
  const hts = d.historicalTickets || [];
  if (!hts.length) { console.log(`• ${caso}: sin historicalTickets → nada que hacer.`); continue; }

  // scanDeals = los deals donde buscar tickets/LIs. MIRROR: TODOS los mirrors (ambas ramas) vía
  // ramasPY; el matcheo por mig_line_item_key (estampado por B' en los LIs de ambos) los une.
  let scanDeals = [];
  if (esMirror) {
    const base = String(d.origenPY || '').toUpperCase().split('#')[0];
    console.log(`• ${caso} [MIRROR]  (base=${base}, ${hts.length} OF)`);
    try {
      scanDeals = await buscarMirrorsPorTwin(d);
    } catch (e) {
      console.warn(`   ✖ error buscando mirrors: ${e.message}`); stats.errores++; continue;
    }
    if (!scanDeals.length) {
      console.warn("   ✖ ningún mirror encontrado (ramasPY → PY → deal_uy_mirror_id). ¿Corriste el motor + B'?");
      stats.dealNoEncontrado++;
      for (const h of hts) registrar({ caso, idOrigen: base, lik: h.mig_line_item_key, accion: 'MIRROR_NO_ENCONTRADO' });
      continue;
    }
    console.log(`   mirrors (${scanDeals.length}): ${scanDeals.map((m) => m.id).join(', ')}`);
  } else {
    console.log(`• ${caso}  (id_crm_origen=${idOrigen}, ${hts.length} OF)`);
    let deal;
    try {
      deal = await buscarDealPorCrmOrigen(idOrigen);
    } catch (e) {
      console.warn(`   ✖ error buscando deal: ${e.message}`); stats.errores++; continue;
    }
    if (!deal) {
      console.warn('   ✖ deal no encontrado por id_crm_origen (¿corriste Paso B?).');
      stats.dealNoEncontrado++;
      for (const h of hts) registrar({ caso, idOrigen, lik: h.of_line_item_key, accion: 'DEAL_NO_ENCONTRADO' });
      continue;
    }
    scanDeals = [deal];
  }

  // Aviso temprano: processUrgentTicket exige facturacion_activa=true en el deal.
  if (scanDeals.some((dl) => String(dl.props?.facturacion_activa || '').toLowerCase() !== 'true')) {
    console.warn('   ⚠️  algún deal con facturacion_activa != true → al prender facturar_ahora el motor bloqueará esa emisión.');
  }

  // Tickets asociados de TODOS los deals a escanear (mirror: ambas ramas).
  let ticketIds = [];
  try {
    for (const dl of scanDeals) ticketIds.push(...await ticketsAsociadosAlDeal(dl.id));
  } catch (e) {
    console.warn(`   ✖ error listando tickets asociados: ${e.message}`); stats.errores++; continue;
  }
  if (!ticketIds.length) {
    console.warn('   ✖ los deals no tienen tickets asociados (¿Phase 2 todavía no promovió?).');
    for (const h of hts) registrar({ caso, idOrigen, lik: h.of_line_item_key, accion: 'SIN_TICKETS_ASOCIADOS' });
    continue;
  }

  let tickets = [];
  try {
    tickets = await leerTickets(ticketIds);
  } catch (e) {
    console.warn(`   ✖ error leyendo tickets: ${e.message}`); stats.errores++; continue;
  }

  // Índice por of_line_item_key (puede haber más de uno por LIK si quedó basura → se detecta abajo).
  const porLik = new Map();
  for (const t of tickets) {
    const lik = String(t.properties?.of_line_item_key || '').trim().toUpperCase();
    if (!lik) continue;
    if (!porLik.has(lik)) porLik.set(lik, []);
    porLik.get(lik).push(t);
  }

  // Puente migración → canónico: el ticket lleva el LIK canónico (lo generó el motor),
  // no el -FE<i>. Mapeamos mig_line_item_key (-FE<i>) → line_item_key canónico vía los LIs del deal.
  const canonByMig = new Map();
  const taxByMig = new Map();
  try {
    for (const dl of scanDeals) {
      const liIds = await lineItemsAsociadosAlDeal(dl.id);
      const lis = await leerLineItems(liIds);
      for (const li of lis) {
        const mig = String(li.properties?.mig_line_item_key || '').trim().toUpperCase();
        const canon = String(li.properties?.line_item_key || '').trim().toUpperCase();
        if (mig && canon) canonByMig.set(mig, canon);
        if (mig) taxByMig.set(mig, String(li.properties?.hs_tax_rate_group_id || '').trim());
      }
    }
  } catch (e) {
    console.warn(`   ✖ error leyendo line items del deal: ${e.message}`); stats.errores++; continue;
  }

  for (const h of hts) {
    const mig = String(h.mig_line_item_key || '').trim().toUpperCase();
    const montoOrig = Number(h.monto_moneda_orig);
    const lik = canonByMig.get(mig) || '';     // canónico para indexar porLik
    const base = { caso, idOrigen, mig, lik };
    if (!mig) { console.warn('   ✖ historicalTicket sin mig_line_item_key → saltado.'); registrar({ ...base, accion: 'HT_SIN_MIG' }); continue; }
    if (!lik) {
      console.warn(`   ✖ ${mig}: ningún LI del deal tiene ese mig_line_item_key (¿Paso B no lo escribió?) → saltado.`);
      stats.sinLiCanonico = (stats.sinLiCanonico || 0) + 1;
      registrar({ ...base, accion: 'SIN_LI_CANONICO' }); continue;
    }
    if (!Number.isFinite(montoOrig) || montoOrig <= 0) {
      console.warn(`   ✖ ${lik}: monto_moneda_orig inválido (${h.monto_moneda_orig}) → saltado.`);
      stats.sinMonto++; registrar({ ...base, accion: 'SIN_MONTO', valor: h.monto_moneda_orig }); continue;
    }

    const candidatos = porLik.get(lik) || [];
    // Candidatos en etapa editable y NO emitidos todavía.
    const editables = candidatos.filter((t) => {
      const st = String(t.properties?.hs_pipeline_stage || '').trim();
      const tieneFactura = String(t.properties?.of_invoice_id || '').trim() !== '';
      return STAGES_EDITABLES.includes(st) && !tieneFactura;
    });

    // Idempotencia: ¿alguno ya facturado o ya en vuelo?
    const yaFacturado = candidatos.find((t) => String(t.properties?.of_invoice_id || '').trim() !== '');
    if (yaFacturado) {
      console.log(`   ✓ ${lik}: ticket ${yaFacturado.id} ya tiene factura (of_invoice_id) → saltado (idempotente).`);
      stats.yaFacturados++; registrar({ ...base, ticketId: yaFacturado.id, accion: 'YA_FACTURADO' }); continue;
    }

    if (editables.length === 0) {
      console.warn(`   ✖ ${lik}: sin ticket en etapa editable (Próximos/Listo). ` +
        `Stages vistos: [${candidatos.map((t) => t.properties?.hs_pipeline_stage).join(', ') || '—'}].`);
      stats.sinMatch++; registrar({ ...base, accion: 'SIN_MATCH', stages: candidatos.map((t) => t.properties?.hs_pipeline_stage) }); continue;
    }
    if (editables.length > 1) {
      console.warn(`   ✖ ${lik}: ${editables.length} tickets editables (ambiguo: ${editables.map((t) => t.id).join(', ')}) → saltado, revisar a mano.`);
      stats.ambiguos++; registrar({ ...base, accion: 'AMBIGUO', ticketIds: editables.map((t) => t.id) }); continue;
    }

    const t = editables[0];
    const ticketId = t.id;
    const stageActual = String(t.properties?.hs_pipeline_stage || '').trim();
    const yaEnVuelo = String(t.properties?.facturar_ahora || '').toLowerCase() === 'true';

    if (stageActual === STAGE_LISTO) {
      console.warn(`   ⚠️  ${lik}: ticket ${ticketId} está en "Listo para Facturar" (el catch-up lo movió), no en "Próximos". Igual editable.`);
    }
    if (yaEnVuelo) {
      console.log(`   ✓ ${lik}: ticket ${ticketId} ya tiene facturar_ahora=true → saltado (en vuelo).`);
      stats.yaEnVuelo++; registrar({ ...base, ticketId, accion: 'YA_EN_VUELO' }); continue;
    }

    // Propiedades de la OF que escribe Paso C (la plata) + flag de migración.
    // El resto (rubro, descripción, ids de origen) llega por snapshot del motor.
    // IVA: el monto de la OF es BRUTO → cálculo inverso para que el total (con IVA) dé el bruto.
    const tasa = tasaIva(taxByMig.get(mig));
    const montoUnitario = tasa > 0 ? round2(montoOrig / (1 + tasa)) : montoOrig;
const props = {
      // ── operativas (las que el motor/HubSpot usan para calcular el total) ──
      monto_unitario_real: montoUnitario,       // neto (bruto / (1+tasa)); HubSpot le suma el IVA
      cantidad_real: 1,
      dolar: Number(h.of_dolar) || '',
      of_costo: Number.isFinite(Number(h.of_costo)) ? Number(h.of_costo) : '',
      // ── respaldos de migración (trazabilidad; NO incluye id Nodum: eso es Paso D) ──
      mig_total: Number(h.total_real_a_facturar) || '',  // Monto OF en USD (respaldo)
      mig_monto_moneda_orig: montoOrig,                  // monto en moneda original (respaldo)
      mig_of_dolar: Number(h.of_dolar) || '',            // TC de la OF (respaldo)
      ...(h.of_fecha_facturacion_real || h.of_fecha_de_facturacion
        ? { mig_of_fecha_facturacion_real: String(h.of_fecha_facturacion_real || h.of_fecha_de_facturacion) }
        : {}),
      mig_emision_historica: 'true',            // ← el motor lo lee para NO propagar al espejo; Paso D lo apaga
    };

    const totalEsperado = montoOrig; // BRUTO: monto_unitario_real (neto) × (1+tasa) ≈ bruto de la OF

    if (!ESCRIBIR) {
      console.log(`   ▷ ${lik}: [dry-run] ticket ${ticketId} (stage ${stageActual}) → ` +
        `monto_unitario_real=${montoUnitario} (bruto ${montoOrig}, IVA ${Math.round(tasa * 100)}%), dolar=${props.dolar}, of_costo=${props.of_costo}, mig_emision_historica=true; ` +
        `luego FREEZE (esperar total≈${totalEsperado}) y facturar_ahora=true.`);
      registrar({ ...base, ticketId, stage: stageActual, accion: 'DRY_RUN', props, totalEsperado });
      continue;
    }

    // ── ESCRIBIR ──
    try {
      await patchTicket(ticketId, props);

      const fz = await esperarFreeze(ticketId, totalEsperado);
      if (!fz.ok) {
        console.warn(`   ✖ ${lik}: FREEZE no convergió (total_real_a_facturar=${fz.total}, esperado≈${totalEsperado}) tras ${fz.intentos} intentos. NO se prende facturar_ahora.`);
        stats.freezeFalla++; registrar({ ...base, ticketId, accion: 'FREEZE_FALLA', total: fz.total, totalEsperado }); continue;
      }

      // Validación opcional del "monto en dólares" calculado contra mig_monto_usd.
      if (PROP_MONTO_USD_CALC) {
        const usdCalc = Number(fz.ticket?.properties?.[PROP_MONTO_USD_CALC]);
        const usdMig = Number(h.total_real_a_facturar);
        if (Number.isFinite(usdCalc) && !casiIgual(usdCalc, usdMig)) {
          console.warn(`   ⚠️  ${lik}: monto en dólares calculado (${usdCalc}) ≠ USD migrado (${usdMig}). Reviso el dólar/monto. (Se prende igual.)`);
        }
      }

      await patchTicket(ticketId, { facturar_ahora: 'true' });
      console.log(`   ✅ ${lik}: ticket ${ticketId} editado (total=${fz.total}) y facturar_ahora=true. El motor emitirá la Invoice (Pendiente).`);
      stats.editados++;
      registrar({ ...base, ticketId, accion: 'EDITADO', total: fz.total, totalEsperado });
    } catch (e) {
      console.warn(`   ✖ ${lik}: error editando/facturando ticket ${ticketId}: ${e.message}`);
      stats.errores++; registrar({ ...base, ticketId, accion: 'ERROR', error: e.message });
    }
  }
  
}

// ───────────────────────── salida ─────────────────────────
console.log('\n=== Resumen ===');
console.table([stats]);

const OUT = `pasoC_resultado${ESCRIBIR ? '' : '_dryrun'}.json`;
writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), env: ENV, escribir: ESCRIBIR, stats, reporte }, null, 2), 'utf8');
console.log(`Detalle por LIK en ${OUT}`);
