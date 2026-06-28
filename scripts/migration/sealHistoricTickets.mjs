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

// AUTO seal (2026-06-28 — reconstrucción): el cron en vivo ya crea, por cada período
// Mansoft AUTO, una invoice Pendiente (id_factura_nodum vacío) + ticket en pipeline AUTO.
// La conducta correcta NO es crear una invoice (la vieja lógica duplicaba) sino
// TRANSICIONAR la existente -> Emitida + id_factura_nodum=11, replicando Paso D:
// PATCH a la factura + runInvoiceNodumPipeline (propaga factura->ticket->deal).
const AUTO_NODUM_SENTINEL = process.env.AUTO_NODUM_SENTINEL || '11';
const PIPELINE_PATH = process.env.PIPELINE_PATH || '../../src/services/invoiceNodumPipeline.js';
let runInvoiceNodumPipeline = null; // import dinámico, solo si --execute

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

  // MANUAL (2026-06-28): NO se sella ni emite. Se reubica a forecast "Próximos a Facturar"
  // (MANUAL_NEW). Nunca READY, nunca invoice, nunca Emitido. Lo emitido manual lo hacen Paso C/D.
  if (!isAuto) {
    if (DRY_RUN) return { action: 'MANUAL_FORECAST', ticketId, pipeline: 'MANUAL', stage: MANUAL_NEW, dryRun: true };
    if (MANUAL_NEW) await hubspot.crm.tickets.basicApi.update(String(ticketId), { properties: { hs_pipeline_stage: MANUAL_NEW } });
    return { action: 'MANUAL_FORECAST', ticketId, pipeline: 'MANUAL' };
  }

  // AUTO: sella a CREATED + numero_de_factura=11 (sin cambios).
  const props = { hs_pipeline_stage: AUTO_CREATED, numero_de_factura: '11' };
  if (DRY_RUN) return { action: 'SEAL_PRE', ticketId, pipeline: 'AUTO', dryRun: true };
  await hubspot.crm.tickets.basicApi.update(String(ticketId), { properties: props });
  return { action: 'SEAL_PRE', ticketId, pipeline: 'AUTO' };
}

async function sealPostCutoff(ticket, dealId, dealCurrency) {

  const ticketId = ticket.id;
  const tp = ticket.properties || {};
  const isAuto = isAutoPipeline(ticket);
  const targetStage = AUTO_CREATED; // solo AUTO llega a crear/sellar invoice acá

  // MANUAL (2026-06-28): NO crea invoice ni emite. Se reubica a forecast (MANUAL_NEW).
  if (!isAuto) {
    if (DRY_RUN) return { action: 'MANUAL_FORECAST', ticketId, pipeline: 'MANUAL', stage: MANUAL_NEW, dryRun: true };
    if (MANUAL_NEW) await hubspot.crm.tickets.basicApi.update(String(ticketId), { properties: { hs_pipeline_stage: MANUAL_NEW } });
    return { action: 'MANUAL_FORECAST', ticketId, pipeline: 'MANUAL' };
  }

  // AUTO (2026-06-28): la emisión AUTO ya NO crea invoices acá — la vieja lógica CREABA
  // una invoice nueva y DUPLICABA con la que el cron en vivo ya genera. La invoice
  // Pendiente la crea el cron y la transiciona sealAutoInvoicesForDeal (Pendiente →
  // Emitida + id_factura_nodum). Si un ticket AUTO llega hasta acá (READY sin of_invoice_id),
  // es una anomalía: el cron todavía no generó su invoice. Se registra y se SALTEA
  // (no se crea nada, para no duplicar). `targetStage`/`dealCurrency` quedan sin uso.
  void targetStage; void dealCurrency;
  addFinding('AUTO_READY_SIN_INVOICE', 'warn', { ticketId, dealId, invoiceKey: tp.of_ticket_key || '' });
  return { action: 'AUTO_SKIP_NO_INVOICE', ticketId, pipeline: 'AUTO', skipped: true };
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

// ─── AUTO invoice transition (Pendiente → Emitida + nodum=11) ───────────────────
// Reemplaza el viejo sealPostCutoff AUTO (que CREABA invoices → duplicaba). Acá se
// transiciona la invoice que YA creó el cron, replicando Paso D / el editor / el motor:
// PATCH etapa=Emitida + id_factura_nodum=11, luego el pipeline de propagación.
// Idempotente: si la invoice ya está Emitida, skip. No toca invoices de tickets MANUAL
// (esas las emiten Paso C/D). No reescribe fechas (no hay fecha histórica en estos
// objetos): solo rellena fecha_de_emision con la hs_invoice_date que puso el cron.

const INVOICE_SEAL_PROPS = [
  'etapa_de_la_factura', 'id_factura_nodum', 'numero_de_factura', 'ticket_id',
  'of_invoice_key', 'line_item_key', 'hs_invoice_date', 'fecha_de_emision', 'hs_due_date',
];

async function getAllAssocIds(fromType, fromId, toType) {
  const ids = [];
  let after;
  do {
    const r = await hubspot.crm.associations.v4.basicApi.getPage(fromType, String(fromId), toType, after, 100);
    for (const x of (r?.results || [])) ids.push(String(x.toObjectId));
    after = r?.paging?.next?.after;
    if (after) await sleep(150);
  } while (after);
  return ids;
}

async function batchReadObjects(objType, ids, properties) {
  const out = [];
  for (let i = 0; i < ids.length; i += 100) {
    const r = await hubspot.crm.objects.batchApi.read(objType, {
      inputs: ids.slice(i, i + 100).map(id => ({ id })), properties,
    });
    out.push(...(r?.results || []));
    if (i + 100 < ids.length) await sleep(150);
  }
  return out;
}

async function sealAutoInvoicesForDeal(dealId, dp, stats) {
  let invoiceIds;
  try {
    invoiceIds = await getAllAssocIds('deals', dealId, 'invoices');
  } catch (err) {
    addFinding('AUTO_FETCH_INVOICES_ERROR', 'error', { dealId, error: err.message });
    stats.errors++; return;
  }
  if (!invoiceIds.length) return;

  let invoices, tickets;
  try {
    invoices = await batchReadObjects('invoices', invoiceIds, INVOICE_SEAL_PROPS);
    const tIds = await getAllAssocIds('deals', dealId, 'tickets');
    tickets = await batchReadObjects('tickets', tIds,
      ['hs_pipeline', 'hs_pipeline_stage', 'fecha_resolucion_esperada', 'of_fecha_de_facturacion', 'subject']);
  } catch (err) {
    addFinding('AUTO_READ_ERROR', 'error', { dealId, error: err.message });
    stats.errors++; return;
  }
  const tById = new Map(tickets.map(t => [String(t.id), t]));

  for (const inv of invoices) {
    const ip = inv.properties || {};
    const etapa = String(ip.etapa_de_la_factura || '').trim();
    const tkId = String(ip.ticket_id || '').trim();
    const tk = tById.get(tkId);
    const isAutoTicket = !!tk && String(tk.properties?.hs_pipeline || '') === AUTO_PIPELINE;

    if (etapa === 'Emitida') { stats.autoAlready++; continue; }   // idempotente
    if (etapa !== 'Pendiente') continue;                          // solo Pendiente
    if (!tkId) { addFinding('AUTO_INV_SIN_TICKET_ID', 'warn', { dealId, invoiceId: inv.id }); stats.autoSkipped++; continue; }
    if (!isAutoTicket) { stats.autoSkipped++; continue; }         // MANUAL → lo emiten Paso C/D

    // fecha_de_emision = la fecha MIGRADA del período (no la del cron). Para AUTO (motor)
    // vive en el ticket como fecha_resolucion_esperada (la misma que va en el título del
    // ticket); fallback of_fecha_de_facturacion. NO se tocan hs_invoice_date / hs_due_date.
    // Esto deja las AUTO consistentes con los manuales (Paso D usa la fecha histórica migrada).
    const tp = tk.properties || {};
    const periodo = toYmd(tp.fecha_resolucion_esperada) || toYmd(tp.of_fecha_de_facturacion);
    const invPatch = { etapa_de_la_factura: 'Emitida', id_factura_nodum: AUTO_NODUM_SENTINEL };
    if (periodo) {
      invPatch.fecha_de_emision = periodo;
    } else {
      addFinding('AUTO_SIN_FECHA_PERIODO', 'warn', { dealId, invoiceId: inv.id, ticketId: tkId });
    }
    const emisionTxt = periodo || '⚠️sin-fecha-migrada';

    if (DRY_RUN) {
      console.log(`        [AUTO-EMIT] inv ${inv.id} (ticket ${tkId}) Pendiente → Emitida nodum=${AUTO_NODUM_SENTINEL} | emision=${emisionTxt} (dry)`);
      stats.autoSealedDry++;
      continue;
    }

    try {
      await hubspot.crm.objects.basicApi.update('invoices', String(inv.id), { properties: invPatch });
      await runInvoiceNodumPipeline(String(inv.id), { id_factura_nodum: AUTO_NODUM_SENTINEL });
      console.log(`        [AUTO-EMIT] inv ${inv.id} (ticket ${tkId}) → Emitida nodum=${AUTO_NODUM_SENTINEL} | emision=${emisionTxt} ✓`);
      stats.autoSealed++;
    } catch (err) {
      addFinding('AUTO_SEAL_ERROR', 'error', { dealId, invoiceId: inv.id, ticketId: tkId, error: err.message });
      stats.errors++;
    }
    await sleep(200);
  }
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

  // El pipeline de propagación solo se necesita al escribir. Import dinámico tras
  // dotenv/config (token correcto). Correr desde la raíz del repo.
  if (!DRY_RUN) {
    try {
      ({ runInvoiceNodumPipeline } = await import(PIPELINE_PATH));
    } catch (e) {
      console.error(`❌ No pude importar runInvoiceNodumPipeline desde ${PIPELINE_PATH}: ${e.message}`);
      console.error('   Corré el seal desde la raíz del repo: node scripts/migration/sealHistoricTickets.mjs ...');
      process.exit(1);
    }
    if (typeof runInvoiceNodumPipeline !== 'function') {
      console.error(`❌ ${PIPELINE_PATH} no exporta runInvoiceNodumPipeline.`); process.exit(1);
    }
  }

  const stats = {
    dealsProcessed: 0,
    dealsSkipped: 0,
    autoSealed: 0,
    autoSealedDry: 0,
    autoAlready: 0,
    autoSkipped: 0,
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
            if (result.skipped) {
              console.log(`        [AUTO] ticket READY sin invoice (cron aún no la generó) → skip, ver findings  ticket:${ticket.id}`);
            } else {
              stats.ticketsSealedPostAuto++;
              const invStr = result.invoiceId ? ` inv:${result.invoiceId}` : '';
              console.log(`        [SEAL-POST] ${fechaBilling} [AUTO] → invoice nodum=11${invStr}  ticket:${ticket.id}${result.dryRun ? ' (dry)' : ''}`);
            }
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

    // ── AUTO: transicionar las invoices Pendiente que creó el cron (Mansoft AUTO) ──
    //    Pasada a nivel deal (invoice-driven), independiente del loop de LIs de arriba.
    await sealAutoInvoicesForDeal(dealId, dp, stats);
    await sleep(200);
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
  console.log(`  ── AUTO invoices (Pendiente → Emitida + nodum=${AUTO_NODUM_SENTINEL}) ──`);
  console.log(`  AUTO emitidas:              ${DRY_RUN ? stats.autoSealedDry + ' (dry)' : stats.autoSealed}`);
  console.log(`  AUTO ya Emitida (skip):     ${stats.autoAlready}`);
  console.log(`  AUTO skip (manual/sin tkt): ${stats.autoSkipped}`);
  console.log(`  Asociaciones reparadas:     ${stats.associationsRepaired}`);
  console.log(`  Errores:                    ${stats.errors}`);
  console.log(`  Hallazgos en reporte:       ${findings.length}`);
  console.log(`  Duración:                   ${elapsed}s`);
  console.log('═'.repeat(70));

  if (DRY_RUN && (stats.ticketsSealedPreAuto + stats.ticketsSealedPreManual + stats.ticketsSealedPostAuto + stats.ticketsSealedPostManual + stats.autoSealedDry) > 0) {
    console.log();
    console.log('  💡 Para ejecutar de verdad, agregá --execute');
  }
}

main().catch(err => {
  console.error('\n❌ Error fatal:', err.message);
  if (err.response?.data) console.error(JSON.stringify(err.response.data, null, 2));
  process.exit(1);
});
