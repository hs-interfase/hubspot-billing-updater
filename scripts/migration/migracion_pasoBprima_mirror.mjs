// migracion_pasoBprima_mirror.mjs
//
// PASO B' — Ajuste del MIRROR con los datos del twin UY apartado.
//
// Corre DESPUÉS de cronWeekendFull (el motor ya creó el mirror copiando las LIs
// uy=true del PY). B' busca ese mirror y EDITA (no borra ni recrea) las propiedades
// de sus line items para reflejar los valores reales del lado UY (twin).
//
//   Edita por LI: price (monto) + fechas (start/anchor) + servicio + mig_line_item_key
//     (la llave del twin → puente para que Paso C/D del mirror matcheen el histórico).
//   NO toca tickets / facturas: eso lo arregla Paso C.
//
// Emparejado mirror <-> twin (modelo COSTO cross-rama, 2026-06-27):
//   - El twin es el lado COSTO del negocio PY COMPLETO (USD+PYG). Tras el fix de Paso A sus OF
//     prenden uy=true en AMBAS ramas → el motor crea UN MIRROR POR RAMA. B' resuelve TODOS los
//     PY/mirror del base (twin.ramasPY) y junta sus LIs en un pool cross-rama.
//   - Empareja por MONTO: Paso A puso COGS del PY = monto original del twin (_ofMontoOrig) y el
//     motor lo copia a price del mirror → mirror.price == twin._ofMontoOrig (match exacto). 1:1,
//     fecha como desempate, tolerante a distinta cantidad (resto sin espejo se reporta).
//
// Dry-run por defecto (no escribe). Para escribir: pasar --write.
//
// Uso (PowerShell, parado en 1_MIGRAR/ dentro de hubspot-billing-updater):
//   node migracion_pasoBprima_mirror.mjs [pruebas_twins.json] [--write]
//   $env:LOG_LEVEL="debug"; node migracion_pasoBprima_mirror.mjs pruebas_twins.json
//
// Toma el token del sandbox de hubspot-billing-updater/.env (HUBSPOT_*_TOKEN).
//
// Cómo enlaza B' el twin con el mirror del motor:
//   twin.origenPY  --(id_crm_origen)-->  deal PY migrado en HubSpot
//   deal PY.deal_uy_mirror_id           -->  mirror creado por el motor
//   (fallback: search es_mirror_de_py=true + deal_py_origen_id=<id PY en HubSpot>)

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@hubspot/api-client';

// ───────────────────────── args ─────────────────────────
const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const TWINS_FILE = args.find((a) => !a.startsWith('--')) || 'pruebas_twins.json';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ───────────────────────── token (.env del repo, un nivel arriba) ─────────────────────────
const TOKEN_VARS = [
  'HUBSPOT_PRIVATE_TOKEN', // la que está en el .env de este repo (igual que el writer)
];

function loadToken() {
  for (const v of TOKEN_VARS) if (process.env[v]) return process.env[v];
  // Busca un .env: primero en el cwd (correr parado en la raíz del repo), luego
  // subiendo desde la ubicación del script (los scripts viven en scripts/migration/).
  const candidatos = [
    join(process.cwd(), '.env'),
    join(__dirname, '..', '..', '.env'),
    join(__dirname, '..', '.env'),
  ];
  for (const envPath of candidatos) {
    if (!existsSync(envPath)) continue;
    for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+)\s*$/);
      if (m && TOKEN_VARS.includes(m[1])) return m[2].replace(/^["']|["']$/g, '').trim();
    }
  }
  return null;
}

const TOKEN = loadToken();
if (!TOKEN) {
  console.error('✖ No encontré el token. Seteá HUBSPOT_PRIVATE_APP_TOKEN (o _ACCESS_TOKEN / _TOKEN)');
  console.error('  en el entorno, o dejalo en ../.env (hubspot-billing-updater/.env).');
  process.exit(1);
}
const hs = new Client({ accessToken: TOKEN });

// ───────────────────────── log ─────────────────────────
const DEBUG = (process.env.LOG_LEVEL || '').toLowerCase() === 'debug';
const log = (...a) => console.log(...a);
const dbg = (...a) => { if (DEBUG) console.log('  ·', ...a); };

// ───────────────────────── helpers HubSpot ─────────────────────────
async function findPyDealByCrmOrigen(idCrmOrigen) {
  const resp = await hs.crm.deals.searchApi.doSearch({
    filterGroups: [{ filters: [{ propertyName: 'id_crm_origen', operator: 'EQ', value: String(idCrmOrigen) }] }],
    properties: ['dealname', 'id_crm_origen', 'deal_uy_mirror_id', 'pais_operativo'],
    limit: 5,
  });
  return resp.results || [];
}

async function findMirrorByOrigin(pyHubspotId) {
  const resp = await hs.crm.deals.searchApi.doSearch({
    filterGroups: [{ filters: [
      { propertyName: 'es_mirror_de_py', operator: 'EQ', value: 'true' },
      { propertyName: 'deal_py_origen_id', operator: 'EQ', value: String(pyHubspotId) },
    ] }],
    properties: ['dealname', 'deal_py_origen_id', 'es_mirror_de_py'],
    limit: 5,
  });
  return resp.results || [];
}

async function getDealLineItems(dealId) {
  const ids = [];
  let after;
  do {
    const r = await hs.crm.associations.v4.basicApi.getPage('deals', dealId, 'line_items', 100, after);
    for (const x of r.results || []) ids.push(x.toObjectId);
    after = r.paging?.next?.after;
  } while (after);
  if (!ids.length) return [];
  const props = ['name', 'price', 'quantity', 'servicio', 'line_item_key', 'mig_line_item_key',
    'hs_recurring_billing_start_date', 'billing_anchor_date', 'of_line_item_py_origen_id', 'hs_product_id'];
  const items = [];
  for (const id of ids) {
    const li = await hs.crm.lineItems.basicApi.getById(id, props);
    items.push({ id: li.id, properties: li.properties || {} });
  }
  return items;
}

// orden determinístico: fecha asc, monto asc, key/id (para emparejar "por orden")
function ordKey(fecha, monto, tie) {
  const n = Number(monto || 0);
  const m = (Number.isFinite(n) ? n : 0).toFixed(2).padStart(18, '0');
  return `${fecha || '9999-99-99'}|${m}|${tie || ''}`;
}

// Empareja cada LI del MIRROR con su LI del TWIN por MONTO. Paso A puso COGS del PY = monto
// original del twin (_ofMontoOrig) y el motor lo copia a price del mirror → mirror.price ==
// twin._ofMontoOrig (match exacto, incl. los divergentes 2–4% que igual toman el monto del twin).
// Tolera distinta CANTIDAD (mirror puede tener menos LIs que el twin): 1:1 por monto, fecha
// desempata, resto sin espejo se reporta. Determinístico (mirror ordenado).
function emparejarPorMontoFecha(mirrorLIs, twinLIs) {
  const usados = new Set();
  const pares = [], sinMirror = [];
  const ms = [...mirrorLIs].sort((a, b) =>
    ordKey(a.properties.hs_recurring_billing_start_date, a.properties.price, a.id)
      .localeCompare(ordKey(b.properties.hs_recurring_billing_start_date, b.properties.price, b.id)));
  for (const m of ms) {
    const md = m.properties.hs_recurring_billing_start_date || m.properties.billing_anchor_date || '';
    const mp = Number(m.properties.price || 0);
    const tol = Math.max(0.5, Math.abs(mp) * 0.005); // mirror.price = monto original del twin (igualdad, margen de redondeo)
    let best = -1, bestScore = Infinity;
    for (let j = 0; j < twinLIs.length; j++) {
      if (usados.has(j)) continue;
      const t = twinLIs[j];
      const tp = Number(t._ofMontoOrig ?? t.price ?? 0); // monto ORIGINAL del twin (= COGS PY = price mirror)
      const dMonto = Math.abs(tp - mp);
      if (dMonto > tol) continue; // el monto DEBE coincidir
      const td = t.hs_recurring_billing_start_date || t.billing_anchor_date || '';
      const dDate = (md && td && md === td) ? 0 : 1; // misma fecha desempata
      const score = dDate * 1e12 + dMonto;
      if (score < bestScore) { bestScore = score; best = j; }
    }
    if (best >= 0) { usados.add(best); pares.push([m, twinLIs[best]]); }
    else sinMirror.push(m);
  }
  const sinTwin = twinLIs.filter((_, j) => !usados.has(j));
  return { pares, sinMirror, sinTwin };
}

// ───────────────────────── resolución cross-rama ─────────────────────────
const basePyId = (s) => String(s || '').split('#')[0];

// Origenes PY candidatos del base: la lista persistida por Paso A (twin.ramasPY) +, como red,
// el origenPY del twin, el base sin split, y las ramas de moneda usuales. EQ por cada uno.
function ramaCandidates(twin) {
  const set = new Set();
  if (Array.isArray(twin.ramasPY)) for (const r of twin.ramasPY) if (r) set.add(String(r));
  if (twin.origenPY) {
    set.add(String(twin.origenPY));
    const base = basePyId(twin.origenPY);
    set.add(base);
    for (const cur of ['USD', 'PYG', 'UYU', 'ARS', 'BRL', 'EUR']) set.add(`${base}#${cur}`);
  }
  return [...set];
}

// Resuelve TODOS los PY (todas las ramas del base) y TODOS sus mirrors. El twin es el lado costo
// del negocio PY completo: sus OF prenden uy=true en ambas ramas → hay un mirror por rama.
async function resolvePysYMirrors(twin) {
  const pys = new Map(); // pyId -> deal (dedup)
  for (const origen of ramaCandidates(twin)) {
    for (const p of await findPyDealByCrmOrigen(origen)) pys.set(p.id, p);
  }
  const mirrorIds = new Set();
  for (const py of pys.values()) {
    let mid = py.properties?.deal_uy_mirror_id || null;
    if (!mid) {
      const ms = await findMirrorByOrigin(py.id);
      if (ms.length === 1) mid = ms[0].id;
      else if (ms.length > 1) log(`  ⚠ ${ms.length} mirrors para PY ${py.id}; resolver a mano (lo salteo).`);
    }
    if (mid) mirrorIds.add(String(mid));
  }
  return { pys: [...pys.values()], mirrorIds: [...mirrorIds] };
}

// ───────────────────────── ajuste de un mirror ─────────────────────────
async function reconcileMirror(twin) {
  const tag = `[${twin.deal?.dealname || twin.idOrigen}]`;
  log(`\n=== ${tag} (twin ${twin.idOrigen} · base ${basePyId(twin.origenPY)}) ===`);

  // 1) TODOS los PY del base + 2) TODOS sus mirrors (uno por rama)
  const { pys, mirrorIds } = await resolvePysYMirrors(twin);
  if (!pys.length) { log(`  ⚠ no encontré ningún PY migrado del base ${basePyId(twin.origenPY)}. ¿Corriste Paso B?`); return; }
  if (!mirrorIds.length) { log(`  ⚠ ningún PY del base tiene mirror todavía. ¿Corrió el motor (cronWeekendFull)?`); return; }
  log(`  PY ramas: ${pys.map((p) => p.id).join(', ')}  ·  mirrors: ${mirrorIds.join(', ')}`);

  // 3) estado actual: LIs de TODOS los mirrors (pool cross-rama), cada uno marcado con su mirror.
  const current = [];
  for (const mid of mirrorIds) {
    for (const li of await getDealLineItems(mid)) { li._mirrorId = mid; current.push(li); }
  }
  const target = twin.lineItems || [];

  // Emparejado mirror <-> twin por MONTO (mirror.price == monto original del twin) + fecha.
  // Robusto a distinta cantidad: best-effort 1:1; el resto del twin sin espejo se reporta.
  const { pares, sinMirror, sinTwin } = emparejarPorMontoFecha(current, target);
  if (current.length !== target.length) {
    log(`  ⚠ distinta cantidad (mirror pool ${current.length} vs twin ${target.length}) → best-effort por monto/fecha: ${pares.length} par(es).`);
  }
  if (!pares.length) {
    log(`  ⚠ ningún LI del mirror coincide por monto con el twin. No edito.`);
    log(`    mirror: ${current.map((li) => `${li.properties.hs_recurring_billing_start_date || '?'}/$${li.properties.price || '?'}`).join(' | ')}`);
    log(`    twin:   ${target.map((t) => `${t.hs_recurring_billing_start_date || '?'}/$${t.price ?? '?'}`).join(' | ')}`);
    return;
  }
  if (sinMirror.length) log(`    sin match (mirror, ${sinMirror.length}): ${sinMirror.map((m) => `${m.properties.hs_recurring_billing_start_date || '?'}/$${m.properties.price || '?'}`).join(', ')}`);
  if (sinTwin.length) dbg(`twin sin espejo (${sinTwin.length}): ${sinTwin.map((t) => `${t.hs_recurring_billing_start_date || '?'}/$${t.price ?? '?'}`).join(', ')}`);

  // armar ediciones:
  //   - MONTO -> hs_cost_of_goods_sold de la LI PY ORIGINAL (no el price del mirror).
  //     El motor deriva el price del mirror desde el COGS del PY en cada sync,
  //     así que escribir price sobre el mirror se pierde. El monto va al original.
  //   - fechas + servicio + mig_line_item_key -> sobre la LI del mirror.
  const editsPy = [];     // costo sobre LIs PY originales
  const editsMirror = []; // fechas/servicio/key sobre LIs del mirror

  for (const [m, t] of pares) {
    // MONTO original del twin -> COGS del PY original (= price del mirror tras re-sync del motor).
    // Manda el monto del twin (igual que Paso A); normalmente ya está seteado → no-op.
    const montoTwin = t._ofMontoOrig ?? t.price;
    if (montoTwin !== undefined && montoTwin !== null) {
      const pyLiId = String(m.properties.of_line_item_py_origen_id || '').trim();
      if (!pyLiId) {
        log(`  ⚠ LI mirror ${m.id} sin of_line_item_py_origen_id → no puedo escribir el costo en el PY. Salteo el monto.`);
      } else {
        try {
          const pyLi = await hs.crm.lineItems.basicApi.getById(pyLiId, ['hs_cost_of_goods_sold', 'name']);
          const pyCogs = pyLi.properties?.hs_cost_of_goods_sold ?? '';
          if (String(montoTwin) !== String(pyCogs)) {
            editsPy.push({ id: pyLiId, props: { hs_cost_of_goods_sold: String(montoTwin) }, _was: pyCogs, _mirrorId: m.id });
          }
        } catch (e) {
          log(`  ⚠ no pude leer el LI PY ${pyLiId} (${e?.message || e}) → salteo el monto.`);
        }
      }
    }

    // SOLO el puente mig_line_item_key del TWIN sobre el LI del mirror (lo que Paso C/D necesitan
    // para matchear el historicalTicket). El motor NO lo toca (no está en sus allowedProps) → sobrevive.
    //
    // ⛔ NO se escribe fecha (hs_recurring_billing_start_date/billing_anchor_date) NI servicio en el LI:
    // (1) el motor los RE-SINCRONIZA en cada pasada (los pisaría → inútil); y, lo CRÍTICO,
    // (2) la idempotencia de Phase P es por `of_ticket_key = dealId::LIK::FECHA`. Si B' pone en el LI
    //     una fecha distinta a la del motor (la del twin difiere ~12-15d de la del PY), cada pasada
    //     genera un of_ticket_key distinto → Phase P NO dedupea → TICKET DUPLICADO (incidente 2026-06-27).
    // Las correcciones van al TICKET con Paso C (monto) y la fecha de emisión la pone Paso D (histórica).
    const props = {};
    if (t.mig_line_item_key && String(t.mig_line_item_key) !== String(m.properties.mig_line_item_key || '')) {
      props.mig_line_item_key = String(t.mig_line_item_key);
    }
    if (Object.keys(props).length) editsMirror.push({ id: m.id, props, _m: m });
  }

  log(`  emparejado por monto/fecha (${pares.length} par/es) · costos PY: ${editsPy.length} · fechas/servicio/key mirror: ${editsMirror.length}`);
  for (const e of editsPy) {
    dbg(`costo PY LI ${e.id}: hs_cost_of_goods_sold ${e._was || '(vacío)'} -> ${e.props.hs_cost_of_goods_sold}  (mirror LI ${e._mirrorId})`);
  }
  for (const e of editsMirror) {
    dbg(`mirror LI ${e.id}: ${JSON.stringify(e.props)}  (era fecha=${e._m.properties.hs_recurring_billing_start_date} serv=${e._m.properties.servicio})`);
  }

  if (!WRITE) { log('  (dry-run: no se escribió nada — pasá --write para aplicar)'); return; }
  for (const e of editsPy)     { await hs.crm.lineItems.basicApi.update(e.id, { properties: e.props }); dbg(`escrito costo PY LI ${e.id}`); }
  for (const e of editsMirror) { await hs.crm.lineItems.basicApi.update(e.id, { properties: e.props }); dbg(`editado mirror LI ${e.id}`); }
  log(`  ✓ ${tag}: ${editsPy.length} costos PY + ${editsMirror.length} LIs mirror (fechas/servicio).`);
}

// ───────────────────────── run ─────────────────────────
if (!existsSync(TWINS_FILE)) {
  console.error(`✖ No existe ${TWINS_FILE}. Generalo con armar_base_pruebas.mjs (o pasá la ruta correcta).`);
  process.exit(1);
}
const data = JSON.parse(readFileSync(TWINS_FILE, 'utf8'));
const twins = data.twinsApartados || [];

log(`=== PASO B' — ajuste de mirrors (${WRITE ? 'WRITE' : 'DRY-RUN'}) ===`);
log(`Archivo: ${TWINS_FILE} · twins: ${twins.length}`);
if (!twins.length) { log('Nada que hacer.'); process.exit(0); }

for (const t of twins) {
  try { await reconcileMirror(t); }
  catch (e) { log(`  ✖ error en ${t.idOrigen}: ${e?.message || e}`); if (DEBUG) console.error(e); }
}

log(`\nListo${WRITE ? '' : ' (dry-run)'}.`);
