// exportReporte.mjs
// Script standalone para exportar reporte consolidado de Deals + Line Items + Tickets
// Uso: node exportReporte.mjs [--pipeline <pipelineId>]
// Requiere: HUBSPOT_PRIVATE_TOKEN en .env o variable de entorno

import 'dotenv/config';
import { Client } from '@hubspot/api-client';
import ExcelJS from 'exceljs';

// ── Config ──
const TOKEN = process.env.HUBSPOT_PRIVATE_TOKEN;
if (!TOKEN) { console.error('Falta HUBSPOT_PRIVATE_TOKEN'); process.exit(1); }

const hubspot = new Client({ accessToken: TOKEN });

// Association type IDs (deal → company)
const ASSOC_PRIMARY_COMPANY = 5;   // HUBSPOT_DEFINED deal→company (primary)
const ASSOC_EMPRESA_FACTURA = 9;   // FIX #2: era 10, correcto es 9
const ASSOC_PARTNER = 1;           // USER_DEFINED partner_internacional

// Probabilidad de corte para separar hojas
const PROB_CORTE = 0.85;

// ── Stage sets para clasificación de tickets (leídos desde .env igual que constants.js) ──
const LISTO_STAGES = new Set([
  process.env.BILLING_TICKET_STAGE_READY,       // "Listo para Facturar" manual
  process.env.BILLING_AUTOMATED_READY,           // "Listo para Facturar" automático
].filter(Boolean));

const INVOICED_STAGES = new Set([
  process.env.BILLING_TICKET_STAGE_ID_BILLED,   // Emitido manual
  process.env.BILLING_TICKET_STAGE_ID_CREATED,  // Creado manual
  process.env.BILLING_TICKET_STAGE_ID_LATE,     // Atrasado manual
  process.env.BILLING_TICKET_PIPELINE_ID_PAID,  // Pagado manual
  process.env.BILLING_AUTOMATED_CREATED,        // Creado auto
  process.env.BILLING_AUTOMATED_LATE,           // Atrasado auto
  process.env.BILLING_AUTOMATED_PAID,           // Pagado auto
].filter(Boolean));

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

// ── Rate-limited API helpers ──
let lastCall = 0;
async function rateLimit() {
  const now = Date.now();
  const diff = now - lastCall;
  if (diff < 110) await sleep(110 - diff); // ~9 calls/sec
  lastCall = Date.now();
}

// ── HubSpot data fetching ──

const DEAL_PROPS = [
  'dealname', 'dealstage', 'deal_currency_code', 'hubspot_owner_id',
  'pais_operativo', 'unidad_de_negocio', 'pipeline',
  'facturacion_activa', 'closedate', 'hs_deal_stage_probability',
  'deal_py_origen_id', 'deal_uy_mirror_id', 'es_mirror_de_py',
];

const LI_PROPS = [
  'name', 'description', 'price', 'hs_cost_of_goods_sold', 'quantity', 'amount',
  'discount', 'hs_discount_percentage',
  'hs_margin',                          // FIX #3: agregado
  'facturacion_activa', 'facturacion_automatica',
  'recurringbillingfrequency', 'hs_recurring_billing_frequency',
  'hs_recurring_billing_start_date', 'fecha_inicio_de_facturacion',
  'fecha_vencimiento_contrato', 'billing_anchor_date',
  'hs_recurring_billing_number_of_payments', 'number_of_payments',
  'hs_product_id',
  'line_item_key', 'of_line_item_key',
  'servicio', 'subrubro', 'reventa', 'porcentaje_margen',
  'uy', 'pais_operativo',
  'hubspot_owner_id',
];

const TICKET_PROPS = [
  'of_ticket_key', 'of_line_item_key', 'of_deal_id', 'of_estado',
  'fecha_resolucion_esperada', 'hs_pipeline_stage', 'hs_pipeline',
  'of_producto_nombres', 'of_descripcion_producto',
  'of_subrubro', 'reventa', 'of_costo', 'of_margen',
  'monto_a_facturar', 'numero_de_factura',
  'of_pais_operativo', 'of_moneda',
];

// Fetch all deals (paginated search)
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

// Fetch line items for a deal
async function fetchLineItems(dealId) {
  await rateLimit();
  let liIds = [];
  try {
    const resp = await hubspot.crm.associations.v4.basicApi.getPage('deals', String(dealId), 'line_items', 100);
    liIds = (resp.results || []).map(r => String(r.toObjectId));
  } catch { return []; }

  if (!liIds.length) return [];

  // Batch read (max 100)
  const batches = [];
  for (let i = 0; i < liIds.length; i += 100) {
    batches.push(liIds.slice(i, i + 100));
  }

  const items = [];
  for (const batch of batches) {
    await rateLimit();
    const resp = await hubspot.crm.lineItems.batchApi.read({
      inputs: batch.map(id => ({ id })),
      properties: LI_PROPS,
    });
    items.push(...(resp?.results || []));
  }
  return items;
}

// Fetch companies associated to deal WITH association types
async function fetchDealCompaniesWithTypes(dealId) {
  await rateLimit();
  try {
    const resp = await hubspot.crm.associations.v4.basicApi.getPage('deals', String(dealId), 'companies', 100);
    // resp.results = [{ toObjectId, associationTypes: [{ typeId, label, category }] }]
    return resp.results || [];
  } catch { return []; }
}

// Fetch company by ID
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

// FIX #1: fetchOwnerName vía hubspot.apiRequest (raw HTTP) en lugar del SDK defaultApi
const ownerCache = new Map();
async function fetchOwnerName(ownerId) {
  if (!ownerId) return '';
  if (ownerCache.has(ownerId)) return ownerCache.get(ownerId);
  await rateLimit();
  try {
    const resp = await hubspot.apiRequest({
      method: 'GET',
      path: `/crm/v3/owners/${ownerId}`,
    });
    const data = await resp.json();
    const name = `${data.firstName || ''} ${data.lastName || ''}`.trim() || data.email || '';
    ownerCache.set(ownerId, name);
    return name;
  } catch {
    ownerCache.set(ownerId, '');
    return '';
  }
}

// Fetch product name by product ID
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

// Fetch tickets for a deal (by of_deal_id search)
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

// ── Resolve companies for deal ──
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

    // Fallback: si no detectó tipo, la primera es primary
    if (!primaryId && types.length === 0) primaryId = cId;
  }

  // Si no hubo primary explícito, tomar la primera company
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

// ── Stage label resolver ──
const stageCache = new Map();
async function resolveStageLabel(pipelineId, stageId) {
  const key = `${pipelineId}::${stageId}`;
  if (stageCache.has(key)) return stageCache.get(key);

  if (!stageCache.has(`__pipelines_loaded__`)) {
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
    'Estado': '', // se llena después con stage label
    'Probabilidad': safeNum(dp.hs_deal_stage_probability),
    'Fecha de Cierre': ymd(dp.closedate),
    'Moneda': safe(dp.deal_currency_code),
  };
}

function buildLineItemRow(li, dealBase, deal, productName) {
  const lp = li.properties || {};
  const freq = safe(lp.recurringbillingfrequency || lp.hs_recurring_billing_frequency);
  const fechaInicio = ymd(lp.hs_recurring_billing_start_date || lp.fecha_inicio_de_facturacion);
  const fechaVenc = ymd(lp.fecha_vencimiento_contrato);
  const ancla = ymd(lp.billing_anchor_date);
  const esAuto = safe(lp.facturacion_automatica).toLowerCase() === 'true';
  const incluyeUY = safe(lp.uy).toLowerCase() === 'true';

  const fechaFact = fechaInicio;
  const { mes, anio } = mesAnio(fechaFact);

  // FIX #3: Margen % calculado desde hs_margin / amount
  const margenPct = safeNum(lp.amount) > 0
    ? Math.round((safeNum(lp.hs_margin) / safeNum(lp.amount)) * 10000) / 100
    : null;

  return {
    ...dealBase,
    'Área de Negocio': productName || safe(lp.name),
    'Descripción': safe(lp.description),
    'Incluye UY': incluyeUY ? 'SI' : 'NO',
    'Fecha Fact Estimada': fechaFact,
    'Mes': mes,
    'Año': anio,
    'Monto': safeNum(lp.amount),
    'Costo': safeNum(lp.hs_cost_of_goods_sold) != null
      ? safeNum(lp.hs_cost_of_goods_sold) * (safeNum(lp.quantity) || 1)
      : null,
    'Margen %': margenPct,
    'Repetitivo': esRepetitivo(freq),
    'Reventa': safe(lp.reventa).toLowerCase() === 'true' ? 'SI' : 'NO',
    'Sub Rubro': safe(lp.subrubro),
    'N Factura': '',
    'Fuente': 'Line Item',
    'Facturación Automática': esAuto ? 'SI' : 'NO',
    'Fecha Inicio Contrato': fechaInicio,
    'Frecuencia': freq,
    'Fecha Fin Contrato': fechaVenc,
    'Fecha Ancla': ancla !== fechaInicio ? ancla : '',
    'Renovación Automática': esRenovacionAutomatica(fechaVenc),
  };
}

function buildTicketRow(ticket, dealBase, lineItemMap, productNameMap) {
  const tp = ticket.properties || {};
  const lik = safe(tp.of_line_item_key);
  const li = lineItemMap.get(lik);
  const lp = li?.properties || {};

  const fechaFact = ymd(tp.fecha_resolucion_esperada);
  const { mes, anio } = mesAnio(fechaFact);

  const freq = safe(lp?.recurringbillingfrequency || lp?.hs_recurring_billing_frequency || '');
  const esAuto = safe(lp?.facturacion_automatica || '').toLowerCase() === 'true';
  const fechaInicio = ymd(lp?.hs_recurring_billing_start_date || lp?.fecha_inicio_de_facturacion || '');
  const fechaVenc = ymd(lp?.fecha_vencimiento_contrato || '');
  const ancla = ymd(lp?.billing_anchor_date || '');
  const incluyeUY = safe(lp?.uy || '').toLowerCase() === 'true';

  return {
    ...dealBase,
    'Área de Negocio': productNameMap.get(safe(lp?.hs_product_id)) || safe(tp.of_producto_nombres || lp?.name || ''),
    'Descripción': safe(tp.of_descripcion_producto || lp?.description || ''),
    'Incluye UY': incluyeUY ? 'SI' : 'NO',
    'Fecha Fact Estimada': fechaFact,
    'Mes': mes,
    'Año': anio,
    'Monto': safeNum(tp.monto_a_facturar),
    'Costo': safeNum(tp.of_costo),
    'Margen %': safeNum(tp.of_margen),
    'Repetitivo': esRepetitivo(freq),
    'Reventa': safe(tp.reventa || lp?.reventa || '').toLowerCase() === 'true' ? 'SI' : 'NO',
    'Sub Rubro': safe(tp.of_subrubro || lp?.subrubro || ''),
    'N Factura': safe(tp.numero_de_factura),
    'Fuente': 'Ticket',
    'Facturación Automática': esAuto ? 'SI' : 'NO',
    'Fecha Inicio Contrato': fechaInicio,
    'Frecuencia': freq,
    'Fecha Fin Contrato': fechaVenc,
    'Fecha Ancla': ancla !== fechaInicio ? ancla : '',
    'Renovación Automática': esRenovacionAutomatica(fechaVenc),
  };
}

// ── Filtrar tickets válidos (no DUPLICADO_UI, no DEPRECATED, no CANCELLED) ──
function isValidTicket(ticket) {
  const tp = ticket.properties || {};
  const estado = safe(tp.of_estado).toUpperCase();
  if (['DUPLICADO_UI', 'DEPRECATED'].includes(estado)) return false;
  return true;
}

// ── MAIN ──
async function main() {
  const args = process.argv.slice(2);
  const pipelineIdx = args.indexOf('--pipeline');
  const pipelineFilter = pipelineIdx >= 0 ? args[pipelineIdx + 1] : null;

  console.log('=== Exportando reporte consolidado ===');
  if (pipelineFilter) console.log(`  Pipeline filter: ${pipelineFilter}`);

  // 1) Fetch all deals
  console.log('\n1. Descargando deals...');
  const allDeals = await fetchAllDeals(pipelineFilter);
  console.log(`   Total deals: ${allDeals.length}`);

  // 2) Pre-load pipelines
  await resolveStageLabel('', '');

  // 3) Process each deal
  const pipelineRows  = []; // prob < 85%
  const forecastRows  = []; // prob >= 85%, stages forecast + próximos a facturar
  const listoRows     = []; // prob >= 85%, stages Listo para Facturar
  const facturadoRows = []; // prob >= 85%, stages post-emisión o con numero_de_factura

  for (let i = 0; i < allDeals.length; i++) {
    const deal = allDeals[i];
    const dp = deal.properties || {};
    const dealId = deal.id;
    const prob = safeNum(dp.hs_deal_stage_probability) ?? 0;

    if ((i + 1) % 10 === 0 || i === 0) {
      console.log(`\n  Procesando deal ${i + 1}/${allDeals.length}: ${safe(dp.dealname)} (prob: ${prob}%)`);
    }

    // Resolve stage label
    const stageLabel = await resolveStageLabel(safe(dp.pipeline), safe(dp.dealstage));

    // Resolve companies
    const companies = await resolveDealCompanies(dealId);

    // Resolve owner
    const ownerName = await fetchOwnerName(safe(dp.hubspot_owner_id));

    // Build deal base
    const dealBase = buildDealBase(deal, companies, ownerName);
    dealBase['Estado'] = stageLabel;

    // Fetch line items
    const lineItems = await fetchLineItems(dealId);

    // Build line item key → line item map
    const liKeyMap = new Map();
    for (const li of lineItems) {
      const lp = li.properties || {};
      const lik = safe(lp.line_item_key || lp.of_line_item_key);
      if (lik) liKeyMap.set(lik, li);
    }

    // Resolve product names para todos los line items del deal
    const productNameMap = new Map();
    await Promise.all(lineItems.map(async (li) => {
      const productId = safe(li.properties?.hs_product_id);
      if (productId) {
        const name = await fetchProductName(productId);
        productNameMap.set(productId, name);
      }
    }));

    if (prob < PROB_CORTE) {
      // ── PIPELINE: filas desde line items ──
      for (const li of lineItems) {
        const productName = productNameMap.get(safe(li.properties?.hs_product_id)) || '';
        pipelineRows.push(buildLineItemRow(li, dealBase, deal, productName));
      }
    } else {
      // ── >= 85%: una fila por ticket (automáticos y manuales) ──
      const tickets = await fetchTicketsForDeal(dealId);
      const validTickets = tickets.filter(isValidTicket);

      for (const ticket of validTickets) {
        const tp = ticket.properties || {};
        const row = buildTicketRow(ticket, dealBase, liKeyMap, productNameMap);
        const stage = safe(tp.hs_pipeline_stage);
        const tieneFactura = safe(tp.numero_de_factura) !== '';

        if (tieneFactura || INVOICED_STAGES.has(stage)) {
          facturadoRows.push(row);
        } else if (LISTO_STAGES.has(stage)) {
          listoRows.push(row);
        } else {
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
    { header: 'Estado', key: 'Estado', width: 22 },
    { header: 'Probabilidad', key: 'Probabilidad', width: 13 },
    { header: 'Fecha de Cierre', key: 'Fecha de Cierre', width: 15 },
    { header: 'Moneda', key: 'Moneda', width: 10 },
    { header: 'Área de Negocio', key: 'Área de Negocio', width: 30 },
    { header: 'Descripción', key: 'Descripción', width: 40 },
    { header: 'Fecha Fact Estimada', key: 'Fecha Fact Estimada', width: 18 },
    { header: 'Mes', key: 'Mes', width: 8 },
    { header: 'Año', key: 'Año', width: 8 },
    { header: 'Monto', key: 'Monto', width: 15 },
    { header: 'Costo', key: 'Costo', width: 15 },
    { header: 'Margen %', key: 'Margen %', width: 12 },
    { header: 'Repetitivo', key: 'Repetitivo', width: 12 },
    { header: 'Reventa', key: 'Reventa', width: 10 },
    { header: 'Sub Rubro', key: 'Sub Rubro', width: 20 },
    { header: 'N Factura', key: 'N Factura', width: 15 },
    { header: 'Fuente', key: 'Fuente', width: 12 },
    { header: 'Facturación Automática', key: 'Facturación Automática', width: 20 },
    { header: 'Fecha Inicio Contrato', key: 'Fecha Inicio Contrato', width: 18 },
    { header: 'Frecuencia', key: 'Frecuencia', width: 15 },
    { header: 'Fecha Fin Contrato', key: 'Fecha Fin Contrato', width: 18 },
    { header: 'Fecha Ancla', key: 'Fecha Ancla', width: 15 },
    { header: 'Renovación Automática', key: 'Renovación Automática', width: 20 },
  ];

  function addSheet(name, rows) {
    const ws = wb.addWorksheet(name);
    ws.columns = COLUMNS;

    // Header style
    ws.getRow(1).eachCell(cell => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2F5496' } };
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    });
    ws.getRow(1).height = 30;

    for (const row of rows) {
      ws.addRow(row);
    }

    // Auto-filter
    ws.autoFilter = { from: 'A1', to: `${String.fromCharCode(64 + COLUMNS.length)}1` };

    // Freeze header
    ws.views = [{ state: 'frozen', ySplit: 1 }];
  }

  addSheet('Pipeline (< 85%)', pipelineRows);
  addSheet('Forecast (pendiente)', forecastRows);
  addSheet('Listo para Facturar', listoRows);
  addSheet('Facturado', facturadoRows);

  const outPath = `reporte_consolidado_${new Date().toISOString().slice(0, 10)}.xlsx`;
  await wb.xlsx.writeFile(outPath);

  console.log(`\n✅ Reporte generado: ${outPath}`);
  console.log(`   Pipeline          : ${pipelineRows.length} filas`);
  console.log(`   Forecast          : ${forecastRows.length} filas`);
  console.log(`   Listo para Facturar: ${listoRows.length} filas`);
  console.log(`   Facturado         : ${facturadoRows.length} filas`);
}

main().catch(err => {
  console.error('Error fatal:', err);
  process.exit(1);
});
