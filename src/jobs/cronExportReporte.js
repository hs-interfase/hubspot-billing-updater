// src/jobs/cronExportReporte.js
//
// Cron de exportación de reporte consolidado.
// Genera el xlsx, lo guarda en PostgreSQL (sobreescribiendo cada día),
// y opcionalmente lo envía por POST a una URL externa (EXPORT_TARGET_URL).
//
// Railway: comando  = node src/jobs/cronExportReporte.js
//          schedule = 0 8 * * 1-5   (5 AM MVD lunes a viernes)
//
// CLI:     node src/jobs/cronExportReporte.js              → genera y guarda
//          node src/jobs/cronExportReporte.js --dry         → genera pero no guarda en DB ni envía
//          node src/jobs/cronExportReporte.js --local-only  → genera, guarda en DB, no envía POST

import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import ExcelJS from 'exceljs';
import axios from 'axios';
import { hubspotClient } from '../hubspotClient.js';
import logger from '../../lib/logger.js';
import { initExportSnapshotsTable, saveExportSnapshot } from '../db-export.js';
import { setCronState } from '../db.js';
import pool from '../db.js';

// ── Config ──────────────────────────────────────────────────────────────────

const EXPORT_TARGET_URL = process.env.EXPORT_TARGET_URL || '';
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 5_000;

// Probabilidad de corte para separar hojas
const PROB_CORTE = 0.85;

// Association type IDs (deal → company)
const ASSOC_PRIMARY_COMPANY = 5;
const ASSOC_EMPRESA_FACTURA = 9;
const ASSOC_PARTNER = 1;

// Stage sets para clasificación de tickets
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

// ── Helpers ─────────────────────────────────────────────────────────────────

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
  return ymd(fechaVenc).startsWith('2099') ? 'SI' : 'NO';
}

function esRepetitivo(freq) {
  const f = safe(freq).toLowerCase();
  return f && !['unico', 'único', 'one_time', ''].includes(f) ? 'SI' : 'NO';
}

// ── TC helpers ──────────────────────────────────────────────────────────────

/**
 * Obtiene el último TC disponible en exchange_rates (para filas no facturadas).
 * Devuelve { uyu_usd, pyg_usd, eur_usd, date } o null.
 */
async function getLatestExchangeRate() {
  try {
    const { rows } = await pool.query(
      `SELECT date, uyu_usd, eur_usd, pyg_usd
       FROM exchange_rates
       ORDER BY date DESC
       LIMIT 1`
    );
    if (!rows.length) return null;
    const r = rows[0];
    return {
      uyu_usd: parseFloat(r.uyu_usd) || null,
      eur_usd: parseFloat(r.eur_usd) || null,
      pyg_usd: parseFloat(r.pyg_usd) || null,
      date: r.date,
    };
  } catch (err) {
    logger.warn({ err: err.message }, '[export] No se pudo obtener TC de exchange_rates');
    return null;
  }
}

/**
 * Convierte un monto a USD dado la moneda y el TC.
 * TC = unidades de moneda local por 1 USD (ej: 42.5 UYU = 1 USD).
 * Si moneda es USD, devuelve el monto tal cual.
 */
function convertToUSD(monto, moneda, tc) {
  if (monto == null || monto === '') return null;
  const m = parseFloat(monto);
  if (isNaN(m)) return null;

  const cur = safe(moneda).toUpperCase();
  if (cur === 'USD') return m;
  if (!tc || tc <= 0) return null;

  return Math.round((m / tc) * 100) / 100;
}

/**
 * Dado la moneda del deal y el objeto de rates, devuelve el TC
 * normalizado como "unidades de moneda local por 1 USD".
 *
 * DB almacena:
 *   uyu_usd = UYU por 1 USD (ej: 42.5)  → ya está bien
 *   pyg_usd = PYG por 1 USD (ej: 7500)  → ya está bien
 *   eur_usd = USD por 1 EUR (ej: 0.92)  → HAY QUE INVERTIR
 *
 * Invertimos EUR para que convertToUSD siempre haga monto / tc.
 */
function getTCForCurrency(moneda, rates) {
  if (!rates) return null;
  const cur = safe(moneda).toUpperCase();
  if (cur === 'USD') return 1;
  if (cur === 'UYU') return rates.uyu_usd;
  if (cur === 'PYG') return rates.pyg_usd;
  if (cur === 'EUR') {
    // eur_usd en DB = ~0.92 (USD que vale 1 EUR)
    // Necesitamos EUR por 1 USD = 1 / 0.92 ≈ 1.087
    return rates.eur_usd > 0 ? Math.round((1 / rates.eur_usd) * 1000) / 1000 : null;
  }
  return null;
}

// ── Rate limiting ───────────────────────────────────────────────────────────
let lastCall = 0;
async function rateLimit() {
  const now = Date.now();
  const diff = now - lastCall;
  if (diff < 110) await sleep(110 - diff);
  lastCall = Date.now();
}

// ── HubSpot data fetching ───────────────────────────────────────────────────

const DEAL_PROPS = [
  'dealname', 'dealstage', 'deal_currency_code', 'hubspot_owner_id',
  'pais_operativo', 'unidad_de_negocio', 'pipeline',
  'facturacion_activa', 'closedate', 'hs_deal_stage_probability',
  'deal_py_origen_id', 'deal_uy_mirror_id', 'es_mirror_de_py',
];

const LI_PROPS = [
  'name', 'description', 'price', 'hs_cost_of_goods_sold', 'quantity', 'amount',
  'discount', 'hs_discount_percentage', 'hs_margin',
  'facturacion_activa', 'facturacion_automatica',
  'recurringbillingfrequency', 'hs_recurring_billing_frequency',
  'hs_recurring_billing_start_date', 'fecha_inicio_de_facturacion',
  'fecha_vencimiento_contrato', 'billing_anchor_date',
  'hs_recurring_billing_number_of_payments', 'number_of_payments',
  'hs_product_id', 'line_item_key', 'of_line_item_key',
  'servicio', 'subrubro', 'reventa', 'porcentaje_margen',
  'uy', 'pais_operativo', 'hubspot_owner_id',
];

const TICKET_PROPS = [
  'of_ticket_key', 'of_line_item_key', 'of_deal_id', 'of_estado',
  'fecha_resolucion_esperada', 'hs_pipeline_stage', 'hs_pipeline',
  'of_producto_nombres', 'of_descripcion_producto',
  'of_rubro', 'of_subrubro', 'reventa', 'of_costo', 'of_margen',
  'total_real_a_facturar', 'numero_de_factura', 'dolar',
  'of_pais_operativo', 'of_moneda',
];

async function fetchAllDeals(pipelineFilter) {
  const deals = [];
  let after;
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
    const resp = await hubspotClient.crm.deals.searchApi.doSearch(body);
    const results = resp?.results || [];
    deals.push(...results);
    after = resp?.paging?.next?.after;
    if (!after || results.length === 0) break;
  }
  return deals;
}

async function fetchLineItems(dealId) {
  await rateLimit();
  let liIds = [];
  try {
    const resp = await hubspotClient.crm.associations.v4.basicApi.getPage('deals', String(dealId), 'line_items', 100);
    liIds = (resp.results || []).map(r => String(r.toObjectId));
  } catch { return []; }
  if (!liIds.length) return [];

  const items = [];
  for (let i = 0; i < liIds.length; i += 100) {
    await rateLimit();
    const resp = await hubspotClient.crm.lineItems.batchApi.read({
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
    const resp = await hubspotClient.crm.associations.v4.basicApi.getPage('deals', String(dealId), 'companies', 100);
    return resp.results || [];
  } catch { return []; }
}

const companyCache = new Map();
async function fetchCompany(companyId) {
  if (companyCache.has(companyId)) return companyCache.get(companyId);
  await rateLimit();
  try {
    const c = await hubspotClient.crm.companies.basicApi.getById(String(companyId), ['name']);
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
    const resp = await hubspotClient.apiRequest({ method: 'GET', path: `/crm/v3/owners/${ownerId}` });
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
    const p = await hubspotClient.crm.products.basicApi.getById(String(productId), ['name']);
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
  let after;
  while (true) {
    await rateLimit();
    const body = {
      filterGroups: [{ filters: [{ propertyName: 'of_deal_id', operator: 'EQ', value: String(dealId) }] }],
      properties: TICKET_PROPS,
      limit: 100,
      ...(after ? { after } : {}),
    };
    const resp = await hubspotClient.crm.tickets.searchApi.doSearch(body);
    const results = resp?.results || [];
    tickets.push(...results);
    after = resp?.paging?.next?.after;
    if (!after || results.length === 0) break;
  }
  return tickets;
}

// ── Resolve helpers ─────────────────────────────────────────────────────────

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
      const pipelines = await hubspotClient.crm.pipelines.pipelinesApi.getAll('deals');
      for (const p of pipelines?.results || []) {
        for (const s of p.stages || []) {
          stageCache.set(`${p.id}::${s.id}`, s.label);
        }
      }
    } catch (e) {
      logger.warn({ err: e.message }, '[export] No se pudieron cargar pipelines');
    }
    stageCache.set('__pipelines_loaded__', true);
  }
  return stageCache.get(key) || stageId;
}

// ── Build rows ──────────────────────────────────────────────────────────────

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
    'Estado': '',
    'Probabilidad': safeNum(dp.hs_deal_stage_probability),
    'Fecha de Cierre': ymd(dp.closedate),
    'Moneda': safe(dp.deal_currency_code),
  };
}

function buildLineItemRow(li, dealBase, deal, productName, latestRates) {
  const lp = li.properties || {};
  const freq = safe(lp.recurringbillingfrequency || lp.hs_recurring_billing_frequency);
  const fechaInicio = ymd(lp.hs_recurring_billing_start_date || lp.fecha_inicio_de_facturacion);
  const fechaVenc = ymd(lp.fecha_vencimiento_contrato);
  const ancla = ymd(lp.billing_anchor_date);
  const esAuto = safe(lp.facturacion_automatica).toLowerCase() === 'true';
  const incluyeUY = safe(lp.uy).toLowerCase() === 'true';
  const fechaFact = fechaInicio;
  const { mes, anio } = mesAnio(fechaFact);

  const monto = safeNum(lp.amount);
  const costo = safeNum(lp.hs_cost_of_goods_sold) != null
    ? safeNum(lp.hs_cost_of_goods_sold) * (safeNum(lp.quantity) || 1)
    : null;
  const margenBruto = (monto != null && costo != null) ? monto - costo : null;
  const margenPct = monto > 0
    ? Math.round((safeNum(lp.hs_margin) / monto) * 10000) / 100
    : null;

  // TC: último cierre para line items (no facturados)
  const moneda = dealBase['Moneda'];
  const tc = getTCForCurrency(moneda, latestRates);

  return {
    ...dealBase,
    'Rubro': safe(lp.servicio),
    'Área de Negocio': productName || safe(lp.name),
    'Descripción': safe(lp.description),
    'Incluye UY': incluyeUY ? 'SI' : 'NO',
    'Fecha Fact Estimada': fechaFact,
    'Mes': mes, 'Año': anio,
    'Monto': monto,
    'Costo': costo,
    'Margen Bruto': margenBruto,
    'Margen %': margenPct,
    'TC Aplicado': tc,
    'Monto USD': convertToUSD(monto, moneda, tc),
    'Costo USD': convertToUSD(costo, moneda, tc),
    'Margen Bruto USD': convertToUSD(margenBruto, moneda, tc),
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

function buildTicketRow(ticket, dealBase, lineItemMap, productNameMap, latestRates) {
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

  const monto = safeNum(tp.total_real_a_facturar) ?? safeNum(tp.monto_a_facturar);
  const costo = safeNum(tp.of_costo);
  const margenBruto = (monto != null && costo != null) ? monto - costo : null;

  // TC: si tiene numero_de_factura → usar tp.dolar (TC de Nodum).
  //     si no → usar último cierre de exchange_rates.
  const moneda = dealBase['Moneda'];
  const tieneFactura = safe(tp.numero_de_factura) !== '';
  const tcNodum = safeNum(tp.dolar);
  const monedaUpper = safe(moneda).toUpperCase();
  const tc = monedaUpper === 'USD'
  ? 1
  : (tieneFactura && tcNodum > 0)
    ? tcNodum
    : getTCForCurrency(moneda, latestRates);

  return {
    ...dealBase,
    'Rubro': safe(tp.of_rubro || lp?.servicio || ''),
    'Área de Negocio': productNameMap.get(safe(lp?.hs_product_id)) || safe(tp.of_producto_nombres || lp?.name || ''),
    'Descripción': safe(tp.of_descripcion_producto || lp?.description || ''),
    'Incluye UY': incluyeUY ? 'SI' : 'NO',
    'Fecha Fact Estimada': fechaFact,
    'Mes': mes, 'Año': anio,
    'Monto': monto,
    'Costo': costo,
    'Margen Bruto': margenBruto,
    'Margen %': safeNum(tp.of_margen),
    'TC Aplicado': tc,
    'Monto USD': convertToUSD(monto, moneda, tc),
    'Costo USD': convertToUSD(costo, moneda, tc),
    'Margen Bruto USD': convertToUSD(margenBruto, moneda, tc),
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

function isValidTicket(ticket) {
  const tp = ticket.properties || {};
  const estado = safe(tp.of_estado).toUpperCase();
  return !['DUPLICADO_UI', 'DEPRECATED'].includes(estado);
}

// ── Excel builder ───────────────────────────────────────────────────────────

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
  { header: 'Rubro', key: 'Rubro', width: 25 },
  { header: 'Área de Negocio', key: 'Área de Negocio', width: 30 },
  { header: 'Descripción', key: 'Descripción', width: 40 },
  { header: 'Fecha Fact Estimada', key: 'Fecha Fact Estimada', width: 18 },
  { header: 'Mes', key: 'Mes', width: 8 },
  { header: 'Año', key: 'Año', width: 8 },
  { header: 'Monto', key: 'Monto', width: 15 },
  { header: 'Costo', key: 'Costo', width: 15 },
  { header: 'Margen Bruto', key: 'Margen Bruto', width: 15 },
  { header: 'Margen %', key: 'Margen %', width: 12 },
  { header: 'TC Aplicado', key: 'TC Aplicado', width: 12 },
  { header: 'Monto USD', key: 'Monto USD', width: 15 },
  { header: 'Costo USD', key: 'Costo USD', width: 15 },
  { header: 'Margen Bruto USD', key: 'Margen Bruto USD', width: 15 },
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

function addSheet(wb, name, rows) {
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

  ws.autoFilter = { from: 'A1', to: `${String.fromCharCode(64 + COLUMNS.length)}1` };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
}

// ── Main export function ────────────────────────────────────────────────────

/**
 * Genera el reporte consolidado y devuelve el buffer xlsx + metadata.
 *
 * @param {Object} [opts]
 * @param {string} [opts.pipelineFilter] - Filtrar por pipeline ID
 * @returns {Promise<{ buffer: Buffer, filename: string, rowCounts: Object }>}
 */
export async function generateExportReporte({ pipelineFilter = null } = {}) {
  const start = Date.now();
  logger.info({ pipelineFilter }, '[export] Iniciando generación de reporte');

  // 0) Obtener último TC disponible para filas no facturadas
  const latestRates = await getLatestExchangeRate();
  if (latestRates) {
    logger.info({ date: latestRates.date, uyu_usd: latestRates.uyu_usd, pyg_usd: latestRates.pyg_usd }, '[export] TC último cierre cargado');
  } else {
    logger.warn('[export] No se encontró TC en exchange_rates — columnas USD quedarán vacías');
  }

  // 1) Fetch all deals
  const allDeals = await fetchAllDeals(pipelineFilter);
  logger.info({ totalDeals: allDeals.length }, '[export] Deals descargados');

  // 2) Pre-load pipelines
  await resolveStageLabel('', '');

  // 3) Process each deal
  const pipelineRows = [];
  const forecastRows = [];
  const listoRows = [];
  const facturadoRows = [];

  for (let i = 0; i < allDeals.length; i++) {
    const deal = allDeals[i];
    const dp = deal.properties || {};
    const dealId = deal.id;
    const prob = safeNum(dp.hs_deal_stage_probability) ?? 0;

    if ((i + 1) % 50 === 0) {
      logger.info({ progress: `${i + 1}/${allDeals.length}` }, '[export] Procesando deals...');
    }

    const stageLabel = await resolveStageLabel(safe(dp.pipeline), safe(dp.dealstage));
    const companies = await resolveDealCompanies(dealId);
    const ownerName = await fetchOwnerName(safe(dp.hubspot_owner_id));

    const dealBase = buildDealBase(deal, companies, ownerName);
    dealBase['Estado'] = stageLabel;

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
      // Pipeline: line items directos
      for (const li of lineItems) {
        const productName = productNameMap.get(safe(li.properties?.hs_product_id)) || '';
        pipelineRows.push(buildLineItemRow(li, dealBase, deal, productName, latestRates));
      }
    } else {
      // Ganado: clasificar tickets
      const tickets = await fetchTicketsForDeal(dealId);
      const validTickets = tickets.filter(isValidTicket);

      for (const ticket of validTickets) {
        const tp = ticket.properties || {};
        const row = buildTicketRow(ticket, dealBase, liKeyMap, productNameMap, latestRates);
        const tieneFactura = safe(tp.numero_de_factura) !== '';

        if (tieneFactura) {
          // Facturado = tiene número de factura de Nodum
          facturadoRows.push(row);
        } else if (LISTO_STAGES.has(safe(tp.hs_pipeline_stage)) || INVOICED_STAGES.has(safe(tp.hs_pipeline_stage))) {
          // Listo para facturar = stages de "ready" + stages avanzados sin N° factura
          listoRows.push(row);
        } else {
          // Forecast = todo lo demás (pendiente)
          forecastRows.push(row);
        }
      }
    }
  }

  // 4) Build Excel
  const wb = new ExcelJS.Workbook();
  addSheet(wb, 'Pipeline (< 85%)', pipelineRows);
  addSheet(wb, 'Forecast (pendiente)', forecastRows);
  addSheet(wb, 'Listo para Facturar', listoRows);
  addSheet(wb, 'Facturado', facturadoRows);

  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  const filename = `reporte_consolidado_${new Date().toISOString().slice(0, 10)}.xlsx`;
  const rowCounts = {
    pipeline: pipelineRows.length,
    forecast: forecastRows.length,
    listo: listoRows.length,
    facturado: facturadoRows.length,
  };

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  logger.info({ filename, rowCounts, elapsedSec: elapsed }, '[export] Reporte generado');

  return { buffer, filename, rowCounts };
}

// ── POST to external URL with retry ─────────────────────────────────────────

async function sendToExternalUrl(buffer, filename) {
  if (!EXPORT_TARGET_URL) return { sent: false, reason: 'EXPORT_TARGET_URL not configured' };

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const FormData = (await import('form-data')).default;
      const form = new FormData();
      form.append('file', buffer, { filename, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });

      await axios.post(EXPORT_TARGET_URL, form, {
        headers: form.getHeaders(),
        timeout: 60_000,
        maxContentLength: 50 * 1024 * 1024,
      });

      logger.info({ url: EXPORT_TARGET_URL, attempt }, '[export] Enviado a URL externa OK');
      return { sent: true };
    } catch (err) {
      logger.warn({ url: EXPORT_TARGET_URL, attempt, err: err.message }, '[export] Error enviando a URL externa');
      if (attempt < MAX_RETRIES) {
        const delay = RETRY_BASE_MS * Math.pow(2, attempt - 1);
        await sleep(delay);
      }
    }
  }

  logger.error({ url: EXPORT_TARGET_URL }, '[export] Falló envío a URL externa tras todos los reintentos');
  return { sent: false, reason: 'max_retries_exceeded' };
}

// ── Cron runner ─────────────────────────────────────────────────────────────

export async function runExportCron({ dry = false, localOnly = false } = {}) {
  const result = { success: false };

  try {
    const { buffer, filename, rowCounts } = await generateExportReporte();
    result.filename = filename;
    result.rowCounts = rowCounts;
    result.sizeKB = Math.round(buffer.length / 1024);

    if (dry) {
      logger.info({ filename, rowCounts, sizeKB: result.sizeKB }, '[export] DRY RUN — no se guarda ni envía');
      result.success = true;
      result.dry = true;
      return result;
    }

    // Guardar en DB
    await saveExportSnapshot({ filename, xlsxBuffer: buffer, rowCounts });
    await setCronState('export_reporte_last_run', new Date().toISOString());
    result.savedToDB = true;

    // Enviar a URL externa
    if (!localOnly) {
      const sendResult = await sendToExternalUrl(buffer, filename);
      result.externalSend = sendResult;
    } else {
      result.externalSend = { sent: false, reason: 'local_only_mode' };
    }

    result.success = true;
  } catch (err) {
    logger.error({ err: err.message, stack: err.stack }, '[export] Error en cron de exportación');
    result.error = err.message;
  }

  return result;
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const isDirectRun =
  typeof process.argv[1] === 'string' &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry');
  const localOnly = args.includes('--local-only');

  await initExportSnapshotsTable();
  const result = await runExportCron({ dry, localOnly });

  if (result.success) {
    logger.info({ result }, '[export] Cron completado OK');
  } else {
    logger.error({ result }, '[export] Cron completado con error');
    process.exitCode = 1;
  }
}