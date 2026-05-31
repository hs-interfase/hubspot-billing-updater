#!/usr/bin/env node
/**
 * matchOrphanInvoices.mjs
 *
 * Para los 4 deals con facturas huérfanas (ticket no existe):
 * 1. Busca todos los tickets que SÍ existen para ese LI (por of_line_item_key)
 * 2. Extrae la fecha de período de la invoice_key de cada factura huérfana
 * 3. Cruza: ¿hay un ticket existente para ese mismo período?
 * 4. Reporta: match encontrado (se puede re-vincular) o no (hay que borrar y re-generar)
 *
 * Uso:
 *   node matchOrphanInvoices.mjs
 */

import 'dotenv/config';
import { Client } from '@hubspot/api-client';
import { readFileSync, writeFileSync } from 'fs';

const TOKEN = process.env.HUBSPOT_PRIVATE_TOKEN;
if (!TOKEN) { console.error('❌ Falta HUBSPOT_PRIVATE_TOKEN'); process.exit(1); }

const hubspot = new Client({ accessToken: TOKEN });
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── Datos de las facturas huérfanas (del diagnóstico) ──────────────────────

const ORPHAN_DEALS = {
  '60565451418': { liId: '55536457898' },
  '60562559136': { liId: '55518811168' },
  '60557535094': { liId: '55532592400' },
  '60564251255': { liId: '55536457891' },
};

// Cargar facturas huérfanas del reporte de diagnóstico
function loadOrphans() {
  try {
    const data = JSON.parse(readFileSync('diagnose-report-2026-05-24.json', 'utf-8'));
    return data.issues.filter(i => i.type === 'INVOICE_TICKET_FANTASMA');
  } catch {
    console.error('❌ No se encontró diagnose-report-2026-05-24.json — poné el archivo en el directorio actual');
    process.exit(1);
  }
}

// Extraer fecha de período de la invoice_key
// Formato: dealId::LIK:dealId:liId:hash::YYYY-MM-DD
function extractPeriodDate(invoiceKey) {
  if (!invoiceKey) return null;
  const match = invoiceKey.match(/::(\d{4}-\d{2}-\d{2})$/);
  return match ? match[1] : null;
}

// ─── Fetchers ────────────────────────────────────────────────────────────────

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
        'of_ticket_key', 'of_line_item_key',
        'of_fecha_de_facturacion', 'fecha_resolucion_esperada',
        'of_invoice_id', 'of_invoice_key', 'numero_de_factura',
        'total_real_a_facturar', 'subtotal_real',
        'of_monto_total', 'of_cantidad',
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

async function fetchLineItem(liId) {
  return hubspot.crm.lineItems.basicApi.getById(liId, [
    'name', 'line_item_key', 'price', 'quantity', 'amount',
    'facturacion_automatica', 'hs_recurring_billing_number_of_payments',
    'fecha_inicio_de_facturacion', 'recurringbillingfrequency',
  ]);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const orphans = loadOrphans();
  console.log('═'.repeat(70));
  console.log('  🔍 MATCH ORPHAN INVOICES vs EXISTING TICKETS');
  console.log(`  Facturas huérfanas: ${orphans.length}`);
  console.log('═'.repeat(70));
  console.log();

  const results = [];

  for (const [dealId, info] of Object.entries(ORPHAN_DEALS)) {
    const dealOrphans = orphans.filter(o => o.dealId === dealId);
    console.log('─'.repeat(70));
    console.log(`  📋 Deal ${dealId} — ${dealOrphans.length} facturas huérfanas`);

    // Leer LI para obtener LIK
    let li;
    try {
      li = await fetchLineItem(info.liId);
    } catch (err) {
      console.error(`     ❌ No se pudo leer LI ${info.liId}: ${err.message}`);
      continue;
    }

    const lik = (li.properties?.line_item_key || '').trim();
    console.log(`     LI: ${li.properties?.name} (LIK: ${lik})`);

    // Buscar tickets existentes
    const tickets = await fetchTicketsByLIK(lik);
    console.log(`     Tickets existentes: ${tickets.length}`);

    // Indexar tickets por fecha de facturación
    const ticketsByDate = new Map();
    for (const t of tickets) {
      const tp = t.properties || {};
      const fecha = (tp.of_fecha_de_facturacion || '').slice(0, 10);
      if (fecha) {
        ticketsByDate.set(fecha, {
          ticketId: t.id,
          fecha,
          hasInvoice: !!(tp.of_invoice_id || tp.numero_de_factura),
          monto: tp.total_real_a_facturar || tp.of_monto_total || '0',
          stage: tp.hs_pipeline_stage,
          ticketKey: tp.of_ticket_key,
        });
      }
    }

    console.log(`     Tickets indexados por fecha: ${ticketsByDate.size}`);
    console.log();

    // Cruzar cada factura huérfana
    let matched = 0;
    let unmatched = 0;

    for (const orphan of dealOrphans) {
      const periodDate = extractPeriodDate(orphan.invoiceKey);
      const ticketMatch = periodDate ? ticketsByDate.get(periodDate) : null;

      const result = {
        dealId,
        invoiceId: orphan.invoiceId,
        invoiceKey: orphan.invoiceKey,
        deadTicketId: orphan.ticketId,
        periodDate,
      };

      if (ticketMatch) {
        matched++;
        result.status = 'MATCH_FOUND';
        result.matchedTicketId = ticketMatch.ticketId;
        result.ticketHasInvoice = ticketMatch.hasInvoice;
        result.ticketMonto = ticketMatch.monto;
        result.action = ticketMatch.hasInvoice
          ? 'TICKET_YA_TIENE_FACTURA — borrar factura huérfana'
          : 'RE-VINCULAR factura a este ticket';
        console.log(`     ✅ Factura ${orphan.invoiceId} (${periodDate}) → ticket ${ticketMatch.ticketId} ${ticketMatch.hasInvoice ? '⚠️ YA TIENE FACTURA' : '🔗 disponible para vincular'}`);
      } else {
        unmatched++;
        result.status = 'NO_MATCH';
        result.action = 'BORRAR factura — no hay ticket para este período';
        console.log(`     ❌ Factura ${orphan.invoiceId} (${periodDate}) → NO HAY TICKET para este período`);
      }

      results.push(result);
    }

    console.log();
    console.log(`     Resumen: ${matched} con match, ${unmatched} sin match`);
    await sleep(300);
  }

  // ─── Resumen global ────────────────────────────────────────────────────────

  const totalMatched = results.filter(r => r.status === 'MATCH_FOUND').length;
  const revinculables = results.filter(r => r.status === 'MATCH_FOUND' && !r.ticketHasInvoice).length;
  const duplicados = results.filter(r => r.status === 'MATCH_FOUND' && r.ticketHasInvoice).length;
  const sinMatch = results.filter(r => r.status === 'NO_MATCH').length;

  console.log();
  console.log('═'.repeat(70));
  console.log('  📊 RESUMEN GLOBAL');
  console.log('═'.repeat(70));
  console.log(`  Total facturas huérfanas:     ${results.length}`);
  console.log(`  Con ticket existente:          ${totalMatched}`);
  console.log(`    → Re-vinculables:            ${revinculables}`);
  console.log(`    → Ticket ya tiene factura:   ${duplicados} (borrar factura huérfana)`);
  console.log(`  Sin ticket para el período:    ${sinMatch} (borrar factura)`);
  console.log('═'.repeat(70));

  const filename = `orphan-match-report-${new Date().toISOString().slice(0, 10)}.json`;
  writeFileSync(filename, JSON.stringify(results, null, 2));
  console.log(`\n📄 Reporte: ${filename}`);
}

main().catch(err => {
  console.error('\n❌ Error fatal:', err.message);
  process.exit(1);
});
