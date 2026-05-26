#!/usr/bin/env node
/**
 * diagnoseSealIssues.mjs
 *
 * Diagnóstico post-sealHistoricTickets:
 * 1. Para cada deal → LIs → tickets por LIK
 * 2. Verifica asociaciones ticket↔deal
 * 3. Busca facturas con monto_a_facturar = 0 o null
 * 4. Detecta facturas que referencian tickets inexistentes
 * 5. Detecta facturas sin etapa "Emitida"
 *
 * Uso:
 *   node diagnoseSealIssues.mjs                           # todos los deals con facturacion_activa
 *   node diagnoseSealIssues.mjs --deal 60542271080        # un deal específico
 *   node diagnoseSealIssues.mjs --deals-file deals.txt    # lista de deal IDs (uno por línea)
 */

import 'dotenv/config';
import { Client } from '@hubspot/api-client';
import { writeFileSync } from 'fs';

const TOKEN = process.env.HUBSPOT_PRIVATE_TOKEN;
if (!TOKEN) { console.error('❌ Falta HUBSPOT_PRIVATE_TOKEN'); process.exit(1); }

const hubspot = new Client({ accessToken: TOKEN });
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── CLI ─────────────────────────────────────────────────────────────────────

function getArg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : null;
}

const SINGLE_DEAL = getArg('deal');

// Deal IDs del Excel "Tickets (22)"
const EXCEL_DEAL_IDS = [
  '60542271080', '60556770915', '60548268152', '60565451415',
  '60532555700', '60564550480', '60532555685', '60546441993',
  '60561645413', '60546441997', '60564550487', '60532555686',
  '60530699074', '60542271095', '60550121389', '60565451418',
  '60562559136', '60557535097', '60565014366', '60548268147',
  '60557535094', '60564251255',
];

// ─── Pipeline / Stage constants ──────────────────────────────────────────────

const AUTO_PIPELINE = process.env.BILLING_AUTOMATED_PIPELINE || '829156883';
const AUTO_CREATED  = process.env.BILLING_AUTOMATED_CREATED  || '1330252332';
const AUTO_CANCELLED = process.env.BILLING_AUTOMATED_CANCELLED || '1330252335';

const MANUAL_PIPELINE  = process.env.BILLING_TICKET_PIPELINE_ID || '832539959';
const MANUAL_BILLED    = process.env.BILLING_TICKET_STAGE_ID_BILLED || '';
const MANUAL_CANCELLED = process.env.BILLING_TICKET_STAGE_CANCELLED || '';

const CANCELLED_STAGES = new Set([AUTO_CANCELLED, MANUAL_CANCELLED].filter(Boolean));

const INVOICED_STAGES = new Set([
  AUTO_CREATED,
  process.env.BILLING_AUTOMATED_LATE || '1330252333',
  process.env.BILLING_AUTOMATED_PAID || '1330252334',
  MANUAL_BILLED,
  process.env.BILLING_TICKET_STAGE_ID_CREATED || '',
  process.env.BILLING_TICKET_STAGE_ID_LATE || '',
  process.env.BILLING_TICKET_PIPELINE_ID_PAID || '',
].filter(Boolean));

// ─── Helpers ─────────────────────────────────────────────────────────────────

function toYmd(raw) {
  if (!raw) return '';
  const s = String(raw).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return s.slice(0, 10);
  return '';
}

function safeNum(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

// ─── Fetchers ────────────────────────────────────────────────────────────────

async function fetchDeal(dealId) {
  return hubspot.crm.deals.basicApi.getById(dealId, [
    'dealname', 'facturacion_activa', 'pais_operativo', 'deal_currency_code', 'dealstage',
  ]);
}

async function fetchLineItemsForDeal(dealId) {
  const assoc = await hubspot.crm.associations.v4.basicApi.getPage(
    'deals', String(dealId), 'line_items', undefined, 100
  );
  const ids = (assoc?.results || []).map(r => String(r.toObjectId));
  if (!ids.length) return [];

  const batch = await hubspot.crm.lineItems.batchApi.read({
    inputs: ids.map(id => ({ id })),
    properties: [
      'name', 'line_item_key', 'facturacion_automatica',
      'price', 'quantity', 'amount',
      'hs_recurring_billing_number_of_payments',
      'hs_recurring_billing_start_date', 'fecha_inicio_de_facturacion',
      'recurringbillingfrequency',
      'pagos_emitidos', 'facturas_restantes',
    ],
  });
  return batch?.results || [];
}

async function fetchTicketsByLIK(lik) {
  const all = [];
  let after;
  do {
    const body = {
      filterGroups: [{ filters: [
        { propertyName: 'of_line_item_key', operator: 'EQ', value: lik },
      ]}],
      properties: [
        'subject', 'hs_pipeline', 'hs_pipeline_stage',
        'of_ticket_key', 'of_line_item_key', 'of_deal_id', 'of_line_item_ids',
        'of_invoice_id', 'of_invoice_key', 'numero_de_factura',
        'of_fecha_de_facturacion', 'fecha_resolucion_esperada',
        'total_real_a_facturar', 'subtotal_real', 'cantidad_real',
        'of_monto_total', 'of_cantidad',
        'of_pais_operativo', 'of_moneda',
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

async function fetchInvoicesForDeal(dealId) {
  const assoc = await hubspot.crm.associations.v4.basicApi.getPage(
    'deals', String(dealId), 'invoices', undefined, 100
  );
  const ids = (assoc?.results || []).map(r => String(r.toObjectId));
  if (!ids.length) return [];

  // Batch read en grupos de 100
  const all = [];
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const batch = await hubspot.crm.objects.batchApi.read('invoices', {
      inputs: chunk.map(id => ({ id })),
      properties: [
        'of_invoice_key', 'ticket_id', 'line_item_key',
        'etapa_de_la_factura', 'id_factura_nodum',
        'monto_a_facturar', 'hs_amount_billed', 'cantidad',
        'hs_invoice_date', 'hs_currency', 'hs_title',
        'pais_operativo', 'nombre_producto',
      ],
    });
    all.push(...(batch?.results || []));
    if (i + 100 < ids.length) await sleep(200);
  }
  return all;
}

async function ticketExists(ticketId) {
  try {
    await hubspot.crm.tickets.basicApi.getById(ticketId, ['hs_object_id']);
    return true;
  } catch (err) {
    if (err?.code === 404 || err?.response?.status === 404) return false;
    // Otro error (rate limit, etc) — asumir que existe para no generar falso positivo
    return true;
  }
}

async function getTicketDealAssociations(ticketId) {
  try {
    const resp = await hubspot.crm.associations.v4.basicApi.getPage(
      'tickets', String(ticketId), 'deals', undefined, 10
    );
    return (resp?.results || []).map(r => String(r.toObjectId));
  } catch {
    return [];
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const startTime = Date.now();
  const dealIds = SINGLE_DEAL ? [SINGLE_DEAL] : EXCEL_DEAL_IDS;

  console.log('═'.repeat(70));
  console.log('  🔍 DIAGNÓSTICO POST-SEAL');
  console.log(`  Deals a analizar: ${dealIds.length}`);
  console.log('═'.repeat(70));
  console.log();

  const report = {
    generatedAt: new Date().toISOString(),
    summary: { deals: 0, lis: 0, tickets: 0, invoices: 0 },
    issues: [],
    dealDetails: [],
  };

  for (const dealId of dealIds) {
    let deal;
    try {
      deal = await fetchDeal(dealId);
    } catch (err) {
      console.error(`  ❌ No se pudo leer deal ${dealId}: ${err.message}`);
      report.issues.push({ type: 'DEAL_NOT_FOUND', dealId, error: err.message });
      continue;
    }

    const dp = deal.properties || {};
    console.log('─'.repeat(70));
    console.log(`  📋 Deal ${dealId} — ${dp.dealname || '(sin nombre)'}`);

    const dealReport = {
      dealId,
      dealName: dp.dealname,
      pais: dp.pais_operativo,
      currency: dp.deal_currency_code,
      lineItems: [],
      invoices: [],
    };

    // ── Line Items + Tickets ──
    const lineItems = await fetchLineItemsForDeal(dealId);
    console.log(`     ${lineItems.length} LI(s)`);
    report.summary.deals++;

    for (const li of lineItems) {
      const lp = li.properties || {};
      const lik = (lp.line_item_key || '').trim();
      const isAuto = String(lp.facturacion_automatica || '').toLowerCase() === 'true';

      if (!lik) {
        console.log(`     ⚠️  LI ${li.id} (${lp.name}) sin LIK — skip`);
        continue;
      }

      report.summary.lis++;
      const tickets = await fetchTicketsByLIK(lik);
      report.summary.tickets += tickets.length;
      await sleep(200);

      const ticketsActivos = tickets.filter(t => !CANCELLED_STAGES.has(String(t.properties?.hs_pipeline_stage)));
      const ticketsInvoiced = ticketsActivos.filter(t => INVOICED_STAGES.has(String(t.properties?.hs_pipeline_stage)));

      // Verificar asociaciones
      let notAssociated = 0;
      for (const t of ticketsActivos.slice(0, 5)) { // sample de 5 para no saturar API
        const assocDeals = await getTicketDealAssociations(t.id);
        if (!assocDeals.includes(String(dealId))) {
          notAssociated++;
          report.issues.push({
            type: 'TICKET_NOT_ASSOCIATED',
            dealId, liId: li.id, lik, ticketId: t.id,
            ticketDate: toYmd(t.properties?.of_fecha_de_facturacion),
          });
        }
        await sleep(100);
      }

      // Tickets con monto 0
      const ticketsSinMonto = ticketsActivos.filter(t => {
        const total = safeNum(t.properties?.total_real_a_facturar);
        return total === null || total === 0;
      });

      const nPagos = parseInt(lp.hs_recurring_billing_number_of_payments || '0', 10);

      const liReport = {
        liId: li.id,
        name: lp.name,
        lik,
        isAuto,
        nPagos: nPagos || 'auto-renew',
        price: lp.price,
        ticketsTotal: tickets.length,
        ticketsActivos: ticketsActivos.length,
        ticketsInvoiced: ticketsInvoiced.length,
        ticketsSinMonto: ticketsSinMonto.length,
        ticketsNotAssociated: notAssociated,
      };

      if (ticketsSinMonto.length > 0) {
        report.issues.push({
          type: 'TICKETS_SIN_MONTO',
          dealId, liId: li.id, lik,
          count: ticketsSinMonto.length,
          ticketIds: ticketsSinMonto.map(t => t.id),
        });
      }

      console.log(`     📦 LI ${li.id} (${lp.name}) [${isAuto ? 'AUTO' : 'MANUAL'}]`);
      console.log(`        tickets: ${ticketsActivos.length} activos | ${ticketsInvoiced.length} facturados | ${ticketsSinMonto.length} sin monto | ${notAssociated} sin asociar`);

      dealReport.lineItems.push(liReport);
    }

    // ── Facturas del deal ──
    const invoices = await fetchInvoicesForDeal(dealId);
    report.summary.invoices += invoices.length;

    let invSinMonto = 0;
    let invPendiente = 0;
    let invTicketFantasma = 0;

    for (const inv of invoices) {
      const ip = inv.properties || {};
      const monto = safeNum(ip.monto_a_facturar);
      const etapa = ip.etapa_de_la_factura || '';
      const ticketId = ip.ticket_id || '';

      if (monto === null || monto === 0) {
        invSinMonto++;
        report.issues.push({
          type: 'INVOICE_SIN_MONTO',
          dealId, invoiceId: inv.id,
          etapa, ticketId,
          invoiceKey: ip.of_invoice_key,
          title: ip.hs_title,
        });
      }

      if (etapa !== 'Emitida' && etapa !== 'Enviada' && etapa !== 'Paga' && etapa !== 'Cancelada') {
        invPendiente++;
        report.issues.push({
          type: 'INVOICE_NO_EMITIDA',
          dealId, invoiceId: inv.id,
          etapa: etapa || '(vacía)',
          ticketId,
        });
      }

      // Verificar si el ticket referenciado existe
      if (ticketId) {
        const exists = await ticketExists(ticketId);
        if (!exists) {
          invTicketFantasma++;
          report.issues.push({
            type: 'INVOICE_TICKET_FANTASMA',
            dealId, invoiceId: inv.id,
            ticketId,
            invoiceKey: ip.of_invoice_key,
            monto: ip.monto_a_facturar,
            title: ip.hs_title,
          });
        }
        await sleep(100);
      }
    }

    console.log(`     📄 Facturas: ${invoices.length} total | ${invSinMonto} sin monto | ${invPendiente} no emitidas | ${invTicketFantasma} ticket fantasma`);

    dealReport.invoices = {
      total: invoices.length,
      sinMonto: invSinMonto,
      noEmitidas: invPendiente,
      ticketFantasma: invTicketFantasma,
    };

    report.dealDetails.push(dealReport);
    await sleep(300);
  }

  // ─── Resumen ───────────────────────────────────────────────────────────────

  // Agrupar issues por tipo
  const issueCounts = {};
  for (const issue of report.issues) {
    issueCounts[issue.type] = (issueCounts[issue.type] || 0) + 1;
  }
  report.issueSummary = issueCounts;

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log();
  console.log('═'.repeat(70));
  console.log('  📊 RESUMEN DIAGNÓSTICO');
  console.log('═'.repeat(70));
  console.log(`  Deals:     ${report.summary.deals}`);
  console.log(`  LIs:       ${report.summary.lis}`);
  console.log(`  Tickets:   ${report.summary.tickets}`);
  console.log(`  Facturas:  ${report.summary.invoices}`);
  console.log();
  console.log('  Issues encontrados:');
  for (const [type, count] of Object.entries(issueCounts)) {
    const emoji = type.includes('FANTASMA') ? '👻' :
                  type.includes('MONTO') ? '💰' :
                  type.includes('ASSOC') ? '🔗' :
                  type.includes('EMITIDA') ? '📋' : '⚠️';
    console.log(`    ${emoji} ${type}: ${count}`);
  }
  console.log();
  console.log(`  Duración: ${elapsed}s`);
  console.log('═'.repeat(70));

  // Guardar reporte
  const filename = `diagnose-report-${new Date().toISOString().slice(0, 10)}.json`;
  writeFileSync(filename, JSON.stringify(report, null, 2));
  console.log(`\n📄 Reporte guardado: ${filename}`);
}

main().catch(err => {
  console.error('\n❌ Error fatal:', err.message);
  if (err.response?.data) console.error(JSON.stringify(err.response.data, null, 2));
  process.exit(1);
});
