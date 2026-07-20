// exportReporte.mjs
// Script standalone para exportar reporte consolidado de Deals + Line Items + Tickets
// Uso: node exportReporte.mjs [--pipeline <pipelineId>]
// Requiere: HUBSPOT_PRIVATE_TOKEN y DATABASE_URL en .env o variable de entorno

import 'dotenv/config';
import { Client } from '@hubspot/api-client';
import ExcelJS from 'exceljs';

// ── Config ──
const TOKEN = process.env.HUBSPOT_PRIVATE_TOKEN;
if (!TOKEN) { console.error('Falta HUBSPOT_PRIVATE_TOKEN'); process.exit(1); }

const hubspot = new Client({ accessToken: TOKEN });

// Association type IDs (deal → company)
// Etiquetas por portal (mismos envs que el motor): Empresa Factura prod=9 / sandbox=2 · Partner prod=2 / sandbox=3.
const ASSOC_PRIMARY_COMPANY = 5;
const ASSOC_EMPRESA_FACTURA = parseInt(process.env.ASSOC_LABEL_EMPRESA_FACTURA || '9', 10);
const ASSOC_PARTNER = parseInt(process.env.ASSOC_LABEL_EMPRESA_PARTNER || '2', 10);

// Probabilidad de corte para separar hojas
const PROB_CORTE = 0.85;

// ── Stage sets para clasificación de tickets ──
const LISTO_STAGES = new Set([
  process.env.BILLING_TICKET_STAGE_READY,
  process.env.BILLING_AUTOMATED_READY,
].filter(Boolean));

const INVOICED_STAGES = new Set([
  process.env.BILLING_TICKET_STAGE_ID_BILLED,
  process.env.BILLING_TICKET_STAGE_ID_CREATED,
  process.env.BILLING_TICKET_STAGE_ID_LATE,
  process.env.BILLING_TICKET_PIPELINE_ID_PAID,
  process.env.BILLING_AUTOMATED_CREATED,
  process.env.BILLING_AUTOMATED_LATE,
  process.env.BILLING_AUTOMATED_PAID,
].filter(Boolean));

// NOTA: estadoBacklog() se elimino — quedo sin llamadores cuando la clasificacion
// Backlog/Facturado paso a resolverse inline (tieneFactura || INVOICED_STAGES -> Facturado).

// ── Helpers ──
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const safe = (v) => (v ?? '').toString().trim();
const safeNum = (v) => { const n = parseFloat(v); return isNaN(n) ? null : n; };
const ymd = (v) => safe(v).slice(0, 10);

function mesAnio(fechaStr) {
  const d = ymd(fechaStr);
  if (!d || d.length < 7) return { mes: '', anio: '' };
  const [y, m] = d.split('-');
  return { mes: m, anio: y };
}

function esRenovacionAutomatica(fechaVenc) {
  const d = ymd(fechaVenc);
  return d.startsWith('2099') ? 'SI' : 'NO';
}

function esRepetitivo(freq) {
  const f = safe(freq).toLowerCase();
  return f && !['unico', 'único', 'one_time', ''].includes(f) ? 'SI' : 'NO';
}

// Fecha a dd/mm/yyyy para las columnas visibles (mesAnio sigue usando ymd internamente).
const dmy = (v) => {
  const d = ymd(v);
  if (!d || d.length < 10) return '';
  const [y, m, day] = d.split('-');
  return `${day}/${m}/${y}`;
};

// Probabilidad 0..1 → "NN%".
const pct = (v) => { const n = safeNum(v); return n == null ? '' : `${Math.round(n * 100)}%`; };

// Frecuencia de facturación → etiqueta en español (los LIs guardan códigos en inglés).
const FREQ_ES = {
  weekly: 'Semanal', biweekly: 'Quincenal', monthly: 'Mensual', quarterly: 'Trimestral',
  per_six_months: 'Semestral', annually: 'Anual', per_two_years: 'Bienal',
  per_three_years: 'Trienal', per_four_years: 'Cada 4 años', per_five_years: 'Cada 5 años',
};
const frecuenciaLI = (raw) => FREQ_ES[safe(raw)] || (safe(raw) || 'Único');

// Momento de facturación → etiqueta legible.
const MOMENTO_ES = { adelantado: 'Adelantado', fin_de_mes: 'Fin de mes', vencido: 'Vencido' };
const momentoLabel = (raw) => MOMENTO_ES[safe(raw)] || safe(raw);

// ── TC helpers ──────────────────────────────────────────────────────────────

// NOTA: aca vivian getLatestExchangeRate(), convertToUSD() y getTCForCurrency(),
// que convertian a USD con el "TC del dia" de exchange_rates. Se eliminaron al pasar
// el reporte al dolar SELLADO por negocio/ticket (prop `dolar`). El cron cronExchangeRates,
// que puebla esa tabla, sigue funcionando sin cambios.

// ── Rate-limited API helpers ──
let lastCall = 0;
async function rateLimit() {
  const now = Date.now();
  const diff = now - lastCall;
  if (diff < 110) await sleep(110 - diff);
  lastCall = Date.now();
}

// ── HubSpot data fetching ──

const DEAL_PROPS = [
  'dealname', 'dealstage', 'deal_currency_code', 'hubspot_owner_id',
  'pais_operativo', 'unidad_de_negocio', 'pipeline',
  'facturacion_activa', 'closedate', 'hs_deal_stage_probability',
  'deal_py_origen_id', 'deal_uy_mirror_id', 'es_mirror_de_py',
  'condiciones_de_pago', 'dolar',
];

const LI_PROPS = [
  'name', 'description', 'price', 'hs_cost_of_goods_sold', 'quantity', 'amount',
  'costo_total_usd', 'dolar', 'monto_usd', 'margen_usd',
  'hs_line_item_currency_code', 'mig_moneda', 'mensaje_para_responsable',
  'discount', 'hs_discount_percentage', 'hs_margin',
  'facturacion_activa', 'facturacion_automatica',
  'recurringbillingfrequency', 'hs_recurring_billing_frequency',
  'hs_recurring_billing_start_date', 'fecha_inicio_de_facturacion',
  'fecha_vencimiento_contrato', 'billing_anchor_date',
  'hs_recurring_billing_number_of_payments', 'number_of_payments',
  'hs_product_id', 'line_item_key', 'of_line_item_key',
  'servicio', 'subrubro', 'reventa', 'porcentaje_margen',
  'uy', 'pais_operativo', 'hubspot_owner_id',
  'momento_de_facturacion', 'area',
];

const TICKET_PROPS = [
  'of_ticket_key', 'of_line_item_key', 'of_deal_id', 'of_estado',
  'fecha_resolucion_esperada', 'hs_pipeline_stage', 'hs_pipeline',
  'of_producto_nombres', 'of_descripcion_producto', 'descripcion', 'observaciones',
  'of_rubro', 'of_subrubro', 'reventa', 'of_costo', 'of_costo_usd', 'of_margen',
  'of_facturacion_usd', 'of_margen_usd',
  'subtotal_real', 'total_real_a_facturar', 'numero_de_factura', 'dolar',
  'of_pais_operativo', 'of_moneda', 'momento_de_facturacion', 'area',
  'of_frecuencia_de_facturacion',
  'nombre_empresa', 'empresa_id', 'empresa_que_factura', 'cliente_partner',
];

async function fetchAllDeals(pipelineFilter) {
  const deals = [];
  let after = undefined;

  const filters = [];
  if (pipelineFilter) {
    filters.push({ propertyName: 'pipeline', operator: 'EQ', value: pipelineFilter });
  }

  while (true) {
    await rateLimit();
    const body = {
      ...(filters.length ? { filterGroups: [{ filters }] } : {}),
      properties: DEAL_PROPS,
      limit: 100,
      sorts: [{ propertyName: 'dealname', direction: 'ASCENDING' }],
      ...(after ? { after } : {}),
    };

    const resp = await hubspot.crm.deals.searchApi.doSearch(body);
    const results = resp?.results || [];
    deals.push(...results);

    after = resp?.paging?.next?.after;
    if (!after || results.length === 0) break;

    console.log(`  Deals fetched: ${deals.length}...`);
  }

  return deals;
}

async function fetchLineItems(dealId) {
  await rateLimit();
  let liIds = [];
  try {
    const resp = await hubspot.crm.associations.v4.basicApi.getPage('deals', String(dealId), 'line_items', 100);
    liIds = (resp.results || []).map(r => String(r.toObjectId));
  } catch { return []; }

  if (!liIds.length) return [];

  const items = [];
  for (let i = 0; i < liIds.length; i += 100) {
    await rateLimit();
    const resp = await hubspot.crm.lineItems.batchApi.read({
      inputs: liIds.slice(i, i + 100).map(id => ({ id })),
      properties: LI_PROPS,
    });
    items.push(...(resp?.results || []));
  }
  return items;
}

async function fetchDealCompaniesWithTypes(dealId) {
  await rateLimit();
  try {
    const resp = await hubspot.crm.associations.v4.basicApi.getPage('deals', String(dealId), 'companies', 100);
    return resp.results || [];
  } catch { return []; }
}

const companyCache = new Map();
async function fetchCompany(companyId) {
  if (companyCache.has(companyId)) return companyCache.get(companyId);
  await rateLimit();
  try {
    const c = await hubspot.crm.companies.basicApi.getById(String(companyId), ['name']);
    companyCache.set(companyId, c);
    return c;
  } catch {
    companyCache.set(companyId, null);
    return null;
  }
}

const ownerCache = new Map();
async function fetchOwnerName(ownerId) {
  if (!ownerId) return '';
  if (ownerCache.has(ownerId)) return ownerCache.get(ownerId);
  await rateLimit();
  try {
    const resp = await hubspot.apiRequest({ method: 'GET', path: `/crm/v3/owners/${ownerId}` });
    const data = await resp.json();
    const name = `${data.firstName || ''} ${data.lastName || ''}`.trim() || data.email || '';
    ownerCache.set(ownerId, name);
    return name;
  } catch {
    ownerCache.set(ownerId, '');
    return '';
  }
}

const productCache = new Map();
async function fetchProductName(productId) {
  if (!productId) return '';
  if (productCache.has(productId)) return productCache.get(productId);
  await rateLimit();
  try {
    const p = await hubspot.crm.products.basicApi.getById(String(productId), ['name']);
    const name = p?.properties?.name || '';
    productCache.set(productId, name);
    return name;
  } catch {
    productCache.set(productId, '');
    return '';
  }
}

async function fetchTicketsForDeal(dealId) {
  const tickets = [];
  let after = undefined;

  while (true) {
    await rateLimit();
    const body = {
      filterGroups: [{ filters: [{ propertyName: 'of_deal_id', operator: 'EQ', value: String(dealId) }] }],
      properties: TICKET_PROPS,
      limit: 100,
      ...(after ? { after } : {}),
    };

    const resp = await hubspot.crm.tickets.searchApi.doSearch(body);
    const results = resp?.results || [];
    tickets.push(...results);

    after = resp?.paging?.next?.after;
    if (!after || results.length === 0) break;
  }

  return tickets;
}

// ── Resolve helpers ──

async function resolveDealCompanies(dealId) {
  const assocs = await fetchDealCompaniesWithTypes(dealId);
  let primaryId = null, facturaId = null, partnerId = null;

  for (const a of assocs) {
    const cId = String(a.toObjectId);
    const types = a.associationTypes || [];
    for (const t of types) {
      const tid = t.typeId ?? t.associationTypeId;
      if (tid === ASSOC_EMPRESA_FACTURA) facturaId = cId;
      else if (tid === ASSOC_PARTNER) partnerId = cId;
      else if (tid === ASSOC_PRIMARY_COMPANY) primaryId = cId;
    }
    if (!primaryId && types.length === 0) primaryId = cId;
  }
  if (!primaryId && assocs.length > 0) primaryId = String(assocs[0].toObjectId);

  const [primary, factura, partner] = await Promise.all([
    primaryId ? fetchCompany(primaryId) : null,
    facturaId ? fetchCompany(facturaId) : null,
    partnerId ? fetchCompany(partnerId) : null,
  ]);

  return {
    beneficiario: { id: primaryId || '', nombre: primary?.properties?.name || '' },
    factura: { id: facturaId || '', nombre: factura?.properties?.name || '' },
    partner: { id: partnerId || '', nombre: partner?.properties?.name || '' },
  };
}

const stageCache = new Map();
async function resolveStageLabel(pipelineId, stageId) {
  const key = `${pipelineId}::${stageId}`;
  if (stageCache.has(key)) return stageCache.get(key);

  if (!stageCache.has('__pipelines_loaded__')) {
    await rateLimit();
    try {
      const pipelines = await hubspot.crm.pipelines.pipelinesApi.getAll('deals');
      for (const p of pipelines?.results || []) {
        for (const s of p.stages || []) {
          stageCache.set(`${p.id}::${s.id}`, s.label);
        }
      }
    } catch (e) {
      console.warn('  Warn: no se pudieron cargar pipelines', e.message);
    }
    stageCache.set('__pipelines_loaded__', true);
  }

  return stageCache.get(key) || stageId;
}

// ── Build rows ──

function buildDealBase(deal, companies, ownerName) {
  const dp = deal.properties || {};
  return {
    'Cliente Beneficiario': companies.beneficiario.nombre,
    'ID Cliente Beneficiario': companies.beneficiario.id,
    'Empresa Factura': companies.factura.nombre,
    'ID Empresa Factura': companies.factura.id,
    'Partner': companies.partner.nombre,
    'ID Partner': companies.partner.id,
    'Negocio': safe(dp.dealname),
    'ID Negocio': deal.id,
    'Ejecutivo Asignado': ownerName,
    'País Operativo': safe(dp.pais_operativo),
    'Ciclo de Negocio': '',
    'Probabilidad': pct(dp.hs_deal_stage_probability),
    'Fecha de Cierre': dmy(dp.closedate),
    'Moneda': safe(dp.deal_currency_code),
    'Condiciones de Pago': safe(dp.condiciones_de_pago),
    'Intercompany': safe(dp.es_mirror_de_py) === 'true' ? 'SI' : 'NO',
  };
}

function buildLineItemRow(li, dealBase, deal, productName, latestRates) {
  const lp = li.properties || {};
  const freq = safe(lp.recurringbillingfrequency || lp.hs_recurring_billing_frequency);
  const fechaInicio = ymd(lp.hs_recurring_billing_start_date || lp.fecha_inicio_de_facturacion);
  const fechaVenc = ymd(lp.fecha_vencimiento_contrato);
  const esAuto = safe(lp.facturacion_automatica).toLowerCase() === 'true';
  const incluyeUY = safe(lp.uy).toLowerCase() === 'true';
  const fechaFact = fechaInicio;
  const { mes, anio } = mesAnio(fechaFact);

  const monto = safeNum(lp.amount);
  // Definición 2026-07-07: costo_total_usd = fuente de verdad (total, USD).
  // Costo (moneda del negocio) = costo_total_usd × dolar(LI); fallback legacy cogs × qty.
  const costoUsdFuente = safeNum(lp.costo_total_usd);
  const dolarLi = safeNum(lp.dolar);
  const costo = (costoUsdFuente != null && dolarLi > 0)
    ? costoUsdFuente * dolarLi
    : safeNum(lp.hs_cost_of_goods_sold) != null
      ? safeNum(lp.hs_cost_of_goods_sold) * (safeNum(lp.quantity) || 1)
      : (costoUsdFuente != null ? costoUsdFuente : null); // sin dolar: al menos en deals USD es el valor correcto
  const margenBruto = (monto != null && costo != null) ? monto - costo : null;
  const margenPct = monto > 0
    ? Math.round((safeNum(lp.hs_margin) / monto) * 10000) / 100
    : null;

  // Moneda REAL del line item (hs_line_item_currency_code / mig_moneda); NO la "home currency"
  // del negocio (que en HubSpot es USD para todos y ocultaba PYG/UYU).
  const moneda = safe(lp.hs_line_item_currency_code) || safe(lp.mig_moneda) || dealBase['Moneda'];
  const esUSD = safe(moneda).toUpperCase() === 'USD';
  // Dólar ASIGNADO al negocio, congelado en creación/cierre/1-ene (NO el cambio del día).
  // Preferencia: dólar del LI; fallback dólar del negocio. En USD no hay conversión → 1.
  const dealDolar = safeNum(deal.properties?.dolar);
  const tc = esUSD ? 1 : (dolarLi != null ? dolarLi : dealDolar);
  // Columnas USD = props CALCULADAS de HubSpot (monto_usd/margen_usd usan el dólar asignado).
  // Fallback USD→valor en moneda (la fórmula monto_usd divide por `dolar`, que en USD puede faltar).
  const montoUSD = safeNum(lp.monto_usd) != null ? safeNum(lp.monto_usd) : (esUSD ? monto : null);
  const costoUSD = costoUsdFuente != null ? costoUsdFuente : (esUSD ? costo : null);
  const margenBrutoUSD = safeNum(lp.margen_usd) != null
    ? safeNum(lp.margen_usd)
    : (montoUSD != null && costoUSD != null ? Math.round((montoUSD - costoUSD) * 100) / 100 : null);

  return {
    ...dealBase,
    'Moneda': moneda,
    'Rubro': safe(lp.servicio),
    // Área de Negocio = prop `area` del LI (regla por país); fallback producto/nombre.
    'Área de Negocio': safe(lp.area) || productName || safe(lp.name),
    'Descripción Producto': safe(lp.description),
    'Descripción Ticket': '',
    'Observaciones': safe(lp.mensaje_para_responsable),
    'Incluye UY': incluyeUY ? 'SI' : 'NO',
    'Fecha Fact Estimada': dmy(fechaFact),
    'Mes': mes, 'Año': anio,
    'Monto': monto,
    'Costo': costo,
    'Margen Bruto': margenBruto,
    'Margen %': margenPct,
    'Dólar': tc,
    'Monto USD': montoUSD,
    'Costo USD': costoUSD,
    'Margen Bruto USD': margenBrutoUSD,
    'Momento de Facturación': momentoLabel(lp.momento_de_facturacion),
    'Repetitivo': esRepetitivo(freq),
    'Reventa': safe(lp.reventa).toLowerCase() === 'true' ? 'SI' : 'NO',
    'Sub Rubro': safe(lp.subrubro),
    'N Factura': '',
    'Fuente': 'Line Item',
    'Facturación Automática': esAuto ? 'SI' : 'NO',
    'Fecha Inicio Contrato': dmy(fechaInicio),
    'Frecuencia': frecuenciaLI(freq),
    'Fecha Fin Contrato': dmy(fechaVenc),
    'Renovación Automática': esRenovacionAutomatica(fechaVenc),
  };
}

function buildTicketRow(ticket, dealBase, lineItemMap, productNameMap, latestRates) {
  const tp = ticket.properties || {};
  const lik = safe(tp.of_line_item_key);
  const li = lineItemMap.get(lik);
  const lp = li?.properties || {};

  const fechaFact = ymd(tp.fecha_resolucion_esperada);
  const { mes, anio } = mesAnio(fechaFact);
  // Frecuencia del TICKET (of_frecuencia_de_facturacion, ya en español); fallback al código del LI.
  const freq = safe(tp.of_frecuencia_de_facturacion) || frecuenciaLI(lp?.recurringbillingfrequency);
  const esAuto = safe(lp?.facturacion_automatica || '').toLowerCase() === 'true';
  const fechaInicio = ymd(lp?.hs_recurring_billing_start_date || lp?.fecha_inicio_de_facturacion || '');
  const fechaVenc = ymd(lp?.fecha_vencimiento_contrato || '');
  const incluyeUY = safe(lp?.uy || '').toLowerCase() === 'true';

  const monto = safeNum(tp.subtotal_real);
  const costo = safeNum(tp.of_costo);
  const margenBruto = (monto != null && costo != null) ? monto - costo : null;

  // Moneda: la del TICKET (of_moneda, sellada al crear la OF); fallback moneda del deal.
  const moneda = safe(tp.of_moneda) || dealBase['Moneda'];
  const esUSD = safe(moneda).toUpperCase() === 'USD';
  const tieneFactura = safe(tp.numero_de_factura) !== '';
  // TC = dólar SELLADO en el ticket al momento de facturación (prop `dolar`). NO cambio del día.
  // En USD no hay conversión → 1 (el ticket puede traer un `dolar` residual que no aplica).
  const tc = esUSD ? 1 : safeNum(tp.dolar);

  // Columnas USD = props CALCULADAS de HubSpot (usan el dólar sellado del ticket):
  //   of_facturacion_usd = subtotal en USD (respeta intercompany=0) · of_margen_usd = margen USD.
  const costoUSD = safeNum(tp.of_costo_usd) != null ? safeNum(tp.of_costo_usd) : (esUSD ? costo : null);
  const montoUSD = safeNum(tp.of_facturacion_usd) != null
    ? safeNum(tp.of_facturacion_usd)
    : (esUSD ? monto : null);
  const margenBrutoUSD = safeNum(tp.of_margen_usd) != null
    ? safeNum(tp.of_margen_usd)
    : (montoUSD != null && costoUSD != null ? Math.round((montoUSD - costoUSD) * 100) / 100 : null);

  return {
    ...dealBase,
    // Empresas: si la etiqueta de asociación todavía no existe (p.ej. estados tempranos),
    // caer a las props que el motor sella en el ticket: nombre_empresa / empresa_id /
    // empresa_que_factura / cliente_partner.
    'Cliente Beneficiario': dealBase['Cliente Beneficiario'] || safe(tp.nombre_empresa),
    'ID Cliente Beneficiario': dealBase['ID Cliente Beneficiario'] || safe(tp.empresa_id),
    'Empresa Factura': dealBase['Empresa Factura'] || safe(tp.empresa_que_factura),
    'Partner': dealBase['Partner'] || safe(tp.cliente_partner),
    'Moneda': moneda,
    'Rubro': safe(tp.of_rubro || lp?.servicio || ''),
    // Área de Negocio = prop `area` del ticket (snapshot del LI, regla por país); fallback legacy.
    'Área de Negocio': safe(tp.area || lp?.area || '') || productNameMap.get(safe(lp?.hs_product_id)) || safe(tp.of_producto_nombres || lp?.name || ''),
    'Descripción Producto': safe(tp.of_descripcion_producto || lp?.description || ''),
    'Descripción Ticket': safe(tp.descripcion || ''),
    'Observaciones': safe(tp.observaciones || lp?.mensaje_para_responsable || ''),
    'Incluye UY': incluyeUY ? 'SI' : 'NO',
    'Fecha Fact Estimada': dmy(fechaFact),
    'Mes': mes, 'Año': anio,
    'Monto': monto,
    'Costo': costo,
    'Margen Bruto': margenBruto,
    'Margen %': safeNum(tp.of_margen),
    'Dólar': tc,
    'Monto USD': montoUSD,
    'Costo USD': costoUSD,
    'Margen Bruto USD': margenBrutoUSD,
    'Momento de Facturación': momentoLabel(tp.momento_de_facturacion || lp?.momento_de_facturacion),
    'Repetitivo': esRepetitivo(freq),
    'Reventa': safe(tp.reventa || lp?.reventa || '').toLowerCase() === 'true' ? 'SI' : 'NO',
    'Sub Rubro': safe(tp.of_subrubro || lp?.subrubro || ''),
    'N Factura': safe(tp.numero_de_factura),
    'Fuente': 'Ticket',
    'Facturación Automática': esAuto ? 'SI' : 'NO',
    'Fecha Inicio Contrato': dmy(fechaInicio),
    'Frecuencia': freq,
    'Fecha Fin Contrato': dmy(fechaVenc),
    'Renovación Automática': esRenovacionAutomatica(fechaVenc),
  };
}

function isValidTicket(ticket) {
  const tp = ticket.properties || {};
  const estado = safe(tp.of_estado).toUpperCase();
  return !['DUPLICADO_UI', 'DEPRECATED'].includes(estado);
}

// ── MAIN ──
async function main() {
  const args = process.argv.slice(2);
  const pipelineIdx = args.indexOf('--pipeline');
  const pipelineFilter = pipelineIdx >= 0 ? args[pipelineIdx + 1] : null;

  console.log('=== Exportando reporte consolidado ===');
  if (pipelineFilter) console.log(`  Pipeline filter: ${pipelineFilter}`);

  // 0) Las columnas USD salen de las props CALCULADAS de HubSpot (dólar asignado al negocio /
  //    sellado en el ticket), NO del cambio del día. Ya no se consulta exchange_rates.
  console.log('\n0. USD desde el dólar asignado (props de HubSpot) — no se usa el cambio del día.');
  const latestRates = null;

  // 1) Fetch all deals
  console.log('\n1. Descargando deals...');
  const allDeals = await fetchAllDeals(pipelineFilter);
  console.log(`   Total deals: ${allDeals.length}`);

  // 2) Pre-load pipelines
  await resolveStageLabel('', '');

  // 3) Process each deal
  const pipelineRows  = [];
  const forecastRows  = [];
  const listoRows     = [];
  const facturadoRows = [];

  for (let i = 0; i < allDeals.length; i++) {
    const deal = allDeals[i];
    const dp = deal.properties || {};
    const dealId = deal.id;
    const prob = safeNum(dp.hs_deal_stage_probability) ?? 0;

    if ((i + 1) % 10 === 0 || i === 0) {
      console.log(`\n  Procesando deal ${i + 1}/${allDeals.length}: ${safe(dp.dealname)} (prob: ${prob}%)`);
    }

    const stageLabel = await resolveStageLabel(safe(dp.pipeline), safe(dp.dealstage));
    const companies = await resolveDealCompanies(dealId);
    const ownerName = await fetchOwnerName(safe(dp.hubspot_owner_id));

    const dealBase = buildDealBase(deal, companies, ownerName);
    dealBase['Ciclo de Negocio'] = stageLabel;

    // Intercompany (mirror PY→UY): FACT 0 para no duplicar; el margen conserva su valor.
    const esIntercompany = dealBase['Intercompany'] === 'SI';
    const aplicarIntercompany = (row) => {
      if (esIntercompany) { row['Monto'] = 0; row['Monto USD'] = 0; }
      return row;
    };

    const lineItems = await fetchLineItems(dealId);

    const liKeyMap = new Map();
    for (const li of lineItems) {
      const lp = li.properties || {};
      const lik = safe(lp.line_item_key || lp.of_line_item_key);
      if (lik) liKeyMap.set(lik, li);
    }

    const productNameMap = new Map();
    await Promise.all(lineItems.map(async (li) => {
      const productId = safe(li.properties?.hs_product_id);
      if (productId) {
        const name = await fetchProductName(productId);
        productNameMap.set(productId, name);
      }
    }));

    if (prob < PROB_CORTE) {
      // Tipo de Forecast por bucket de probabilidad del deal (spec Paola jul-2026).
      const tipoForecast = prob < 0.50 ? 'Forecast' : prob < 0.75 ? 'Forecast en Strech' : 'Forecast Firme';
      for (const li of lineItems) {
        const productName = productNameMap.get(safe(li.properties?.hs_product_id)) || '';
        const row = buildLineItemRow(li, dealBase, deal, productName, latestRates);
        row['Tipo de Forecast'] = tipoForecast;
        pipelineRows.push(aplicarIntercompany(row));
      }
    } else {
      const tickets = await fetchTicketsForDeal(dealId);
      const validTickets = tickets.filter(isValidTicket);

      for (const ticket of validTickets) {
        const tp = ticket.properties || {};
        const row = buildTicketRow(ticket, dealBase, liKeyMap, productNameMap, latestRates);
        const tieneFactura = safe(tp.numero_de_factura) !== '';
        const stage = safe(tp.hs_pipeline_stage);
        aplicarIntercompany(row);

        // Facturado = con nº de factura o en etapas Emitido/Enviado/Atrasado/Cobrado.
        if (tieneFactura || INVOICED_STAGES.has(stage)) {
          facturadoRows.push(row);
        } else if (LISTO_STAGES.has(stage)) {
          // Listo para facturar (ambos pipelines) → Notificado.
          row['Estado Backlog'] = 'Notificado';
          listoRows.push(row);
        } else {
          // 85% / 95% / Próximos a facturar (y forecast previo) → Pendiente de notificar.
          row['Estado Backlog'] = 'Pendiente de notificar';
          forecastRows.push(row);
        }
      }
    }
  }

  console.log(`\n  Pipeline rows : ${pipelineRows.length}`);
  console.log(`  Forecast rows : ${forecastRows.length}`);
  console.log(`  Listo rows    : ${listoRows.length}`);
  console.log(`  Facturado rows: ${facturadoRows.length}`);

  // 4) Build Excel
  console.log('\n4. Generando Excel...');

  const wb = new ExcelJS.Workbook();

  const COLUMNS = [
    { header: 'Cliente Beneficiario', key: 'Cliente Beneficiario', width: 30 },
    { header: 'ID Cliente Beneficiario', key: 'ID Cliente Beneficiario', width: 15 },
    { header: 'Empresa Factura', key: 'Empresa Factura', width: 30 },
    { header: 'ID Empresa Factura', key: 'ID Empresa Factura', width: 15 },
    { header: 'Partner', key: 'Partner', width: 25 },
    { header: 'ID Partner', key: 'ID Partner', width: 15 },
    { header: 'Negocio', key: 'Negocio', width: 35 },
    { header: 'ID Negocio', key: 'ID Negocio', width: 15 },
    { header: 'Ejecutivo Asignado', key: 'Ejecutivo Asignado', width: 22 },
    { header: 'País Operativo', key: 'País Operativo', width: 15 },
    { header: 'Incluye UY', key: 'Incluye UY', width: 12 },
    { header: 'Ciclo de Negocio', key: 'Ciclo de Negocio', width: 22 },
    { header: 'Tipo de Forecast', key: 'Tipo de Forecast', width: 18 },
    { header: 'Estado Backlog', key: 'Estado Backlog', width: 20 },
    { header: 'Intercompany', key: 'Intercompany', width: 13 },
    { header: 'Probabilidad', key: 'Probabilidad', width: 13 },
    { header: 'Fecha de Cierre', key: 'Fecha de Cierre', width: 15 },
    { header: 'Moneda', key: 'Moneda', width: 10 },
    { header: 'Rubro', key: 'Rubro', width: 25 },
    { header: 'Área de Negocio', key: 'Área de Negocio', width: 30 },
    { header: 'Descripción Producto', key: 'Descripción Producto', width: 40 },
    { header: 'Descripción Ticket', key: 'Descripción Ticket', width: 40 },
    { header: 'Observaciones', key: 'Observaciones', width: 30 },
    { header: 'Fecha Fact Estimada', key: 'Fecha Fact Estimada', width: 18 },
    { header: 'Mes', key: 'Mes', width: 8 },
    { header: 'Año', key: 'Año', width: 8 },
    { header: 'Monto', key: 'Monto', width: 15 },
    { header: 'Costo', key: 'Costo', width: 15 },
    { header: 'Margen Bruto', key: 'Margen Bruto', width: 15 },
    { header: 'Margen %', key: 'Margen %', width: 12 },
    { header: 'Dólar', key: 'Dólar', width: 12 },
    { header: 'Monto USD', key: 'Monto USD', width: 15 },
    { header: 'Costo USD', key: 'Costo USD', width: 15 },
    { header: 'Margen Bruto USD', key: 'Margen Bruto USD', width: 15 },
    { header: 'Repetitivo', key: 'Repetitivo', width: 12 },
    { header: 'Reventa', key: 'Reventa', width: 10 },
    { header: 'Sub Rubro', key: 'Sub Rubro', width: 20 },
    { header: 'N Factura', key: 'N Factura', width: 15 },
    { header: 'Fuente', key: 'Fuente', width: 12 },
    { header: 'Momento de Facturación', key: 'Momento de Facturación', width: 20 },
    { header: 'Condiciones de Pago', key: 'Condiciones de Pago', width: 25 },
    { header: 'Facturación Automática', key: 'Facturación Automática', width: 20 },
    { header: 'Fecha Inicio Contrato', key: 'Fecha Inicio Contrato', width: 18 },
    { header: 'Frecuencia', key: 'Frecuencia', width: 15 },
    { header: 'Fecha Fin Contrato', key: 'Fecha Fin Contrato', width: 18 },
    { header: 'Renovación Automática', key: 'Renovación Automática', width: 20 },
  ];

  function addSheet(name, rows) {
    const ws = wb.addWorksheet(name);
    ws.columns = COLUMNS;

    ws.getRow(1).eachCell(cell => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2F5496' } };
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    });
    ws.getRow(1).height = 30;

    for (const row of rows) {
      ws.addRow(row);
    }

    // Forma objeto: con 26+ columnas el cálculo por letra (A..Z) se rompía.
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: COLUMNS.length } };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
  }

  // 3 grandes conceptos (spec Paola jul-2026): Forecast / Backlog / Facturado
  const backlogRows = [...forecastRows, ...listoRows];
  addSheet('Forecast', pipelineRows);
  addSheet('Backlog', backlogRows);
  addSheet('Facturado', facturadoRows);

  const outPath = `reporte_consolidado_${new Date().toISOString().slice(0, 10)}.xlsx`;
  await wb.xlsx.writeFile(outPath);

  console.log(`\n✅ Reporte generado: ${outPath}`);
  console.log(`   Forecast : ${pipelineRows.length} filas`);
  console.log(`   Backlog  : ${backlogRows.length} filas (pendiente ${forecastRows.length} + notificado ${listoRows.length})`);
  console.log(`   Facturado: ${facturadoRows.length} filas`);
}

main().catch(err => {
  console.error('Error fatal:', err);
  process.exit(1);
});
