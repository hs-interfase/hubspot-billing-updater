#!/usr/bin/env node
/**
 * auditOrphans.mjs
 *
 * Detecta invoices y tickets huérfanos:
 *   - Invoice huérfana: tiene line_item_key pero no existe ningún line_item con esa key.
 *   - Ticket huérfano: tiene of_line_item_key pero no existe ningún line_item con esa key.
 *
 * Las invoices huérfanas se listan para eliminación MANUAL en HubSpot.
 * Los tickets huérfanos se pueden eliminar automáticamente con --delete-tickets.
 *
 * Uso:
 *   node auditOrphans.mjs                  # solo detecta y reporta (safe)
 *   node auditOrphans.mjs --delete-tickets  # detecta y elimina tickets huérfanos
 */

import 'dotenv/config';
import { hubspotClient } from './src/hubspotClient.js';

const args = process.argv.slice(2);
const DELETE_TICKETS = args.includes('--delete-tickets');

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ─── HubSpot helpers ───────────────────────────────────────────────────────────

/**
 * Busca todos los objetos de un tipo con paginación automática.
 * filterGroups, properties y searchFn son el cuerpo de la búsqueda.
 */
async function searchAllPaginated(searchFn, filterGroups, properties, label) {
  const results = [];
  let after;
  while (true) {
    const body = {
      filterGroups,
      properties,
      limit: 100,
      ...(after ? { after } : {}),
    };
    const resp = await searchFn(body);
    results.push(...(resp.results || []));
    process.stdout.write(`\r   ${label}: ${results.length} leídos...`);
    if (resp.paging?.next?.after) {
      after = resp.paging.next.after;
      await sleep(150);
    } else break;
  }
  console.log(); // nueva línea tras el \r
  return results;
}

async function searchAllInvoices() {
  return searchAllPaginated(
    body => hubspotClient.crm.objects.searchApi.doSearch('invoices', body),
    [{ filters: [{ propertyName: 'line_item_key', operator: 'HAS_PROPERTY' }] }],
    ['line_item_key', 'invoice_key', 'etapa_de_la_factura'],
    'Invoices',
  );
}

async function searchAllTickets() {
  return searchAllPaginated(
    body => hubspotClient.crm.tickets.searchApi.doSearch(body),
    [{ filters: [{ propertyName: 'of_line_item_key', operator: 'HAS_PROPERTY' }] }],
    ['of_line_item_key', 'of_ticket_key', 'hs_pipeline_stage', 'subject', 'of_deal_id'],
    'Tickets',
  );
}

/** Devuelve true si existe al menos un line_item con esa line_item_key. */
async function lineItemExistsForLik(lik) {
  const resp = await hubspotClient.crm.objects.searchApi.doSearch('line_items', {
    filterGroups: [{
      filters: [{ propertyName: 'line_item_key', operator: 'EQ', value: lik }],
    }],
    properties: ['line_item_key'],
    limit: 1,
  });
  return (resp?.results?.length ?? 0) > 0;
}

async function safeDeleteTicket(ticketId) {
  try {
    await hubspotClient.crm.tickets.basicApi.archive(String(ticketId));
    return { ok: true };
  } catch (err) {
    const status = err?.statusCode ?? err?.code;
    if (status === 404) return { ok: true, alreadyGone: true };
    if (status === 429) {
      console.log('      ⏳ Rate limit, esperando 10s...');
      await sleep(10_000);
      return safeDeleteTicket(ticketId);
    }
    return { ok: false, message: err.message };
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  AUDIT DE HUÉRFANOS — invoices y tickets');
  if (DELETE_TICKETS) {
    console.log('  ⚠️  MODO: detectar y ELIMINAR tickets huérfanos');
  } else {
    console.log('  ℹ️  MODO: solo reporte');
    console.log('     (agregar --delete-tickets para eliminar tickets)');
  }
  console.log('═══════════════════════════════════════════════════════════\n');

  // ── 1. Recolectar invoices y tickets ────────────────────────────────────────
  console.log('📥 Leyendo objetos de HubSpot...');
  const allInvoices = await searchAllInvoices();
  const allTickets  = await searchAllTickets();
  console.log(`   Invoices con line_item_key: ${allInvoices.length}`);
  console.log(`   Tickets con of_line_item_key: ${allTickets.length}`);

  // ── 2. Recolectar LIKs únicos a verificar ───────────────────────────────────
  const uniqueLiks = new Set();
  for (const inv of allInvoices) {
    const lik = (inv.properties?.line_item_key || '').trim();
    if (lik) uniqueLiks.add(lik);
  }
  for (const t of allTickets) {
    const lik = (t.properties?.of_line_item_key || '').trim();
    if (lik) uniqueLiks.add(lik);
  }

  console.log(`\n🔍 LIKs únicos a verificar: ${uniqueLiks.size}`);

  if (uniqueLiks.size === 0) {
    console.log('\n✅ No hay LIKs que verificar. Sin huérfanos.');
    return;
  }

  // ── 3. Verificar existencia de cada LIK ─────────────────────────────────────
  const orphanLiks = new Set();
  let checked = 0;
  for (const lik of uniqueLiks) {
    const exists = await lineItemExistsForLik(lik);
    if (!exists) orphanLiks.add(lik);
    checked++;
    if (checked % 5 === 0 || checked === uniqueLiks.size) {
      process.stdout.write(`\r   Verificados: ${checked}/${uniqueLiks.size} — huérfanos: ${orphanLiks.size}`);
    }
    await sleep(130); // ~7 req/seg para no saturar el rate limit
  }
  console.log('\n');

  // ── 4. Clasificar ────────────────────────────────────────────────────────────
  const orphanInvoices = allInvoices.filter(inv => {
    const lik = (inv.properties?.line_item_key || '').trim();
    return orphanLiks.has(lik);
  });

  const orphanTickets = allTickets.filter(t => {
    const lik = (t.properties?.of_line_item_key || '').trim();
    return orphanLiks.has(lik);
  });

  // ── 5. Reporte: invoices huérfanas ──────────────────────────────────────────
  console.log('══════════════════════════════════════════════════════════');
  console.log(`📄 INVOICES HUÉRFANAS: ${orphanInvoices.length}`);
  console.log('   → Eliminar manualmente en HubSpot (no se auto-eliminan)');
  console.log('══════════════════════════════════════════════════════════');

  if (orphanInvoices.length === 0) {
    console.log('   ✅ Sin invoices huérfanas\n');
  } else {
    for (const inv of orphanInvoices) {
      const lik   = (inv.properties?.line_item_key      || '').trim();
      const key   = (inv.properties?.invoice_key         || '-').trim();
      const etapa = (inv.properties?.etapa_de_la_factura || '-').trim();
      console.log(`\n   ID: ${inv.id}  |  etapa: ${etapa}`);
      console.log(`      invoice_key:   ${key}`);
      console.log(`      line_item_key: ${lik}`);
    }
    console.log();
  }

  // ── 6. Reporte y optional eliminación: tickets huérfanos ────────────────────
  console.log('══════════════════════════════════════════════════════════');
  console.log(`🎫 TICKETS HUÉRFANOS: ${orphanTickets.length}`);
  console.log('══════════════════════════════════════════════════════════');

  if (orphanTickets.length === 0) {
    console.log('   ✅ Sin tickets huérfanos\n');
  } else {
    let deleted = 0;
    let alreadyGone = 0;
    let errors = 0;

    for (const t of orphanTickets) {
      const lik     = (t.properties?.of_line_item_key || '').trim();
      const key     = (t.properties?.of_ticket_key    || '-').trim();
      const stage   = (t.properties?.hs_pipeline_stage || '-').trim();
      const subject = (t.properties?.subject           || '-').trim();
      const dealId  = (t.properties?.of_deal_id        || '-').trim();

      console.log(`\n   ID: ${t.id}  |  stage: ${stage}  |  deal: ${dealId}`);
      console.log(`      subject:          ${subject}`);
      console.log(`      of_ticket_key:    ${key}`);
      console.log(`      of_line_item_key: ${lik}`);

      if (DELETE_TICKETS) {
        const result = await safeDeleteTicket(t.id);
        if (result.ok && result.alreadyGone) {
          console.log('      ⚠️  Ya no existía');
          alreadyGone++;
        } else if (result.ok) {
          console.log('      🗑️  Eliminado');
          deleted++;
          await sleep(150);
        } else {
          console.error(`      ❌ Error: ${result.message}`);
          errors++;
        }
      }
    }

    console.log();
    if (DELETE_TICKETS) {
      console.log(`   Resumen: ${deleted} eliminados, ${alreadyGone} ya no existían, ${errors} errores`);
    } else {
      console.log(`   Ejecutar con --delete-tickets para eliminarlos`);
    }
    console.log();
  }

  // ── 7. Resumen final ─────────────────────────────────────────────────────────
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  RESUMEN FINAL');
  console.log(`  Invoices huérfanas (acción manual): ${orphanInvoices.length}`);
  console.log(`  Tickets huérfanos:                  ${orphanTickets.length}`);
  console.log('  ✅ Audit completado');
  console.log('═══════════════════════════════════════════════════════════');
}

main().catch(err => {
  console.error('\n❌ Error fatal:', err.message);
  if (err.response?.data) console.error(JSON.stringify(err.response.data, null, 2));
  process.exit(1);
});
