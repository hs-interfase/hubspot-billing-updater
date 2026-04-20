#!/usr/bin/env node
/**
 * auditDeals.mjs
 *
 * Auditoría masiva de deals: detecta anomalías en tickets por cada line item.
 * - Tickets de más o de menos respecto a lo esperado (pago único / plan fijo / auto-renew)
 * - Tickets sin of_line_item_key (huérfanos de LIK)
 * - Tickets sin of_deal_id (huérfanos de deal)
 * - Duplicados por fecha de facturación dentro de un LI
 *
 * Uso:
 *   node auditDeals.mjs                        # todos los deals
 *   node auditDeals.mjs --pipeline <ID>        # filtrar por pipeline
 *   node auditDeals.mjs --deal <ID>            # solo un deal
 *
 * Genera: audit_deals_YYYY-MM-DD.xlsx
 */

import 'dotenv/config';
import { Client } from '@hubspot/api-client';
import ExcelJS from 'exceljs';

// ─── Config ───────────────────────────────────────────────────────────────────

const TOKEN = process.env.HUBSPOT_PRIVATE_TOKEN;
if (!TOKEN) { console.error('❌ Falta HUBSPOT_PRIVATE_TOKEN'); process.exit(1); }

const hubspot = new Client({ accessToken: TOKEN });

const args = process.argv.slice(2);
const pipelineFilter = (() => { const i = args.indexOf('--pipeline'); return i !== -1 ? args[i + 1] : null; })();
const singleDealId   = (() => { const i = args.indexOf('--deal');     return i !== -1 ? args[i + 1] : null; })();

// ─── Rate limit ───────────────────────────────────────────────────────────────

let lastCall = 0;
async function rateLimit() {
  const now = Date.now();
  const diff = now - lastCall;
  if (diff < 120) await new Promise(r => setTimeout(r, 120 - diff));
  lastCall = Date.now();
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const safe  = v => (v ?? '').toString().trim();
const ymd   = v => safe(v).slice(0, 10);

// ─── Fecha / TZ ───────────────────────────────────────────────────────────────

function nowMontevideoYmd() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Montevideo' });
}
function toYmd(raw) {
  if (!raw) return '';
  const s = String(raw).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return s.slice(0, 10);
  const ms = Number(s);
  if (!Number.isNaN(ms) && ms > 0) return new Date(ms).toISOString().slice(0, 10);
  return '';
}
function parseLocalDate(raw) {
  const d = toYmd(raw);
  if (!d) return null;
  const [y, m, dd] = d.split('-').map(Number);
  return new Date(y, m - 1, dd);
}
function formatDateISO(d) {
  if (!d || !Number.isFinite(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function addInterval(d, interval) {
  if (!d || !interval) return null;
  const r = new Date(d.getTime());
  if (interval.months) r.setMonth(r.getMonth() + interval.months);
  if (interval.days)   r.setDate(r.getDate() + interval.days);
  return r;
}

// ─── Frecuencia → intervalo ───────────────────────────────────────────────────

function getInterval(freqRaw) {
  switch ((freqRaw ?? '').toString().trim().toLowerCase()) {
    case 'weekly':          return { months: 0, days: 7 };
    case 'biweekly':        return { months: 0, days: 14 };
    case 'monthly':         return { months: 1, days: 0 };
    case 'quarterly':       return { months: 3, days: 0 };
    case 'per_six_months':  return { months: 6, days: 0 };
    case 'annually':        return { months: 12, days: 0 };
    case 'per_two_years':   return { months: 24, days: 0 };
    case 'semanal':         return { months: 0, days: 7 };
    case 'quincenal':       return { months: 0, days: 14 };
    case 'mensual':         return { months: 1, days: 0 };
    case 'bimestral':       return { months: 2, days: 0 };
    case 'trimestral':      return { months: 3, days: 0 };
    case 'semestral':       return { months: 6, days: 0 };
    case 'anual':           return { months: 12, days: 0 };
    default:                return null;
  }
}

// ─── buildDesiredDates (misma lógica que auditDeal.mjs) ──────────────────────

function buildDesiredDates(li) {
  const p = li?.properties || {};
  const today = nowMontevideoYmd();

  const startYmd =
    toYmd(p.hs_recurring_billing_start_date) ||
    toYmd(p.fecha_inicio_de_facturacion) ||
    '';

  if (!startYmd) return { desiredCount: 0, dates: [], mode: 'sin_fecha_inicio' };

  const freqKey  = (p.recurringbillingfrequency || p.hs_recurring_billing_frequency || '').trim();
  const interval = freqKey ? getInterval(freqKey) : null;

  // Pago único
  if (!freqKey) return { desiredCount: 1, dates: [startYmd], mode: 'pago_unico' };
  if (!interval) return { desiredCount: 1, dates: [startYmd], mode: 'frecuencia_desconocida' };

  const termRaw    = p.hs_recurring_billing_number_of_payments ?? p.number_of_payments ?? null;
  const term       = termRaw ? parseInt(String(termRaw), 10) : null;
  const isAutoRenew =
    String(p.renovacion_automatica || '').toLowerCase() === 'true' ||
    !(term > 0);

  const hardMax       = 24;
  const pagosEmitidos = parseInt(String(p.pagos_emitidos || '0'), 10) || 0;

  let maxCount;
  if (!isAutoRenew && term > 0) {
    maxCount = Math.min(Math.max(0, term - pagosEmitidos), hardMax);
  } else {
    maxCount = hardMax;
  }

  if (maxCount === 0) return { desiredCount: 0, dates: [], mode: 'plan_fijo_completo' };

  const lastTicketedYmd = toYmd(p.last_ticketed_date);
  const anchorYmd       = toYmd(p.billing_anchor_date);
  const billingNextYmd  = toYmd(p.billing_next_date);

  // AUTO RENEW
  if (isAutoRenew) {
    let seriesStart = today;
    if (lastTicketedYmd) {
      const d0 = parseLocalDate(lastTicketedYmd);
      if (d0) { d0.setDate(d0.getDate() + 1); const p1 = formatDateISO(d0); if (p1 > seriesStart) seriesStart = p1; }
    }
    if (billingNextYmd && billingNextYmd > seriesStart) seriesStart = billingNextYmd;
    if ((anchorYmd || startYmd) > seriesStart) seriesStart = anchorYmd || startYmd;

    const startDate = parseLocalDate(seriesStart);
    if (!startDate) return { desiredCount: 0, dates: [], mode: 'auto_renew_sin_start' };

    const horizon = new Date(startDate.getTime());
    horizon.setFullYear(horizon.getFullYear() + 2);

    const dates = [];
    let d = new Date(startDate.getTime());
    while (dates.length < maxCount) {
      if (!d || !Number.isFinite(d.getTime()) || d > horizon) break;
      dates.push(formatDateISO(d));
      const next = addInterval(d, interval);
      if (!next || next.getTime() === d.getTime()) break;
      d = next;
    }
    return { desiredCount: dates.length, dates, mode: 'auto_renew', term: null, pagosEmitidos };
  }

  // PLAN FIJO
  const anchorEsManual = anchorYmd && anchorYmd !== startYmd;
  let floorYmd;
  if (anchorEsManual) {
    floorYmd = today;
    if (lastTicketedYmd) {
      const d0 = parseLocalDate(lastTicketedYmd);
      if (d0) { d0.setDate(d0.getDate() + 1); const p1 = formatDateISO(d0); if (p1 > floorYmd) floorYmd = p1; }
    }
  } else {
    floorYmd = lastTicketedYmd
      ? (() => { const d0 = parseLocalDate(lastTicketedYmd); d0.setDate(d0.getDate() + 1); return formatDateISO(d0); })()
      : startYmd;
  }

  const seriesStartYmd = anchorYmd || startYmd;
  const startDate = parseLocalDate(seriesStartYmd);
  if (!startDate) return { desiredCount: 0, dates: [], mode: 'plan_fijo_sin_start' };

  let d = new Date(startDate.getTime());
  let safety = 0;
  while (formatDateISO(d) < floorYmd) {
    const next = addInterval(d, interval);
    if (!next || !Number.isFinite(next.getTime()) || next.getTime() === d.getTime()) break;
    d = next;
    if (++safety > 1200) break;
  }

  const dates = [];
  while (dates.length < maxCount) {
    if (!d || !Number.isFinite(d.getTime())) break;
    dates.push(formatDateISO(d));
    const next = addInterval(d, interval);
    if (!next || !Number.isFinite(next.getTime()) || next.getTime() === d.getTime()) break;
    d = next;
  }

  return { desiredCount: dates.length, dates, mode: 'plan_fijo', term, pagosEmitidos, maxCount };
}

// ─── Stage sets ───────────────────────────────────────────────────────────────

const CANCELLED_STAGES = new Set([
  process.env.BILLING_TICKET_STAGE_CANCELLED,
  process.env.BILLING_AUTOMATED_CANCELLED,
].filter(Boolean));

const FORECAST_STAGES = new Set([
  process.env.BILLING_TICKET_STAGE_FORECAST_85,
  process.env.BILLING_TICKET_STAGE_FORECAST_95,
  process.env.BILLING_AUTOMATED_FORECAST_85,
  process.env.BILLING_AUTOMATED_FORECAST_95,
].filter(Boolean));

const isCancelled = t => CANCELLED_STAGES.has(safe(t?.properties?.hs_pipeline_stage));
const isForecast  = t => FORECAST_STAGES.has(safe(t?.properties?.hs_pipeline_stage));

// ─── Props ────────────────────────────────────────────────────────────────────

const DEAL_PROPS = [
  'dealname', 'dealstage', 'pipeline', 'pais_operativo',
  'facturacion_activa', 'facturacion_automatica',
  'es_mirror_de_py', 'deal_uy_mirror_id', 'deal_py_origen_id',
];

const LI_PROPS = [
  'name', 'line_item_key', 'of_line_item_py_origen_id',
  'recurringbillingfrequency', 'hs_recurring_billing_frequency',
  'hs_recurring_billing_start_date', 'fecha_inicio_de_facturacion',
  'hs_recurring_billing_number_of_payments', 'number_of_payments',
  'renovacion_automatica', 'facturacion_automatica',
  'billing_anchor_date', 'billing_next_date',
  'last_ticketed_date', 'pagos_emitidos', 'facturas_restantes',
  'pausa', 'facturacion_activa',
];

const TICKET_PROPS = [
  'subject', 'hs_pipeline', 'hs_pipeline_stage',
  'of_ticket_key', 'of_line_item_key', 'of_deal_id',
  'of_invoice_id', 'numero_de_factura',
  'fecha_resolucion_esperada', 'of_fecha_de_facturacion',
  'fecha_real_de_facturacion',
  'of_estado',
];

// ─── Fetchers ─────────────────────────────────────────────────────────────────

async function fetchAllDeals() {
  const deals = [];
  let after;
  const filters = [];
  if (pipelineFilter) filters.push({ propertyName: 'pipeline', operator: 'EQ', value: pipelineFilter });

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
    deals.push(...(resp?.results || []));
    after = resp?.paging?.next?.after;
    if (!after || !resp?.results?.length) break;
    process.stdout.write(`\r   Deals leídos: ${deals.length}...`);
  }
  console.log(`\r   Deals leídos: ${deals.length}   `);
  return deals;
}

async function fetchLineItemsForDeal(dealId) {
  await rateLimit();
  let liIds = [];
  try {
    const resp = await hubspot.crm.associations.v4.basicApi.getPage('deals', String(dealId), 'line_items', undefined, 100);
    liIds = (resp?.results || []).map(r => String(r.toObjectId));
  } catch { return []; }
  if (!liIds.length) return [];

  await rateLimit();
  const batch = await hubspot.crm.lineItems.batchApi.read({
    inputs: liIds.map(id => ({ id })),
    properties: LI_PROPS,
  });
  return batch?.results || [];
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
    const resp = await hubspot.crm.tickets.searchApi.doSearch(body);
    tickets.push(...(resp?.results || []));
    after = resp?.paging?.next?.after;
    if (!after || !resp?.results?.length) break;
  }
  return tickets;
}

// ─── Auditar un deal ──────────────────────────────────────────────────────────

function auditDeal(deal, lineItems, tickets) {
  const dp    = deal.properties || {};
  const anomalies = [];

  // Agrupar tickets por LIK
  const ticketsByLik = new Map();
  const ticketsSinLik = [];
  const ticketsSinDeal = [];

  for (const t of tickets) {
    const tp  = t.properties || {};
    const lik = safe(tp.of_line_item_key);
    const did = safe(tp.of_deal_id);

    if (!did) ticketsSinDeal.push(t);
    if (!lik) { ticketsSinLik.push(t); continue; }

    if (!ticketsByLik.has(lik)) ticketsByLik.set(lik, []);
    ticketsByLik.get(lik).push(t);
  }

  // Anomalía: tickets sin LIK
  if (ticketsSinLik.length) {
    anomalies.push({
      tipo: 'TICKET_SIN_LIK',
      gravedad: '🔴',
      liId: '',
      liNombre: '',
      lik: '',
      detalle: `${ticketsSinLik.length} ticket(s) sin of_line_item_key`,
      ticketIds: ticketsSinLik.map(t => t.id).join(', '),
      esperado: '',
      real: ticketsSinLik.length,
      diferencia: '',
    });
  }

  // Anomalía: tickets sin deal (raro si los buscamos por deal, pero por si acaso)
  if (ticketsSinDeal.length) {
    anomalies.push({
      tipo: 'TICKET_SIN_DEAL',
      gravedad: '🔴',
      liId: '',
      liNombre: '',
      lik: '',
      detalle: `${ticketsSinDeal.length} ticket(s) sin of_deal_id`,
      ticketIds: ticketsSinDeal.map(t => t.id).join(', '),
      esperado: '',
      real: ticketsSinDeal.length,
      diferencia: '',
    });
  }

  // LIKs de tickets que no corresponden a ningún LI de este deal
  const dealLiks = new Set(lineItems.map(li => safe(li.properties?.line_item_key)).filter(Boolean));
  for (const [lik, tks] of ticketsByLik.entries()) {
    if (!dealLiks.has(lik)) {
      anomalies.push({
        tipo: 'TICKET_LIK_AJENO',
        gravedad: '🟠',
        liId: '',
        liNombre: '',
        lik,
        detalle: `${tks.length} ticket(s) con LIK que no pertenece a ningún LI de este deal`,
        ticketIds: tks.map(t => t.id).join(', '),
        esperado: '',
        real: tks.length,
        diferencia: '',
      });
    }
  }

  // Auditar cada line item
  for (const li of lineItems) {
    const lp  = li.properties || {};
    const lik = safe(lp.line_item_key);

    if (!lik) {
      anomalies.push({
        tipo: 'LI_SIN_LIK',
        gravedad: '🟠',
        liId: li.id,
        liNombre: safe(lp.name),
        lik: '',
        detalle: 'Line item sin line_item_key',
        ticketIds: '',
        esperado: '',
        real: '',
        diferencia: '',
      });
      continue;
    }

    const allTickets    = ticketsByLik.get(lik) || [];
    const activos       = allTickets.filter(t => !isCancelled(t));
    const cancelados    = allTickets.filter(t => isCancelled(t));
    const forecast      = activos.filter(t => isForecast(t));
    const reales        = activos.filter(t => !isForecast(t));

    const { desiredCount, dates: desiredDates, mode, term, pagosEmitidos } = buildDesiredDates(li);

    // ── Tickets faltantes ──
    if (activos.length < desiredCount) {
      anomalies.push({
        tipo: 'TICKETS_FALTANTES',
        gravedad: '🔴',
        liId: li.id,
        liNombre: safe(lp.name),
        lik,
        detalle: `Modo: ${mode}${term ? ` | term=${term}` : ''}${pagosEmitidos ? ` | emitidos=${pagosEmitidos}` : ''}`,
        ticketIds: '',
        esperado: desiredCount,
        real: activos.length,
        diferencia: activos.length - desiredCount,
      });
    }

    // ── Tickets de más ──
    if (activos.length > desiredCount) {
      anomalies.push({
        tipo: 'TICKETS_EXTRA',
        gravedad: '🟡',
        liId: li.id,
        liNombre: safe(lp.name),
        lik,
        detalle: `Modo: ${mode}${term ? ` | term=${term}` : ''}${pagosEmitidos ? ` | emitidos=${pagosEmitidos}` : ''}`,
        ticketIds: activos.map(t => t.id).join(', '),
        esperado: desiredCount,
        real: activos.length,
        diferencia: activos.length - desiredCount,
      });
    }

    // ── Duplicados por fecha de facturación ──
    const fechaCount = new Map();
    for (const t of activos) {
      const tp    = t.properties || {};
      const fecha = toYmd(tp.of_fecha_de_facturacion) || toYmd(tp.fecha_resolucion_esperada) || '';
      if (!fecha) continue;
      if (!fechaCount.has(fecha)) fechaCount.set(fecha, []);
      fechaCount.get(fecha).push(t.id);
    }
    for (const [fecha, ids] of fechaCount.entries()) {
      if (ids.length > 1) {
        anomalies.push({
          tipo: 'DUPLICADO_FECHA',
          gravedad: '🔴',
          liId: li.id,
          liNombre: safe(lp.name),
          lik,
          detalle: `Fecha ${fecha} duplicada en ${ids.length} tickets`,
          ticketIds: ids.join(', '),
          esperado: 1,
          real: ids.length,
          diferencia: ids.length - 1,
        });
      }
    }

    // ── Tickets reales sin invoice ──
    const sinInvoice = reales.filter(t => !t.properties?.of_invoice_id && !t.properties?.numero_de_factura);
    if (sinInvoice.length) {
      anomalies.push({
        tipo: 'REAL_SIN_INVOICE',
        gravedad: '🟡',
        liId: li.id,
        liNombre: safe(lp.name),
        lik,
        detalle: `${sinInvoice.length} ticket(s) en etapa real pero sin invoice asociada`,
        ticketIds: sinInvoice.map(t => t.id).join(', '),
        esperado: '',
        real: sinInvoice.length,
        diferencia: '',
      });
    }
  }

  return {
    dealId:    deal.id,
    dealNombre: safe(dp.dealname),
    pais:      safe(dp.pais_operativo),
    esMirror:  safe(dp.es_mirror_de_py) === 'true' ? 'Sí' : 'No',
    totalLIs:  lineItems.length,
    totalTickets: tickets.length,
    anomalias: anomalies,
  };
}

// ─── Excel ────────────────────────────────────────────────────────────────────

async function exportExcel(summaryRows, detailRows) {
  const wb = new ExcelJS.Workbook();
  const today = new Date().toISOString().slice(0, 10);

  // ── Hoja 1: Resumen por deal ──
  const ws1 = wb.addWorksheet('Resumen por Deal');
  ws1.columns = [
    { header: 'Deal ID',         key: 'dealId',        width: 16 },
    { header: 'Deal Nombre',     key: 'dealNombre',    width: 40 },
    { header: 'País',            key: 'pais',          width: 12 },
    { header: 'Mirror',          key: 'esMirror',      width: 10 },
    { header: 'Line Items',      key: 'totalLIs',      width: 12 },
    { header: 'Tickets',         key: 'totalTickets',  width: 12 },
    { header: '# Anomalías',     key: 'totalAnomalias',width: 14 },
    { header: 'Tipos',           key: 'tipos',         width: 60 },
  ];

  styleHeader(ws1);
  for (const r of summaryRows) ws1.addRow(r);
  applyConditionalColor(ws1, 7, summaryRows.length); // col G = # Anomalías
  ws1.autoFilter = { from: 'A1', to: 'H1' };
  ws1.views = [{ state: 'frozen', ySplit: 1 }];

  // ── Hoja 2: Detalle de anomalías ──
  const ws2 = wb.addWorksheet('Detalle Anomalías');
  ws2.columns = [
    { header: 'Deal ID',       key: 'dealId',      width: 16 },
    { header: 'Deal Nombre',   key: 'dealNombre',  width: 35 },
    { header: 'País',          key: 'pais',        width: 12 },
    { header: 'Mirror',        key: 'esMirror',    width: 10 },
    { header: 'Gravedad',      key: 'gravedad',    width: 10 },
    { header: 'Tipo',          key: 'tipo',        width: 22 },
    { header: 'LI ID',         key: 'liId',        width: 16 },
    { header: 'LI Nombre',     key: 'liNombre',    width: 30 },
    { header: 'LIK',           key: 'lik',         width: 20 },
    { header: 'Detalle',       key: 'detalle',     width: 50 },
    { header: 'Esperado',      key: 'esperado',    width: 11 },
    { header: 'Real',          key: 'real',        width: 11 },
    { header: 'Diferencia',    key: 'diferencia',  width: 12 },
    { header: 'Ticket IDs',    key: 'ticketIds',   width: 60 },
  ];

  styleHeader(ws2);
  for (const r of detailRows) ws2.addRow(r);
  ws2.autoFilter = { from: 'A1', to: 'N1' };
  ws2.views = [{ state: 'frozen', ySplit: 1 }];

  const outPath = `audit_deals_${today}.xlsx`;
  await wb.xlsx.writeFile(outPath);
  return outPath;
}

function styleHeader(ws) {
  ws.getRow(1).eachCell(cell => {
    cell.font      = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E79' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  });
  ws.getRow(1).height = 28;
}

function applyConditionalColor(ws, colNumber, rowCount) {
  for (let i = 2; i <= rowCount + 1; i++) {
    const cell = ws.getRow(i).getCell(colNumber);
    const val  = cell.value;
    if (val > 0) {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFC7CE' } };
      cell.font = { color: { argb: 'FF9C0006' }, bold: true };
    } else {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFC6EFCE' } };
      cell.font = { color: { argb: 'FF276221' } };
    }
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const today = nowMontevideoYmd();
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  AUDITORÍA MASIVA DE DEALS');
  console.log(`  Fecha (Montevideo): ${today}`);
  if (pipelineFilter) console.log(`  Pipeline:          ${pipelineFilter}`);
  if (singleDealId)   console.log(`  Deal único:        ${singleDealId}`);
  console.log('═══════════════════════════════════════════════════════════\n');

  // 1. Deals
  let deals;
  if (singleDealId) {
    console.log('📥 Cargando deal único...');
    const d = await hubspot.crm.deals.basicApi.getById(String(singleDealId), DEAL_PROPS);
    deals = [d];
  } else {
    console.log('📥 Cargando todos los deals...');
    deals = await fetchAllDeals();
  }
  console.log(`   Total deals a auditar: ${deals.length}\n`);

  // 2. Procesar deal a deal
  const summaryRows = [];
  const detailRows  = [];

  let dealsOk  = 0;
  let dealsCon = 0;

  for (let i = 0; i < deals.length; i++) {
    const deal   = deals[i];
    const dealId = deal.id;
    const nombre = safe(deal.properties?.dealname);

    process.stdout.write(`\r   [${i+1}/${deals.length}] ${nombre.slice(0, 45).padEnd(45)} `);

    const [lineItems, tickets] = await Promise.all([
      fetchLineItemsForDeal(dealId),
      fetchTicketsForDeal(dealId),
    ]);
    await sleep(100);

    const result = auditDeal(deal, lineItems, tickets);

    // Fila de resumen
    const tipos = [...new Set(result.anomalias.map(a => a.tipo))].join(', ');
    summaryRows.push({
      dealId:          result.dealId,
      dealNombre:      result.dealNombre,
      pais:            result.pais,
      esMirror:        result.esMirror,
      totalLIs:        result.totalLIs,
      totalTickets:    result.totalTickets,
      totalAnomalias:  result.anomalias.length,
      tipos:           tipos || '✅ Sin anomalías',
    });

    // Filas de detalle
    for (const a of result.anomalias) {
      detailRows.push({
        dealId:      result.dealId,
        dealNombre:  result.dealNombre,
        pais:        result.pais,
        esMirror:    result.esMirror,
        gravedad:    a.gravedad,
        tipo:        a.tipo,
        liId:        a.liId,
        liNombre:    a.liNombre,
        lik:         a.lik,
        detalle:     a.detalle,
        esperado:    a.esperado,
        real:        a.real,
        diferencia:  a.diferencia,
        ticketIds:   a.ticketIds,
      });
    }

    if (result.anomalias.length === 0) dealsOk++;
    else dealsCon++;
  }

  console.log('\n');

  // 3. Exportar
  console.log('📊 Generando Excel...');
  const outPath = await exportExcel(summaryRows, detailRows);

  // 4. Resumen en consola
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  RESUMEN FINAL');
  console.log(`  Deals auditados:      ${deals.length}`);
  console.log(`  ✅ Sin anomalías:     ${dealsOk}`);
  console.log(`  ⚠️  Con anomalías:    ${dealsCon}`);
  console.log(`  Total anomalías:      ${detailRows.length}`);
  console.log('');

  // Conteo por tipo
  const tipoCounts = {};
  for (const r of detailRows) {
    tipoCounts[r.tipo] = (tipoCounts[r.tipo] || 0) + 1;
  }
  for (const [tipo, count] of Object.entries(tipoCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`     ${tipo.padEnd(25)} ${count}`);
  }

  console.log('');
  console.log(`  📁 Reporte: ${outPath}`);
  console.log('═══════════════════════════════════════════════════════════');
}

main().catch(err => {
  console.error('\n❌ Error fatal:', err.message ?? err);
  if (err.response?.data) console.error(JSON.stringify(err.response.data, null, 2));
  process.exit(1);
});
