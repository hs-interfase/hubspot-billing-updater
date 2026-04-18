#!/usr/bin/env node
/**
 * auditDeal.mjs
 * Auditoría completa de un deal: cuántos tickets/facturas debería tener,
 * cuántos tiene realmente, y qué anomalías hay.
 *
 * Uso:
 *   node auditDeal.mjs --deal <DEAL_ID>
 *
 * Requiere: HUBSPOT_PRIVATE_TOKEN en .env
 */

import 'dotenv/config';
import { Client } from '@hubspot/api-client';
import axios from 'axios';

// ─── Config ──────────────────────────────────────────────────────────────────

const TOKEN = process.env.HUBSPOT_PRIVATE_TOKEN;
if (!TOKEN) { console.error('❌ Falta HUBSPOT_PRIVATE_TOKEN'); process.exit(1); }

const dealId = (() => {
  const i = process.argv.indexOf('--deal');
  return i !== -1 ? process.argv[i + 1] : null;
})();
if (!dealId) { console.error('❌ Uso: node auditDeal.mjs --deal <DEAL_ID>'); process.exit(1); }

const hubspot = new Client({ accessToken: TOKEN });
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── TZ / fechas (Montevideo) ─────────────────────────────────────────────────

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
  const ymd = toYmd(raw);
  if (!ymd) return null;
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function formatDateISO(d) {
  if (!d || !Number.isFinite(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function addInterval(d, interval) {
  if (!d || !interval) return null;
  const r = new Date(d.getTime());
  if (interval.months) r.setMonth(r.getMonth() + interval.months);
  if (interval.days)   r.setDate(r.getDate() + interval.days);
  return r;
}

// ─── Frecuencia → intervalo ───────────────────────────────────────────────────

function getIntervalFromFrequency(freqRaw) {
  const f = (freqRaw ?? '').toString().trim().toLowerCase();
  switch (f) {
    case 'weekly':           return { months: 0, days: 7 };
    case 'biweekly':         return { months: 0, days: 14 };
    case 'monthly':          return { months: 1, days: 0 };
    case 'quarterly':        return { months: 3, days: 0 };
    case 'per_six_months':   return { months: 6, days: 0 };
    case 'annually':         return { months: 12, days: 0 };
    case 'per_two_years':    return { months: 24, days: 0 };
    case 'per_three_years':  return { months: 36, days: 0 };
    case 'per_four_years':   return { months: 48, days: 0 };
    case 'per_five_years':   return { months: 60, days: 0 };
    // Fallbacks en español / legacy
    case 'semanal':          return { months: 0, days: 7 };
    case 'quincenal':        return { months: 0, days: 14 };
    case 'mensual':          return { months: 1, days: 0 };
    case 'bimestral':        return { months: 2, days: 0 };
    case 'trimestral':       return { months: 3, days: 0 };
    case 'semestral':        return { months: 6, days: 0 };
    case 'anual':            return { months: 12, days: 0 };
    default:                 return null;
  }
}

// ─── buildDesiredDates (standalone, basada en phasep.js) ─────────────────────

/**
 * Calcula las fechas que DEBERÍA tener un line item según su configuración.
 * Tickets reales recibidos para descontar pagos_emitidos en plan fijo.
 */
function buildDesiredDates(li, realTickets = []) {
  const p = li?.properties || {};
  const today = nowMontevideoYmd();

  const startYmd =
    toYmd(p.hs_recurring_billing_start_date) ||
    toYmd(p.recurringbillingstartdate) ||
    toYmd(p.fecha_inicio_de_facturacion) ||
    '';

  if (!startYmd) return { desiredCount: 0, dates: [], reason: 'sin_fecha_inicio' };

  const freqKey = (p.recurringbillingfrequency || p.hs_recurring_billing_frequency || '').trim();
  const interval = freqKey ? getIntervalFromFrequency(freqKey) : null;

  // Pago único
  if (!freqKey) {
    return { desiredCount: 1, dates: [startYmd], reason: 'pago_unico', interval: null };
  }

  if (!interval) {
    return { desiredCount: 1, dates: [startYmd], reason: 'frecuencia_sin_intervalo_conocido', interval: null };
  }

  const termRaw = p.hs_recurring_billing_number_of_payments ?? p.number_of_payments ?? null;
  const term = termRaw ? parseInt(String(termRaw), 10) : null;

  const isAutoRenew =
    String(p.renovacion_automatica || '').toLowerCase() === 'true' ||
    !(term > 0);

  const hardMax = 24;

  // Contar emitidos: tickets que NO son forecast
  // Un ticket es forecast si su of_ticket_key apunta a una fecha futura y no tiene invoice
  const pagosEmitidos = parseInt(String(p.pagos_emitidos || '0'), 10) || 0;

  let maxCount;
  if (!isAutoRenew && term > 0) {
    maxCount = Math.min(Math.max(0, term - pagosEmitidos), hardMax);
  } else {
    maxCount = hardMax;
  }

  if (maxCount === 0) return { desiredCount: 0, dates: [], reason: 'plan_fijo_completo', interval };

  const lastTicketedYmd = toYmd(p.last_ticketed_date);
  const anchorYmd       = toYmd(p.billing_anchor_date);
  const billingNextYmd  = toYmd(p.billing_next_date);

  // ── AUTO RENEW ──────────────────────────────────────────────────────────────
  if (isAutoRenew) {
    let seriesStart = today;
    if (lastTicketedYmd) {
      const d0 = parseLocalDate(lastTicketedYmd);
      if (d0) { d0.setDate(d0.getDate() + 1); const p1 = formatDateISO(d0); if (p1 > seriesStart) seriesStart = p1; }
    }
    if (billingNextYmd && billingNextYmd > seriesStart) seriesStart = billingNextYmd;
    if ((anchorYmd || startYmd) > seriesStart) seriesStart = anchorYmd || startYmd;

    const startDate = parseLocalDate(seriesStart);
    if (!startDate) return { desiredCount: 0, dates: [], reason: 'auto_renew_sin_start', interval };

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
    return { desiredCount: dates.length, dates, reason: 'auto_renew', interval, term: null, pagosEmitidos };
  }

  // ── PLAN FIJO ────────────────────────────────────────────────────────────────
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
  if (!startDate) return { desiredCount: 0, dates: [], reason: 'plan_fijo_sin_start', interval };

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

  return { desiredCount: dates.length, dates, reason: 'plan_fijo', interval, term, pagosEmitidos, maxCount };
}

// ─── HubSpot fetchers ─────────────────────────────────────────────────────────

async function fetchDeal(id) {
  const props = [
    'dealname', 'dealstage', 'pipeline', 'closedate',
    'pais_operativo', 'facturacion_activa', 'facturacion_automatica',
    // cupo
    'tipo_de_cupo', 'cupo_activo', 'cupo_total', 'cupo_total_monto',
    'cupo_consumido', 'cupo_restante', 'cupo_umbral', 'cupo_estado',
    // mirrors
    'deal_py_origen_id', 'deal_uy_mirror_id', 'es_mirror_de_py',
    'hs_object_id', 'createdate', 'hs_lastmodifieddate',
  ];
  return hubspot.crm.deals.basicApi.getById(String(id), props);
}

async function fetchLineItemsForDeal(id) {
  const assocResp = await hubspot.crm.associations.v4.basicApi.getPage(
    'deals', String(id), 'line_items', undefined, 100
  );
  const liIds = (assocResp?.results || []).map(r => String(r.toObjectId));
  if (!liIds.length) return [];

  const props = [
    'name', 'description', 'price', 'quantity', 'amount',
    'recurringbillingfrequency', 'hs_recurring_billing_frequency',
    'hs_recurring_billing_start_date', 'hs_recurring_billing_number_of_payments',
    'hs_recurring_billing_period',
    'renovacion_automatica', 'facturacion_automatica', 'facturacion_activa',
    'billing_anchor_date', 'billing_next_date', 'last_ticketed_date', 'last_billing_period',
    'pagos_emitidos', 'facturas_restantes', 'progreso_pagos',
    'line_item_key', 'of_line_item_py_origen_id',
    'parte_del_cupo', 'irregular', 'facturar_ahora', 'pausa',
    'pais_operativo', 'fecha_inicio_de_facturacion',
    'createdate', 'hs_lastmodifieddate',
  ];

  const batch = await hubspot.crm.lineItems.batchApi.read({ inputs: liIds.map(id => ({ id })), properties: props });
  return batch?.results || [];
}

async function fetchTicketsByLineItemKey(lik) {
  if (!lik) return [];
  const body = {
    filterGroups: [{ filters: [{ propertyName: 'of_line_item_key', operator: 'EQ', value: String(lik) }] }],
    properties: [
      'subject', 'hs_pipeline', 'hs_pipeline_stage',
      'of_ticket_key', 'of_line_item_key', 'of_deal_id',
      'of_invoice_id', 'of_invoice_key', 'of_invoice_status',
      'fecha_resolucion_esperada', 'of_fecha_de_facturacion',
      'fecha_real_de_facturacion', 'numero_de_factura',
      'of_pais_operativo', 'of_aplica_cupo', 'of_cupo_consumido',
      'createdate', 'hs_lastmodifieddate',
    ],
    limit: 100,
  };
  let all = [];
  let after;
  do {
    if (after) body.after = after;
    const resp = await hubspot.crm.tickets.searchApi.doSearch(body);
    all = all.concat(resp?.results || []);
    after = resp?.paging?.next?.after;
    if (after) await sleep(150);
  } while (after);
  return all;
}

async function fetchInvoicesByDeal(id) {
  // Estrategia A: asociación directa deal → invoices
  let fromAssoc = [];
  try {
    const resp = await hubspot.crm.associations.v4.basicApi.getPage(
      'deals', String(id), 'invoices', undefined, 100
    );
    const invIds = (resp?.results || []).map(r => String(r.toObjectId));
    if (invIds.length) {
      const batch = await axios.post(
        `https://api.hubapi.com/crm/v3/objects/invoices/batch/read`,
        {
          inputs: invIds.map(id => ({ id })),
          properties: [
            'of_invoice_key', 'etapa_de_la_factura', 'hs_invoice_status',
            'hs_due_date', 'hs_invoice_date', 'fecha_de_emision',
            'hs_amount_billed', 'id_factura_nodum', 'numero_de_factura',
            'ticket_id', 'line_item_key', 'createdate',
          ],
        },
        { headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' } }
      );
      fromAssoc = batch.data?.results || [];
    }
  } catch (e) {
    console.warn('   ⚠️  Error buscando invoices por asociación:', e.message);
  }

  return fromAssoc;
}

async function fetchInvoicesByIds(ids) {
  if (!ids.length) return [];
  try {
    const resp = await axios.post(
      `https://api.hubapi.com/crm/v3/objects/invoices/batch/read`,
      {
        inputs: ids.map(id => ({ id })),
        properties: [
          'of_invoice_key', 'etapa_de_la_factura', 'hs_invoice_status',
          'hs_due_date', 'hs_invoice_date', 'fecha_de_emision',
          'hs_amount_billed', 'id_factura_nodum', 'numero_de_factura',
          'ticket_id', 'line_item_key', 'createdate',
        ],
      },
      { headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' } }
    );
    return resp.data?.results || [];
  } catch (e) {
    console.warn('   ⚠️  Error leyendo invoices por ID:', e.message);
    return [];
  }
}

// ─── Stage / pipeline labels ─────────────────────────────────────────────────

const PIPELINE_LABELS = {
  [process.env.BILLING_TICKET_PIPELINE_ID]:  'MANUAL',
  [process.env.BILLING_AUTOMATED_PIPELINE]:  'AUTO',
  '832539959': 'MANUAL',
  '829156883': 'AUTO',
};

const STAGE_LABELS = {
  // Manual
  [process.env.BILLING_TICKET_STAGE_FORECAST_85]:  'FORECAST_85',
  [process.env.BILLING_TICKET_STAGE_FORECAST_95]:  'FORECAST_95',
  [process.env.BILLING_TICKET_STAGE_NEW]:           'PRÓXIMO',
  [process.env.BILLING_TICKET_STAGE_READY]:         'LISTO',
  [process.env.BILLING_TICKET_STAGE_ID_BILLED]:     'EMITIDO',
  [process.env.BILLING_TICKET_STAGE_ID_CREATED]:    'CREADO',
  [process.env.BILLING_TICKET_STAGE_ID_LATE]:       'ATRASADO',
  [process.env.BILLING_TICKET_PIPELINE_ID_PAID]:    'PAGADO',
  [process.env.BILLING_TICKET_STAGE_CANCELLED]:     'CANCELADO',
  // Auto
  [process.env.BILLING_AUTOMATED_FORECAST_85]:  'AUTO_FORECAST_85',
  [process.env.BILLING_AUTOMATED_FORECAST_95]:  'AUTO_FORECAST_95',
  [process.env.BILLING_AUTOMATED_READY]:        'AUTO_LISTO',
  [process.env.BILLING_AUTOMATED_CREATED]:      'AUTO_CREADO',
  [process.env.BILLING_AUTOMATED_LATE]:         'AUTO_ATRASADO',
  [process.env.BILLING_AUTOMATED_PAID]:         'AUTO_PAGADO',
  [process.env.BILLING_AUTOMATED_CANCELLED]:    'AUTO_CANCELADO',
};

function stageLabel(stageId) {
  const l = STAGE_LABELS[stageId];
  return l ? `${l} (${stageId})` : (stageId || '—');
}
function pipelineLabel(pipelineId) {
  const l = PIPELINE_LABELS[pipelineId];
  return l ? `${l}` : (pipelineId || '—');
}

const FORECAST_STAGES = new Set([
  process.env.BILLING_TICKET_STAGE_FORECAST_85,
  process.env.BILLING_TICKET_STAGE_FORECAST_95,
  process.env.BILLING_AUTOMATED_FORECAST_85,
  process.env.BILLING_AUTOMATED_FORECAST_95,
].filter(Boolean));

const CANCELLED_STAGES = new Set([
  process.env.BILLING_TICKET_STAGE_CANCELLED,
  process.env.BILLING_AUTOMATED_CANCELLED,
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

function isForecast(ticket) { return FORECAST_STAGES.has(String(ticket?.properties?.hs_pipeline_stage || '')); }
function isCancelled(ticket) { return CANCELLED_STAGES.has(String(ticket?.properties?.hs_pipeline_stage || '')); }
function isInvoiced(ticket)  { return INVOICED_STAGES.has(String(ticket?.properties?.hs_pipeline_stage || '')); }

// ─── Formateo ─────────────────────────────────────────────────────────────────

const SEP  = '═'.repeat(70);
const SEP2 = '─'.repeat(70);
const nl   = () => console.log();

function num(v, decimals = 2) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n.toLocaleString('es-UY', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) : '—';
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(SEP);
  console.log(`  🔍 AUDITORÍA DE DEAL — ${dealId}`);
  console.log(`  Fecha hoy (Montevideo): ${nowMontevideoYmd()}`);
  console.log(SEP);
  nl();

  // ── 1. Deal ──────────────────────────────────────────────────────────────────
  let deal;
  try {
    deal = await fetchDeal(dealId);
  } catch (e) {
    console.error('❌ No se pudo leer el deal:', e.message);
    process.exit(1);
  }
  const dp = deal.properties;

  console.log('╔══ 1. DEAL OVERVIEW');
  console.log(`║  Nombre:           ${dp.dealname || '—'}`);
  console.log(`║  Stage:            ${dp.dealstage || '—'}`);
  console.log(`║  País operativo:   ${dp.pais_operativo || '—'}`);
  console.log(`║  Es mirror PY→UY:  ${dp.es_mirror_de_py || 'false'}`);
  console.log(`║  Mirror ID (UY):   ${dp.deal_uy_mirror_id || '—'}`);
  console.log(`║  Origen PY:        ${dp.deal_py_origen_id || '—'}`);
  console.log(`║  Facturación:      activa=${dp.facturacion_activa || '—'}  automática=${dp.facturacion_automatica || '—'}`);
  nl();
  console.log(`║  CUPO`);
  if (dp.tipo_de_cupo) {
    console.log(`║    Tipo:           ${dp.tipo_de_cupo}`);
    console.log(`║    Activo:         ${dp.cupo_activo}`);
    console.log(`║    Estado:         ${dp.cupo_estado || '—'}`);
    const cupoTotal = dp.tipo_de_cupo === 'Por Monto' ? dp.cupo_total_monto : dp.cupo_total;
    console.log(`║    Total:          ${num(cupoTotal)}  |  Consumido: ${num(dp.cupo_consumido)}  |  Restante: ${num(dp.cupo_restante)}`);
    console.log(`║    Umbral:         ${dp.cupo_umbral || '—'}`);
  } else {
    console.log(`║    Sin cupo`);
  }
  console.log('╚' + '═'.repeat(50));
  nl();

  // ── 2. Line Items ─────────────────────────────────────────────────────────────
  console.log('📦 Cargando line items...');
  const lineItems = await fetchLineItemsForDeal(dealId);
  console.log(`   ${lineItems.length} line items encontrados`);
  nl();

  // Recolectar invoices por ticket mientras procesamos LIs
  const invoiceIdsFromTickets = new Set();
  const allAnomalies = [];
  const allTicketsByLik = new Map(); // lik → tickets[]

  for (let liIdx = 0; liIdx < lineItems.length; liIdx++) {
    const li = lineItems[liIdx];
    const lp = li.properties || {};
    const lik = (lp.line_item_key || '').trim();

    console.log(SEP2);
    console.log(`  📋 LINE ITEM ${liIdx + 1}/${lineItems.length}  ID: ${li.id}`);
    console.log(`     Nombre:        ${lp.name || '—'}`);
    console.log(`     Precio:        ${num(lp.price)}  ×  ${lp.quantity || 1}`);
    console.log(`     LIK:           ${lik || '⚠️  SIN KEY'}`);
    console.log(`     Frecuencia:    ${lp.recurringbillingfrequency || lp.hs_recurring_billing_frequency || 'pago único'}`);
    console.log(`     # Pagos:       ${lp.hs_recurring_billing_number_of_payments || '—'}`);
    console.log(`     Auto-renew:    ${lp.renovacion_automatica || 'false'}`);
    console.log(`     Auto-factura:  ${lp.facturacion_automatica || 'false'}`);
    console.log(`     Parte cupo:    ${lp.parte_del_cupo || 'false'}`);
    console.log(`     Inicio:        ${toYmd(lp.hs_recurring_billing_start_date) || toYmd(lp.fecha_inicio_de_facturacion) || '—'}`);
    console.log(`     Anchor:        ${toYmd(lp.billing_anchor_date) || '—'}`);
    console.log(`     Last ticketed: ${toYmd(lp.last_ticketed_date) || '—'}`);
    console.log(`     Billing next:  ${toYmd(lp.billing_next_date) || '—'}`);
    console.log(`     pagos_emitidos:${lp.pagos_emitidos || '0'}  |  facturas_restantes: ${lp.facturas_restantes || '—'}`);
    console.log(`     Pausa:         ${lp.pausa || 'false'}  |  Mirror PY origen: ${lp.of_line_item_py_origen_id || '—'}`);
    nl();

    if (!lik) {
      const msg = `LI ${li.id} sin line_item_key — no se pueden buscar tickets`;
      console.log(`   ⚠️  ${msg}`);
      allAnomalies.push({ liId: li.id, tipo: 'SIN_LIK', msg });
      nl();
      continue;
    }

    // ── Tickets reales ──────────────────────────────────────────────────────────
    console.log(`   🎫 Buscando tickets para LIK ${lik}...`);
    const tickets = await fetchTicketsByLineItemKey(lik);
    allTicketsByLik.set(lik, tickets);
    await sleep(200);

    const ticketsActivos    = tickets.filter(t => !isCancelled(t));
    const ticketsCancelados = tickets.filter(t => isCancelled(t));
    const ticketsForecast   = ticketsActivos.filter(t => isForecast(t));
    const ticketsReales     = ticketsActivos.filter(t => !isForecast(t));
    const ticketsConInvoice = ticketsReales.filter(t => t.properties?.of_invoice_id || t.properties?.numero_de_factura);

    // Recolectar invoice IDs para la sección 3
    for (const t of tickets) {
      const invId = t.properties?.of_invoice_id;
      if (invId) invoiceIdsFromTickets.add(String(invId));
    }

    // ── Fechas esperadas ────────────────────────────────────────────────────────
    const { desiredCount, dates: desiredDates, reason, interval, term, pagosEmitidos, maxCount } =
      buildDesiredDates(li, ticketsReales);

    console.log(`   ── ESPERADO (buildDesiredDates)`);
    console.log(`      Razón/modo:    ${reason}`);
    if (term !== undefined && term !== null) console.log(`      Término:       ${term} pagos  |  pagos_emitidos: ${pagosEmitidos}  |  maxCount: ${maxCount}`);
    if (interval) console.log(`      Intervalo:     ${JSON.stringify(interval)}`);
    console.log(`      Tickets esp.:  ${desiredCount}`);
    if (desiredDates.length) {
      console.log(`      Fechas esp.:   ${desiredDates.join(', ')}`);
    }
    nl();

    console.log(`   ── REAL`);
    console.log(`      Total tickets: ${tickets.length}  (activos: ${ticketsActivos.length}, cancelados: ${ticketsCancelados.length})`);
    console.log(`      Forecast:      ${ticketsForecast.length}`);
    console.log(`      Reales:        ${ticketsReales.length}  (con invoice: ${ticketsConInvoice.length})`);
    nl();

    // Mostrar cada ticket activo
    for (const t of ticketsActivos) {
      const tp = t.properties || {};
      const fechaBilling = toYmd(tp.of_fecha_de_facturacion) || toYmd(tp.fecha_resolucion_esperada) || '—';
      const fechaReal    = toYmd(tp.fecha_real_de_facturacion) || '—';
      const esForecast   = isForecast(t) ? ' 🔮FORECAST' : '';
      const tieneInvoice = (tp.of_invoice_id || tp.numero_de_factura) ? ' 💰' : '';
      console.log(`      🎫 ${t.id}${esForecast}${tieneInvoice}`);
      console.log(`         Subject:    ${tp.subject || '—'}`);
      console.log(`         Pipeline:   ${pipelineLabel(tp.hs_pipeline)}`);
      console.log(`         Stage:      ${stageLabel(tp.hs_pipeline_stage)}`);
      console.log(`         Fecha bill: ${fechaBilling}  |  Fecha real: ${fechaReal}`);
      console.log(`         ticket_key: ${tp.of_ticket_key || '—'}`);
      console.log(`         invoice_id: ${tp.of_invoice_id || '—'}  |  nro_factura: ${tp.numero_de_factura || '—'}`);
      console.log(`         País:       ${tp.of_pais_operativo || '—'}  |  Cupo consumido: ${tp.of_cupo_consumido || '—'}`);
    }
    if (ticketsCancelados.length) {
      console.log(`      (${ticketsCancelados.length} cancelado/s — IDs: ${ticketsCancelados.map(t => t.id).join(', ')})`);
    }
    nl();

    // ── Detección de anomalías por LI ───────────────────────────────────────────
    const liAnomalias = [];

    // Duplicados por fecha de billing
    const fechaCount = new Map();
    for (const t of ticketsActivos) {
      const tp = t.properties || {};
      const fecha = toYmd(tp.of_fecha_de_facturacion) || toYmd(tp.fecha_resolucion_esperada) || '';
      if (!fecha) continue;
      if (!fechaCount.has(fecha)) fechaCount.set(fecha, []);
      fechaCount.get(fecha).push(t.id);
    }
    for (const [fecha, ids] of fechaCount.entries()) {
      if (ids.length > 1) {
        liAnomalias.push({ tipo: '🔴 DUPLICADO_FECHA', msg: `Fecha ${fecha} aparece en ${ids.length} tickets: ${ids.join(', ')}` });
      }
    }

    // Duplicados de invoice por fecha real
    const invoiceFechaCount = new Map();
    for (const t of ticketsReales) {
      const tp = t.properties || {};
      const fechaReal = toYmd(tp.fecha_real_de_facturacion) || '';
      const invId     = tp.of_invoice_id || '';
      if (!fechaReal || !invId) continue;
      if (!invoiceFechaCount.has(fechaReal)) invoiceFechaCount.set(fechaReal, []);
      invoiceFechaCount.get(fechaReal).push({ ticketId: t.id, invoiceId: invId });
    }
    for (const [fecha, entries] of invoiceFechaCount.entries()) {
      if (entries.length > 1) {
        liAnomalias.push({ tipo: '🔴 INVOICE_DUPLICADA_FECHA', msg: `Fecha real ${fecha} → ${entries.length} invoices: ${entries.map(e => e.invoiceId + '(t:' + e.ticketId + ')').join(', ')}` });
      }
    }

    // Más tickets reales que esperados
    if (ticketsReales.length > (desiredCount + (pagosEmitidos || 0))) {
      liAnomalias.push({ tipo: '🟡 TICKETS_EXTRA', msg: `${ticketsReales.length} tickets reales vs ${desiredCount} esperados` });
    }

    // Tickets reales sin invoice
    const sinInvoice = ticketsReales.filter(t => !t.properties?.of_invoice_id && !t.properties?.numero_de_factura);
    if (sinInvoice.length) {
      liAnomalias.push({ tipo: '🟡 REAL_SIN_INVOICE', msg: `${sinInvoice.length} tickets reales sin invoice: ${sinInvoice.map(t => t.id).join(', ')}` });
    }

    // LI de mirror UY con facturacion_automatica=true
    if (lp.of_line_item_py_origen_id && String(lp.facturacion_automatica).toLowerCase() === 'true') {
      liAnomalias.push({ tipo: '🔴 MIRROR_LI_AUTO', msg: `LI mirror UY tiene facturacion_automatica=true — debería ser false` });
    }

    // Sin fecha de inicio
    if (!toYmd(lp.hs_recurring_billing_start_date) && !toYmd(lp.fecha_inicio_de_facturacion)) {
      liAnomalias.push({ tipo: '🟠 SIN_FECHA_INICIO', msg: `LI sin fecha de inicio de facturación` });
    }

    if (liAnomalias.length) {
      console.log(`   ⚠️  ANOMALÍAS DETECTADAS EN ESTE LI:`);
      for (const a of liAnomalias) {
        console.log(`      ${a.tipo}: ${a.msg}`);
        allAnomalies.push({ liId: li.id, liNombre: lp.name, ...a });
      }
    } else {
      console.log(`   ✅ Sin anomalías detectadas en este LI`);
    }
    nl();
  }

  // ── 3. Invoices ───────────────────────────────────────────────────────────────
  console.log(SEP);
  console.log('  💰 3. INVOICES HUBSPOT');
  console.log(SEP);
  nl();

  console.log('   Buscando invoices por asociación al deal...');
  const invoicesFromAssoc = await fetchInvoicesByDeal(dealId);
  await sleep(300);

  // Invoices por of_invoice_id de los tickets (Estrategia B)
  const invoiceIdsExtra = [...invoiceIdsFromTickets].filter(
    id => !invoicesFromAssoc.some(inv => String(inv.id) === id)
  );
  let invoicesFromTickets = [];
  if (invoiceIdsExtra.length) {
    console.log(`   Buscando ${invoiceIdsExtra.length} invoices adicionales por of_invoice_id en tickets...`);
    invoicesFromTickets = await fetchInvoicesByIds(invoiceIdsExtra);
  }

  // Combinar y deduplicar
  const allInvoicesMap = new Map();
  for (const inv of [...invoicesFromAssoc, ...invoicesFromTickets]) {
    allInvoicesMap.set(String(inv.id), inv);
  }
  const allInvoices = [...allInvoicesMap.values()];

  // Marcar origen
  const fromAssocIds = new Set(invoicesFromAssoc.map(i => String(i.id)));
  const fromTicketIds = new Set(invoicesFromTickets.map(i => String(i.id)));

  console.log(`   Total invoices: ${allInvoices.length}  (por asociación: ${invoicesFromAssoc.length}, solo en tickets: ${invoicesFromTickets.length})`);
  nl();

  for (const inv of allInvoices) {
    const ip = inv.properties || {};
    const origen = fromAssocIds.has(String(inv.id)) && fromTicketIds.has(String(inv.id))
      ? 'AMBAS' : fromAssocIds.has(String(inv.id)) ? 'ASOCIACIÓN' : 'TICKET';
    console.log(`   📄 Invoice ${inv.id}  [origen: ${origen}]`);
    console.log(`      of_invoice_key:    ${ip.of_invoice_key || '—'}`);
    console.log(`      Etapa:             ${ip.etapa_de_la_factura || ip.hs_invoice_status || '—'}`);
    console.log(`      Fecha emisión:     ${toYmd(ip.fecha_de_emision) || toYmd(ip.hs_invoice_date) || '—'}`);
    console.log(`      Fecha venc.:       ${toYmd(ip.hs_due_date) || '—'}`);
    console.log(`      Monto:             ${num(ip.hs_amount_billed)}`);
    console.log(`      Nro Nodum:         ${ip.id_factura_nodum || ip.numero_de_factura || '—'}`);
    console.log(`      line_item_key:     ${ip.line_item_key || '—'}`);
    console.log(`      ticket_id ref:     ${ip.ticket_id || '—'}`);
    nl();
  }

  // Detectar invoices con fecha duplicada
  const invoiceAnomalias = [];
  const invFechaCount = new Map();
  for (const inv of allInvoices) {
    const ip = inv.properties || {};
    const etapa = ip.etapa_de_la_factura || '';
    if (etapa === 'Cancelada') continue;
    const fecha = toYmd(ip.fecha_de_emision) || toYmd(ip.hs_invoice_date) || '';
    if (!fecha) continue;
    if (!invFechaCount.has(fecha)) invFechaCount.set(fecha, []);
    invFechaCount.get(fecha).push(inv.id);
  }
  for (const [fecha, ids] of invFechaCount.entries()) {
    if (ids.length > 1) {
      const msg = `Fecha ${fecha} aparece en ${ids.length} invoices: ${ids.join(', ')}`;
      invoiceAnomalias.push({ tipo: '🔴 INVOICE_FECHA_DUPLICADA', msg });
      allAnomalies.push({ liId: 'INVOICE', tipo: '🔴 INVOICE_FECHA_DUPLICADA', msg });
    }
  }

  // Invoices no asociadas al deal
  for (const inv of invoicesFromTickets) {
    const msg = `Invoice ${inv.id} existe en ticket pero NO está asociada al deal`;
    invoiceAnomalias.push({ tipo: '🟡 INVOICE_NO_ASOCIADA_DEAL', msg });
    allAnomalies.push({ liId: 'INVOICE', tipo: '🟡 INVOICE_NO_ASOCIADA_DEAL', msg });
  }

  // Invoices sin ticket vinculado
  for (const inv of allInvoices) {
    const ip = inv.properties || {};
    const likInvoice = ip.line_item_key || '';
    if (!likInvoice) continue;
    const ticketsDelLik = allTicketsByLik.get(likInvoice) || [];
    const ticketVinculado = ticketsDelLik.some(t =>
      String(t.properties?.of_invoice_id) === String(inv.id) ||
      String(t.properties?.numero_de_factura) === String(ip.numero_de_factura || '')
    );
    if (!ticketVinculado) {
      const msg = `Invoice ${inv.id} (LIK: ${likInvoice}) no está vinculada a ningún ticket`;
      invoiceAnomalias.push({ tipo: '🟡 INVOICE_SIN_TICKET', msg });
      allAnomalies.push({ liId: 'INVOICE', tipo: '🟡 INVOICE_SIN_TICKET', msg });
    }
  }

  if (invoiceAnomalias.length) {
    console.log(`   ⚠️  ANOMALÍAS EN INVOICES:`);
    for (const a of invoiceAnomalias) console.log(`      ${a.tipo}: ${a.msg}`);
  } else {
    console.log(`   ✅ Sin anomalías detectadas en invoices`);
  }
  nl();

  // ── 4. Resumen consolidado ────────────────────────────────────────────────────
  console.log(SEP);
  console.log('  ⚠️  4. RESUMEN DE ANOMALÍAS');
  console.log(SEP);
  nl();

  if (!allAnomalies.length) {
    console.log('   ✅ No se detectaron anomalías. El deal parece consistente.');
  } else {
    console.log(`   ${allAnomalies.length} anomalía(s) encontrada(s):\n`);
    for (const a of allAnomalies) {
      const contexto = a.liNombre ? `[LI: ${a.liNombre} (${a.liId})]` : `[${a.liId}]`;
      console.log(`   ${a.tipo}`);
      console.log(`      ${contexto} ${a.msg}`);
      nl();
    }
  }

  console.log(SEP);
  console.log('  ✅ Auditoría completada');
  console.log(SEP);
}

main().catch(err => {
  console.error('\n❌ Error fatal:', err.message);
  if (err.response?.data) console.error(JSON.stringify(err.response.data, null, 2));
  process.exit(1);
});
