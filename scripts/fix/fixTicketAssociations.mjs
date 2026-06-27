#!/usr/bin/env node
/**
 * fixTicketAssociations.mjs
 *
 * Verifica y repara asociaciones nativas ticket↔deal en HubSpot.
 *
 * Problema: los tickets tienen of_deal_id como propiedad de texto pero
 * pueden faltar las asociaciones nativas en el grafo de HubSpot.
 * Sin la asociación nativa, el sistema no "ve" los tickets al navegar deal → tickets.
 *
 * Estrategia:
 * - Busca todos los tickets que tienen of_deal_id (via Search API, keyset pagination)
 * - Para cada ticket, verifica si existe la asociación nativa ticket→deal
 * - Si falta, la crea
 *
 * Uso:
 *   node fixTicketAssociations.mjs                        # dry run
 *   node fixTicketAssociations.mjs --execute              # ejecución real
 *   node fixTicketAssociations.mjs --deal 60542271080     # solo tickets de un deal
 */

import 'dotenv/config';
import { Client } from '@hubspot/api-client';
import { writeFileSync } from 'fs';

const TOKEN = process.env.HUBSPOT_PRIVATE_TOKEN;
if (!TOKEN) { console.error('❌ Falta HUBSPOT_PRIVATE_TOKEN'); process.exit(1); }

const hubspot = new Client({ accessToken: TOKEN });
const sleep = ms => new Promise(r => setTimeout(r, ms));

const DRY_RUN = !process.argv.includes('--execute');
guardProduction({ scriptName: 'fixTicketAssociations.mjs', dryRun: DRY_RUN });

function getArg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : null;
}

const SINGLE_DEAL = getArg('deal');

// ─── Fetchers ────────────────────────────────────────────────────────────────

/**
 * Busca todos los tickets que tienen of_deal_id seteado.
 * Keyset pagination con hs_object_id GT lastId.
 */
async function fetchAllTicketsWithDealId() {
  const all = [];
  let lastId = '0';
  let page = 0;

  const baseFilters = [
    { propertyName: 'of_deal_id', operator: 'HAS_PROPERTY' },
  ];

  if (SINGLE_DEAL) {
    baseFilters.push({ propertyName: 'of_deal_id', operator: 'EQ', value: SINGLE_DEAL });
  }

  while (true) {
    page++;
    const body = {
      filterGroups: [{
        filters: [
          ...baseFilters,
          { propertyName: 'hs_object_id', operator: 'GT', value: lastId },
        ],
      }],
      properties: ['of_deal_id', 'of_ticket_key', 'of_line_item_key', 'of_line_item_ids', 'subject'],
      sorts: [{ propertyName: 'hs_object_id', direction: 'ASCENDING' }],
      limit: 100,
    };

    const resp = await hubspot.crm.tickets.searchApi.doSearch(body);
    const results = resp?.results || [];

    if (!results.length) break;

    all.push(...results);
    lastId = results[results.length - 1].id;

    console.log(`     📄 Página ${page}: ${results.length} tickets (total: ${all.length})`);

    if (results.length < 100) break;
    await sleep(250);
  }

  return all;
}

/**
 * Verifica si existe la asociación nativa ticket→deal.
 */
async function checkTicketDealAssociation(ticketId, dealId) {
  try {
    const resp = await hubspot.crm.associations.v4.basicApi.getPage(
      'tickets', String(ticketId), 'deals', undefined, 10
    );
    return (resp?.results || []).some(r => String(r.toObjectId) === String(dealId));
  } catch (err) {
    // Si el ticket o deal no existe, no hay asociación
    if (err?.response?.status === 404) return false;
    throw err;
  }
}

/**
 * Crea la asociación nativa ticket→deal.
 */
async function createTicketDealAssociation(ticketId, dealId) {
  await hubspot.crm.associations.v4.basicApi.create(
    'tickets', String(ticketId), 'deals', String(dealId), []
  );
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const startTime = Date.now();

  console.log('═'.repeat(70));
  console.log('  🔗 FIX TICKET ↔ DEAL ASSOCIATIONS');
  console.log(`  Modo:  ${DRY_RUN ? '🔍 DRY RUN' : '🚀 EJECUCIÓN REAL'}`);
  console.log(`  Scope: ${SINGLE_DEAL ? `Deal ${SINGLE_DEAL}` : 'TODOS los tickets con of_deal_id'}`);
  console.log('═'.repeat(70));
  console.log();

  const stats = {
    ticketsChecked: 0,
    alreadyAssociated: 0,
    repaired: 0,
    dealIdEmpty: 0,
    errors: 0,
  };

  const repairs = [];

  // ─── Buscar tickets ──────────────────────────────────────────────────────

  console.log('  🔍 Buscando tickets con of_deal_id...');
  let tickets;
  try {
    tickets = await fetchAllTicketsWithDealId();
  } catch (err) {
    console.error(`  ❌ Error buscando tickets: ${err.message}`);
    process.exit(1);
  }

  console.log(`\n  📦 ${tickets.length} ticket(s) encontrado(s)\n`);

  if (!tickets.length) {
    console.log('  ✅ No hay tickets con of_deal_id — nada que hacer');
    return;
  }

  // ─── Procesar cada ticket ────────────────────────────────────────────────

  for (const ticket of tickets) {
    stats.ticketsChecked++;
    const tp = ticket.properties || {};
    const ticketId = ticket.id;
    const dealId = (tp.of_deal_id || '').trim();

    if (!dealId) {
      stats.dealIdEmpty++;
      continue;
    }

    try {
      const hasAssoc = await checkTicketDealAssociation(ticketId, dealId);

      if (hasAssoc) {
        stats.alreadyAssociated++;
        continue;
      }

      // Falta la asociación — reparar
      if (DRY_RUN) {
        console.log(`     🔍 [DRY] Ticket ${ticketId} → deal ${dealId} (falta asociación)`);
      } else {
        await createTicketDealAssociation(ticketId, dealId);
        console.log(`     ✅ Ticket ${ticketId} → deal ${dealId} asociado`);
      }

      stats.repaired++;
      repairs.push({ ticketId, dealId, subject: tp.subject || '', applied: !DRY_RUN });

      await sleep(150);

    } catch (err) {
      console.error(`     ❌ Ticket ${ticketId} → deal ${dealId}: ${err.message}`);
      stats.errors++;
      repairs.push({ ticketId, dealId, error: err.message });
    }

    // Log progreso cada 200 tickets
    if (stats.ticketsChecked % 200 === 0) {
      console.log(`     ... ${stats.ticketsChecked} revisados, ${stats.repaired} reparados`);
    }
  }

  // ─── Resumen ───────────────────────────────────────────────────────────────

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log();
  console.log('═'.repeat(70));
  console.log('  📊 RESUMEN');
  console.log('═'.repeat(70));
  console.log(`  Tickets revisados:       ${stats.ticketsChecked}`);
  console.log(`  Ya asociados (OK):       ${stats.alreadyAssociated}`);
  console.log(`  Reparados:               ${stats.repaired}`);
  console.log(`  of_deal_id vacío:        ${stats.dealIdEmpty}`);
  console.log(`  Errores:                 ${stats.errors}`);
  console.log(`  Duración:                ${elapsed}s`);
  console.log('═'.repeat(70));

  if (DRY_RUN && stats.repaired > 0) {
    console.log('\n  💡 Para ejecutar: node fixTicketAssociations.mjs --execute');
  }

  const filename = `fix-associations-report-${new Date().toISOString().slice(0, 10)}.json`;
  writeFileSync(filename, JSON.stringify({ stats, repairs }, null, 2));
  console.log(`\n📄 Reporte: ${filename}`);
}

main().catch(err => {
  console.error('\n❌ Error fatal:', err.message);
  process.exit(1);
});
