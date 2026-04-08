// diagnoseMirrorTickets.mjs
// Diagnóstico de tickets del deal mirror UY 58956114841
// Busca todos los tickets, agrupa por of_ticket_key y reporta duplicados
// con stage y createdate para entender la causa raíz.
//
// Uso: node diagnoseMirrorTickets.mjs

import 'dotenv/config';
import { Client } from '@hubspot/api-client';

const TOKEN = process.env.HUBSPOT_PRIVATE_TOKEN;
if (!TOKEN) { console.error('Falta HUBSPOT_PRIVATE_TOKEN en .env'); process.exit(1); }
const hubspotClient = new Client({ accessToken: TOKEN });

const MIRROR_DEAL_ID = '58956114841';
const KEEP_IDS = new Set(['44226332527', '44226332528']);

async function getTicketsForDeal(dealId) {
  const tickets = [];
  let after;

  do {
    const resp = await hubspotClient.crm.tickets.searchApi.doSearch({
      filterGroups: [
        { filters: [{ propertyName: 'of_deal_id', operator: 'EQ', value: String(dealId) }] },
      ],
      properties: [
        'hs_pipeline_stage',
        'hs_pipeline',
        'of_ticket_key',
        'of_line_item_key',
        'fecha_resolucion_esperada',
        'subject',
        'createdate',
        'hs_lastmodifieddate',
      ],
      sorts: [{ propertyName: 'createdate', direction: 'ASCENDING' }],
      limit: 100,
      ...(after ? { after } : {}),
    });

    tickets.push(...(resp?.results || []));
    after = resp?.paging?.next?.after || null;
  } while (after);

  return tickets;
}

// Búsqueda alternativa por of_line_item_key (para tickets forecast
// que NO están asociados al deal)
async function getTicketsByLik(lik) {
  if (!lik) return [];
  const resp = await hubspotClient.crm.tickets.searchApi.doSearch({
    filterGroups: [
      { filters: [{ propertyName: 'of_line_item_key', operator: 'EQ', value: String(lik) }] },
    ],
    properties: [
      'hs_pipeline_stage',
      'hs_pipeline',
      'of_ticket_key',
      'of_line_item_key',
      'fecha_resolucion_esperada',
      'subject',
      'createdate',
    ],
    sorts: [{ propertyName: 'createdate', direction: 'ASCENDING' }],
    limit: 100,
  });
  return resp?.results || [];
}

function fmtDate(raw) {
  if (!raw) return '(vacío)';
  // epoch ms
  const ms = Number(raw);
  if (!isNaN(ms) && ms > 1e10) return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
  return String(raw).slice(0, 19);
}

async function main() {
  console.log(`\n🔍 Diagnóstico tickets deal mirror UY: ${MIRROR_DEAL_ID}\n`);

  // 1) Traer tickets asociados al deal
  const byDeal = await getTicketsForDeal(MIRROR_DEAL_ID);
  console.log(`Tickets encontrados via of_deal_id: ${byDeal.length}`);

  // 2) Extraer LIKs únicos para buscar también por of_line_item_key
  const liks = [...new Set(byDeal.map(t => t.properties?.of_line_item_key).filter(Boolean))];
  console.log(`LIKs encontrados: ${liks.length} → ${liks.join(', ')}\n`);

  let allTickets = [...byDeal];

  // 3) Buscar por LIK para capturar forecast sin of_deal_id
  for (const lik of liks) {
    const byLik = await getTicketsByLik(lik);
    for (const t of byLik) {
      if (!allTickets.find(x => x.id === t.id)) {
        allTickets.push(t);
      }
    }
  }

  console.log(`Total tickets únicos (deal + LIK): ${allTickets.length}\n`);

  // 4) Agrupar por of_ticket_key
  const byKey = new Map();
  const sinKey = [];

  for (const t of allTickets) {
    const key = String(t.properties?.of_ticket_key || '').trim();
    if (!key) {
      sinKey.push(t);
      continue;
    }
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(t);
  }

  // 5) Separar únicos vs duplicados
  const unicos = [];
  const duplicados = [];

  for (const [key, group] of byKey.entries()) {
    if (group.length === 1) {
      unicos.push({ key, ticket: group[0] });
    } else {
      duplicados.push({ key, tickets: group });
    }
  }

  // 6) Reporte de duplicados
  console.log('═'.repeat(80));
  console.log(`DUPLICADOS (${duplicados.length} keys con más de 1 ticket):`);
  console.log('═'.repeat(80));

  if (duplicados.length === 0) {
    console.log('  ✅ No hay duplicados por of_ticket_key\n');
  } else {
    for (const { key, tickets } of duplicados) {
      const fecha = (key.split('::').pop() || '').slice(0, 10);
      console.log(`\n  📅 Fecha: ${fecha}`);
      console.log(`  🔑 Key:   ${key}`);
      for (const t of tickets) {
        const p = t.properties || {};
        const marca = KEEP_IDS.has(t.id) ? ' ← CONSERVAR' : '';
        console.log(`     ID: ${t.id}${marca}`);
        console.log(`       stage:     ${p.hs_pipeline_stage}`);
        console.log(`       pipeline:  ${p.hs_pipeline}`);
        console.log(`       createdate: ${fmtDate(p.createdate)}`);
        console.log(`       subject:   ${p.subject || '(vacío)'}`);
      }
    }
  }

  // 7) Reporte de únicos
  console.log('\n' + '═'.repeat(80));
  console.log(`ÚNICOS (${unicos.length} tickets sin duplicado):`);
  console.log('═'.repeat(80));

  // Ordenar por fecha en la key
  unicos.sort((a, b) => a.key.localeCompare(b.key));

  for (const { key, ticket } of unicos) {
    const p = ticket.properties || {};
    const fecha = (key.split('::').pop() || '').slice(0, 10);
    const marca = KEEP_IDS.has(ticket.id) ? ' ✅ CONSERVAR' : '';
    console.log(`  ${fecha}  ID: ${ticket.id}${marca}  stage: ${p.hs_pipeline_stage}  created: ${fmtDate(p.createdate)}`);
  }

  // 8) Sin key
  if (sinKey.length) {
    console.log('\n' + '═'.repeat(80));
    console.log(`SIN of_ticket_key (${sinKey.length} tickets):`);
    console.log('═'.repeat(80));
    for (const t of sinKey) {
      const p = t.properties || {};
      console.log(`  ID: ${t.id}  stage: ${p.hs_pipeline_stage}  fecha: ${p.fecha_resolucion_esperada}  created: ${fmtDate(p.createdate)}`);
    }
  }

  // 9) Resumen
  console.log('\n' + '═'.repeat(80));
  console.log('RESUMEN:');
  console.log(`  Total tickets:     ${allTickets.length}`);
  console.log(`  Keys duplicadas:   ${duplicados.length}`);
  console.log(`  Keys únicas:       ${unicos.length}`);
  console.log(`  Sin key:           ${sinKey.length}`);

  // 10) Lista de IDs a borrar (todos menos los 2 a conservar)
  const toDelete = allTickets.filter(t => !KEEP_IDS.has(t.id));
  console.log(`\n  A borrar (todos menos los 2 correctos): ${toDelete.length} tickets`);
  console.log(`  IDs: ${toDelete.map(t => t.id).join(', ')}`);
  console.log('');
}

main().catch(err => {
  console.error('Error:', err?.message || err);
  process.exit(1);
});
