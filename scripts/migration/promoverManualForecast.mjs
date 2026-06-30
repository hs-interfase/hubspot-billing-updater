// promoverManualForecast.mjs — RED DE SEGURIDAD del path manual.
//
// Promueve tickets MANUALES atascados en Forecast cuya fecha de facturación ya pasó
// o cae dentro de los próximos N días (default 30), a "Próximos a facturar" (1234282360).
// Razón: si un ticket manual queda en Forecast pasada su fecha, el motor no lo factura;
// esta pasada lo rescata. NO emite nada, solo mueve de stage. Idempotente.
//
// Uso (dry-run):   node promoverManualForecast.mjs
//      (escribe):  node promoverManualForecast.mjs --execute
//      opciones:   --days 30   --deal <dealId>   (acota a un deal)
// Lee .env del cwd (correr desde la raíz del repo → token de prod).

import { readFileSync, existsSync, writeFileSync } from 'node:fs';

function loadEnv(p = '.env') {
  if (!existsSync(p)) return;
  for (const l of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = l.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/); if (!m) continue;
    let v = m[2]; if (/^".*"$/.test(v) || /^'.*'$/.test(v)) v = v.slice(1, -1);
    if (!(m[1] in process.env)) process.env[m[1]] = v;
  }
}
loadEnv();

const TOKEN = process.env.HUBSPOT_PRIVATE_TOKEN;
if (!TOKEN) { console.error('Falta HUBSPOT_PRIVATE_TOKEN'); process.exit(1); }
const BASE = 'https://api.hubapi.com';
const MANUAL_PIPELINE = process.env.BILLING_TICKET_PIPELINE_ID || '832539959';
const PROXIMOS = process.env.BILLING_TICKET_STAGE_ID || '1234282360'; // "Próximos a facturar"
const FORECAST_STAGES = [
  process.env.BILLING_TICKET_FORECAST     || '1294744238',
  process.env.BILLING_TICKET_FORECAST_50  || '1294744239',
  process.env.BILLING_TICKET_FORECAST_75  || '1296492870',
  process.env.BILLING_TICKET_FORECAST_85  || '1329838706',
  process.env.BILLING_TICKET_FORECAST_95  || '1296492871',
];

function getArg(n) { const i = process.argv.indexOf(`--${n}`); return i !== -1 ? process.argv[i + 1] : null; }
const DRY_RUN = !process.argv.includes('--execute');
const DAYS = Number(getArg('days') || 30);
const SINGLE_DEAL = getArg('deal');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// fetch con reintentos (la red venía dando ConnectTimeout intermitente)
async function hs(method, path, body, tries = 4) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(BASE + path, {
        method,
        headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(25000),
      });
      if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${(await res.text().catch(() => '')).slice(0, 250)}`);
      return res.status === 204 ? null : res.json();
    } catch (err) {
      if (i >= tries) throw err;
      await sleep(500 * i);
    }
  }
}

const ymd = (v) => {
  if (v == null || v === '') return null;
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const n = Number(s);
  if (!Number.isNaN(n) && n > 0) return new Date(n).toISOString().slice(0, 10);
  const d = new Date(s); return isNaN(d) ? null : d.toISOString().slice(0, 10);
};
const todayYMD = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Montevideo' });

async function fetchManualForecastTickets() {
  const props = ['hs_pipeline_stage', 'of_fecha_de_facturacion', 'fecha_resolucion_esperada',
    'subject', 'facturacion_automatica', 'of_deal_id', 'numero_de_factura', 'of_invoice_id'];
  const filters = [
    { propertyName: 'hs_pipeline', operator: 'EQ', value: MANUAL_PIPELINE },
    { propertyName: 'hs_pipeline_stage', operator: 'IN', values: FORECAST_STAGES },
  ];
  if (SINGLE_DEAL) filters.push({ propertyName: 'of_deal_id', operator: 'EQ', value: String(SINGLE_DEAL) });
  const all = []; let after;
  do {
    const r = await hs('POST', '/crm/v3/objects/tickets/search', {
      filterGroups: [{ filters }], properties: props, limit: 100, ...(after ? { after } : {}),
    });
    all.push(...(r?.results || []));
    after = r?.paging?.next?.after;
    if (after) await sleep(150);
  } while (after);
  return all;
}

async function main() {
  const today = todayYMD();
  const cutoff = new Date(new Date(today + 'T12:00:00Z').getTime() + DAYS * 86400000).toISOString().slice(0, 10);
  console.log('═'.repeat(70));
  console.log('  🛟 PROMOVER MANUALES ATASCADOS EN FORECAST → Próximos a facturar');
  console.log(`  Hoy: ${today} | Umbral (hoy+${DAYS}d): ${cutoff} | Modo: ${DRY_RUN ? 'DRY-RUN' : 'EJECUTA'}${SINGLE_DEAL ? ` | Deal ${SINGLE_DEAL}` : ''}`);
  console.log('═'.repeat(70));

  const tickets = await fetchManualForecastTickets();
  console.log(`\nTickets MANUAL en Forecast: ${tickets.length}\n`);

  const stats = { total: tickets.length, promote: 0, futuros: 0, sinFecha: 0, errores: 0, yaEmitidos: 0 };
  const aPromover = [];

  for (const t of tickets) {
    const p = t.properties || {};
    // ya facturado de algún modo → no tocar (no debería estar en forecast, pero por las dudas)
    if (String(p.numero_de_factura || '').trim() || String(p.of_invoice_id || '').trim()) { stats.yaEmitidos++; continue; }
    const fecha = ymd(p.of_fecha_de_facturacion) || ymd(p.fecha_resolucion_esperada);
    if (!fecha) { stats.sinFecha++; console.log(`  [SIN FECHA] tkt ${t.id} st=${p.hs_pipeline_stage} | ${(p.subject || '').slice(0, 50)}`); continue; }
    if (fecha > cutoff) { stats.futuros++; continue; } // futuro lejano → lo promueve el motor a su tiempo
    aPromover.push({ id: t.id, fecha, subject: p.subject || '', deal: p.of_deal_id || '', stage: p.hs_pipeline_stage });
  }

  aPromover.sort((a, b) => a.fecha.localeCompare(b.fecha));
  for (const t of aPromover) {
    const venc = t.fecha < today ? 'PASADA ' : 'próx.  ';
    const asocStr = t.deal ? ` +asoc→deal ${t.deal}` : ' ⚠️SIN of_deal_id (no asocia)';
    if (DRY_RUN) {
      console.log(`  [PROMOVER ${venc}] tkt ${t.id} fecha=${t.fecha} deal=${t.deal || '∅'}${asocStr} | ${t.subject.slice(0, 40)} (dry)`);
      stats.promote++;
      continue;
    }
    try {
      // 1) stage → Próximos a facturar
      await hs('PATCH', `/crm/v3/objects/tickets/${t.id}`, { properties: { hs_pipeline_stage: PROXIMOS } });
      // 2) asociar ticket↔deal (los forecast NO están asociados; sin esto Paso C/el motor no los ven).
      //    Asociación DEFAULT (v4). of_deal_id viene en el propio ticket.
      if (t.deal) {
        try {
          await hs('PUT', `/crm/v4/objects/tickets/${t.id}/associations/default/deals/${t.deal}`);
        } catch (e) {
          console.warn(`  ⚠️ tkt ${t.id}: stage OK pero asociación falló: ${e.message.slice(0, 80)}`);
          stats.errores++;
        }
      } else {
        console.warn(`  ⚠️ tkt ${t.id}: promovido pero SIN of_deal_id → no se pudo asociar (revisar)`);
      }
      console.log(`  [PROMOVIDO ${venc}] tkt ${t.id} fecha=${t.fecha} → Próximos a facturar${asocStr} ✓`);
      stats.promote++;
      await sleep(150);
    } catch (err) {
      console.warn(`  ⚠️ tkt ${t.id}: ${err.message}`);
      stats.errores++;
    }
  }

  const report = { generatedAt: new Date().toISOString(), mode: DRY_RUN ? 'DRY' : 'EXECUTE', today, cutoff, days: DAYS, deal: SINGLE_DEAL || 'ALL', stats, promovidos: aPromover };
  writeFileSync(`promover-manual-forecast-${today}.json`, JSON.stringify(report, null, 2));

  console.log('\n' + '═'.repeat(70));
  console.log('  📊 RESUMEN');
  console.log(`  En forecast:            ${stats.total}`);
  console.log(`  ${DRY_RUN ? 'A promover' : 'Promovidos'} (fecha≤hoy+${DAYS}d): ${stats.promote}`);
  console.log(`  Futuros (no se tocan):  ${stats.futuros}`);
  console.log(`  Sin fecha (revisar):    ${stats.sinFecha}`);
  console.log(`  Ya facturados (skip):   ${stats.yaEmitidos}`);
  console.log(`  Errores:                ${stats.errores}`);
  console.log('═'.repeat(70));
  if (DRY_RUN && stats.promote > 0) console.log('\n  💡 Para ejecutar: agregá --execute');
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
