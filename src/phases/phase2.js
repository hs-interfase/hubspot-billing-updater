// src/phases/phase2.js

import { hubspotClient } from '../hubspotClient.js';
import { parseBool } from '../utils/parsers.js';
import { getTodayYMD, parseLocalDate, diffDays, formatDateISO } from '../utils/dateUtils.js';
import { MANUAL_TICKET_LOOKAHEAD_DAYS } from '../config/constants.js';
import { resolvePlanYMD } from '../utils/resolvePlanYMD.js';
import { createTicketAssociations, getDealCompanies, getDealContacts } from '../services/tickets/ticketService.js';
import { buildTicketKeyFromLineItemKey } from '../utils/ticketKey.js';
import { syncLineItemAfterPromotion } from '../services/lineItems/syncAfterPromotion.js'; 


/**
 * PHASE 2 (MANUAL):
 * - Requiere deal.facturacion_activa=true
 * - Solo aplica a line items manuales (facturacion_automatica != true)
 * - Si la próxima fecha (planYMD) está en la ventana de lookahead (ej. 30 días),
 *   NO crea tickets: PROMUEVE el ticket forecast existente a READY (entrada al flujo real manual).
 *
 * Idempotencia:
 * - El ticket se identifica por of_ticket_key = dealId::LIK::YYYY-MM-DD
 * - Si ya fue promovido (ya no está en forecast stage), no se toca.
 */

// ====== STAGES (IDs reales) ======
const BILLING_TICKET_STAGE_READY_ENTRY = process.env.BILLING_TICKET_STAGE_ID || '1234282360';

// Manual forecast stages por bucket de deal stage
const BILLING_TICKET_FORECAST_25 = '1294744238';
const BILLING_TICKET_FORECAST_50 = '1294744239';
const BILLING_TICKET_FORECAST_75 = '1296492870';
const BILLING_TICKET_FORECAST_95 = '1296492871';

const FORECAST_MANUAL_STAGES = new Set([
  BILLING_TICKET_FORECAST_25,
  BILLING_TICKET_FORECAST_50,
  BILLING_TICKET_FORECAST_75,
  BILLING_TICKET_FORECAST_95,
]);

function buildTicketKey(dealId, lineItemKey, ymd) {
  return `${String(dealId)}::${String(lineItemKey)}::${String(ymd)}`;
}

function resolveDealBucket(dealstage) {
  // dealstage: internal name (appointmentscheduled, decisionmakerboughtin, contractsent, closedwon, etc.)
  const s = String(dealstage || '');
  if (s === 'decisionmakerboughtin') return '50';
  if (s === 'contractsent') return '75';
  if (s === 'closedwon') return '95';
  return '25'; // stages 5/10/25
}

function resolveManualForecastStageForDealStage(dealstage) {
  const b = resolveDealBucket(dealstage);
  if (b === '50') return BILLING_TICKET_FORECAST_50;
  if (b === '75') return BILLING_TICKET_FORECAST_75;
  if (b === '95') return BILLING_TICKET_FORECAST_95;
  return BILLING_TICKET_FORECAST_25;
}

async function findTicketByTicketKey(ticketKey) {
  const body = {
    filterGroups: [
      {
        filters: [{ propertyName: 'of_ticket_key', operator: 'EQ', value: String(ticketKey) }],
      },
    ],
    properties: [
      'hs_pipeline_stage',
      'of_ticket_key',
      'fecha_resolucion_esperada',
      'of_line_item_key',
      'of_deal_id',
    ],
    limit: 2,
  };

  const resp = await hubspotClient.crm.tickets.searchApi.doSearch(body);
  return (resp?.results || [])[0] || null;
}

async function moveTicketToStage(ticketId, stageId) {
  return hubspotClient.crm.tickets.basicApi.update(String(ticketId), {
    properties: { hs_pipeline_stage: String(stageId) },
  });
}

/**
 * Promueve un ticket forecast manual a READY (entrada al flujo real).
 * - No crea tickets.
 * - Solo mueve si el ticket está en forecast manual (cualquiera) y
 * crea asociaciones para que sean visibles desde el deal 
 *   preferentemente en el forecast stage esperado para el deal stage.
 */
async function promoteManualForecastTicketToReady({
  dealId,
  dealStage,
  lineItemKey,
  nextBillingDate,
  lineItemId,
}) {

  if (!lineItemKey) return { moved: false, reason: 'missing_line_item_key' };

const ticketKeyNew = buildTicketKeyFromLineItemKey(dealId, lineItemKey, nextBillingDate);
let t = await findTicketByTicketKey(ticketKeyNew);

let ticketKeyUsed = ticketKeyNew;

 if (ticketKeyUsed !== ticketKeyNew) {
  console.log('[phase2][lookup] used fallback key', { ticketKeyNew, ticketKeyUsed });
}

if (!t) {
    return { moved: false, reason: 'missing_forecast_ticket', ticketKey: ticketKeyUsed };
  }

  const currentStage = String(t?.properties?.hs_pipeline_stage || '');

  // Si ya está en READY_ENTRY (limbo previo), no hacer nada (idempotente OK)
  if (currentStage === BILLING_TICKET_STAGE_READY_ENTRY) {
    return { moved: false, reason: 'already_ready_entry', ticketId: t.id };
  }

  // Si no está en forecast manual, NO tocar (puede ser real o automático)
  if (!FORECAST_MANUAL_STAGES.has(currentStage)) {
    return { moved: false, reason: `not_manual_forecast_stage:${currentStage}`, ticketId: t.id };
  }


  // cargar asociaciones objetivo (no bloquear si algo falla)
  const companyIds = await getDealCompanies(String(dealId)).catch(() => []);
  const contactIds =
    (typeof getDealContacts === 'function'
      ? await getDealContacts(String(dealId)).catch(() => [])
      : []);

  // Validación suave (log): forecast stage esperado por deal stage
  const expectedForecastStage = resolveManualForecastStageForDealStage(dealStage);

  let moved = false;
  let reason = '';

  if (currentStage !== expectedForecastStage) {
    await moveTicketToStage(t.id, BILLING_TICKET_STAGE_READY_ENTRY);
    moved = true;
    reason = `moved_from_unexpected_forecast_stage:${currentStage}_expected:${expectedForecastStage}`;
  } else {
    await moveTicketToStage(t.id, BILLING_TICKET_STAGE_READY_ENTRY);
    moved = true;
    reason = 'moved';
  }

  // Asociar SOLO al pasar a READY_ENTRY
  if (lineItemId) {
    await createTicketAssociations(
      String(t.id),
      String(dealId),
      String(lineItemId),
      companyIds || [],
      contactIds || []
    );
  }

  // Llamar syncLineItemAfterPromotion si se promovió
  if (moved) {
    await syncLineItemAfterPromotion({
      dealId,
      lineItemId,
      lineItemKey,
      expectedYMD: nextBillingDate,
    });
  }

  return { moved, ticketId: t.id, reason };
}


export async function runPhase2({ deal, lineItems }) {
  const dealId = String(deal.id || deal.properties?.hs_object_id);
  const dp = deal.properties || {};
  const dealStage = String(dp.dealstage || '');
  const today = getTodayYMD();

  console.log(`   [Phase2] Hoy: ${today}`);
  console.log(
    `   [Phase2] Lookahead: ${MANUAL_TICKET_LOOKAHEAD_DAYS} días (hasta ${calculateLookaheadDate(
      today,
      MANUAL_TICKET_LOOKAHEAD_DAYS
    )})`
  );
  console.log(`   [Phase2] Total line items: ${lineItems.length}`);

  const dealFacturacionActiva = parseBool(dp.facturacion_activa);
  console.log(
    `   [Phase2] Deal facturacion_activa: ${dp.facturacion_activa} (parsed=${dealFacturacionActiva})`
  );

  if (!dealFacturacionActiva) {
    console.log(`   [Phase2] ⚠️  Deal NO tiene facturacion_activa=true, saltando Phase 2`);
    return { ticketsCreated: 0, errors: [] };
  }

  let ticketsCreated = 0; // (en realidad: promoted)
  const errors = [];

  // Line items manuales: facturacion_automatica !== true
  const manualLineItems = (lineItems || []).filter((li) => {
    const lp = li?.properties || {};
    const raw = lp.facturacion_automatica;
    const isManual = raw !== true && raw !== 'true';

    console.log(
      `   [Phase2] LI ${li.id}: facturacion_automatica=${raw} → es manual: ${isManual}`
    );
    return isManual;
  });

  console.log(
    `   [Phase2] Line items MANUALES (facturacion_automatica!=true): ${manualLineItems.length}`
  );

  if (manualLineItems.length === 0) {
    console.log(`   [Phase2] No hay line items para tickets manuales`);
    return { ticketsCreated: 0, errors: [] };
  }

  for (const li of manualLineItems) {
    const lineItemId = String(li.id || li.properties?.hs_object_id);
    const lp = li.properties || {};
    const liName = lp.name || `LI ${lineItemId}`;

    console.log(`\n   [Phase2] Analizando: ${liName} (${lineItemId})`);
    console.log(`      facturacion_automatica: ${lp.facturacion_automatica || 'undefined/null'}`);
    console.log(`      billing_next_date: ${lp.billing_next_date || 'undefined'}`);

    try {
      const persistedNext = (lp.billing_next_date ?? '').toString().slice(0, 10);

      const planYMD = resolvePlanYMD({
        lineItemProps: lp,
        context: { flow: 'PHASE2', dealId, lineItemId },
      });

      console.log(
        `      → planYMD: ${planYMD || 'null'} (persisted billing_next_date=${persistedNext || 'null'})`
      );

      const nextBillingDate = planYMD;

      if (!nextBillingDate) {
        console.log(`      ⚠️  Sin próxima fecha de facturación, saltando...`);
        continue;
      }

      const daysUntilBilling = diffDays(today, nextBillingDate);

      if (daysUntilBilling === null) {
        console.log(`      ⚠️  No se pudo calcular días hasta facturación, saltando...`);
        continue;
      }

      if (daysUntilBilling < 0) {
        console.log(`      📅 Fecha pasada (${nextBillingDate}), saltando...`);
        continue;
      }

      if (daysUntilBilling > MANUAL_TICKET_LOOKAHEAD_DAYS) {
        console.log(
          `      📅 Fecha ${nextBillingDate} en ${daysUntilBilling} días (fuera de lookahead de ${MANUAL_TICKET_LOOKAHEAD_DAYS} días)`
        );
        continue;
      }

      console.log(`      🎫 ¡DENTRO DEL LOOKAHEAD! Promoviendo ticket forecast → READY`);
      console.log(`      Fecha: ${nextBillingDate}, faltan ${daysUntilBilling} días`);

      const lineItemKey = lp.line_item_key ? String(lp.line_item_key).trim() : '';
      if (!lineItemKey) {
        console.log(
          `      ⚠️ line_item_key vacío para LI ${lineItemId}; Phase1 debería setearlo. Skip.`
        );
        continue;
      }

const promoted = await promoteManualForecastTicketToReady({
  dealId,
  dealStage,
  lineItemKey,
  nextBillingDate: planYMD,
  lineItemId,
});


      if (promoted.moved) {
        ticketsCreated++;
        console.log(`      ✅ Ticket movido a READY: ${promoted.ticketId}`);
        if (promoted.reason && promoted.reason !== 'moved') {
          console.log(`      ℹ️  Nota: ${promoted.reason}`);
        }
      } else {
        console.log(
          `      🔄 No se movió: ${promoted.reason} (${promoted.ticketId || promoted.ticketKey || 'sin ticket'})`
        );
        if (promoted.reason === 'missing_forecast_ticket') {
          errors.push({
            lineItemId,
            error: `Missing forecast ticket for ${promoted.ticketKey}`,
          });
        }
      }
    } catch (err) {
      console.error(`      ❌ Error procesando:`, err?.message || err);
      errors.push({ lineItemId, error: err?.message || 'Error desconocido' });
    }
  }

  console.log(
    `\n   ✅ Phase 2 completada: ${ticketsCreated} tickets promovidos a READY, ${errors.length} errores`
  );

  return { ticketsCreated, errors };
}

/**
 * Calcula la fecha límite del lookahead para mostrar en logs
 */
function calculateLookaheadDate(today, days) {
  const date = parseLocalDate(today);
  if (!date) return 'N/A';
  date.setDate(date.getDate() + days);
  return formatDateISO(date);
}
