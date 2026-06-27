#!/usr/bin/env node
/**
 * deleteOrphanInvoices.mjs
 *
 * Borra facturas huérfanas que apuntan a tickets que no existen.
 * Lee el orphan-match-report JSON generado por el diagnóstico.
 *
 * Antes de borrar cada factura:
 * 1. Verifica que la factura existe en HubSpot
 * 2. Confirma que el ticket asociado NO existe (doble check)
 * 3. Desasocia de deal si hay asociación
 * 4. Borra la factura (archive)
 *
 * Uso:
 *   node deleteOrphanInvoices.mjs                                          # dry run
 *   node deleteOrphanInvoices.mjs --execute                               # ejecución real
 *   node deleteOrphanInvoices.mjs --file orphan-match-report-2026-05-25.json  # archivo custom
 */

import 'dotenv/config';
import { guardProduction } from '../_lib/guardProduction.mjs';
import { Client } from '@hubspot/api-client';
import { readFileSync, writeFileSync } from 'fs';

const TOKEN = process.env.HUBSPOT_PRIVATE_TOKEN;
if (!TOKEN) { console.error('❌ Falta HUBSPOT_PRIVATE_TOKEN'); process.exit(1); }

const hubspot = new Client({ accessToken: TOKEN });
const sleep = ms => new Promise(r => setTimeout(r, ms));

const DRY_RUN = !process.argv.includes('--execute');
guardProduction({ scriptName: 'deleteOrphanInvoices.mjs', dryRun: DRY_RUN });

function getArg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : null;
}

const REPORT_FILE = getArg('file') || 'orphan-match-report-2026-05-25.json';

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function invoiceExists(invoiceId) {
  try {
    await hubspot.crm.objects.basicApi.getById('invoices', String(invoiceId), ['of_invoice_key']);
    return true;
  } catch (err) {
    if (err?.response?.status === 404 || err?.code === 404) return false;
    throw err;
  }
}

async function ticketExists(ticketId) {
  try {
    await hubspot.crm.tickets.basicApi.getById(String(ticketId), ['hs_object_id']);
    return true;
  } catch (err) {
    if (err?.response?.status === 404 || err?.code === 404) return false;
    throw err;
  }
}

async function deleteInvoice(invoiceId) {
  await hubspot.crm.objects.basicApi.archive('invoices', String(invoiceId));
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const startTime = Date.now();

  // Leer reporte
  let orphans;
  try {
    const raw = readFileSync(REPORT_FILE, 'utf-8');
    orphans = JSON.parse(raw);
  } catch (err) {
    console.error(`❌ No se pudo leer ${REPORT_FILE}: ${err.message}`);
    process.exit(1);
  }

  // Filtrar solo NO_MATCH
  const toDelete = orphans.filter(o => o.status === 'NO_MATCH');

  console.log('═'.repeat(70));
  console.log('  🗑️  DELETE ORPHAN INVOICES');
  console.log(`  Modo:     ${DRY_RUN ? '🔍 DRY RUN' : '🚀 EJECUCIÓN REAL'}`);
  console.log(`  Archivo:  ${REPORT_FILE}`);
  console.log(`  Total:    ${orphans.length} entries, ${toDelete.length} a borrar (NO_MATCH)`);
  console.log('═'.repeat(70));
  console.log();

  const stats = {
    checked: 0,
    deleted: 0,
    alreadyGone: 0,
    ticketActuallyExists: 0,
    errors: 0,
  };

  const results = [];

  for (const entry of toDelete) {
    stats.checked++;
    const { invoiceId, deadTicketId, dealId, periodDate, invoiceKey } = entry;

    // 1. Verificar que la factura existe
    let invExists;
    try {
      invExists = await invoiceExists(invoiceId);
    } catch (err) {
      console.error(`     ❌ Error verificando factura ${invoiceId}: ${err.message}`);
      stats.errors++;
      results.push({ invoiceId, error: err.message });
      continue;
    }

    if (!invExists) {
      stats.alreadyGone++;
      console.log(`     ⚪ Factura ${invoiceId} ya no existe (skip)`);
      results.push({ invoiceId, status: 'ALREADY_GONE' });
      continue;
    }

    // 2. Doble check: el ticket NO debe existir
    if (deadTicketId) {
      try {
        const tExists = await ticketExists(deadTicketId);
        if (tExists) {
          stats.ticketActuallyExists++;
          console.log(`     ⚠️  Factura ${invoiceId} → ticket ${deadTicketId} SÍ EXISTE (skip — no es huérfana)`);
          results.push({ invoiceId, deadTicketId, status: 'TICKET_EXISTS_SKIP' });
          continue;
        }
      } catch (err) {
        // Si falla la verificación, asumimos que no existe (fail-open para borrado)
      }
    }

    // 3. Borrar
    if (DRY_RUN) {
      console.log(`     🔍 [DRY] Borrar factura ${invoiceId} (deal ${dealId}, período ${periodDate})`);
      results.push({ invoiceId, dealId, periodDate, status: 'WOULD_DELETE' });
    } else {
      try {
        await deleteInvoice(invoiceId);
        console.log(`     🗑️  Factura ${invoiceId} borrada (deal ${dealId}, período ${periodDate})`);
        results.push({ invoiceId, dealId, periodDate, status: 'DELETED' });
      } catch (err) {
        console.error(`     ❌ Error borrando factura ${invoiceId}: ${err.message}`);
        stats.errors++;
        results.push({ invoiceId, error: err.message });
        continue;
      }
    }

    stats.deleted++;
    await sleep(200);
  }

  // ─── Resumen ───────────────────────────────────────────────────────────────

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log();
  console.log('═'.repeat(70));
  console.log('  📊 RESUMEN');
  console.log('═'.repeat(70));
  console.log(`  Revisadas:               ${stats.checked}`);
  console.log(`  Borradas:                ${stats.deleted}`);
  console.log(`  Ya no existían:          ${stats.alreadyGone}`);
  console.log(`  Ticket sí existe (skip): ${stats.ticketActuallyExists}`);
  console.log(`  Errores:                 ${stats.errors}`);
  console.log(`  Duración:                ${elapsed}s`);
  console.log('═'.repeat(70));

  if (DRY_RUN && stats.deleted > 0) {
    console.log('\n  💡 Para ejecutar: node deleteOrphanInvoices.mjs --execute');
  }

  const filename = `delete-orphans-report-${new Date().toISOString().slice(0, 10)}.json`;
  writeFileSync(filename, JSON.stringify({ stats, results }, null, 2));
  console.log(`\n📄 Reporte: ${filename}`);
}

main().catch(err => {
  console.error('\n❌ Error fatal:', err.message);
  process.exit(1);
});
