// src/phases/phaseP.js
import { hubspotClient } from '../hubspotClient.js';
import { getEffectiveBillingConfig } from '../billingEngine.js';
import { parseLocalDate, formatDateISO, addInterval } from '../utils/dateUtils.js';
import { getDealCompanies } from '../services/tickets/ticketService.js';

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

function buildTicketKey({ dealId, lineItemKey, ymd }) {
  return `${String(dealId)}::${String(lineItemKey)}::${String(ymd)}`;
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
 * - frequency + term finito => term
 * - frequency + autorenew (sin term) => 24
 */
function buildDesiredDates(lineItem) {
  const p = lineItem?.properties || {};
  const cfg = getEffectiveBillingConfig(lineItem);

  // startDate efectivo
  const startYmd =
    toYmd(p.hs_recurring_billing_start_date) ||
    (cfg?.startDate ? formatDateISO(cfg.startDate) : '') ||
    toYmd(p.recurringbillingstartdate) ||
    toYmd(p.fecha_inicio_de_facturacion) ||
    '';

  if (!startYmd) return { desiredCount: 0, dates: [] };

  // frequency/interval efectivo
  const interval = cfg?.interval ?? null;
  const hasFrequency = !!interval;

  // term finito: leerlo directo (porque cfg no retorna numberOfPayments)
  const termRaw =
    p.hs_recurring_billing_number_of_payments ||
    p.number_of_payments ||
    null;

  const term = safeInt(termRaw);

  // Caso pago único
  if (!hasFrequency) {
    return { desiredCount: 1, dates: [startYmd] };
  }

  // Caso con frecuencia
  let desiredCount = 24; // autorenew por default
  if (term && term > 0) desiredCount = term;

  // Generación
  const dates = [];
  let d = parseLocalDate(startYmd);
  if (!d) return { desiredCount: 0, dates: [] };

  for (let i = 0; i < desiredCount; i++) {
    if (i > 0) d = addInterval(d, interval);
    dates.push(formatDateISO(d));
  }

  return { desiredCount, dates };
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
      'hs_pipeline_stage',
      'fecha_resolucion_esperada',
      'of_line_item_key',
      'of_deal_id',
      'of_ticket_key',
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
  return buildTicketKey({ dealId, lineItemKey, ymd });
}

async function resolveCompanySnapshot(dealId) {
  try {
    const companyIds = await getDealCompanies(String(dealId)); // ya existe en ticketService
    const companyId = companyIds?.[0] ? String(companyIds[0]) : '';
    if (!companyId) return { empresaId: '', empresaNombre: '' };

    const c = await hubspotClient.crm.companies.basicApi.getById(companyId, ['name']);
    const empresaNombre = c?.properties?.name || '';
    return { empresaId: companyId, empresaNombre };
  } catch (e) {
    return { empresaId: '', empresaNombre: '' };
  }
}

function resolveProductAndUEN(lineItem) {
  const lp = lineItem?.properties || {};
  const productoNombre = lp.name || lp.hs_name || ''; // "name" suele ser el nombre del producto del line item
  const unidadDeNegocio =
    lp.unidad_de_negocio || lp.of_unidad_de_negocio || lp.hs_business_unit || '';
  return { productoNombre, unidadDeNegocio };
}

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

const companyIds = await getDealCompanies(String(dealId));
const empresaId = companyIds?.[0] ? String(companyIds[0]) : '';

let empresaNombre = '';
if (empresaId) {
  const c = await hubspotClient.crm.companies.basicApi.getById(empresaId, ['name']);
  empresaNombre = c?.properties?.name || '';
}

  for (const li of lineItems || []) {
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
    const protectedTickets = allTickets.filter(t => !isForecastTicket(t)); // no-touch

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
      const key = buildTicketKey({ dealId, lineItemKey, ymd });
      desiredKeys.add(key);
      desiredByKey.set(key, ymd);
    }

    // 5) Mapear existentes por key (incluye forecast + protegidos)
    const existingByKey = new Map();
    for (const t of allTickets) {
      const k = getTicketKeyOrDerive({ ticket: t, dealId, lineItemKey });
      if (!k) continue;
      // Si hay colisiones, preferimos el NO forecast (protegido), para evitar recreación.
      if (!existingByKey.has(k)) {
        existingByKey.set(k, t);
      } else {
        const prev = existingByKey.get(k);
        const prevIsForecast = isForecastTicket(prev);
        const nextIsForecast = isForecastTicket(t);
        if (prevIsForecast && !nextIsForecast) existingByKey.set(k, t);
      }
    }

    let changed = false;

    // 6) Upsert: crear faltantes; actualizar solo si es forecast editable
    for (const key of desiredKeys) {
      const expectedYmd = desiredByKey.get(key);
      const existing = existingByKey.get(key);

      if (!existing) {
        console.log('[phaseP] create forecast ticket', { dealId, lineItemKey, expectedYmd, targetStage });
const { productoNombre, unidadDeNegocio } = resolveProductAndUEN(li);

const hsPipeline = automated ? BILLING_AUTOMATED_PIPELINE_ID : BILLING_TICKET_PIPELINE_ID;
const rubro = (li?.properties?.servicio || '').toString(); // viene del line item

await createForecastTicket({
  dealId,
  lineItemKey,
  ticketKey: key,
  expectedYmd,
  targetStage,

  lineItemId: li.id,
  hsPipeline,

  empresaId,
  empresaNombre,
  productoNombre,
  unidadDeNegocio,
  rubro,
});

        created++;
        changed = true;
        continue;
      }

      // existe, pero solo podemos tocar si sigue siendo forecast editable
      if (!isForecastTicket(existing)) {
        // protegido: no tocar
        continue;
      }

      const currentYmd = toYmd(existing?.properties?.fecha_resolucion_esperada);
      const currentStage = String(existing?.properties?.hs_pipeline_stage || '');
      const currentKey = String(existing?.properties?.of_ticket_key || '').trim();

      const patch = {};
      if (currentYmd !== expectedYmd) patch.fecha_resolucion_esperada = expectedYmd;
      if (currentStage !== targetStage) patch.hs_pipeline_stage = targetStage;
      if (!currentKey) patch.of_ticket_key = key;

      if (Object.keys(patch).length) {
        console.log('[phaseP] update forecast ticket', { ticketId: existing.id, patch });
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
