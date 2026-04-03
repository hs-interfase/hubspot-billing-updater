// verify-search-finds-forecast.mjs
// Verificación 1: ¿Search API encuentra tickets forecast que NO están asociados al deal?
//
// Uso: node verify-search-finds-forecast.mjs
// Requiere: HUBSPOT_PRIVATE_TOKEN en .env o variable de entorno

import 'dotenv/config';
import { Client } from '@hubspot/api-client';

const hubspotClient = new Client({ accessToken: process.env.HUBSPOT_PRIVATE_TOKEN });

const TICKET_KEY = '58567555713::LIK:58567555713:53748055663:ae45c0::2026-04-09';
const DEAL_ID = '58567555713';

async function main() {
  console.log('=== Verificación 1: Search API vs Asociaciones ===\n');

  // --- A) Buscar por Search API (of_ticket_key) ---
  console.log(`[Search API] Buscando of_ticket_key = "${TICKET_KEY}"`);
  const searchResp = await hubspotClient.crm.tickets.searchApi.doSearch({
    filterGroups: [{
      filters: [{
        propertyName: 'of_ticket_key',
        operator: 'EQ',
        value: TICKET_KEY,
      }],
    }],
    properties: [
      'of_ticket_key', 'hs_pipeline', 'hs_pipeline_stage',
      'of_invoice_id', 'of_estado', 'createdate',
    ],
    limit: 10,
  });

  const searchResults = searchResp.results || [];
  console.log(`[Search API] Encontrados: ${searchResults.length} ticket(s)\n`);
  for (const t of searchResults) {
    const p = t.properties || {};
    console.log(`  ID: ${t.id}`);
    console.log(`    pipeline_stage: ${p.hs_pipeline_stage}`);
    console.log(`    of_estado:      ${p.of_estado || '(vacío)'}`);
    console.log(`    of_invoice_id:  ${p.of_invoice_id || '(vacío)'}`);
    console.log(`    createdate:     ${p.createdate}`);
    console.log();
  }

  // --- B) Buscar por Asociaciones deal→tickets ---
  console.log(`[Asociaciones] Buscando tickets asociados al deal ${DEAL_ID}`);
  let assocTicketIds = [];
  try {
    const assoc = await hubspotClient.crm.associations.v4.basicApi.getPage(
      'deals', String(DEAL_ID), 'tickets', 100
    );
    assocTicketIds = (assoc.results || []).map(r => String(r.toObjectId));
  } catch (err) {
    console.log(`[Asociaciones] Error: ${err.message}`);
  }
  console.log(`[Asociaciones] Encontrados: ${assocTicketIds.length} ticket(s) asociados\n`);

  // --- C) Comparar ---
  const searchIds = new Set(searchResults.map(t => String(t.id)));
  const assocIds = new Set(assocTicketIds);

  const onlyInSearch = [...searchIds].filter(id => !assocIds.has(id));
  const onlyInAssoc = [...assocIds].filter(id => !searchIds.has(id));

  if (onlyInSearch.length) {
    console.log(`⚠️  Tickets encontrados SOLO por Search API (no asociados al deal):`);
    console.log(`   ${onlyInSearch.join(', ')}`);
    console.log(`   → Esto confirma que el fallback por Search API resolvería el bug.\n`);
  } else {
    console.log(`✅ Todos los tickets encontrados por Search API también están asociados al deal.`);
    console.log(`   → El bug podría no reproducirse con esta ticket key específica.\n`);
  }

  if (onlyInAssoc.length) {
    console.log(`ℹ️  Tickets asociados al deal pero NO matchean la key buscada: ${onlyInAssoc.length}`);
  }

  console.log('=== Fin verificación 1 ===');
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
