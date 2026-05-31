#!/usr/bin/env node
/**
 * sealHistoricTickets.mjs
 *
 * Post-migración Mansoft: sella tickets históricos en stage READY sin invoice.
 *
 * Pipelines:
 *   AUTOMÁTICO → pre-corte: CREATED + numero_de_factura=11 | post-corte: invoice con id_factura_nodum=11
 *   MANUAL     → pre-corte: EMITIDO (sin ID ficticio)      | post-corte: invoice (sin ID ficticio)
 *
 * Genera reporte JSON de hallazgos al finalizar.
 *
 * Uso:
 *   node sealHistoricTickets.mjs                          # dry run (default)
 *   node sealHistoricTickets.mjs --execute                # ejecución real
 *   node sealHistoricTickets.mjs --deal 60463210135       # un deal (dry)
 *   node sealHistoricTickets.mjs --deal 60463210135 --execute
 *   node sealHistoricTickets.mjs --cutoff 2025-02-01      # corte configurable
 *
 * Requiere: HUBSPOT_PRIVATE_TOKEN en .env
 */

import 'dotenv/config';
import { Client } from '@hubspot/api-client';
import { writeFileSync } from 'fs';

// ─── Config ──────────────────────────────────────────────────────────────────

const TOKEN = process.env.HUBSPOT_PRIVATE_TOKEN;
if (!TOKEN) { console.error('❌ Falta HUBSPOT_PRIVATE_TOKEN'); process.exit(1); }

const hubspot = new Client({ accessToken: TOKEN });
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── CLI args ─────────────────────────────────────────────────────────────────

function getArg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : null;
}

const SINGLE_DEAL = getArg('deal');
const CUTOFF      = getArg('cutoff') || '2025-01-01';
const DRY_RUN     = !process.argv.includes('--execute');

// ─── Pipeline / Stage constants ───────────────────────────────────────────────

// Automático
const AUTO_PIPELINE     = process.env.BILLING_AUTOMATED_PIPELINE_ID || process.env.BILLING_AUTOMATED_PIPELINE || '829156883';
const AUTO_READY        = process.env.BILLING_AUTOMATED_READY       || '1311404151';
const AUTO_CREATED      = process.env.BILLING_AUTOMATED_CREATED     || '1330252332';
const AUTO_FORECAST_85  = process.env.BILLING_AUTOMATED_FORECAST_85 || '1330252330';
const AUTO_FORECAST_95  = process.env.BILLING_AUTOMATED_FORECAST_95 || '1330252331';
const AUTO_CANCELLED    = process.env.BILLING_AUTOMATED_CANCELLED   || '1330252335';
const AUTO_LATE         = process.env.BILLING_AUTOMATED_LATE        || '1330252333';
const AUTO_PAID         = process.env.BILLING_AUTOMATED_PAID        || '1330252334';

// Manual
const MANUAL_PIPELINE   = process.env.BILLING_TICKET_PIPELINE_ID    || '832539959';
const MANUAL_READY      = process.env.BILLING_TICKET_STAGE_READY    || '';
const MANUAL_NEW        = process.env.BILLING_TICKET_STAGE_ID       || '';
const MANUAL_BILLED     = process.env.BILLING_TICKET_STAGE_ID_BILLED   || '';
const MANUAL_CREATED    = process.env.BILLING_TICKET_STAGE_ID_CREATED  || '';
const MANUAL_LATE       = process.env.BILLING_TICKET_STAGE_ID_LATE     || '';
const MANUAL_PAID       = process.env.BILLING_TICKET_PIPELINE_ID_PAID  || '';
const MANUAL_CANCELLED  = process.env.BILLING_TICKET_STAGE_CANCELLED   || '';
const MANUAL_FORECAST_85 = process.env.BILLING_TICKET_FORECAST_85      || '';
const MANUAL_FORECAST_95 = process.env.BILLING_TICKET_FORECAST_95      || '';

// Stage sets
const FORECAST_STAGES = new Set([
  AUTO_FORECAST_85, AUTO_FORECAST_95,
  MANUAL_FORECAST_85, MANUAL_FORECAST_95,
].filter(Boolean));

const CANCELLED_STAGES = new Set([AUTO_CANCELLED, MANUAL_CANCELLED].filter(Boolean));

const READY_STAGES = new Set([AUTO_READY, MANUAL_READY, MANUAL_NEW].filter(Boolean));

const INVOICED_STAGES = new Set([
  AUTO_CREATED, AUTO_LATE, AUTO_PAID,
  MANUAL_CREATED, MANUAL_BILLED, MANUAL_LATE, MANUAL_PAID,
].filter(Boolean));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toYmd(raw) {
  if (!raw) return '';
  const s = String(raw).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return s.slice(0, 10);
  const ms = Number(s);
  if (!Number.isNaN(ms) && ms > 0) return new Date(ms).toISOString().slice(0, 10);
  return '';
}

function getTodayYMD() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Montevideo' });
}

function isAutoPipeline(ticket) {
  return String(ticket?.properties?.hs_pipeline || '') === AUTO_PIPELINE;
}

// ─── Findings collector ───────────────────────────────────────────────────────

const findings = [];

function addFinding(type, severity, data) {
  findings.push({ type, severity, timestamp: new Date().toISOString(), ...data });
}

// ─── Fetchers ─────────────────────────────────────────────────────────────────

async function fetchTargetDeals() {
  if (SINGLE_DEAL) {
    const deal = await hubspot.crm.deals.basicApi.getById(SINGLE_DEAL, [
      'dealname', 'facturacion_activa', 'facturacion_automatica', 'pais_operativo', 'deal_currency_code',
    ]);
    return [deal];
  }

  const all = [];
  let after;
  do {
    const body = {
      filterGroups: [{
        filters: [
          { propertyName: 'facturacion_activa', operator: 'EQ', value: 'true' },
        ],
      }],
      properties: ['dealname', 'facturacion_activa', 'facturacion_automatica', 'pais_operativo', 'deal_currency_code'],
      sorts: [{ propertyName: 'hs_object_id', direction: 'ASCENDING' }],
      limit: 100,
    };
    if (after) body.after = after;
    const resp = await hubspot.crm.deals.searchApi.doSearch(body);
    all.push(...(resp?.results || []));
    after = resp?.paging?.next?.after;
    if (after) await sleep(200);
  } while (after);

  return all;
}

async function fetchLineItemsForDeal(dealId) {
  // 1) Traer TODAS las asociaciones, paginando (getPage corta en 100)
  const liIds = [];
  let assocAfter;
  do {
    const assocResp = await hubspot.crm.associations.v4.basicApi.getPage(
      'deals', String(dealId), 'line_items', assocAfter, 100
    );
    for (const r of (assocResp?.results || [])) {
      liIds.push(String(r.toObjectId));
    }
    assocAfter = assocResp?.paging?.next?.after;
    if (assocAfter) await sleep(150);
  } while (assocAfter);

  if (!liIds.length) return [];

  const props = [
    'name', 'line_item_key', 'facturacion_automatica',
    'price', 'quantity', 'amount',
    'recurringbillingfrequency', 'hs_recurring_billing_frequency',
    'hs_recurring_billing_start_date', 'fecha_inicio_de_facturacion',
    'hs_recurring_billing_number_of_payments',
    'renovacion_automatica', 'pagos_emitidos',
    'facturas_restantes', 'fechas_completas', 'progreso_pagos',
  ];

  // 2) Leer en lotes de 100 (batchApi.read tope = 100)
  const results = [];
  for (let i = 0; i < liIds.length; i += 100) {
    const batch = await hubspot.crm.lineItems.batchApi.read({
      inputs: liIds.slice(i, i + 100).map(id => ({ id })),
      properties: props,
    });
    results.push(...(batch?.results || []));
    if (i + 100 < liIds.length) await sleep(150);
  }

  return results;
}

async function fetchTicketsForLIK(lik) {
  const all = [];
  let after;
  do {
    const body = {
      filterGroups: [{
        filters: [
          { propertyName: 'of_line_item_key', operator: 'EQ', value: lik },
        ],
      }],
      properties: [
        'subject', 'hs_pipeline', 'hs_pipeline_stage',
        'of_ticket_key', 'of_line_item_key', 'of_deal_id', 'of_line_item_ids',
        'of_invoice_id', 'of_invoice_key', 'numero_de_factura',
        'of_fecha_de_facturacion', 'fecha_resolucion_esperada',
        'fecha_real_de_facturacion',
        'of_pais_operativo', 'of_monto_total', 'subtotal_real',
        'of_cantidad', 'total_real_a_facturar', 'cantidad_real', 'monto_unitario_real',
        'descuento_en_porcentaje', 'descuento_por_unidad_real',
        'of_iva', 'exonera_irae', 'of_moneda',
      ],
      limit: 100,
    };
    if (after) body.after = after;
    const resp = await hubspot.crm.tickets.searchApi.doSearch(body);
    all.push(...(resp?.results || []));
    after = resp?.paging?.next?.after;
    if (after) await sleep(150);
  } while (after);
  return all;
}

// ─── Association repair ───────────────────────────────────────────────────────

async function ensureTicketDealAssociation(ticketId, dealId) {
  try {
    const existing = await hubspot.crm.associations.v4.basicApi.getPage(
      'tickets', String(ticketId), 'deals', undefined, 10
    );
    const hasAssoc = (existing?.results || []).some(
      r => String(r.toObjectId) === String(dealId)
    );
    if (hasAssoc) return { repaired: false };

    if (DRY_RUN) return { repaired: true, dryRun: true };

    await hubspot.crm.associations.v4.basicApi.create(
      'tickets', String(ticketId), 'deals', String(dealId), []
    );
    return { repaired: true };
  } catch (err) {
    addFinding('ASSOC_REPAIR_ERROR', 'error', { ticketId, dealId, error: err.message });
    return { repaired: false, error: err.message };
  }
}

// ─── Seal logic ───────────────────────────────────────────────────────────────

async function sealPreCutoff(ticket) {
  const ticketId = ticket.id;
  const isAuto = isAutoPipeline(ticket);
  const targetStage = isAuto ? AUTO_CREATED : (MANUAL_BILLED || MANUAL_CREATED);

  const props = { hs_pipeline_stage: targetStage };

  // Solo automático lleva numero_de_factura = 11
  if (isAuto) {
    props.numero_de_factura = '11';
  }

  if (DRY_RUN) return { action: 'SEAL_PRE', ticketId, pipeline: isAuto ? 'AUTO' : 'MANUAL', dryRun: true };

  await hubspot.crm.tickets.basicApi.update(String(ticketId), { properties: props });
  return { action: 'SEAL_PRE', ticketId, pipeline: isAuto ? 'AUTO' : 'MANUAL' };
}

async function sealPostCutoff(ticket, dealId, dealCurrency) {

  const ticketId = ticket.id;
  const tp = ticket.properties || {};
  const isAuto = isAutoPipeline(ticket);
  const targetStage = isAuto ? AUTO_CREATED : (MANUAL_BILLED || MANUAL_CREATED);

  if (DRY_RUN) return { action: 'SEAL_POST', ticketId, pipeline: isAuto ? 'AUTO' : 'MANUAL', dryRun: true };

  if (!dealCurrency) {
    addFinding('DEAL_SIN_CURRENCY', 'error', { ticketId, dealId, fecha: toYmd(tp.of_fecha_de_facturacion) });
    throw new Error(`Deal ${dealId} sin deal_currency_code — no se puede crear invoice`);
  }

  const invoiceKey = tp.of_ticket_key || '';
  const todayYmd = getTodayYMD();
  const baseDate = new Date(todayYmd + 'T12:00:00Z');
  baseDate.setUTCDate(baseDate.getUTCDate() + 10);
  const dueDateYmd = baseDate.toISOString().slice(0, 10);

const invoiceProps = {
    hs_title: tp.subject || 'Factura migración Mansoft',
    of_invoice_key: invoiceKey,
    ticket_id: String(ticketId),
    line_item_key: tp.of_line_item_key || '',
    etapa_de_la_factura: 'Pendiente',
    fecha_de_emision: todayYmd,
    hs_invoice_date: todayYmd,
    hs_due_date: dueDateYmd,
    pais_operativo: tp.of_pais_operativo || '',
    // FREEZE RULE: montos del ticket
    monto_a_facturar: tp.total_real_a_facturar || '0',
    hs_amount_billed: tp.total_real_a_facturar || '0',
    cantidad: tp.cantidad_real || tp.of_cantidad || '1',
    monto_unitario: tp.monto_unitario_real || '',
    descuento: tp.descuento_en_porcentaje || '',
    descuento_por_unidad: tp.descuento_por_unidad_real || '',
    iva: tp.of_iva || 'false',
    exonera_irae: tp.exonera_irae || '',
    hs_currency: dealCurrency || '',
  };

  // Solo automático lleva id_factura_nodum = 11
  if (isAuto) {
    invoiceProps.id_factura_nodum = '11';
  }

  let invoiceId;
  try {
    const resp = await hubspot.crm.objects.basicApi.create('invoices', { properties: invoiceProps });
    invoiceId = resp.id;
  } catch (err) {
    addFinding('INVOICE_CREATE_ERROR', 'error', { ticketId, dealId, error: err.message });
    throw err;
  }

  // Actualizar ticket
  await hubspot.crm.tickets.basicApi.update(String(ticketId), {
    properties: {
      hs_pipeline_stage: targetStage,
      of_invoice_id: String(invoiceId),
      of_invoice_key: invoiceKey,
      fecha_real_de_facturacion: todayYmd,
    },
  });

  // Asociaciones invoice → deal, invoice → ticket
  try {
    await hubspot.crm.associations.v4.basicApi.create('invoices', String(invoiceId), 'deals', String(dealId), []);
  } catch (err) {
    addFinding('INVOICE_ASSOC_ERROR', 'warn', { invoiceId, dealId, error: err.message });
  }
  try {
    await hubspot.crm.associations.v4.basicApi.create('invoices', String(invoiceId), 'tickets', String(ticketId), []);
  } catch (err) {
    addFinding('INVOICE_ASSOC_ERROR', 'warn', { invoiceId, ticketId, error: err.message });
  }

  await sleep(150);
  return { action: 'SEAL_POST', ticketId, invoiceId, pipeline: isAuto ? 'AUTO' : 'MANUAL' };
}

// ─── Recalc counters ──────────────────────────────────────────────────────────

async function recalcLICounters(lineItem, lik, dealId) {
  const lp = lineItem.properties || {};
  const liId = lineItem.id;

  const isAR = String(lp.renovacion_automatica || '').toLowerCase() === 'true' ||
    !(parseInt(String(lp.hs_recurring_billing_number_of_payments || ''), 10) > 0);

  // Contar tickets en INVOICED_STAGES
  let countInvoiced = 0;
  let after;
  do {
    const body = {
      filterGroups: [{
        filters: [
          { propertyName: 'of_line_item_key', operator: 'EQ', value: lik },
        ],
      }],
      properties: ['hs_pipeline_stage'],
      limit: 100,
    };
    if (after) body.after = after;
    const resp = await hubspot.crm.tickets.searchApi.doSearch(body);
    for (const t of (resp?.results || [])) {
      if (INVOICED_STAGES.has(String(t.properties?.hs_pipeline_stage || ''))) {
        countInvoiced++;
      }
    }
    after = resp?.paging?.next?.after;
    if (after) await sleep(150);
  } while (after);

  const cuotasTotales = parseInt(String(lp.hs_recurring_billing_number_of_payments || ''), 10);
  const propsToUpdate = {};

  if (isAR) {
    if (String(lp.facturas_restantes || '').trim() !== '') propsToUpdate.facturas_restantes = '';
    if (String(lp.progreso_pagos || '').trim() !== '') propsToUpdate.progreso_pagos = '';
  } else if (Number.isFinite(cuotasTotales) && cuotasTotales > 0) {
    const restantes = Math.max(0, cuotasTotales - countInvoiced);
    propsToUpdate.facturas_restantes = String(restantes);
    if (restantes === 0) propsToUpdate.fechas_completas = 'true';
    const emitidas = Math.min(countInvoiced, cuotasTotales);
    const filled = Math.round((emitidas / cuotasTotales) * 10);
    propsToUpdate.progreso_pagos = `${'█'.repeat(filled)}${'░'.repeat(10 - filled)} ${emitidas} / ${cuotasTotales}`;
  }

  propsToUpdate.pagos_emitidos = String(countInvoiced);

  if (DRY_RUN) {
    return { liId, dryRun: true, wouldUpdate: propsToUpdate, countInvoiced, cuotasTotales: isAR ? null : cuotasTotales };
  }

  if (Object.keys(propsToUpdate).length > 0) {
    await hubspot.crm.lineItems.basicApi.update(String(liId), { properties: propsToUpdate });
  }

  return { liId, updated: propsToUpdate, countInvoiced, cuotasTotales: isAR ? null : cuotasTotales };
}

// ─── LI validation ────────────────────────────────────────────────────────────

function validateLineItem(li, dealId) {
  const lp = li.properties || {};
  const lik = (lp.line_item_key || '').trim();

  if (!lik) {
    addFinding('LI_SIN_LIK', 'error', { dealId, liId: li.id, liName: lp.name });
    return false;
  }

  const startYmd = toYmd(lp.hs_recurring_billing_start_date) || toYmd(lp.fecha_inicio_de_facturacion);
  if (!startYmd) {
    addFinding('LI_SIN_FECHA_INICIO', 'warn', { dealId, liId: li.id, liName: lp.name, lik });
  }

  const price = parseFloat(lp.price);
  if (!Number.isFinite(price) || price === 0) {
    addFinding('LI_SIN_MONTO', 'warn', { dealId, liId: li.id, liName: lp.name, lik, price: lp.price });
  }

  return true;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const startTime = Date.now();

  console.log('═'.repeat(70));
  console.log('  🔧 SEAL HISTORIC TICKETS — Post-migración Mansoft');
  console.log(`  Fecha:   ${getTodayYMD()}`);
  console.log(`  Corte:   ${CUTOFF}`);
  console.log(`  Modo:    ${DRY_RUN ? '🔍 DRY RUN (--execute para ejecutar)' : '🚀 EJECUCIÓN REAL'}`);
  console.log(`  Scope:   ${SINGLE_DEAL ? `Deal ${SINGLE_DEAL}` : 'Todos los deals'}`);
  console.log('═'.repeat(70));
  console.log();

  const stats = {
    dealsProcessed: 0,
    dealsSkipped: 0,
    lisProcessed: 0,
    lisSkipped: 0,
    ticketsSealedPreAuto: 0,
    ticketsSealedPreManual: 0,
    ticketsSealedPostAuto: 0,
    ticketsSealedPostManual: 0,
    ticketsAlreadySealed: 0,
    ticketsForecast: 0,
    associationsRepaired: 0,
    errors: 0,
  };

  const deals = await fetchTargetDeals();
  console.log(`📦 ${deals.length} deal(s) a procesar\n`);

  for (const deal of deals) {
    const dealId = deal.id;
    const dp = deal.properties || {};
    console.log('─'.repeat(70));
    console.log(`  📋 Deal ${dealId} — ${dp.dealname || '(sin nombre)'}`);

    let lineItems;
    try {
      lineItems = await fetchLineItemsForDeal(dealId);
    } catch (err) {
      addFinding('DEAL_FETCH_LI_ERROR', 'error', { dealId, error: err.message });
      stats.errors++;
      continue;
    }

    if (!lineItems.length) {
      console.log('     (sin line items, skip)');
      addFinding('DEAL_SIN_LIS', 'info', { dealId, dealName: dp.dealname });
      stats.dealsSkipped++;
      continue;
    }

    console.log(`     ${lineItems.length} LI(s) encontrado(s)`);
    stats.dealsProcessed++;

    for (const li of lineItems) {
      const lp = li.properties || {};
      const lik = (lp.line_item_key || '').trim();
      const liName = lp.name || li.id;
      const isAutoLI = String(lp.facturacion_automatica || '').toLowerCase() === 'true';

      console.log();
      console.log(`     📦 LI ${li.id} — ${liName} [${isAutoLI ? 'AUTO' : 'MANUAL'}]`);

      // Validación
      if (!validateLineItem(li, dealId)) {
        console.log('        ⚠️  Sin line_item_key, skip');
        stats.lisSkipped++;
        continue;
      }

      let tickets;
      try {
        tickets = await fetchTicketsForLIK(lik);
      } catch (err) {
        addFinding('TICKET_FETCH_ERROR', 'error', { dealId, liId: li.id, lik, error: err.message });
        stats.errors++;
        continue;
      }

      // Detectar tickets huérfanos (of_deal_id no matchea)
      for (const t of tickets) {
        const tp = t.properties || {};
        const ticketDealId = String(tp.of_deal_id || '').trim();
        if (ticketDealId && ticketDealId !== String(dealId)) {
          addFinding('TICKET_HUERFANO', 'warn', {
            ticketId: t.id, lik, expectedDealId: dealId, actualDealId: ticketDealId,
          });
        }
      }

      // Filtrar tickets a sellar
      const ticketsToSeal = tickets.filter(t => {
        const tp = t.properties || {};
        const stage = String(tp.hs_pipeline_stage || '');
        if (CANCELLED_STAGES.has(stage)) return false;
        if (FORECAST_STAGES.has(stage)) { stats.ticketsForecast++; return false; }
        if (!READY_STAGES.has(stage)) return false;
        if (tp.of_invoice_id || tp.numero_de_factura) { stats.ticketsAlreadySealed++; return false; }
        return true;
      });

      console.log(`        Tickets totales: ${tickets.length} | A sellar: ${ticketsToSeal.length}`);

      // Ordenar cronológicamente
      ticketsToSeal.sort((a, b) => {
        const fa = toYmd(a.properties?.of_fecha_de_facturacion) || '';
        const fb = toYmd(b.properties?.of_fecha_de_facturacion) || '';
        return fa.localeCompare(fb);
      });

      for (const ticket of ticketsToSeal) {
        const tp = ticket.properties || {};
        const fechaBilling = toYmd(tp.of_fecha_de_facturacion) || toYmd(tp.fecha_resolucion_esperada) || '';
        const isAuto = isAutoPipeline(ticket);
        const pipeLabel = isAuto ? 'AUTO' : 'MANUAL';

        // 1. Reparar asociación
        try {
          const assocResult = await ensureTicketDealAssociation(ticket.id, dealId);
          if (assocResult.repaired) {
            stats.associationsRepaired++;
            console.log(`        🔗 Asociación reparada: ticket ${ticket.id} → deal ${dealId}${assocResult.dryRun ? ' (dry)' : ''}`);
          }
        } catch (err) { /* already logged in finding */ }

        // 2. Sellar
        try {
          if (fechaBilling < CUTOFF) {
            const result = await sealPreCutoff(ticket);
            if (isAuto) stats.ticketsSealedPreAuto++; else stats.ticketsSealedPreManual++;
            const nroStr = isAuto ? ' nro=11' : '';
            console.log(`        [SEAL-PRE]  ${fechaBilling} [${pipeLabel}] → CREATED${nroStr}  ticket:${ticket.id}${result.dryRun ? ' (dry)' : ''}`);
          } else if (isAuto) {
            const result = await sealPostCutoff(ticket, dealId, dp.deal_currency_code);
            stats.ticketsSealedPostAuto++;
            const invStr = result.invoiceId ? ` inv:${result.invoiceId}` : '';
            console.log(`        [SEAL-POST] ${fechaBilling} [AUTO] → invoice nodum=11${invStr}  ticket:${ticket.id}${result.dryRun ? ' (dry)' : ''}`);
          } else {
            if (!DRY_RUN) {
              await hubspot.crm.tickets.basicApi.update(String(ticket.id), {
                properties: { hs_pipeline_stage: MANUAL_READY || MANUAL_NEW },
              });
            }
            stats.ticketsSealedPostManual++;
            console.log(`        [SEAL-POST] ${fechaBilling} [MANUAL] → READY (próximos a facturar)  ticket:${ticket.id}${DRY_RUN ? ' (dry)' : ''}`);
          }
        } catch (err) {
          addFinding('SEAL_ERROR', 'error', { dealId, liId: li.id, ticketId: ticket.id, fecha: fechaBilling, error: err.message });
          stats.errors++;
        }
        await sleep(200);
      }

      // 3. Recalcular contadores
      if (ticketsToSeal.length > 0) {
        try {
          const liFresh = await hubspot.crm.lineItems.basicApi.getById(String(li.id), [
            'name', 'line_item_key', 'facturacion_automatica',
            'renovacion_automatica', 'hs_recurring_billing_number_of_payments',
            'pagos_emitidos', 'facturas_restantes', 'fechas_completas', 'progreso_pagos',
          ]);

          const r = await recalcLICounters(liFresh, lik, dealId);

          if (r.cuotasTotales) {
            const props = r.updated || r.wouldUpdate || {};
            console.log(`        [RECALC] restantes: ${props.facturas_restantes ?? '—'} | completas: ${props.fechas_completas ?? '—'} | progreso: ${props.progreso_pagos ?? '—'}${r.dryRun ? ' (dry)' : ''}`);
          } else {
            console.log(`        [RECALC] auto-renew — contadores limpiados${r.dryRun ? ' (dry)' : ''}`);
          }
        } catch (err) {
          addFinding('RECALC_ERROR', 'error', { dealId, liId: li.id, error: err.message });
          stats.errors++;
        }
      }

      stats.lisProcessed++;
      await sleep(300);
    }
  }

  // ─── Reporte JSON ──────────────────────────────────────────────────────────
  const reportFilename = `seal-report-${getTodayYMD()}.json`;
  const report = {
    generatedAt: new Date().toISOString(),
    mode: DRY_RUN ? 'DRY_RUN' : 'EXECUTE',
    cutoff: CUTOFF,
    scope: SINGLE_DEAL || 'ALL',
    stats,
    findings,
  };

  writeFileSync(reportFilename, JSON.stringify(report, null, 2));
  console.log();
  console.log(`📄 Reporte guardado: ${reportFilename}`);

  // ─── Resumen ───────────────────────────────────────────────────────────────
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log();
  console.log('═'.repeat(70));
  console.log('  📊 RESUMEN');
  console.log('═'.repeat(70));
  console.log(`  Modo:                       ${DRY_RUN ? 'DRY RUN' : 'EJECUCIÓN REAL'}`);
  console.log(`  Deals procesados/skipped:   ${stats.dealsProcessed} / ${stats.dealsSkipped}`);
  console.log(`  LIs procesados/skipped:     ${stats.lisProcessed} / ${stats.lisSkipped}`);
  console.log(`  Sellados PRE  AUTO:         ${stats.ticketsSealedPreAuto}`);
  console.log(`  Sellados PRE  MANUAL:       ${stats.ticketsSealedPreManual}`);
  console.log(`  Sellados POST AUTO:         ${stats.ticketsSealedPostAuto}`);
  console.log(`  Sellados POST MANUAL:       ${stats.ticketsSealedPostManual}`);
  console.log(`  Ya sellados (skip):         ${stats.ticketsAlreadySealed}`);
  console.log(`  Forecast (no tocados):      ${stats.ticketsForecast}`);
  console.log(`  Asociaciones reparadas:     ${stats.associationsRepaired}`);
  console.log(`  Errores:                    ${stats.errors}`);
  console.log(`  Hallazgos en reporte:       ${findings.length}`);
  console.log(`  Duración:                   ${elapsed}s`);
  console.log('═'.repeat(70));

  if (DRY_RUN && (stats.ticketsSealedPreAuto + stats.ticketsSealedPreManual + stats.ticketsSealedPostAuto + stats.ticketsSealedPostManual) > 0) {
    console.log();
    console.log('  💡 Para ejecutar de verdad, agregá --execute');
  }
}

main().catch(err => {
  console.error('\n❌ Error fatal:', err.message);
  if (err.response?.data) console.error(JSON.stringify(err.response.data, null, 2));
  process.exit(1);
});
