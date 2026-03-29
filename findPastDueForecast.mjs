// findPastDueForecast.mjs
// Busca tickets en stages FORECAST (manual + auto) con fecha_resolucion_esperada <= hoy
// para el deal 58479672592.
// READ-ONLY: no modifica nada.
//
// Uso: node findPastDueForecast.mjs

import { hubspotClient } from './src/hubspotClient.js';
import {
  FORECAST_AUTO_STAGES,
  FORECAST_MANUAL_STAGES,
} from './src/config/constants.js';

const DEAL_ID = '58479672592';

const ALL_FORECAST = [...FORECAST_AUTO_STAGES, ...FORECAST_MANUAL_STAGES];

// Stage ID → label
const STAGE_LABELS = new Map();
for (const id of FORECAST_AUTO_STAGES)   STAGE_LABELS.set(id, 'AUTO_FORECAST');
for (const id of FORECAST_MANUAL_STAGES) STAGE_LABELS.set(id, 'MANUAL_FORECAST');

function todayYMD() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Montevideo',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

async function run() {
  const today = todayYMD();
  console.log(`Hoy (Montevideo): ${today}`);
  console.log(`Deal: ${DEAL_ID}`);
  console.log(`Buscando tickets forecast con fecha_resolucion_esperada <= ${today}...\n`);

  // HubSpot Pro: max 5 filterGroups → chunk los stages en grupos de 5
  // Cada filterGroup: of_deal_id = DEAL_ID AND hs_pipeline_stage = X
  const results = [];

  // Chunks de 5 stages (HubSpot Pro limit)
  for (let i = 0; i < ALL_FORECAST.length; i += 5) {
    const chunk = ALL_FORECAST.slice(i, i + 5);

    const filterGroups = chunk.map(stageId => ({
      filters: [
        { propertyName: 'of_deal_id', operator: 'EQ', value: DEAL_ID },
        { propertyName: 'hs_pipeline_stage', operator: 'EQ', value: stageId },
      ],
    }));

    const body = {
      filterGroups,
      properties: [
        'hs_pipeline',
        'hs_pipeline_stage',
        'of_ticket_key',
        'of_line_item_key',
        'of_deal_id',
        'fecha_resolucion_esperada',
        'subject',
      ],
      sorts: [{ propertyName: 'fecha_resolucion_esperada', direction: 'ASCENDING' }],
      limit: 100,
    };

    try {
      const resp = await hubspotClient.crm.tickets.searchApi.doSearch(body);
      const tickets = resp?.results || [];
      results.push(...tickets);
    } catch (err) {
      console.error(`Error en chunk ${i}:`, err?.message || err);
    }
  }

  // Dedup por ID (por si hay overlap)
  const seen = new Set();
  const unique = [];
  for (const t of results) {
    if (!seen.has(t.id)) {
      seen.add(t.id);
      unique.push(t);
    }
  }

  // Filtrar: fecha_resolucion_esperada <= today
  const pastDue = unique.filter(t => {
    const fecha = (t.properties?.fecha_resolucion_esperada || '').slice(0, 10);
    return fecha && fecha <= today;
  });

  // También mostrar los que tienen fecha futura para contexto
  const future = unique.filter(t => {
    const fecha = (t.properties?.fecha_resolucion_esperada || '').slice(0, 10);
    return fecha && fecha > today;
  });

  console.log(`Total tickets forecast encontrados: ${unique.length}`);
  console.log(`  - Con fecha pasada/hoy (<= ${today}): ${pastDue.length}`);
  console.log(`  - Con fecha futura (> ${today}): ${future.length}\n`);

  if (pastDue.length > 0) {
    console.log('=== TICKETS FORECAST CON FECHA PASADA/HOY ===\n');
    for (const t of pastDue.sort((a, b) =>
      (a.properties?.fecha_resolucion_esperada || '').localeCompare(b.properties?.fecha_resolucion_esperada || '')
    )) {
      const p = t.properties || {};
      const stageLabel = STAGE_LABELS.get(p.hs_pipeline_stage) || `UNKNOWN(${p.hs_pipeline_stage})`;
      console.log(`  ID: ${t.id}`);
      console.log(`    fecha_resolucion_esperada: ${(p.fecha_resolucion_esperada || '').slice(0, 10)}`);
      console.log(`    stage: ${stageLabel} (${p.hs_pipeline_stage})`);
      console.log(`    of_ticket_key: ${p.of_ticket_key || '(vacío)'}`);
      console.log(`    of_line_item_key: ${p.of_line_item_key || '(vacío)'}`);
      console.log(`    subject: ${p.subject || '(vacío)'}`);
      console.log('');
    }
  }

  if (future.length > 0) {
    console.log(`=== TICKETS FORECAST FUTUROS (${future.length} total, mostrando primeros 5) ===\n`);
    for (const t of future.sort((a, b) =>
      (a.properties?.fecha_resolucion_esperada || '').localeCompare(b.properties?.fecha_resolucion_esperada || '')
    ).slice(0, 5)) {
      const p = t.properties || {};
      const stageLabel = STAGE_LABELS.get(p.hs_pipeline_stage) || `UNKNOWN(${p.hs_pipeline_stage})`;
      console.log(`  ID: ${t.id} | fecha: ${(p.fecha_resolucion_esperada || '').slice(0, 10)} | ${stageLabel} | LIK: ${p.of_line_item_key || '?'}`);
    }
    console.log('');
  }

  console.log('--- FIN (read-only, nada modificado) ---');
}

run().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
