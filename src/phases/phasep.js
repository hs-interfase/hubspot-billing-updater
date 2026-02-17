// src/phases/phaseP.js
import { hubspotClient } from '../hubspotClient.js';
import { getEffectiveBillingConfig } from '../billingEngine.js';
import { parseLocalDate, formatDateISO, addInterval } from '../utils/dateUtils.js';
import { buildTicketKeyFromLineItemKey } from '../utils/ticketKey.js';
import { updateTicket } from '../services/tickets/ticketService.js';
import { buildTicketFullProps } from '../services/tickets/ticketService.js'; 
import { safeCreateTicket } from '../services/tickets/ticketService.js';

const BILLING_TZ = 'America/Montevideo';

// ==============================
// Forecast stages (EDITABLES) — reales
// ==============================
const STAGE = {
  // Manual forecast
  MANUAL_FORECAST_25: '1294744238', // deal 5/10/25
  MANUAL_FORECAST_50: '1294744239', // deal 50
  MANUAL_FORECAST_75: '1296492870', // deal 75
  MANUAL_FORECAST_95: '1296492871', // deal 95

  // Automated forecast
  AUTO_FORECAST_25: '1294745999', // deal 5/10/25
  AUTO_FORECAST_50: '1294746000', // deal 50
  AUTO_FORECAST_75: '1296489840', // deal 75
  AUTO_FORECAST_95: '1296362566', // deal 95
};
const BILLING_TICKET_PIPELINE_ID = '832539959';
const BILLING_AUTOMATED_PIPELINE_ID = '829156883';

const FORECAST_TICKET_STAGES = new Set(Object.values(STAGE));

function nowMontevideoYmd() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: BILLING_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function toYmd(value) {
  return (value || '').toString().slice(0, 10);
}

function safeInt(v) {
  const n = Number.parseInt(String(v ?? '').trim(), 10);
  return Number.isFinite(n) ? n : null;
}

// ==============================
// DEAL-LEVEL CLEANUP (orphan forecast)
// ==============================

function parseLikFromTicketKey(ticketKey) {
  const k = String(ticketKey || '').trim();
  if (!k) return '';
  const marker = '::LIK:';
  const i = k.indexOf(marker);
  if (i === -1) return '';
  const rest = k.slice(i + marker.length);
  const j = rest.indexOf('::');
  if (j === -1) return '';
  return rest.slice(0, j).trim();
}

async function cleanupOrphanForecastTicketsForDeal({ dealId, validLiks }) {
  const body = {
    filterGroups: [
      {
        filters: [
          { propertyName: 'of_deal_id', operator: 'EQ', value: String(dealId) },
        ],
      },
    ],
    properties: [
      'hs_pipeline_stage',
      'of_ticket_key',
    ],
    limit: 100,
  };

  const resp = await hubspotClient.crm.tickets.searchApi.doSearch(body);
  const allTickets = resp?.results || [];

  const forecastTickets = allTickets.filter(isForecastTicket);

  console.log('[phaseP][cleanup] forecast tickets encontrados', {
    dealId,
    total: forecastTickets.length,
  });

  let orphanDeleted = 0;

  for (const t of forecastTickets) {
    const ticketId = t.id;
    const ticketKey = String(t?.properties?.of_ticket_key || '').trim();

    if (!ticketKey) continue;

    const lik = parseLikFromTicketKey(ticketKey);
    if (!lik) continue;

    if (!validLiks.has(lik)) {
      await deleteTicket(ticketId);
      orphanDeleted++;
      console.log('[phaseP][cleanup] orphan deleted', { ticketId, ticketKey });
    }
  }

  console.log('[phaseP][cleanup] resumen', { dealId, orphanDeleted });
}

/**
 * ⚠️ Ajustá esto a tu property real de "facturación automática".
 * Yo dejo varios fallbacks razonables.
 */
function isAutomatedBilling(lineItem) {
  const p = lineItem?.properties || {};
  const raw =
    p.facturacion_automatica ??
    p.billing_automatico ??
    p.facturacion_automatica__c ??
    p.of_facturacion_automatica ??
    '';

  const v = String(raw).trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'si' || v === 'sí' || v === 'yes';
}

function resolveBucketFromDealStage(dealStage) {
  const s = String(dealStage || '');

  // 5/10/25
  if (s === 'appointmentscheduled') return '25';
  if (s === 'qualifiedtobuy') return '25';
  if (s === 'presentationscheduled') return '25';

  // 50/75/95
  if (s === 'decisionmakerboughtin') return '50';
  if (s === 'contractsent') return '75';
  if (s === 'closedwon') return '95';

  return null;
}


function resolveForecastStage({ dealStage, automated }) {
  const bucket = resolveBucketFromDealStage(dealStage);
  if (!bucket) return null;

  if (!automated) {
    if (bucket === '50') return STAGE.MANUAL_FORECAST_50;
    if (bucket === '75') return STAGE.MANUAL_FORECAST_75;
    if (bucket === '95') return STAGE.MANUAL_FORECAST_95;
    return STAGE.MANUAL_FORECAST_25;
  }

  // automated
  if (bucket === '50') return STAGE.AUTO_FORECAST_50;
  if (bucket === '75') return STAGE.AUTO_FORECAST_75;
  if (bucket === '95') return STAGE.AUTO_FORECAST_95;
  return STAGE.AUTO_FORECAST_25;
}

/**
 * Construye fechas deseadas según contrato:
 * - start sin frequency => 1
 * - frequency + term finito => hasta term, pero con tope 24 y sin pasar 2 años desde start
 * - frequency + autorenew (sin term) => hasta 2 años desde start, con tope 24
 *
 * Nota: horizonte 2 años = criterio principal; maxCount=24 = límite duro final.
 * Si term existe, también limita (min(term, 24)).
 */
function buildDesiredDates(lineItem) {
  const p = lineItem?.properties || {};
  const cfg = getEffectiveBillingConfig(lineItem);

  // startDate efectivo (YYYY-MM-DD)
  const startYmd =
    toYmd(p.hs_recurring_billing_start_date) ||
    (cfg?.startDate ? formatDateISO(cfg.startDate) : '') ||
    toYmd(p.recurringbillingstartdate) ||
    toYmd(p.fecha_inicio_de_facturacion) ||
    '';

  if (!startYmd) return { desiredCount: 0, dates: [] };

  // ✅ frecuencia real basada en props (si no hay, es "pago único")
  const hasFreqProps =
    String(p.recurringbillingfrequency ?? p.hs_recurring_billing_frequency ?? '').trim() !== '';

  if (!hasFreqProps) {
    return { desiredCount: 1, dates: [startYmd] };
  }

  // frequency/interval efectivo
  const interval = cfg?.interval ?? null;

  // ✅ si hay frecuencia pero interval no se pudo resolver → fallback conservador
  if (!interval) {
    console.log('[phaseP][dates][WARN] has frequency but interval is null -> cannot expand', {
      lineItemId: lineItem?.id,
      lik: p.line_item_key || p.of_line_item_key || '',
      recurringbillingfrequency: p.recurringbillingfrequency,
      hs_recurring_billing_frequency: p.hs_recurring_billing_frequency,
      hs_recurring_billing_number_of_payments: p.hs_recurring_billing_number_of_payments,
    });
    return { desiredCount: 1, dates: [startYmd] };
  }

  // término (si existe)
  const termRaw = p.hs_recurring_billing_number_of_payments ?? p.number_of_payments ?? null;
  const term = safeInt(termRaw);

  // Límite duro final
  const hardMax = 24;
  const maxCount = term && term > 0 ? Math.min(term, hardMax) : hardMax;

  // startDate y horizonte 2 años desde start
  // ==========================
  // ✅ AUTORENEW: arrancar desde HOY / billing_next_date (no desde start histórico)
  // ==========================
  const todayYmd = nowMontevideoYmd();
  const lastTicketedYmd = toYmd(p.last_ticketed_date);
  const billingNextYmd = toYmd(p.billing_next_date);

  // ojo: definí una sola regla de autorenew (acá uso cfg primero)
  const isAutoRenew =
    cfg?.isAutoRenew === true ||
    cfg?.autorenew === true ||
    String(p.renovacion_automatica || '').toLowerCase() === 'true' ||
    // fallback típico: sin term => autorenew
    !(safeInt(p.hs_recurring_billing_number_of_payments ?? p.number_of_payments ?? null) > 0);

  // effectiveToday = hoy o last_ticketed + 1
  let effectiveTodayYmd = todayYmd;
  if (lastTicketedYmd) {
    const d0 = parseLocalDate(lastTicketedYmd);
    if (d0 && Number.isFinite(d0.getTime())) {
      d0.setDate(d0.getDate() + 1);
      const plusOne = formatDateISO(d0);
      if (plusOne > effectiveTodayYmd) effectiveTodayYmd = plusOne;
    }
  }

  // Piso final para autorenew:
  // - priorizá billing_next_date si existe (está alineado con Phase1/Phase2)
  // - si no, hoy/last_ticketed+1
  let seriesStartYmd = startYmd;

  if (isAutoRenew) {
    seriesStartYmd = effectiveTodayYmd;
    if (billingNextYmd && billingNextYmd > seriesStartYmd) seriesStartYmd = billingNextYmd;

    // y nunca antes del start del contrato (por seguridad)
    if (startYmd && startYmd > seriesStartYmd) seriesStartYmd = startYmd;
  }

  // startDate efectivo para generar
  const startDate = parseLocalDate(seriesStartYmd);
  if (!startDate) return { desiredCount: 0, dates: [] };

  // horizonte 2 años desde el start efectivo de generación (no el histórico)
  const horizonDate = new Date(startDate.getTime());
  horizonDate.setFullYear(horizonDate.getFullYear() + 2);

  const dates = [];
  let d = new Date(startDate.getTime());

  while (dates.length < maxCount) {
    if (!d || !Number.isFinite(d.getTime())) break;

    // horizonte principal: si ya pasamos los 2 años, cortamos
    if (d.getTime() > horizonDate.getTime()) break;

    dates.push(formatDateISO(d));

    // avanzar al siguiente período
    const next = addInterval(d, interval);
    if (!next || !Number.isFinite(next.getTime())) break;

    // guardrail anti-loop (por si addInterval devuelve lo mismo)
    if (next.getTime() === d.getTime()) break;

    d = next;
  }

  return { desiredCount: dates.length, dates };
}

/**
 * Trae TODOS los tickets del LIK (forecast + reales).
 * Importante: no filtramos por stage acá. Filtramos al momento de tocar/borrar.
 */
async function findTicketsByLineItemKey(lineItemKey) {
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

  const resp = await hubspotClient.crm.tickets.searchApi.doSearch(body);
  return resp?.results || [];
}

function isForecastTicket(ticket) {
  const stage = String(ticket?.properties?.hs_pipeline_stage || '');
  return FORECAST_TICKET_STAGES.has(stage);
}

/**
 * Si falta of_ticket_key (legacy), derivamos uno "virtual" por fecha.
 * Esto evita que Phase P duplique por no ver keys en tickets viejos.
 */
function getTicketKeyOrDerive({ ticket, dealId, lineItemKey }) {
  const k = String(ticket?.properties?.of_ticket_key || '').trim();
  if (k) return k;
  const ymd = toYmd(ticket?.properties?.fecha_resolucion_esperada);
  if (!ymd) return '';
  return buildTicketKeyFromLineItemKey(dealId, lineItemKey, ymd);
}

/*
export async function createForecastTicket({
  dealId,
  lineItemKey,
  ticketKey,
  expectedYmd,
  targetStage,

  lineItemId,
  hsPipeline,

  empresaId,
  empresaNombre,
  productoNombre,
  unidadDeNegocio,
  rubro,
}) {
  const billDateYMD = String(expectedYmd);

  const subject = `${empresaNombre || 'SIN_EMPRESA'} - ${productoNombre || 'SIN_PRODUCTO'} - ${billDateYMD}`;

  const properties = {
    // pipeline + stage
    hs_pipeline: String(hsPipeline),
    hs_pipeline_stage: String(targetStage),

    // identidad / trazabilidad
    of_deal_id: String(dealId),
    of_line_item_key: String(lineItemKey),
    of_ticket_key: String(ticketKey),
    of_line_item_ids: String(lineItemId || ''),

    // fechas
    fecha_resolucion_esperada: billDateYMD,

    // title
    subject,

    // snapshots para análisis
    empresa_id: empresaId || '',
    nombre_empresa: empresaNombre || '',
    unidad_de_negocio: unidadDeNegocio || '',

    // dropdown producto (si existe en ticket)
    of_producto_nombres: productoNombre || '',

    // rubro/servicio en property existente
    of_rubro: rubro || '',
  };

  return hubspotClient.crm.tickets.basicApi.create({ properties });
}
*/

async function deleteTicket(ticketId) {
  return hubspotClient.crm.tickets.basicApi.archive(String(ticketId));
}

async function updateLineItemLastGeneratedAt(lineItemId) {
  const ymd = nowMontevideoYmd();
  await hubspotClient.crm.lineItems.basicApi.update(String(lineItemId), {
    properties: { forecast_last_generated_at: ymd },
  });
}
/**
 * Phase P (por deal)
 */
export async function runPhaseP({ deal, lineItems }) {
  const dealId = deal?.id || deal?.objectId || deal?.properties?.hs_object_id;
  const dealStage = deal?.properties?.dealstage || '';

  // Contadores de métricas
  let created = 0, updated = 0, deleted = 0, skipped = 0;

  if (!dealId) {
    console.log('[phaseP] missing dealId, skip');
    return { success: false, reason: 'missing_dealId', created: 0, updated: 0, deleted: 0, skipped: 0 };
  }

  console.log('[phaseP] start', { dealId, dealStage, lineItems: lineItems?.length || 0 });
/*
const companyIds = await getDealCompanies(String(dealId));
const empresaId = companyIds?.[0] ? String(companyIds[0]) : '';

let empresaNombre = '';
if (empresaId) {
  const c = await hubspotClient.crm.companies.basicApi.getById(empresaId, ['name']);
  empresaNombre = c?.properties?.name || '';
}
*/
// 🔎 Construir set de LIKs válidos actuales
const validLiks = new Set();

for (const li of lineItems || []) {
  const p = li?.properties || {};
  const lik = p.line_item_key || p.of_line_item_key || '';
  if (lik) validLiks.add(String(lik).trim());
}

// 🧹 Cleanup huérfanos a nivel deal
await cleanupOrphanForecastTicketsForDeal({ dealId, validLiks });

  for (const li of lineItems || []) {
    let changed = false;

    const p = li?.properties || {};
    const lineItemKey = p.line_item_key || p.of_line_item_key || '';

    if (!lineItemKey) {
      console.log('[phaseP] skip line item without line_item_key', { lineItemId: li.id });
      skipped++;
      continue;
    }

    const automated = isAutomatedBilling(li);
    const targetStage = resolveForecastStage({ dealStage, automated });
    const cfg = getEffectiveBillingConfig(li);

    console.log('[phaseP][li]', {
      lineItemId: li.id,
      lik: lineItemKey,
      dealStage,
      automated,
      targetStage,
      startDate: cfg?.startDate ? formatDateISO(cfg.startDate) : null,
      interval: cfg?.interval ?? null,
      numberOfPayments:
        safeInt(p.hs_recurring_billing_number_of_payments ?? p.number_of_payments ?? null),
      autorenew: cfg?.isAutoRenew ?? cfg?.autorenew ?? null,
    });

    if (!targetStage) {
      console.log('[phaseP][skip][bucket]', {
        dealStage,
        lineItemId: li.id,
        reason: 'dealstage_not_in_forecast_buckets',
      });
      skipped++;
      continue;
    }

    // 1) Fechas deseadas
    const { desiredCount, dates } = buildDesiredDates(li);
    console.log('[phaseP][dates]', {
      lineItemId: li.id,
      lik: lineItemKey,
      desiredCount,
      count: dates.length,
      first: dates[0] || null,
      last: dates[dates.length - 1] || null,
    });

    // 2) Traer existentes (TODOS)
    const allTickets = await findTicketsByLineItemKey(lineItemKey);
    const forecastTickets = allTickets.filter(isForecastTicket);      // editables
//    const protectedTickets = allTickets.filter(t => !isForecastTicket(t)); // no-touch

    // 3) Si desiredCount=0 → borrar SOLO forecast existentes
    if (desiredCount === 0) {
      if (forecastTickets.length) {
        console.log('[phaseP] no start_date => delete forecast tickets', {
          lineItemId: li.id,
          lineItemKey,
          count: forecastTickets.length,
        });
        for (const t of forecastTickets) {
          await deleteTicket(t.id);
          deleted++;
        }
        await updateLineItemLastGeneratedAt(li.id);
      }
      continue;
    }

    // 4) Armar set de keys deseadas
    const desiredKeys = new Set();
    const desiredByKey = new Map(); // key -> expectedYmd

    for (const ymd of dates) {
      const key = buildTicketKeyFromLineItemKey(dealId, lineItemKey, ymd);
      desiredKeys.add(key);
      desiredByKey.set(key, ymd);
    }

 // 5) Mapear existentes por key SEPARADOS (forecast vs protegidos)
const existingForecastByKey = new Map();
const existingProtectedByKey = new Map();

for (const t of allTickets) {
  const k = getTicketKeyOrDerive({ ticket: t, dealId, lineItemKey });
  if (!k) continue;

  if (isForecastTicket(t)) {
    // si hay colisión, nos quedamos con el primero (da igual)
    if (!existingForecastByKey.has(k)) existingForecastByKey.set(k, t);
  } else {
    if (!existingProtectedByKey.has(k)) existingProtectedByKey.set(k, t);
  }
}

// 6) Upsert: crear faltantes; actualizar solo si es forecast editable
for (const key of desiredKeys) {
  const expectedYmd = desiredByKey.get(key);

  const existingForecast = existingForecastByKey.get(key);
  const existingProtected = existingProtectedByKey.get(key); // opcional para logs

  if (!existingForecast) {
  // ✅ Si ya existe protected para esa key (promovido/ready/facturado), NO crear duplicado.
  if (existingProtected) {
    console.log('[phaseP] key covered by protected -> skip create', {
      key,
      expectedYmd,
      protectedTicketId: existingProtected.id,
    });
    continue;
  }

  console.log('[phaseP] create forecast ticket', { dealId, lineItemKey, expectedYmd, targetStage });

  const hsPipeline = automated ? BILLING_AUTOMATED_PIPELINE_ID : BILLING_TICKET_PIPELINE_ID;

  const fullProps = await buildTicketFullProps({
    deal,
    lineItem: li,
    dealId,
    lineItemId: li.id,
    lineItemKey,
    ticketKey: key,
    expectedYMD: expectedYmd,
    orderedYMD: null, // forecast
  });

  await safeCreateTicket(hubspotClient, {
    properties: {
      ...fullProps,
      hs_pipeline: String(hsPipeline),
      hs_pipeline_stage: String(targetStage),
    },
  });

  created++;
  changed = true;
  continue;
}

 /* // Si NO hay forecast para esa key => crear SIEMPRE (aunque exista protegido/promovido/facturado)
if (!existingForecast) {
  // ✅ Si existe protected (promovido/ready/facturado) con la misma key, NO crear duplicado.
  if (existingProtected) {
    console.log('[phaseP] key already covered by protected -> skip create', {
      key,
      expectedYmd,
      protectedTicketId: existingProtected.id,
    });
    continue;
  }

  console.log('[phaseP] create forecast ticket', { dealId, lineItemKey, expectedYmd, targetStage });

  const hsPipeline = automated ? BILLING_AUTOMATED_PIPELINE_ID : BILLING_TICKET_PIPELINE_ID;

  const fullProps = await buildTicketFullProps({
    deal,
    lineItem: li,
    dealId,
    lineItemId: li.id,
    lineItemKey,
    ticketKey: key,
    expectedYMD: expectedYmd,
    orderedYMD: null, // forecast
  });

  await safeCreateTicket(hubspotClient, {
    properties: {
      ...fullProps,
      hs_pipeline: String(hsPipeline),
      hs_pipeline_stage: String(targetStage),
    },
  });

  created++;
  changed = true;
  continue;
}
*/

// Existe forecast => STAGE-ONLY (no tocamos contenido)
const existing = existingForecast;

const patch = {};

// ✅ pipeline correcto según modalidad
const hsPipeline = automated ? BILLING_AUTOMATED_PIPELINE_ID : BILLING_TICKET_PIPELINE_ID;
if (String(existing?.properties?.hs_pipeline || '') !== String(hsPipeline)) {
  patch.hs_pipeline = String(hsPipeline);
}

// ✅ stage correcto según bucket dealstage
if (String(existing?.properties?.hs_pipeline_stage || '') !== String(targetStage)) {
  patch.hs_pipeline_stage = String(targetStage);
}

// ✅ compat legacy: si falta of_ticket_key, lo seteamos (no cambia contenido)
if (!String(existing?.properties?.of_ticket_key || '').trim()) {
  patch.of_ticket_key = String(key);
}

// 🚫 NO tocar subject, fecha_resolucion_esperada, ni fullProps.

if (Object.keys(patch).length) {
  await updateTicket(existing.id, patch);
  updated++;
  changed = true;
}
}

    // 7) Borrar sobrantes: SOLO forecast editables cuyo key no esté en desiredKeys
    for (const t of forecastTickets) {
      const k = getTicketKeyOrDerive({ ticket: t, dealId, lineItemKey });
      if (!k) continue;
      if (!desiredKeys.has(k)) {
        console.log('[phaseP] delete extra forecast ticket', { ticketId: t.id, ticketKey: k });
        await deleteTicket(t.id);
        deleted++;
        changed = true;
      }
    }

    if (changed) {
      await updateLineItemLastGeneratedAt(li.id);
    } else {
      // opcional: log para saber que corrió estable
      // console.log('[phaseP] no changes', { lineItemId: li.id, lineItemKey });
    }
  }

  console.log('[phaseP] done', { dealId, created, updated, deleted, skipped });
  return { success: true, created, updated, deleted, skipped };
}
