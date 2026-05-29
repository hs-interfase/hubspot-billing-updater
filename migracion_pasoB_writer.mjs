// migracion_pasoB_writer.mjs
// Paso B (PILOTO): escribe a HubSpot desde uno o más JSON de dry-run.
// Soporta DOS fuentes:
//   - dryrun_objetos.json  → pago único (manual one-time) + tickets históricos
//   - mansoft_deals.json   → contratos recurrentes (automáticos), SIN tickets
// Crea deal → line items (asociados) → ticket histórico (solo únicos) →
// asociación a company. Idempotente por id_crm_origen (en mansoft = _key).
// MIGRA LOS DATOS TAL CUAL: no transforma fechas, frecuencia ni términos.
// Node 18+ (fetch nativo), ESM, sin dependencias.
//
// Uso (PowerShell, parado en la carpeta del repo con el .env):
//   # 1) Dry-run del test mixto (NO escribe, DEFAULT):
//   node migracion_pasoB_writer.mjs dryrun_objetos.json mansoft_deals.json sandbox
//
//   # 2) Escritura real (cuando el dry-run se vea bien):
//   $env:ESCRIBIR="true"; node migracion_pasoB_writer.mjs dryrun_objetos.json mansoft_deals.json sandbox
//
//   # 3) Elegir otros casos (fragmentos de nombre, separados por coma):
//   $env:SOLO="Isa Paraguay,Acronar,BCP"; node migracion_pasoB_writer.mjs ... sandbox
//
//   # 4) Migrar TODO (sin slice por nombre, sin límite):
//   $env:SOLO=""; $env:LIMITE=""; node migracion_pasoB_writer.mjs dryrun_objetos.json mansoft_deals.json prod
//
// Args: cualquier [*.json] = archivo a leer · [sandbox|prod] = portal objetivo.

import { readFileSync, existsSync } from 'node:fs';

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

// ═══════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════
const TOKEN =
  process.env.HUBSPOT_PRIVATE_TOKEN ||
  process.env.HUBSPOT_TOKEN ||
  process.env.HUBSPOT_SANDBOX_TOKEN ||
  process.env.HUBSPOT_ACCESS_TOKEN;

// Argumentos: archivos .json + env objetivo
const ARGS = process.argv.slice(2);
const ARCHIVOS = ARGS.filter((a) => a.toLowerCase().endsWith('.json'));
const ENV_OBJETIVO = (ARGS.find((a) => ['sandbox', 'prod'].includes(a.toLowerCase())) || 'sandbox').toLowerCase();
// Default: ambos archivos del flujo, si existen.
const ARCHIVOS_FINAL = ARCHIVOS.length
  ? ARCHIVOS
  : ['dryrun_objetos.json', 'mansoft_deals.json'].filter((f) => existsSync(f));

// Si ESCRIBIR !== 'true', es DRY-RUN: no escribe nada, solo loguea.
const ESCRIBIR = (process.env.ESCRIBIR || '').toLowerCase() === 'true';

// LIMITE: cantidad por corrida cuando NO hay slice por nombre.
//   - sin definir → 3 (piloto)
//   - "" (vacío)  → null (sin límite)
const LIMITE =
  process.env.LIMITE !== undefined
    ? (process.env.LIMITE === '' ? null : parseInt(process.env.LIMITE, 10))
    : 3;

// SOLO: fragmentos de nombre (coma) para armar el slice mixto.
//   - sin definir → usa DEFAULT_SOLO (el test mixto acordado)
//   - "" (vacío)  → sin filtro por nombre (procesa según LIMITE)
const DEFAULT_SOLO = 'Isa Paraguay,Maldonado,Elio Ocampos,Acronar,BCP,Granja,AGESIC,DUCSA';
const SOLO_RAW = process.env.SOLO !== undefined ? process.env.SOLO : DEFAULT_SOLO;
const SOLO = SOLO_RAW.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

// Ticket histórico (solo únicos) → pipeline "Órdenes de Facturación" + stage "Emitido".
const TICKET_PIPELINE = process.env.BILLING_TICKET_PIPELINE_ID || '875213463';
const TICKET_STAGE_EMITIDO = process.env.BILLING_TICKET_STAGE_ID_BILLED || '1311451809';

// Etapa por defecto de los mansoft (contratos recurrentes activos).
const MANSOFT_DEAL_STAGE = process.env.MANSOFT_DEAL_STAGE || 'closedwon';

// Tags de batch (idempotencia / limpieza posterior). Valores VÁLIDOS del portal:
//   CRM_Activos · CRM_Mirror_UY · Mantsoft_UY · Mantsoft_PY
const ARCHIVO_UNICO = 'CRM_Activos';
const ARCHIVO_MIRROR = 'CRM_Mirror_UY';
const ARCHIVO_MANSOFT_UY = 'Mantsoft_UY';
const ARCHIVO_MANSOFT_PY = 'Mantsoft_PY';

// Company por Nodum (solo aplica a únicos que NO traen empresa_record_id).
// Mientras esté vacío, se saltea esa asociación.
const COMPANY_NODUM_PROP = process.env.COMPANY_NODUM_PROP || 'codigo_contactos';

// Props del LINE ITEM de únicos que el dry-run trae pero NO van como LI.
const LI_PROPS_UNICO_DESCARTAR = new Set(['facturacion_activa', 'of_frecuencia_de_facturacion']);

// Props del LINE ITEM de mansoft a descartar:
//  - empresa_* → metadata
//  - hs_recurring_billing_number_of_payments → read-only por API (HubSpot lo calcula)
const LI_PROPS_MANSOFT_DESCARTAR = new Set([
  'empresa_record_id',
  'empresa_nombre_match',
  'hs_recurring_billing_number_of_payments',
]);

// Moneda PY sin resolver → fallback (lo más probable USD; ~70 PY quedan a confirmar).
const MONEDA_PENDIENTE_FALLBACK = process.env.MONEDA_PENDIENTE_FALLBACK || 'USD';
function monedaFinal(code) {
  const c = String(code || '').trim();
  return /^PENDIENTE/i.test(c) ? MONEDA_PENDIENTE_FALLBACK : c;
}

// Catálogo de productos del SANDBOX. Si el id del JSON YA es válido, se respeta
// (preserva casos especiales, ej. el PAR_ de Isa que va a MiFactura). Si NO es
// válido, se deriva del rubro y se usa el id del entorno de pruebas.
const PRODUCTO_SANDBOX_VALIDOS = new Set([
  '42010181660', // Portal
  '42010367404', // PayRoll
  '41943709577', // Proyectos
  '41943895219', // Flota
  '42010367402', // iGDoc
  '42010181659', // MiFactura
  '42004648587', // MiRecibo
  '42010181658', // i2
  '41943895217', // iJServ
  '41948442381', // iSCert
]);
const PRODUCTO_POR_PREFIJO = [
  ['ISAPY_', '42010181659'], // MiFactura (antes que ISA_)
  ['IGD_', '42010367402'],   // iGDoc
  ['IJS_', '41943895217'],   // iJServ
  ['INT_', '42010181658'],   // i2
  ['ISA_', '41948442381'],   // iSCert
  ['ISC_', '41948442381'],   // iSCert
  ['PAY_', '42010367404'],   // PayRoll
  ['PAR_', '42010367404'],   // PayRoll
  ['UX_', '42010181660'],    // Portal
  ['PYPROY', '41943709577'], // Proyectos
];
function resolverProductoSandbox(idActual, rubro) {
  const id = String(idActual || '').trim();
  if (id && PRODUCTO_SANDBOX_VALIDOS.has(id)) return { id, cambiado: false };
  const r = String(rubro || '').trim().toUpperCase();
  for (const [pref, pid] of PRODUCTO_POR_PREFIJO) {
    if (r.startsWith(pref)) return { id: pid, cambiado: true };
  }
  return { id, cambiado: false, sinMatch: true };
}

// ═══════════════════════════════════════════════════════════════
if (!TOKEN) {
  console.error('Falta el token. Definí HUBSPOT_PRIVATE_TOKEN en el .env.');
  process.exit(1);
}
if (!ARCHIVOS_FINAL.length) {
  console.error('No encontré archivos para leer. Pasá dryrun_objetos.json y/o mansoft_deals.json.');
  process.exit(1);
}

const BASE = 'https://api.hubapi.com';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, method = 'GET', body, { intentos = 5 } = {}) {
  let espera = 500;
  for (let i = 1; ; i++) {
    let res, json;
    try {
      res = await fetch(`${BASE}${path}`, {
        method,
        headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
    } catch (netErr) {
      // Error de red → reintentar
      if (i >= intentos) throw netErr;
      console.log(`    ⏳ red en ${method} ${path} — reintento ${i}/${intentos - 1} en ${Math.round(espera / 1000)}s`);
      await sleep(espera); espera = Math.min(espera * 2, 8000); continue;
    }
    if (res.ok) return json;
    // 429 (rate limit) o 5xx → backoff exponencial (respeta Retry-After)
    if ((res.status === 429 || res.status >= 500) && i < intentos) {
      const ra = parseInt(res.headers.get('retry-after') || '', 10);
      const wait = Number.isFinite(ra) ? ra * 1000 : espera;
      console.log(`    ⏳ ${res.status} en ${method} ${path} — reintento ${i}/${intentos - 1} en ${Math.round(wait / 1000)}s`);
      await sleep(wait); espera = Math.min(espera * 2, 8000); continue;
    }
    throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json)}`);
  }
}

// Limpia props: saca nulls/vacíos, claves internas (_… y mig_…), coacciona booleanos.
function limpiarProps(obj, descartar = new Set()) {
  const out = {};
  for (const [k, vv] of Object.entries(obj)) {
    if (k.startsWith('_')) continue;
    if (k.startsWith('mig_')) continue;
    if (descartar.has(k)) continue;
    let v = vv;
    if (typeof v === 'boolean') v = v ? 'true' : 'false';
    if (v === null || v === undefined || v === '') continue;
    out[k] = v;
  }
  return out;
}

// ── Deal de ÚNICO → props válidas (lógica original) ──
function propsDeal(deal) {
  const p = limpiarProps(deal);
  if (deal.vendedor) {
    p.propietario_del_negocio_provisional = deal.vendedor;
    delete p.vendedor;
  }
  if (p.tipo_de_cupo && !['Por Horas', 'Por Monto'].includes(p.tipo_de_cupo)) {
    delete p.tipo_de_cupo;
    p.cupo_activo = 'false';
  }
  if (p.deal_currency_code) p.deal_currency_code = monedaFinal(p.deal_currency_code);
  // owner: en sandbox los IDs de prod no existen → se quita (queda el nombre en provisional)
  if (ENV_OBJETIVO === 'sandbox') delete p.hubspot_owner_id;
  // empresa_record_id / empresa_nombre_match no son props de deal → fuera
  delete p.empresa_record_id;
  delete p.empresa_nombre_match;
  p.archivo_de_importacion = p.es_mirror_de_py === 'true' ? ARCHIVO_MIRROR : ARCHIVO_UNICO;
  return p;
}

function propsLineItemUnico(li) {
  return limpiarProps(li, LI_PROPS_UNICO_DESCARTAR);
}

// ═══════════════════════════════════════════════════════════════
// NORMALIZADORES → forma interna común
//   { tipo, caso, idOrigen, dealProps, lineItems[], tickets[], companyId, nodum }
// ═══════════════════════════════════════════════════════════════
function normalizarUnico(d) {
  return {
    tipo: 'unico',
    caso: d.caso || d.deal?.id_crm_origen || d.idOrigen,
    idOrigen: d.idOrigen || d.deal?.id_crm_origen,
    dealProps: propsDeal(d.deal),
    lineItems: (d.lineItems || []).map(propsLineItemUnico),
    tickets: d.historicalTickets || [],
    companyId: d.deal?.empresa_record_id ? String(d.deal.empresa_record_id) : null,
    nodum: d.deal?.cliente_nodum ?? d.deal?.id_cliente_nodum ?? null,

  };
}

// Plan fijo (venc < 2099 y con frecuencia): cantidad de pagos como ISO term.
//   hs_recurring_billing_period = "P{N}M"  (N = meses de inicio→venc, inclusivo)
//   Para mensuales, N = cantidad de pagos (P12M = 12 pagos). HubSpot deriva
//   number_of_payments dividiendo el term por la frecuencia.
// Auto-renew (venc 2099 o vacío, o sin frecuencia): devuelve '' (period vacío).
function periodoPlanFijo(li) {
  const freq = String(li.recurringbillingfrequency || li.hs_recurring_billing_frequency || '').trim();
  const start = String(li.hs_recurring_billing_start_date || '').slice(0, 10);
  const venc = String(li.fecha_vencimiento_contrato || '').slice(0, 10);
  if (!freq || !start || !venc) return '';
  const sy = +start.slice(0, 4), sm = +start.slice(5, 7);
  const vy = +venc.slice(0, 4), vm = +venc.slice(5, 7);
  if (!sy || !vy || !sm || !vm) return '';
  if (vy >= 2099) return '';                       // auto-renew
  const n = (vy - sy) * 12 + (vm - sm) + 1;        // meses inclusivos
  return n >= 1 ? `P${n}M` : '';
}

function normalizarMansoft(d) {
  const dealProps = limpiarProps({
    dealname: d.dealname,
    dealstage: MANSOFT_DEAL_STAGE,
    pais_operativo: d.pais_operativo,
    deal_currency_code: monedaFinal(d.deal_currency_code),
    facturacion_activa: 'true',
    propietario_del_negocio_provisional: d.vendedor,
    id_crm_origen: d._key,
    archivo_de_importacion: String(d.pais_operativo).toLowerCase().startsWith('parag')
      ? ARCHIVO_MANSOFT_PY
      : ARCHIVO_MANSOFT_UY,
  });

  const lineItems = (d.lineItems || []).map((li) => {
    const p = limpiarProps(li, LI_PROPS_MANSOFT_DESCARTAR);
    // Producto: si el id no es válido en sandbox, derivarlo del rubro
    const prod = resolverProductoSandbox(li.hs_product_id, li.mig_rubro);
    if (prod.cambiado) {
      console.log(`    ⚙ ${d.dealname}: producto ${li.hs_product_id} → ${prod.id} (${li.mig_rubro})`);
      p.hs_product_id = prod.id;
    } else if (prod.sinMatch) {
      console.log(`    ⚠ ${d.dealname}: producto ${li.hs_product_id || '—'} no válido y rubro ${li.mig_rubro || '—'} sin mapeo`);
    }
    // Plan fijo → cantidad de pagos como P{N}M; auto-renew → vacío
    const periodo = periodoPlanFijo(li);
    if (periodo) p.hs_recurring_billing_period = periodo;
    else delete p.hs_recurring_billing_period;
    if (!p.nota) {
      const partes = [li.mig_rubro && `rubro ${li.mig_rubro}`, d._key && `key ${d._key}`].filter(Boolean);
      if (partes.length) p.nota = `Migrado Mansoft | ${partes.join(' | ')}`;
    }
    return p;
  });

  return {
    tipo: 'mansoft',
    caso: d.dealname || d._key,
    idOrigen: d._key,
    dealProps,
    lineItems,
    tickets: [], // mansoft no trae tickets históricos
    companyId: d.empresa_record_id ? String(d.empresa_record_id) : null,
    nodum: null,
  };
}

// Detecta el tipo del archivo por la forma del primer deal y normaliza todo.
function cargarArchivo(ruta) {
  const data = JSON.parse(readFileSync(ruta, 'utf8'));
  if (data.env && data.env.toLowerCase() !== ENV_OBJETIVO) {
    throw new Error(
      `el JSON "${ruta}" fue generado para "${data.env}" pero apuntás a "${ENV_OBJETIVO}". ` +
      `Regenerá el dry-run para ${ENV_OBJETIVO}.`
    );
  }
  const deals = data.deals || [];
  const esMansoft = deals[0] && deals[0]._key !== undefined;
  const norm = deals.map(esMansoft ? normalizarMansoft : normalizarUnico);
  console.log(`  · ${ruta}: ${norm.length} deals (${esMansoft ? 'mansoft' : 'único'})`);
  return norm;
}

// ── Idempotencia: ¿ya existe un deal con este id_crm_origen? ──
async function buscarDealPorOrigen(idOrigen) {
  if (!idOrigen) return null;
  const r = await api('/crm/v3/objects/deals/search', 'POST', {
    filterGroups: [{ filters: [{ propertyName: 'id_crm_origen', operator: 'EQ', value: String(idOrigen) }] }],
    properties: ['id_crm_origen'],
    limit: 1,
  });
  return r.results?.[0]?.id || null;
}

// Normaliza un código Nodum: solo dígitos (saca puntos/comas/espacios) y ceros a la izquierda.
function normalizarNodum(v) {
  return String(v ?? '').replace(/\D/g, '').replace(/^0+/, '');
}

// Mapa codigo_contactos(normalizado) → companyId, armado en UNA pasada paginada
// (evita el lag de indexado de la Search API).
let MAPA_COMPANIES = null;             // Map<string, string>
const COMPANIES_AMBIGUAS = new Set();  // mismo código en 2+ empresas → no asociar

async function cargarMapaCompaniesPorNodum() {
  if (!COMPANY_NODUM_PROP) return null;
  const mapa = new Map();
  let after, guard = 0;
  do {
    const qs = `?limit=100&properties=${COMPANY_NODUM_PROP}` + (after ? `&after=${after}` : '');
    const r = await api(`/crm/v3/objects/companies${qs}`);
    for (const c of r.results || []) {
      const cod = normalizarNodum(c.properties?.[COMPANY_NODUM_PROP]);
      if (!cod) continue;
      if (mapa.has(cod) && mapa.get(cod) !== c.id) COMPANIES_AMBIGUAS.add(cod);
      else mapa.set(cod, c.id);
    }
    after = r.paging?.next?.after;
  } while (after && ++guard < 200);
  MAPA_COMPANIES = mapa;
  return mapa;
}

function buscarCompanyPorNodum(nodum) {
  if (!MAPA_COMPANIES) return null;
  const cod = normalizarNodum(nodum);
  if (!cod) return null;
  if (COMPANIES_AMBIGUAS.has(cod)) {
    console.log(`    ⚠ código nodum ${cod} ambiguo (en 2+ empresas) → no asocio`);
    return null;
  }
  return MAPA_COMPANIES.get(cod) || null;
}

// Asociación v4 "default".
async function asociar(fromType, fromId, toType, toId) {
  await api(`/crm/v4/objects/${fromType}/${fromId}/associations/default/${toType}/${toId}`, 'PUT', []);
}

// ── Filtro por schema: descarta props que no existen en el portal destino ──
const propsValidas = { deals: null, line_items: null, tickets: null };
const dropeadas = new Set(); // para no spamear el mismo aviso

async function cargarPropsValidas(objeto) {
  if (propsValidas[objeto]) return propsValidas[objeto];
  let after, nombres = new Set(), guard = 0;
  do {
    const r = await api(`/crm/v3/properties/${objeto}` + (after ? `?after=${after}` : ''));
    for (const p of r.results || []) nombres.add(p.name);
    after = r.paging?.next?.after;
  } while (after && ++guard < 20);
  propsValidas[objeto] = nombres;
  return nombres;
}

function filtrarPorSchema(props, objeto) {
  const validas = propsValidas[objeto];
  if (!validas) return props; // sin schema cargado → no filtra
  const out = {};
  for (const [k, v] of Object.entries(props)) {
    if (validas.has(k)) { out[k] = v; continue; }
    const tag = `${objeto}.${k}`;
    if (!dropeadas.has(tag)) { dropeadas.add(tag); console.log(`    ⚠ prop inexistente en portal, se omite: ${tag}`); }
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════
// Procesa un deal (forma normalizada)
// ═══════════════════════════════════════════════════════════════
async function procesarDeal(n, i) {
  console.log(`\n[${i + 1}] ${n.caso}  (${n.tipo})`);

  const existente = await buscarDealPorOrigen(n.idOrigen);
  if (existente) {
    console.log(`    ↩ ya existe (deal ${existente}). Salteo.`);
    return { saltado: true };
  }

  const dealProps = filtrarPorSchema(n.dealProps, 'deals');
  const lis = n.lineItems.map((p) => filtrarPorSchema(p, 'line_items'));
  const tickets = n.tickets;

  // Company: empresa_record_id directo (mansoft), o lookup por nodum (únicos)
  let companyId = n.companyId;
  if (!companyId && n.tipo === 'unico') companyId = buscarCompanyPorNodum(n.nodum);

  if (!ESCRIBIR) {
    console.log(`    [DRY] crearía deal con ${Object.keys(dealProps).length} props, ${lis.length} LIs, ${tickets.length} tickets`);
    console.log(`    [DRY] company: ${companyId || '— sin asociar'}${n.tipo === 'unico' && n.nodum != null ? `  (nodum ${normalizarNodum(n.nodum) || '—'})` : ''}`);
    console.log(`    [DRY] deal:`, JSON.stringify(dealProps));
    if (lis[0]) console.log(`    [DRY] LI ejemplo:`, JSON.stringify(lis[0]));
    return { dry: true };
  }

  // 1) Deal
  const deal = await api('/crm/v3/objects/deals', 'POST', { properties: dealProps });
  console.log(`    ✔ deal ${deal.id}`);

  // 2) Line items + asociación al deal
  for (const liProps of lis) {
    const li = await api('/crm/v3/objects/line_items', 'POST', { properties: liProps });
    await asociar('line_items', li.id, 'deals', deal.id);
    await sleep(80);
  }
  console.log(`    ✔ ${lis.length} line items`);

  // 3) Tickets históricos (solo únicos) → pipeline OF, stage Emitido + asociación
  for (const t of tickets) {
    const tProps = filtrarPorSchema(limpiarProps(t), 'tickets');
    tProps.hs_pipeline = TICKET_PIPELINE;
    tProps.hs_pipeline_stage = TICKET_STAGE_EMITIDO;
    const ticket = await api('/crm/v3/objects/tickets', 'POST', { properties: tProps });
    await asociar('tickets', ticket.id, 'deals', deal.id);
    await sleep(80);
  }
  if (tickets.length) console.log(`    ✔ ${tickets.length} tickets históricos`);

  // 4) Asociación a company
 if (companyId) {
    await asociar('deals', deal.id, 'companies', companyId);
    console.log(`    ✔ asociado a company ${companyId}`);
  } else {
    console.log(`    ⚠ sin company asociada`);
  }

  return { dealId: deal.id };
}

// ═══════════════════════════════════════════════════════════════
async function main() {
  console.log(`Modo: ${ESCRIBIR ? 'ESCRITURA REAL' : 'DRY-RUN (no escribe)'} | env: ${ENV_OBJETIVO}`);
  console.log(`Archivos:`);

  let todos = [];
  for (const ruta of ARCHIVOS_FINAL) {
    try {
      todos = todos.concat(cargarArchivo(ruta));
    } catch (e) {
      console.error(`\n✗ ABORTO al cargar ${ruta}: ${e.message}`);
      process.exit(1);
    }
  }

  // Schema del portal → para descartar props inexistentes antes de crear
  try {
    await cargarPropsValidas('deals');
    await cargarPropsValidas('line_items');
    await cargarPropsValidas('tickets');
    console.log(`Schema cargado: deals(${propsValidas.deals.size}) line_items(${propsValidas.line_items.size}) tickets(${propsValidas.tickets.size})`);
  } catch (e) {
    console.log(`⚠ No pude leer el schema del portal (${e.message}). Sigo sin filtro por schema.`);
  }

  if (COMPANY_NODUM_PROP) {
    try {
      await cargarMapaCompaniesPorNodum();
      console.log(`Companies por ${COMPANY_NODUM_PROP}: ${MAPA_COMPANIES.size} únicas` +
        (COMPANIES_AMBIGUAS.size ? ` · ${COMPANIES_AMBIGUAS.size} ambiguos (no se asocian)` : ''));
    } catch (e) {
      console.log(`⚠ No pude armar el mapa de companies (${e.message}). Los únicos no se asocian por nodum.`);
    }
  }

  // ── Slice por nombre (SOLO) o por LIMITE ──
  let seleccion;
  if (SOLO.length) {
    const matchedFrag = new Set();
    seleccion = todos.filter((n) => {
      const caso = String(n.caso || '').toLowerCase();
      const hit = SOLO.find((frag) => caso.includes(frag));
      if (hit) { matchedFrag.add(hit); return true; }
      return false;
    });
    const sinMatch = SOLO.filter((f) => !matchedFrag.has(f));
    console.log(`\nSlice por nombre (SOLO): ${seleccion.length} deals matchearon.`);
    if (sinMatch.length) console.log(`  ⚠ fragmentos SIN match en tus JSON: ${sinMatch.join(', ')}`);
  } else {
    seleccion = LIMITE == null ? todos : todos.slice(0, LIMITE);
    console.log(`\nSin slice por nombre → ${seleccion.length} deals (LIMITE=${LIMITE == null ? '∞' : LIMITE}).`);
  }

  if (!seleccion.length) {
    console.log('\nNada para procesar. Revisá SOLO / los nombres en los JSON.');
    return;
  }

  let ok = 0, saltados = 0, errores = 0;
  for (let i = 0; i < seleccion.length; i++) {
    try {
      const r = await procesarDeal(seleccion[i], i);
      if (r.saltado) saltados++; else ok++;
    } catch (e) {
      errores++;
      console.error(`    ✗ ERROR: ${e.message}`);
    }
    await sleep(120);
  }

  console.log(`\n── Resumen ── procesados: ${ok} · salteados: ${saltados} · errores: ${errores}`);
  if (!ESCRIBIR) console.log('Fue DRY-RUN. Para escribir: $env:ESCRIBIR="true"; node migracion_pasoB_writer.mjs ...');
}

main().catch((e) => { console.error('✗ Fatal:', e.message); process.exit(1); });
