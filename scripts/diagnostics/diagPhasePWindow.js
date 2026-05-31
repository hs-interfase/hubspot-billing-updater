#!/usr/bin/env node
/**
 * diagPhasePWindow.js
 *
 * Diagnóstico dry-run de la ventana fija de buildDesiredDates (Phase P).
 *
 * Uso (PowerShell):
 *   node diagPhasePWindow.js --deal 55261281948
 *   node diagPhasePWindow.js --deal 55261281948 --simulate-year 2027
 *   node diagPhasePWindow.js --deal 55261281948 --verbose
 *
 * Qué hace:
 *   1. Lee deal + line items desde HubSpot
 *   2. Por cada LI auto-renew, corre buildDesiredDates en modo dry (no crea tickets)
 *   3. Muestra fechas generadas, split pasado/futuro, conteos
 *   4. Busca tickets existentes y cruza keys para detectar colisiones con protegidos
 *   5. Con --simulate-year, overridea "hoy" al 01-05 de ese año para verificar ventana
 */

import 'dotenv/config';
import { hubspotClient } from './src/hubspotClient.js';
import { buildDesiredDates } from './src/phases/phaseP.js';
import { getEffectiveBillingConfig } from './src/billingEngine.js';
import { buildTicketKeyFromLineItemKey } from './src/utils/ticketKey.js';
import { withRetry } from './src/utils/withRetry.js';
import { isForecastStage } from './src/config/constants.js';

// ── Args ──────────────────────────────────────────────────
const args = process.argv.slice(2);

function getArg(name) {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : null;
}

const dealId = getArg('--deal');
const simulateYear = getArg('--simulate-year');
const verbose = args.includes('--verbose');

if (!dealId) {
  console.error('Uso: node diagPhasePWindow.js --deal <DEAL_ID> [--simulate-year <AÑO>] [--verbose]');
  process.exit(1);
}

// Si simulate-year, construimos un "hoy" ficticio: 1ro de mayo de ese año
const overrideToday = simulateYear ? `${simulateYear}-05-01` : null;

// ── Helpers ───────────────────────────────────────────────

function isAutomatedBilling(li) {
  const p = li?.properties || {};
  const raw =
    p.facturacion_automatica ??
    p.billing_automatico ??
    p.facturacion_automatica__c ??
    p.of_facturacion_automatica ??
    '';
  const v = String(raw).trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'si' || v === 'sí' || v === 'yes';
}

const LINE_ITEM_PROPS = [
  'name',
  'line_item_key',
  'of_line_item_key',
  'hs_recurring_billing_start_date',
  'recurringbillingstartdate',
  'fecha_inicio_de_facturacion',
  'hs_recurring_billing_frequency',
  'recurringbillingfrequency',
  'hs_recurring_billing_number_of_payments',
  'number_of_payments',
  'hs_recurring_billing_period',
  'renovacion_automatica',
  'facturacion_automatica',
  'billing_automatico',
  'facturacion_automatica__c',
  'of_facturacion_automatica',
  'billing_next_date',
  'billing_anchor_date',
  'last_ticketed_date',
  'forecast_last_generated_at',
  'pausa',
  'motivo_de_pausa',
  'hs_lastmodifieddate',
];

const DEAL_PROPS = [
  'dealname',
  'dealstage',
  'pipeline',
  'of_pais_operativo',
];

async function fetchDeal(id) {
  return hubspotClient.crm.deals.basicApi.getById(String(id), DEAL_PROPS);
}

async function fetchLineItems(dealIdStr) {
  const assocResp = await hubspotClient.crm.associations.v4.basicApi.getPage(
    'deals',
    String(dealIdStr),
    'line_items',
    undefined,
    500
  );
  const ids = (assocResp?.results || []).map(a => String(a.toObjectId));
  if (!ids.length) return [];

  const items = [];
  for (const liId of ids) {
    const li = await hubspotClient.crm.lineItems.basicApi.getById(liId, LINE_ITEM_PROPS);
    items.push(li);
  }
  return items;
}

async function findTicketsByLIK(lineItemKey) {
  if (!lineItemKey) return [];
  const body = {
    filterGroups: [
      {
        filters: [
          { propertyName: 'of_line_item_key', operator: 'EQ', value: String(lineItemKey) },
        ],
      },
    ],
    properties: [
      'hs_pipeline',
      'hs_pipeline_stage',
      'fecha_resolucion_esperada',
      'of_line_item_key',
      'of_deal_id',
      'of_ticket_key',
      'subject',
    ],
    limit: 100,
  };

  const resp = await withRetry(
    () => hubspotClient.crm.tickets.searchApi.doSearch(body),
    { module: 'diag', fn: 'findTicketsByLIK', lineItemKey }
  );
  return resp?.results || [];
}

// ── Main ──────────────────────────────────────────────────

async function main() {
  const sep = '═'.repeat(60);
  const thin = '─'.repeat(60);

  console.log(sep);
  console.log('  DIAGNÓSTICO — Phase P Ventana Fija (buildDesiredDates)');
  console.log(sep);
  console.log(`  Deal ID:        ${dealId}`);
  console.log(`  Simulate year:  ${simulateYear || '(actual)'}`);
  console.log(`  Override today: ${overrideToday || '(none)'}`);
  console.log(sep);
  console.log();

  // 1) Fetch deal
  const deal = await fetchDeal(dealId);
  const dp = deal?.properties || {};
  console.log(`  Deal:       ${dp.dealname || '—'}`);
  console.log(`  Stage:      ${dp.dealstage || '—'}`);
  console.log(`  País:       ${dp.of_pais_operativo || '—'}`);
  console.log();

  // 2) Fetch line items
  const lineItems = await fetchLineItems(dealId);
  console.log(`  Line items: ${lineItems.length}`);
  console.log();

  if (!lineItems.length) {
    console.log('  Sin line items, nada que diagnosticar.');
    return;
  }

  let totalAutoRenew = 0;

  for (const li of lineItems) {
    const p = li?.properties || {};
    const lik = p.line_item_key || p.of_line_item_key || '';
    const automated = isAutomatedBilling(li);
    const cfg = getEffectiveBillingConfig(li);
const termRaw = p.hs_recurring_billing_number_of_payments ?? p.number_of_payments ?? null;
const term = termRaw !== null ? Number.parseInt(String(termRaw).trim(), 10) : null;
const isAutoRenew =
  cfg?.isAutoRenew === true ||
  cfg?.autorenew === true ||
  String(p.renovacion_automatica || '').toLowerCase() === 'true' ||
  !(term > 0);

    console.log(thin);
    console.log(`  📦 LI: ${p.name || li.id}`);
    console.log(`     ID:              ${li.id}`);
    console.log(`     LIK:             ${lik || '(sin key)'}`);
    console.log(`     Automático:      ${automated}`);
    console.log(`     Auto-renew:      ${isAutoRenew}`);
    console.log(`     Start date:      ${p.hs_recurring_billing_start_date || p.recurringbillingstartdate || '—'}`);
    console.log(`     Anchor date:     ${p.billing_anchor_date || '—'}`);
    console.log(`     Frequency:       ${p.hs_recurring_billing_frequency || p.recurringbillingfrequency || '—'}`);
    console.log(`     # Payments:      ${p.hs_recurring_billing_number_of_payments || p.number_of_payments || '—'}`);
    console.log(`     billing_next:    ${p.billing_next_date || '—'}`);
    console.log(`     last_ticketed:   ${p.last_ticketed_date || '—'}`);
    console.log(`     Pausa:           ${p.pausa || 'false'}`);
    console.log();

    if (!lik) {
      console.log(`     ⚠️  Sin line_item_key — Phase P lo saltaría`);
      console.log();
      continue;
    }

    // Fetch tickets existentes para este LIK
    const allTickets = await findTicketsByLIK(lik);
    const forecastTickets = allTickets.filter(t => isForecastStage(String(t?.properties?.hs_pipeline_stage || '')));
    const protectedTickets = allTickets.filter(t => !isForecastStage(String(t?.properties?.hs_pipeline_stage || '')));

    console.log(`     Tickets existentes: ${allTickets.length} total (${forecastTickets.length} forecast, ${protectedTickets.length} protegidos)`);

    // Correr buildDesiredDates
    const opts = overrideToday ? { overrideToday } : {};
    const { desiredCount, dates } = buildDesiredDates(li, allTickets, opts);

    if (!isAutoRenew) {
      console.log(`     [Plan fijo] Fechas deseadas: ${desiredCount}`);
      if (verbose && dates.length) {
        for (const d of dates) console.log(`       • ${d}`);
      } else if (dates.length) {
        console.log(`       Primera: ${dates[0]}  |  Última: ${dates[dates.length - 1]}`);
      }
      console.log();
      continue;
    }

    // Auto-renew — análisis detallado
    totalAutoRenew++;
    const todayRef = overrideToday || new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Montevideo',
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());

    const pastDates = dates.filter(d => d < todayRef);
    const futureDates = dates.filter(d => d >= todayRef);

    console.log();
    console.log(`     🔄 AUTO-RENEW — Ventana fija`);
    console.log(`     "Hoy" ref:       ${todayRef}`);
    console.log(`     Total fechas:    ${dates.length}`);
    console.log(`     Pasadas (<hoy):  ${pastDates.length}`);
    console.log(`     Futuras (>=hoy): ${futureDates.length}`);

    if (dates.length) {
      console.log(`     Rango:           ${dates[0]} → ${dates[dates.length - 1]}`);
    }

    if (verbose) {
      console.log();
      if (pastDates.length) {
        console.log(`     ── Pasadas ──`);
        for (const d of pastDates) console.log(`       ${d}`);
      }
      if (futureDates.length) {
        console.log(`     ── Futuras ──`);
        for (const d of futureDates) console.log(`       ${d}`);
      }
    }

    // Cruce de colisiones con tickets protegidos
    console.log();
    console.log(`     ── Cruce de colisiones ──`);

    const protectedKeys = new Set();
    for (const t of protectedTickets) {
      const tk = String(t?.properties?.of_ticket_key || '').trim();
      if (tk) protectedKeys.add(tk);
    }

    let collisions = 0;
    let wouldCreate = 0;
    let alreadyForecast = 0;

    const forecastKeys = new Set();
    for (const t of forecastTickets) {
      const tk = String(t?.properties?.of_ticket_key || '').trim();
      if (tk) forecastKeys.add(tk);
    }

    for (const ymd of dates) {
      const key = buildTicketKeyFromLineItemKey(dealId, lik, ymd);

      if (protectedKeys.has(key)) {
        collisions++;
        if (verbose) console.log(`       🛡️  ${ymd} — protegido (skip creación)`);
      } else if (forecastKeys.has(key)) {
        alreadyForecast++;
        if (verbose) console.log(`       🔄 ${ymd} — forecast existente (update)`);
      } else {
        wouldCreate++;
        if (verbose) console.log(`       ✨ ${ymd} — nuevo (crearía forecast)`);
      }
    }

    // Forecast sobrantes (existen pero no están en dates deseadas)
    const desiredKeysSet = new Set(dates.map(ymd => buildTicketKeyFromLineItemKey(dealId, lik, ymd)));
    let wouldDelete = 0;
    for (const tk of forecastKeys) {
      if (!desiredKeysSet.has(tk)) {
        wouldDelete++;
        if (verbose) console.log(`       🗑️  sobrante: ${tk}`);
      }
    }

    console.log();
    console.log(`     Resumen upsert:`);
    console.log(`       Crearía:             ${wouldCreate}`);
    console.log(`       Actualizaría:        ${alreadyForecast}`);
    console.log(`       Skip (protegidos):   ${collisions}`);
    console.log(`       Eliminaría sobrantes: ${wouldDelete}`);
    console.log();
  }

  console.log(sep);
  console.log(`  Total LIs auto-renew analizados: ${totalAutoRenew}`);
  console.log(sep);
}

main().catch(err => {
  console.error('Error fatal:', err);
  process.exit(1);
});