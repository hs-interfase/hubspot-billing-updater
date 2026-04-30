// src/services/orphanAuditService.js
//
// Detecta invoices y tickets huérfanos:
//   - Invoice huérfana: tiene line_item_key pero no existe ningún line_item con esa key.
//   - Ticket huérfano: tiene of_line_item_key pero no existe ningún line_item con esa key.
//
// Las invoices huérfanas se listan para eliminación MANUAL en HubSpot.
// Los tickets huérfanos se pueden eliminar automáticamente con deleteTickets: true.
//
// Uso como módulo:
//   import { auditOrphanTickets } from './orphanAuditService.js'
//   const result = await auditOrphanTickets({ deleteTickets: false })
//
// Uso CLI:
//   node src/services/orphanAuditService.js                   # solo reporte
//   node src/services/orphanAuditService.js --delete-tickets   # detecta y elimina

import { hubspotClient } from '../hubspotClient.js';
import logger from '../../lib/logger.js';
import { sendAlert } from '../../lib/alertService.js';
import { fileURLToPath } from 'url';
import { pathToFileURL } from 'url';

const MOD = 'orphanAuditService';

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ─── HubSpot helpers ───────────────────────────────────────────────────────────

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
    logger.debug({ module: MOD, label, count: results.length }, 'Paginando búsqueda');
    if (resp.paging?.next?.after) {
      after = resp.paging.next.after;
      await sleep(150);
    } else break;
  }
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
      logger.warn({ module: MOD, ticketId }, 'Rate limit en delete, esperando 10s');
      await sleep(10_000);
      return safeDeleteTicket(ticketId);
    }
    return { ok: false, message: err.message };
  }
}

// ─── Función principal exportable ──────────────────────────────────────────────

/**
 * Audita tickets e invoices huérfanos.
 *
 * @param {Object} opts
 * @param {boolean} opts.deleteTickets - true para eliminar tickets huérfanos (default: false)
 * @returns {Object} resumen con conteos
 */
export async function auditOrphanTickets({ deleteTickets = false } = {}) {
  const fn = 'auditOrphanTickets';
  const start = Date.now();

  logger.info(
    { module: MOD, fn, deleteTickets },
    `Inicio audit de huérfanos — modo: ${deleteTickets ? 'DELETE' : 'REPORT'}`
  );

  // 1. Recolectar invoices y tickets
  const allInvoices = await searchAllInvoices();
  const allTickets = await searchAllTickets();

  logger.info(
    { module: MOD, fn, invoices: allInvoices.length, tickets: allTickets.length },
    'Objetos leídos de HubSpot'
  );

  // 2. Recolectar LIKs únicos
  const uniqueLiks = new Set();
  for (const inv of allInvoices) {
    const lik = (inv.properties?.line_item_key || '').trim();
    if (lik) uniqueLiks.add(lik);
  }
  for (const t of allTickets) {
    const lik = (t.properties?.of_line_item_key || '').trim();
    if (lik) uniqueLiks.add(lik);
  }

  logger.info({ module: MOD, fn, uniqueLiks: uniqueLiks.size }, 'LIKs únicos a verificar');

  if (uniqueLiks.size === 0) {
    logger.info({ module: MOD, fn }, 'Sin LIKs que verificar — sin huérfanos');
    return { orphanInvoices: 0, orphanTickets: 0, deleted: 0, errors: 0 };
  }

  // 3. Verificar existencia de cada LIK
  const orphanLiks = new Set();
  let checked = 0;
  for (const lik of uniqueLiks) {
    const exists = await lineItemExistsForLik(lik);
    if (!exists) orphanLiks.add(lik);
    checked++;
    if (checked % 50 === 0) {
      logger.debug({ module: MOD, fn, checked, total: uniqueLiks.size, orphans: orphanLiks.size }, 'Progreso verificación LIKs');
    }
    await sleep(130);
  }

  // 4. Clasificar
  const orphanInvoices = allInvoices.filter(inv => {
    const lik = (inv.properties?.line_item_key || '').trim();
    return orphanLiks.has(lik);
  });

  const orphanTickets = allTickets.filter(t => {
    const lik = (t.properties?.of_line_item_key || '').trim();
    return orphanLiks.has(lik);
  });

  // 5. Log invoices huérfanas (siempre solo reporte)
  if (orphanInvoices.length > 0) {
    const invoiceDetails = orphanInvoices.map(inv => ({
      id: inv.id,
      line_item_key: (inv.properties?.line_item_key || '').trim(),
      invoice_key: (inv.properties?.invoice_key || '').trim(),
      etapa: (inv.properties?.etapa_de_la_factura || '').trim(),
    }));

    logger.error(
      { module: MOD, fn, count: orphanInvoices.length, details: invoiceDetails.slice(0, 20) },
      'ORPHAN_INVOICES: invoices huérfanas detectadas (eliminar manualmente en HubSpot)'
    );
  }

  // 6. Log y optional eliminación de tickets huérfanos
  let deleted = 0;
  let alreadyGone = 0;
  let errors = 0;

  if (orphanTickets.length > 0) {
    const ticketDetails = orphanTickets.map(t => ({
      id: t.id,
      of_line_item_key: (t.properties?.of_line_item_key || '').trim(),
      of_ticket_key: (t.properties?.of_ticket_key || '').trim(),
      stage: (t.properties?.hs_pipeline_stage || '').trim(),
      subject: (t.properties?.subject || '').trim(),
      dealId: (t.properties?.of_deal_id || '').trim(),
    }));

    logger.error(
      { module: MOD, fn, count: orphanTickets.length, deleteTickets, details: ticketDetails.slice(0, 20) },
      'ORPHAN_TICKETS: tickets huérfanos detectados'
    );

    if (deleteTickets) {
      for (const t of orphanTickets) {
        const result = await safeDeleteTicket(t.id);
        if (result.ok && result.alreadyGone) {
          alreadyGone++;
        } else if (result.ok) {
          deleted++;
          logger.info({ module: MOD, fn, ticketId: t.id }, 'Ticket huérfano eliminado');
          await sleep(150);
        } else {
          errors++;
          logger.error({ module: MOD, fn, ticketId: t.id, error: result.message }, 'Error eliminando ticket huérfano');
        }
      }

      logger.info(
        { module: MOD, fn, deleted, alreadyGone, errors },
        'Eliminación de tickets huérfanos completada'
      );
    }
  }

  // 7. Alerta por email si hay huérfanos
  const totalOrphans = orphanInvoices.length + orphanTickets.length;
  if (totalOrphans > 0) {
    await sendAlert(
      'warning',
      `Huérfanos detectados: ${orphanInvoices.length} invoices, ${orphanTickets.length} tickets`,
      {
        orphanInvoices: orphanInvoices.length,
        orphanTickets: orphanTickets.length,
        mode: deleteTickets ? 'DELETE' : 'REPORT',
        deleted,
        errors,
        elapsedMs: Date.now() - start,
        sampleInvoiceIds: orphanInvoices.slice(0, 5).map(i => i.id).join(', '),
        sampleTicketIds: orphanTickets.slice(0, 5).map(t => t.id).join(', '),
      }
    ).catch(() => {}); // nunca romper por falla de alertas
  }

  const result = {
    orphanInvoices: orphanInvoices.length,
    orphanTickets: orphanTickets.length,
    orphanLiks: orphanLiks.size,
    deleted,
    alreadyGone,
    errors,
    elapsedMs: Date.now() - start,
  };

  logger.info({ module: MOD, fn, ...result }, 'Audit de huérfanos completado');

  return result;
}

// ─── CLI ───────────────────────────────────────────────────────────────────────

const argv1 = process.argv?.[1];
const isDirectRun =
  typeof argv1 === 'string' &&
  argv1.length > 0 &&
  import.meta.url === pathToFileURL(argv1).href;

if (isDirectRun) {
  // Cargar dotenv solo en ejecución directa
  await import('dotenv/config');

  const args = process.argv.slice(2);
  const deleteTickets = args.includes('--delete-tickets') || args.includes('--delete');

  try {
    const result = await auditOrphanTickets({ deleteTickets });
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('  RESUMEN FINAL');
    console.log(`  Invoices huérfanas (acción manual): ${result.orphanInvoices}`);
    console.log(`  Tickets huérfanos:                  ${result.orphanTickets}`);
    if (deleteTickets) {
      console.log(`  Eliminados: ${result.deleted}  |  Ya no existían: ${result.alreadyGone}  |  Errores: ${result.errors}`);
    }
    console.log(`  Tiempo: ${(result.elapsedMs / 1000).toFixed(1)}s`);
    console.log('═══════════════════════════════════════════════════════════');
  } catch (err) {
    logger.error({ module: MOD, err: err?.message, stack: err?.stack }, 'Error fatal en audit de huérfanos');
    process.exitCode = 1;
  }
}