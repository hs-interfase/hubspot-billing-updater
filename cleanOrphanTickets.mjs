// cleanOrphanTickets.mjs
// Limpia tickets huérfanos del portal: sin asociación a deal Y sin asociación a line item,
// en stages forecast (manual + auto, todos los buckets).
//
// Uso:
//   node cleanOrphanTickets.mjs          ← DRY RUN (solo lista, no borra)
//   node cleanOrphanTickets.mjs --delete ← BORRA los huérfanos
//
// Preserva tickets con of_invoice_id seteado, o en stages READY/post-emisión.

import { hubspotClient } from './src/hubspotClient.js';
import {
  FORECAST_MANUAL_STAGES,
  FORECAST_AUTO_STAGES,
} from './src/config/constants.js';

const DRY_RUN = !process.argv.includes('--delete');

const ALL_FORECAST_STAGES = [...new Set([
  ...FORECAST_MANUAL_STAGES,
  ...FORECAST_AUTO_STAGES,
])].filter(Boolean);

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// ── Buscar todos los tickets en stages forecast (paginado, chunks de 5) ──
async function fetchAllForecastTickets() {
  const tickets = [];

  // HubSpot Pro: max 5 filterGroups por query → chunkeamos los stages
  for (let i = 0; i < ALL_FORECAST_STAGES.length; i += 5) {
    const chunk = ALL_FORECAST_STAGES.slice(i, i + 5);

    const filterGroups = chunk.map(stageId => ({
      filters: [{ propertyName: 'hs_pipeline_stage', operator: 'EQ', value: stageId }],
    }));

    let after;
    do {
      const resp = await hubspotClient.crm.tickets.searchApi.doSearch({
        filterGroups,
        properties: [
          'hs_pipeline_stage',
          'of_ticket_key',
          'of_deal_id',
          'of_line_item_ids',
          'of_invoice_id',
          'subject',
        ],
        limit: 100,
        ...(after ? { after } : {}),
      });

      tickets.push(...(resp?.results || []));
      after = resp?.paging?.next?.after;
    } while (after);
  }

  // Deduplicar por ID (puede aparecer en múltiples chunks si stages se solapan)
  const seen = new Set();
  return tickets.filter(t => {
    if (seen.has(t.id)) return false;
    seen.add(t.id);
    return true;
  });
}

// ── Verificar si un ticket tiene asociación a deal vía associations v4 ──
async function hasDealAssociation(ticketId) {
  try {
    const resp = await hubspotClient.crm.associations.v4.basicApi.getPage(
      'tickets', String(ticketId), 'deals', 10
    );
    return (resp?.results || []).length > 0;
  } catch {
    return false;
  }
}

// ── Verificar si un ticket tiene asociación a line item vía associations v4 ──
async function hasLineItemAssociation(ticketId) {
  try {
    const resp = await hubspotClient.crm.associations.v4.basicApi.getPage(
      'tickets', String(ticketId), 'line_items', 10
    );
    return (resp?.results || []).length > 0;
  } catch {
    return false;
  }
}

// ── Borrar ticket ──
async function deleteTicket(ticketId) {
  await hubspotClient.crm.tickets.basicApi.archive(String(ticketId));
}

// ── Main ──
async function main() {
  log(`Modo: ${DRY_RUN ? 'DRY RUN (pasá --delete para borrar)' : '⚠️  DELETE ACTIVO'}`);
  log(`Stages forecast a evaluar: ${ALL_FORECAST_STAGES.length}`);
  log('Buscando todos los tickets en stages forecast...');

  const allTickets = await fetchAllForecastTickets();
  log(`Total tickets en forecast: ${allTickets.length}`);

  // Filtrar primero los que tienen of_invoice_id seteado (preservar)
  const candidates = allTickets.filter(t => {
    const invoiceId = (t.properties?.of_invoice_id || '').trim();
    return !invoiceId; // si tiene factura, no es candidato
  });

  log(`Candidatos sin of_invoice_id: ${candidates.length}`);
  log('Verificando asociaciones (deal + line item) — esto puede tardar...\n');

  let orphans = [];
  let checked = 0;

  for (const ticket of candidates) {
    checked++;
    if (checked % 50 === 0) log(`  Verificados: ${checked}/${candidates.length}`);

    // Primero chequear of_deal_id como fast-path (evita llamada a associations)
    const dealIdProp = (ticket.properties?.of_deal_id || '').trim();
    const liIdsProp  = (ticket.properties?.of_line_item_ids || '').trim();

    // Si ambas propiedades están vacías, verificar via associations v4
    let hasDeal = false;
    let hasLI   = false;

    if (dealIdProp) {
      hasDeal = true;
    } else {
      hasDeal = await hasDealAssociation(ticket.id);
    }

    if (hasDeal) continue; // tiene deal → no es huérfano

    if (liIdsProp) {
      hasLI = true;
    } else {
      hasLI = await hasLineItemAssociation(ticket.id);
    }

    if (hasLI) continue; // tiene line item → no es huérfano

    // Es huérfano: sin deal Y sin line item
    orphans.push(ticket);
  }

  log(`\nTickets huérfanos encontrados: ${orphans.length}`);

  if (orphans.length === 0) {
    log('Nada que limpiar. ✅');
    return;
  }

  // Listar huérfanos
  console.log('\n--- TICKETS HUÉRFANOS ---');
  for (const t of orphans) {
    const stage = t.properties?.hs_pipeline_stage || '';
    const key   = t.properties?.of_ticket_key || '(sin key)';
    const subj  = t.properties?.subject || '(sin asunto)';
    console.log(`  ID: ${t.id} | stage: ${stage} | key: ${key} | subject: ${subj}`);
  }
  console.log('-------------------------\n');

  if (DRY_RUN) {
    log(`DRY RUN: no se borró nada. Ejecutá con --delete para eliminar los ${orphans.length} tickets.`);
    return;
  }

  // Borrar
  log(`Borrando ${orphans.length} tickets huérfanos...`);
  let deleted = 0;
  let errors  = 0;

  for (const t of orphans) {
    try {
      await deleteTicket(t.id);
      deleted++;
      log(`  ✅ Borrado: ${t.id} (${t.properties?.of_ticket_key || 'sin key'})`);
    } catch (err) {
      errors++;
      log(`  ❌ Error borrando ${t.id}: ${err?.message || err}`);
    }
  }

  log(`\nResumen: ${deleted} borrados, ${errors} errores.`);
}

main().catch(err => {
  console.error('Error fatal:', err);
  process.exit(1);
});
