// scripts/diagnostics/diagValorTotal.mjs
//
// Diagnóstico del cálculo de `valor_total` de un deal.
// Imprime, ticket por ticket, si cuenta o no y POR QUÉ, replicando exactamente
// la lógica de src/services/deal/recalcValorTotal.js (reusa sus constantes).
//
// Uso:
//   node ./scripts/diagnostics/diagValorTotal.mjs <DEAL_ID>
//   node ./scripts/diagnostics/diagValorTotal.mjs <DEAL_ID> --year 2025   (simula otro año)
//
// NO escribe nada en HubSpot: solo lee.

import 'dotenv/config';
import { Client } from '@hubspot/api-client';
import { TICKET_STAGES, BILLING_AUTOMATED_CANCELLED } from '../../src/config/constants.js';
import { getDealTicketIds } from '../../src/services/deal/recalcValorTotal.js';

const TOKEN = process.env.HUBSPOT_PRIVATE_TOKEN;
if (!TOKEN) { console.error('Falta HUBSPOT_PRIVATE_TOKEN'); process.exit(1); }

const PROP_DEAL_TOTAL = process.env.PROP_DEAL_TOTAL || 'valor_total';

// ── Args ──
const argv = process.argv.slice(2);
const DEAL_ID = argv.find((a) => /^\d+$/.test(a));
const yearFlagIdx = argv.indexOf('--year');
const ANIO = yearFlagIdx >= 0 ? Number(argv[yearFlagIdx + 1]) : new Date().getUTCFullYear();

if (!DEAL_ID) {
  console.error('Uso: node ./scripts/diagnostics/diagValorTotal.mjs <DEAL_ID> [--year YYYY]');
  process.exit(1);
}

const hubspot = new Client({ accessToken: TOKEN });

const CANCELLED = new Set(
  [TICKET_STAGES.CANCELLED, BILLING_AUTOMATED_CANCELLED].filter(Boolean)
);

const FECHAS_PRIORIDAD = [
  'fecha_real_de_facturacion',
  'of_fecha_de_facturacion',
  'fecha_resolucion_esperada',
];

// Devuelve { campo, valor, anio } de la primera fecha con valor, o null.
function fechaDelPago(p) {
  for (const f of FECHAS_PRIORIDAD) {
    const raw = p?.[f];
    if (raw === undefined || raw === null || raw === '') continue;
    const s = String(raw).trim();
    let anio = null;
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) anio = Number(s.slice(0, 4));
    else {
      const ms = Number(s);
      if (Number.isFinite(ms) && ms > 0) anio = new Date(ms).getUTCFullYear();
    }
    return { campo: f, valor: s, anio };
  }
  return null;
}

const fmt = (n) => Number(n).toLocaleString('es-UY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function main() {
  console.log('\n══════════════════════════════════════════════════════════');
  console.log(`DIAGNÓSTICO valor_total — Deal ${DEAL_ID}  (año de cálculo: ${ANIO})`);
  console.log('══════════════════════════════════════════════════════════');

  const deal = await hubspot.crm.deals.basicApi.getById(DEAL_ID, [
    'dealname', 'deal_currency_code', 'es_mirror_de_py', PROP_DEAL_TOTAL,
  ]);
  const dp = deal.properties;
  console.log(`dealname        : ${dp.dealname}`);
  console.log(`moneda          : ${dp.deal_currency_code || '(sin código)'}`);
  console.log(`es_mirror_de_py : ${dp.es_mirror_de_py || 'false'}`);
  console.log(`${PROP_DEAL_TOTAL} actual : ${dp[PROP_DEAL_TOTAL] ?? '(vacío)'}`);

  const ticketIds = await getDealTicketIds(DEAL_ID);
  console.log(`\nTickets del deal (of_deal_id ∪ asociaciones): ${ticketIds.length}`);
  if (!ticketIds.length) { console.log('Nada que sumar → valor_total = 0'); return; }

  let total = 0;
  const filas = [];
  const resumen = { contados: 0, cancelados: 0, fueraDeAnio: 0, sinFecha: 0 };

  for (let i = 0; i < ticketIds.length; i += 100) {
    const chunk = ticketIds.slice(i, i + 100);
    const batch = await hubspot.crm.tickets.batchApi.read({
      inputs: chunk.map((id) => ({ id })),
      properties: [
        'subject', 'renovacion_automatica', 'subtotal_real', 'hs_pipeline_stage',
        ...FECHAS_PRIORIDAD,
      ],
    }, false);

    for (const t of batch.results || []) {
      const p = t.properties || {};
      const valor = Number.parseFloat(p.subtotal_real) || 0;
      const esRenew = String(p.renovacion_automatica || '').toLowerCase() === 'true';
      const stage = String(p.hs_pipeline_stage || '');
      const f = fechaDelPago(p);

      let cuenta = false;
      let motivo;

      if (CANCELLED.has(stage)) {
        motivo = 'CANCELADO';
        resumen.cancelados++;
      } else if (esRenew) {
        if (!f || f.anio === null) {
          motivo = 'auto-renew SIN FECHA → no cuenta';
          resumen.sinFecha++;
        } else if (f.anio === ANIO) {
          cuenta = true;
          motivo = `auto-renew año ${f.anio} = ${ANIO} ✔`;
        } else {
          motivo = `auto-renew año ${f.anio} ≠ ${ANIO} → fuera`;
          resumen.fueraDeAnio++;
        }
      } else {
        cuenta = true;
        motivo = 'plan fijo/manual → cuenta';
      }

      if (cuenta) { total += valor; resumen.contados++; }

      filas.push({
        id: t.id,
        subject: (p.subject || '').slice(0, 24),
        renew: esRenew ? 'sí' : 'no',
        subtotal: valor,
        fecha: f ? `${f.campo.replace('fecha_', '').replace('_de_facturacion', '')}=${f.valor.slice(0, 10)}` : '—',
        cuenta: cuenta ? '✔' : '·',
        motivo,
      });
    }
  }

  total = Math.round(total * 100) / 100;

  // ── Tabla ──
  console.log('\n─────────────────────────────────────────────────────────────────────────────');
  console.log('TICKET'.padEnd(12) + 'RENEW'.padEnd(7) + 'SUBTOTAL'.padStart(14) + '  ' + 'CUENTA'.padEnd(8) + 'MOTIVO');
  console.log('─────────────────────────────────────────────────────────────────────────────');
  for (const r of filas) {
    console.log(
      String(r.id).padEnd(12) +
      r.renew.padEnd(7) +
      fmt(r.subtotal).padStart(14) + '  ' +
      r.cuenta.padEnd(8) +
      r.motivo + (r.fecha !== '—' ? `  [${r.fecha}]` : '')
    );
  }

  // ── Resumen ──
  console.log('\n══════════════════════════════════════════════════════════');
  console.log('RESUMEN');
  console.log('══════════════════════════════════════════════════════════');
  console.log(`Tickets contados   : ${resumen.contados}`);
  console.log(`Excluidos cancelado: ${resumen.cancelados}`);
  console.log(`Auto-renew fuera año: ${resumen.fueraDeAnio}`);
  console.log(`Auto-renew sin fecha: ${resumen.sinFecha}`);
  console.log('───────────────────────────────────');
  console.log(`TOTAL CALCULADO    : ${fmt(total)} ${dp.deal_currency_code || ''}`);
  console.log(`valor_total actual : ${dp[PROP_DEAL_TOTAL] != null ? fmt(dp[PROP_DEAL_TOTAL]) : '(vacío)'}`);
  const prev = Number.parseFloat(dp[PROP_DEAL_TOTAL]);
  if (Number.isFinite(prev)) {
    console.log(prev === total ? '✔ Coincide con el valor en HubSpot' : `⚠ DIFIERE en ${fmt(total - prev)} (se actualizaría al correr las fases)`);
  } else {
    console.log('ℹ valor_total aún no tiene valor en HubSpot');
  }
}

main().catch((err) => {
  console.error('Error fatal:', err.message);
  process.exit(1);
});
