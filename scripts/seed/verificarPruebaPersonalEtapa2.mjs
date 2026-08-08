#!/usr/bin/env node
/**
 * verificarPruebaPersonalEtapa2.mjs — ETAPA 2: el negocio pasa a CIERRE GANADO
 *
 * SOLO LECTURA. Hermano de verificarPruebaPersonal.mjs (etapa 1, negocio NO ganado).
 * Corre contra el mismo negocio sembrado por seedPruebaPersonal.mjs y mide lo que
 * tiene que pasar AL GANAR. No escribe nada: se puede correr cuantas veces haga falta.
 *
 * Uso:
 *   node scripts/seed/verificarPruebaPersonalEtapa2.mjs            → tabla resumida
 *   node scripts/seed/verificarPruebaPersonalEtapa2.mjs --detalle  → + el detalle ticket a ticket
 *
 * Lee `prueba-personal-manifest.json`. Salida: exit 0 si todo PASS, 1 si hay FAIL.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 🔴 LO QUE HAY QUE SABER ANTES DE CORRERLO (verificado en el código, 2-ago)
 *
 * 1. MOVER EL NEGOCIO A «CIERRE GANADO» NO DISPARA NADA EN EL MOTOR.
 *    `api/escuchar-cambios.js:131` — el webhook de `dealstage` sólo se encola si el
 *    stage nuevo es de CANCELACIÓN; cualquier otro contesta «Dealstage no es de
 *    cancelación, skipped». Y `facturacion_activa` no tiene ruta: cae en «Property
 *    not supported, skipped» (:393). Las dos props ESTÁN suscriptas como webhook,
 *    pero el motor las descarta. ⇒ La asociación de tickets ocurre recién en la
 *    próxima corrida COMPLETA de fases: el cron diario, o un evento no relacionado
 *    (editar un line item ⇒ `recalc`).
 *
 * 2. EL PORTERO NO ES LA ETAPA, ES `facturacion_activa`.
 *    `associateOnClosedWon.js:188` corta con `applies:false` si el negocio no tiene
 *    `facturacion_activa=true`, y NADIE en el motor la prende (grep completo: sólo
 *    `cancelDeal.js` la apaga). La prende un workflow del portal o una persona.
 *    ⚠️ Y desde el arreglo de la frontera (`76b0722`), un negocio GANADO SIN
 *    `facturacion_activa` queda en zona muerta: `webhookQueue.js:454` saltea el job
 *    entero («Deal ganado con facturación inactiva, skip»). O sea: ganar sin prender
 *    la facturación deja al negocio sin rearme Y sin asociación.
 *
 * 3. POR ESO NO LLEGAN LAS ETIQUETAS. `ticket_label_sync` lee los tickets POR
 *    ASOCIACIÓN; sin asociación devuelve `skipped:true · reason:"sin_tickets"`
 *    (medido en los jobs 8065/8070/8071/8083 del 3-ago). Las etiquetas del negocio
 *    llegan a los tickets DESPUÉS de que se asocien, no antes.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ⚠️ Los tickets se leen por `of_line_item_key` Y por asociación (lección de la ronda
 *    D+E). Afirmar "no existe" sólo es válido si las dos vías dan 0.
 */

import 'dotenv/config';
import fs from 'fs';
import { hubspotClient } from '../../src/hubspotClient.js';
import { getTodayYMD, diffDays } from '../../src/utils/dateUtils.js';

const DETALLE = process.argv.includes('--detalle');
const MANIFEST = 'prueba-personal-manifest.json';

// Etapas del pipeline manual de tickets (sandbox).
const STAGE_LABEL = {
  '1311451803': 'Forecast', '1311451804': '50% Forecast', '1311451805': '75% Forecast',
  '1330250642': '85% Forecast', '1311451806': '95% Forecast',
  '1311451807': 'Próximos a facturar', '1311451808': 'Notificado', '1311451809': 'Emitido',
  '1311451810': 'Enviado', '1311451811': 'Atrasado', '1311451812': 'Cobrado',
  '1311451813': 'CANCELADO',
};
const stageLbl = (s) => STAGE_LABEL[String(s)] || `(${s})`;

const STAGE_85_FORECAST = '1330250642';   // destino de Phase P con el deal en «Cierre ganado»
const STAGE_PROXIMOS    = '1311451807';   // destino de Phase 2 (≤30 días) y de la ETAPA ÚNICA
const PIPELINE_MANUAL   = '875213463';
const LOOKAHEAD_DIAS    = 30;             // MANUAL_TICKET_LOOKAHEAD_DAYS

const DEAL_STAGE_GANADO = 'closedwon';
const EMISORA_ESPEJO_ESPERADA = 'ISA PARAGUAY';

// ¿ETAPA ÚNICA prendida en el servicio que procesa? Cambia la etapa destino al ganar
// (bucket 85 → «Próximos a facturar» en vez de «85% Forecast», `phasep.js:334`).
// El env de Railway no se puede leer desde acá, así que se asume PRENDIDA — medido
// indirectamente el 3-ago: `li_prop_sync` sobre tickets en forecast devolvió
// `scan:16 · skipped:0`, y con la llave apagada el guard de etapa los habría contado
// a todos como `skipped` (`syncLineItemPropToTicket.js:246`). Se puede forzar:
//   --sin-etapa-unica   → esperar «85% Forecast» para el resto del cronograma
const ETAPA_UNICA = !process.argv.includes('--sin-etapa-unica');

// Tax groups del portal (para derivar el of_iva esperado igual que detectIVA()).
const IVA_UY = process.env.IVA_UY_TAX_GROUP_ID || '';
const IVA_PY = process.env.IVA_PY_TAX_GROUP_ID || '';
const IVA_EXENTO = process.env.IVA_EXENTO_TAX_GROUP_ID || '';
const ivaEsperado = (taxGroupId) => {
  const raw = String(taxGroupId || '').trim();
  if (!raw) return '';
  if ((IVA_UY && raw === IVA_UY) || (IVA_PY && raw === IVA_PY)) return 'true';
  if (IVA_EXENTO && raw === IVA_EXENTO) return 'false';
  return '';
};

const M = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
const HOY = getTodayYMD();

// ── Checks ────────────────────────────────────────────────────────────────────
const checks = [];
function check(bloque, nombre, esperado, actual, ok = null) {
  const pass = ok === null ? String(esperado) === String(actual) : ok;
  checks.push({ bloque, nombre, esperado, actual, pass });
}

const num = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));
const casiIgual = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 0.01;
const parseBool = (v) => String(v ?? '').trim().toLowerCase() === 'true';

// ── Lecturas ──────────────────────────────────────────────────────────────────
const LI_PROPS = ['name', 'price', 'quantity', 'costo_total_usd', 'hs_cost_of_goods_sold',
  'area', 'empresa_que_factura', 'nombre_producto', 'hs_product_id', 'dolar', 'uy',
  'parte_del_cupo', 'line_item_key', 'facturacion_automatica', 'billing_next_date',
  'description', 'unidad_de_negocio', 'tipo_de_parametrica', 'opera_trading',
  'exonera_irae', 'hs_tax_rate_group_id', 'hs_lastmodifieddate'];
const TK_PROPS = ['subject', 'hs_pipeline', 'hs_pipeline_stage', 'fecha_resolucion_esperada',
  'of_line_item_key', 'of_ticket_key', 'area', 'entidad_facturadora', 'of_producto',
  'of_costo', 'of_margen', 'of_costo_usd', 'nombre_empresa', 'empresa_que_factura',
  'monto_unitario_real', 'cantidad_real', 'of_invoice_id', 'of_billing_error',
  'of_propietario_secundario', 'of_moneda',
  // La «hoja» del ticket — lo que el vendedor carga en el line item y tiene que bajar
  'of_descripcion_producto', 'unidad_de_negocio', 'of_tipo_de_parametrica',
  'opera_trading', 'exonera_irae', 'of_iva', 'cliente_partner', 'of_snapshot_source_modified'];

async function ticketsDeLik(lik) {
  const r = await hubspotClient.crm.tickets.searchApi.doSearch({
    filterGroups: [{ filters: [{ propertyName: 'of_line_item_key', operator: 'EQ', value: lik }] }],
    properties: TK_PROPS, limit: 100,
  });
  return r.results || [];
}

async function ticketsAsociados(dealId) {
  try {
    const r = await hubspotClient.apiRequest({ method: 'GET', path: `/crm/v4/objects/deals/${dealId}/associations/tickets?limit=500` });
    const j = await r.json();
    return new Set((j.results || []).map((x) => String(x.toObjectId)));
  } catch { return new Set(); }
}

/** Empresas asociadas a un objeto, con sus etiquetas. */
async function empresasDe(objectType, objectId) {
  const r = await hubspotClient.apiRequest({ method: 'GET', path: `/crm/v4/objects/${objectType}/${objectId}/associations/companies` });
  const j = await r.json();
  const out = [];
  for (const a of (j.results || [])) {
    let nombre = '';
    try { nombre = (await hubspotClient.crm.companies.basicApi.getById(a.toObjectId, ['name'])).properties.name || ''; } catch { /* borrada */ }
    out.push({ id: String(a.toObjectId), nombre, labels: (a.associationTypes || []).map((t) => t.label).filter(Boolean) });
  }
  return out;
}

async function contactosDe(dealId) {
  try {
    const r = await hubspotClient.apiRequest({ method: 'GET', path: `/crm/v4/objects/deals/${dealId}/associations/contacts` });
    const j = await r.json();
    return (j.results || []).map((x) => String(x.toObjectId));
  } catch { return []; }
}

const deal = await hubspotClient.crm.deals.basicApi.getById(M.dealId, ['dealname', 'dealstage',
  'pais_operativo', 'facturacion_activa', 'facturacion_automatica', 'cupo_activo', 'cupo_total',
  'cupo_consumido', 'valor_total', 'amount', 'margen_total_usd', 'dolar', 'tc_pesos',
  'deal_uy_mirror_id', 'facturacion_proxima_fecha', 'billing_error', 'producto', 'area']);
const dp = deal.properties;

const GANADO = String(dp.dealstage) === DEAL_STAGE_GANADO;
const ACTIVA = parseBool(dp.facturacion_activa);

// ── BLOQUE A: el negocio ganado ───────────────────────────────────────────────
check('NEGOCIO', 'está en «Cierre ganado»', DEAL_STAGE_GANADO, dp.dealstage);
check('NEGOCIO', '🔴 facturacion_activa = true (el portero real)', 'true', dp.facturacion_activa || '(vacía)', ACTIVA);
check('NEGOCIO', 'país operativo', 'Paraguay', dp.pais_operativo);
check('NEGOCIO', 'sin billing_error', '(vacío)', dp.billing_error ? String(dp.billing_error).slice(0, 60) : '(vacío)', !dp.billing_error);
check('NEGOCIO', 'VALOR total no se rompió', 'un número > 0', dp.valor_total ?? '(vacío)', num(dp.valor_total) > 0);
check('NEGOCIO', 'MARGEN total no se rompió', 'un número > 0', dp.margen_total_usd ?? '(vacío)', num(dp.margen_total_usd) > 0);
check('NEGOCIO', 'cupo consumido todavía en 0 (nada emitido)', 0, dp.cupo_consumido ?? '(vacío)', num(dp.cupo_consumido) === 0);

// Empresas del negocio y sus etiquetas — es la FUENTE de lo que tiene que bajar al ticket.
const empresasDeal = await empresasDe('deals', M.dealId);
const empFactura = empresasDeal.find((e) => e.labels.includes('Empresa Factura'));
const empPartner = empresasDeal.find((e) => e.labels.includes('Partner'));
const empPrimary = empresasDeal.find((e) => e.labels.includes('Primary'));
check('NEGOCIO', 'tiene empresa con etiqueta «Empresa Factura»', 'una', empFactura?.nombre || '(ninguna)', Boolean(empFactura));
check('NEGOCIO', 'tiene empresa con etiqueta «Partner»', 'una', empPartner?.nombre || '(ninguna)', Boolean(empPartner));
const contactosDeal = await contactosDe(M.dealId);

// ── BLOQUE B: LA ASOCIACIÓN DE TICKETS — lo primero de esta etapa ─────────────
const asociados = await ticketsAsociados(M.dealId);

const ESPERADOS = { 'LI-1': 1, 'LI-2': 1, 'LI-3': 16, 'LI-4': 12, 'LI-5': 1 };
const lisPorSlug = {};
const todosLosTickets = [];
let totalOriginal = 0;

for (const [slug, li] of Object.entries(M.lineItems)) {
  lisPorSlug[slug] = (await hubspotClient.crm.lineItems.basicApi.getById(li.id, LI_PROPS)).properties;
  const ts = await ticketsDeLik(li.lineItemKey);
  totalOriginal += ts.length;
  todosLosTickets.push(...ts.map((t) => ({ slug, t })));
  check('ASOCIACIÓN', `${slug} · siguen existiendo sus tickets`, ESPERADOS[slug], ts.length);
}

const asociadosDelStack = todosLosTickets.filter(({ t }) => asociados.has(String(t.id)));
check('ASOCIACIÓN', '🔴 TODOS los tickets asociados al negocio', totalOriginal,
  `${asociadosDelStack.length} de ${totalOriginal}`, asociadosDelStack.length === totalOriginal && totalOriginal > 0);

for (const [slug, li] of Object.entries(M.lineItems)) {
  const delSlug = todosLosTickets.filter((x) => x.slug === slug);
  const asoc = delSlug.filter(({ t }) => asociados.has(String(t.id))).length;
  check('ASOCIACIÓN', `${slug} · asociados`, delSlug.length, asoc);
}

// Todos son del pipeline MANUAL: la regla «sólo el próximo automático» no aplica acá.
const noManuales = todosLosTickets.filter(({ t }) => String(t.properties.hs_pipeline) !== PIPELINE_MANUAL).length;
check('ASOCIACIÓN', 'todos en el pipeline MANUAL (la regla del automático no aplica)', 0, noManuales);

// ── BLOQUE C: las etiquetas bajan al ticket ──────────────────────────────────
// Se miden sobre una MUESTRA (uno por line item): son 31 tickets × 2 empresas.
let etiquetasOk = 0, etiquetasTotal = 0, primaryPerdido = 0;
const muestra = Object.keys(M.lineItems)
  .map((slug) => todosLosTickets.find((x) => x.slug === slug))
  .filter(Boolean);

for (const { slug, t } of muestra) {
  etiquetasTotal++;
  const emps = await empresasDe('tickets', t.id);
  const tieneFactura = empFactura ? emps.some((e) => e.id === empFactura.id && e.labels.includes('Empresa Factura')) : false;
  const tienePartner = empPartner ? emps.some((e) => e.id === empPartner.id && e.labels.includes('Partner')) : false;
  // ¿QUIÉN quedó como empresa «Primary» del ticket? Tiene que ser la misma que la
  // del NEGOCIO (el cliente beneficiario). HubSpot marca Primary a la PRIMERA empresa
  // asociada, y `associateOnClosedWon.js:293-302` las recorre en el orden en que
  // vienen del deal — que no está garantizado. No es el bug del PUT del 30-jul
  // (ese BORRABA la marca): acá la marca existe, pero puesta en la empresa equivocada.
  const sinEmpresas = emps.length === 0;
  const primaryDelTicket = emps.find((e) => e.labels.includes('Primary'));
  const primaryOk = Boolean(empPrimary) && primaryDelTicket?.id === empPrimary.id;
  if (tieneFactura && tienePartner) etiquetasOk++;
  if (!primaryOk && !sinEmpresas) primaryPerdido++;

  check('ETIQUETAS', `${slug} · «Empresa Factura» en el ticket`, empFactura?.nombre || '(no hay en el negocio)',
    tieneFactura ? empFactura.nombre : '(no llegó)', tieneFactura);
  check('ETIQUETAS', `${slug} · «Partner» en el ticket`, empPartner?.nombre || '(no hay en el negocio)',
    tienePartner ? empPartner.nombre : '(no llegó)', tienePartner);
  check('ETIQUETAS', `${slug} · la empresa «Primary» del ticket`,
    empPrimary?.nombre || '(el negocio no tiene Primary)',
    sinEmpresas ? '(el ticket no tiene ninguna empresa)' : (primaryDelTicket?.nombre || '(ninguna marcada)'),
    primaryOk);
}

// ── BLOQUE D: las etapas de los tickets ──────────────────────────────────────
// Con el negocio en «Cierre ganado» el bucket pasa a 85 (`phasep.js:311`):
//   · ETAPA ÚNICA ON  → TODO el cronograma manual nace/aterriza en «Próximos a facturar».
//   · ETAPA ÚNICA OFF → Phase P realinea a «85% Forecast», y Phase 2 promueve —por line
//     item— SÓLO el próximo a facturar, y sólo si está a ≤30 días (`phase2.js:414`).
const STAGE_RESTO = ETAPA_UNICA ? STAGE_PROXIMOS : STAGE_85_FORECAST;
for (const [slug] of Object.entries(M.lineItems)) {
  const delSlug = todosLosTickets.filter((x) => x.slug === slug)
    .sort((a, b) => String(a.t.properties.fecha_resolucion_esperada).localeCompare(String(b.t.properties.fecha_resolucion_esperada)));
  if (!delSlug.length) continue;

  const primero = delSlug[0].t.properties;
  const dias = diffDays(HOY, String(primero.fecha_resolucion_esperada || '').slice(0, 10));
  const entraEnVentana = dias !== null && dias <= LOOKAHEAD_DIAS;
  const stagePrimero = String(primero.hs_pipeline_stage);
  const esperadoPrimero = (ETAPA_UNICA || entraEnVentana) ? STAGE_PROXIMOS : STAGE_85_FORECAST;

  check('ETAPAS', `${slug} · el próximo (${String(primero.fecha_resolucion_esperada).slice(0, 10)}, ${dias}d)`,
    stageLbl(esperadoPrimero), stageLbl(stagePrimero), stagePrimero === esperadoPrimero);

  const resto = delSlug.slice(1);
  if (resto.length) {
    const etapas = [...new Set(resto.map(({ t }) => String(t.properties.hs_pipeline_stage)))];
    check('ETAPAS', `${slug} · el resto (${resto.length}) en «${stageLbl(STAGE_RESTO)}»`, stageLbl(STAGE_RESTO),
      etapas.map(stageLbl).join('|'), etapas.length === 1 && etapas[0] === STAGE_RESTO);
  }
}

// ── BLOQUE D2: LA HOJA DEL TICKET — lo que el vendedor carga en el line item ──
// Todas estas salen del LINE ITEM (`snapshotService.js:288,313,316,339` y
// `ticketService.js:546-571`), y dos de ellas del NEGOCIO. Se comparan contra su
// fuente: si el LI no tiene el dato, el ticket tampoco debe inventarlo.
// ⚠️ `of_tipo_de_parametrica` y `unidad_de_negocio` NO están en LI_PROP_TO_TICKET_KEYS
// ⇒ el sync quirúrgico no las lleva nunca; sólo llegan al construir el ticket.
const HOJA = [
  { tk: 'of_descripcion_producto', li: 'description',            etiqueta: 'Descripción (of_descripcion_producto)' },
  { tk: 'unidad_de_negocio',       li: 'unidad_de_negocio',      etiqueta: 'Unidad de Negocio' },
  { tk: 'of_tipo_de_parametrica',  li: 'tipo_de_parametrica',    etiqueta: 'Tipo de paramétrica' },
  { tk: 'opera_trading',           li: 'opera_trading',          etiqueta: 'Opera Trading', bool: true },
  { tk: 'exonera_irae',            li: 'exonera_irae',           etiqueta: 'Exonera IRAE' },
];
for (const [slug] of Object.entries(M.lineItems)) {
  const ts = todosLosTickets.filter((x) => x.slug === slug).map((x) => x.t);
  if (!ts.length) continue;
  const p = lisPorSlug[slug];

  for (const campo of HOJA) {
    const origen = p[campo.li];
    const esperado = campo.bool
      ? (parseBool(origen) ? 'true' : 'false')
      : String(origen ?? '');
    const vistos = [...new Set(ts.map((t) => String(t.properties[campo.tk] ?? '')))];
    check('HOJA DEL TICKET', `${slug} · ${campo.etiqueta}`,
      esperado === '' ? '(vacío, como el LI)' : esperado,
      vistos.map((v) => v || '(vacío)').join('|'),
      vistos.length === 1 && vistos[0] === esperado);
  }

  // IVA: se deriva del tax group del LI con las mismas envs que detectIVA().
  const ivaEsp = ivaEsperado(p.hs_tax_rate_group_id);
  const ivas = [...new Set(ts.map((t) => String(t.properties.of_iva ?? '')))];
  check('HOJA DEL TICKET', `${slug} · IVA (tax group ${p.hs_tax_rate_group_id || '(sin asignar)'})`,
    ivaEsp === '' ? '(vacío: sin tax group reconocido)' : ivaEsp,
    ivas.map((v) => v || '(vacío)').join('|'), ivas.length === 1 && ivas[0] === ivaEsp);

  // Las dos que salen del NEGOCIO, no del line item (ticketService.js:546-571):
  // se resuelven al CONSTRUIR el ticket, desde las etiquetas deal→empresa.
  const qf = [...new Set(ts.map((t) => String(t.properties.empresa_que_factura ?? '')))];
  check('HOJA DEL TICKET', `${slug} · «Cliente que factura» (etiqueta del negocio)`,
    empFactura?.nombre || '(el negocio no tiene «Empresa Factura»)',
    qf.map((v) => v || '(vacío)').join('|'),
    Boolean(empFactura) && qf.length === 1 && qf[0] === empFactura.nombre);

  const cp = [...new Set(ts.map((t) => String(t.properties.cliente_partner ?? '')))];
  check('HOJA DEL TICKET', `${slug} · «Cliente partner» (etiqueta del negocio)`,
    empPartner?.nombre || '(el negocio no tiene «Partner»)',
    cp.map((v) => v || '(vacío)').join('|'),
    Boolean(empPartner) && cp.length === 1 && cp[0] === empPartner.nombre);
}

// ── BLOQUE E: NO-REGRESIÓN — el contenido que ya estaba bien en la etapa 1 ────
for (const [slug] of Object.entries(M.lineItems)) {
  const ts = todosLosTickets.filter((x) => x.slug === slug).map((x) => x.t);
  if (!ts.length) continue;
  const p = lisPorSlug[slug];

  const costoEsperado = num(p.costo_total_usd) * (num(p.dolar) || 1);
  const costos = [...new Set(ts.map((t) => t.properties.of_costo))];
  check('NO-REGRESIÓN', `${slug} · costo del ticket`, costoEsperado, costos.join('|'),
    costos.length === 1 && casiIgual(num(costos[0]), costoEsperado));

  const areas = [...new Set(ts.map((t) => t.properties.area || '(vacía)'))];
  check('NO-REGRESIÓN', `${slug} · área`, 'Paraguay', areas.join('|'), areas.length === 1 && areas[0] === 'Paraguay');

  const ents = [...new Set(ts.map((t) => t.properties.entidad_facturadora || '(vacía)'))];
  check('NO-REGRESIÓN', `${slug} · emisora`, 'ISA PY', ents.join('|'), ents.length === 1 && ents[0] === 'ISA PY');

  let nombreProd = '';
  try { nombreProd = (await hubspotClient.crm.products.basicApi.getById(p.hs_product_id, ['name'])).properties.name; } catch { /* 404 */ }
  const prods = [...new Set(ts.map((t) => t.properties.of_producto || '(vacío)'))];
  check('NO-REGRESIÓN', `${slug} · producto`, nombreProd || '(el del LI)', prods.join('|'),
    Boolean(nombreProd) && prods.length === 1 && prods[0] === nombreProd);

  const facturados = ts.filter((t) => t.properties.of_invoice_id).length;
  check('NO-REGRESIÓN', `${slug} · sin facturas emitidas (la emisión es la etapa 3)`, 0, facturados);

  const conError = ts.filter((t) => t.properties.of_billing_error).length;
  check('NO-REGRESIÓN', `${slug} · sin of_billing_error`, 0, conError);
}

// ── BLOQUE F: el espejo ──────────────────────────────────────────────────────
let mirrorId = dp.deal_uy_mirror_id || '';
if (!mirrorId) {
  const r = await hubspotClient.crm.deals.searchApi.doSearch({
    filterGroups: [{ filters: [
      { propertyName: 'dealname', operator: 'CONTAINS_TOKEN', value: M.prefix.replace(/[[\]]/g, '') },
      { propertyName: 'es_mirror_de_py', operator: 'EQ', value: 'true' }] }],
    properties: ['dealname'], limit: 5,
  });
  mirrorId = r.results?.[0]?.id || '';
}
check('ESPEJO', 'el negocio espejo sigue existiendo', 'sí', mirrorId || 'NO EXISTE', Boolean(mirrorId));

let espejoStage = '', espejoActiva = '', espejoTicketsAsoc = 0, espejoTickets = 0;
if (mirrorId) {
  const mdp = (await hubspotClient.crm.deals.basicApi.getById(mirrorId,
    ['dealstage', 'facturacion_activa', 'valor_total', 'billing_error'])).properties;
  espejoStage = String(mdp.dealstage || '');
  espejoActiva = mdp.facturacion_activa || '(vacía)';

  // dealMirroring copia el stage del PY hasta 85% (:699-718) ⇒ el espejo debería ganar solo.
  check('ESPEJO', 'el stage se copió del original', DEAL_STAGE_GANADO, espejoStage);
  check('ESPEJO', 'su facturacion_activa (portero propio del espejo)', 'true', espejoActiva, parseBool(mdp.facturacion_activa));

  const emp = await empresasDe('deals', mirrorId);
  const emisora = emp.find((e) => e.labels.includes('Empresa Factura'));
  check('ESPEJO', 'Empresa Factura', EMISORA_ESPEJO_ESPERADA, emisora?.nombre || '(ninguna)',
    Boolean(emisora) && emisora.nombre.toUpperCase().includes(EMISORA_ESPEJO_ESPERADA));

  const mlis = await hubspotClient.crm.lineItems.searchApi.doSearch({
    filterGroups: [{ filters: [{ propertyName: 'line_item_key', operator: 'CONTAINS_TOKEN', value: mirrorId }] }],
    properties: LI_PROPS, limit: 20,
  });
  check('ESPEJO', 'sigue con 1 line item', 1, mlis.results.length);

  if (mlis.results.length) {
    const ml = mlis.results[0].properties;
    const mt = await ticketsDeLik(ml.line_item_key);
    espejoTickets = mt.length;
    check('ESPEJO', 'sigue con 1 ticket', 1, mt.length);

    const asocEspejo = await ticketsAsociados(mirrorId);
    espejoTicketsAsoc = mt.filter((t) => asocEspejo.has(String(t.id))).length;
    check('ESPEJO', 'su ticket queda asociado al negocio espejo', mt.length,
      espejoTicketsAsoc, mt.length > 0 && espejoTicketsAsoc === mt.length);
  }
}

// ── Salida ────────────────────────────────────────────────────────────────────
const anchoNombre = Math.max(...checks.map((c) => c.nombre.length));
let bloqueActual = '';
for (const c of checks) {
  if (c.bloque !== bloqueActual) { bloqueActual = c.bloque; console.log(`\n── ${bloqueActual}`); }
  const icono = c.pass ? '✅' : '❌';
  const detalle = c.pass ? String(c.actual) : `obtuvo: ${c.actual}   ·   esperaba: ${c.esperado}`;
  console.log(`  ${icono} ${c.nombre.padEnd(anchoNombre)}  ${detalle}`);
}

const fails = checks.filter((c) => !c.pass);
console.log(`\n${'═'.repeat(76)}`);
console.log(`  ETAPA 2 (cierre ganado)   ${checks.length - fails.length}/${checks.length} en verde     hoy=${HOY}`);
console.log(`${'═'.repeat(76)}`);
if (fails.length) {
  console.log('\n  Lo que falla:');
  for (const f of fails) console.log(`   ❌ [${f.bloque}] ${f.nombre} → ${f.actual}  (esperaba ${f.esperado})`);
}

// Diagnóstico — no es PASS/FAIL, es para saber DÓNDE mirar cuando algo falla.
console.log('\n  ℹ️  Diagnóstico');
console.log(`     negocio ${M.dealId} · espejo ${mirrorId || '—'}`);
console.log(`     dealstage=${dp.dealstage}  facturacion_activa=${dp.facturacion_activa || '(vacía)'}`);
console.log(`     tickets del original: ${totalOriginal} · asociados: ${asociadosDelStack.length}`);
console.log(`     tickets del espejo:   ${espejoTickets} · asociados: ${espejoTicketsAsoc}`);
console.log(`     etiquetas completas en la muestra: ${etiquetasOk}/${etiquetasTotal}` +
  `${primaryPerdido ? `  🐛 Primary en la empresa equivocada en ${primaryPerdido}` : ''}`);
console.log(`     empresas del negocio: ${empresasDeal.map((e) => `${e.nombre} [${e.labels.join(',')}]`).join(' · ') || '(ninguna)'}`);
console.log(`     contactos del negocio: ${contactosDeal.length}`);
console.log(`     etapa única asumida: ${ETAPA_UNICA ? 'PRENDIDA' : 'apagada'} (--sin-etapa-unica para invertir)`);

// Re-snapshot pendiente: el LI se editó DESPUÉS del último snapshot del ticket.
// Es el semáforo de "el dato está en el line item pero todavía no bajó".
for (const [slug] of Object.entries(M.lineItems)) {
  const ts = todosLosTickets.filter((x) => x.slug === slug).map((x) => x.t);
  if (!ts.length) continue;
  const liMod = String(lisPorSlug[slug].hs_lastmodifieddate || '');
  const desfasados = ts.filter((t) => String(t.properties.of_snapshot_source_modified || '') !== liMod);
  if (desfasados.length) {
    console.log(`     ⏳ ${slug}: ${desfasados.length}/${ts.length} tickets con snapshot viejo ` +
      `(LI modificado ${liMod.slice(0, 19)} · snapshot ${String(ts[0].properties.of_snapshot_source_modified || '—').slice(0, 19)})`);
  }
}

if (GANADO && !ACTIVA) {
  console.log('\n  🔴 ZONA MUERTA: el negocio está GANADO y `facturacion_activa` NO está en true.');
  console.log('     · La asociación de tickets NO se ejecuta (associateOnClosedWon.js:188 → applies:false).');
  console.log('     · Sin asociación, `ticket_label_sync` responde skipped/"sin_tickets" y las etiquetas no bajan.');
  console.log('     · Y desde el arreglo de la frontera, los webhooks del negocio se saltean enteros');
  console.log('       (webhookQueue.js:454 «Deal ganado con facturación inactiva, skip»).');
  console.log('     👉 Prender `facturacion_activa` y forzar una corrida completa de fases.');
}
if (GANADO && ACTIVA && asociadosDelStack.length === 0) {
  console.log('\n  ⚠️  Facturación activa pero 0 asociados: falta que CORRA una pasada completa de fases.');
  console.log('     Mover el stage NO encola nada (escuchar-cambios.js:131). La disparan el cron diario');
  console.log('     o un evento de line item (`recalc` / `product_reassign`).');
}

if (DETALLE) {
  console.log('\n── DETALLE de los tickets');
  for (const { slug, t } of todosLosTickets.sort((a, b) =>
    String(a.t.properties.fecha_resolucion_esperada).localeCompare(String(b.t.properties.fecha_resolucion_esperada)))) {
    const p = t.properties;
    console.log(`  ${slug}  ${String(p.fecha_resolucion_esperada).slice(0, 10)}  ${stageLbl(p.hs_pipeline_stage).padEnd(20)} ` +
      `${asociados.has(String(t.id)) ? 'asociado ' : 'SUELTO   '} monto=${p.monto_unitario_real} cant=${p.cantidad_real} ` +
      `costo=${p.of_costo} margen=${p.of_margen} prod="${p.of_producto || ''}"`);
  }
}

console.log('');
process.exit(fails.length ? 1 : 0);
