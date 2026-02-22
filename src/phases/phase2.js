// src/phases/phase2.js

import { hubspotClient } from '../hubspotClient.js';
import { parseBool } from '../utils/parsers.js';
import { getTodayYMD, parseLocalDate, diffDays, formatDateISO } from '../utils/dateUtils.js';
import { MANUAL_TICKET_LOOKAHEAD_DAYS } from '../config/constants.js';
import { resolvePlanYMD } from '../utils/resolvePlanYMD.js';
import { createTicketAssociations, getDealCompanies, getDealContacts } from '../services/tickets/ticketService.js';
import { buildTicketKeyFromLineItemKey } from '../utils/ticketKey.js';
import { syncLineItemAfterPromotion } from '../services/lineItems/syncAfterPromotion.js';
import logger from '../../lib/logger.js';
import { reportHubSpotError } from '../utils/hubspotErrorCollector.js';

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

function reportIfActionable({ objectType, objectId, message, err }) {
  const status = err?.response?.status ?? err?.statusCode ?? null;
  if (status === null) { reportHubSpotError({ objectType, objectId, message }); return; }
  if (status === 429 || status >= 500) return;
  if (status >= 400 && status < 500) reportHubSpotError({ objectType, objectId, message });
}

function buildTicketKey(dealId, lineItemKey, ymd) {
  return `${String(dealId)}::${String(lineItemKey)}::${String(ymd)}`;
}

function resolveDealBucket(dealstage) {
  const s = String(dealstage || '');
  if (s === 'decisionmakerboughtin') return '50';
  if (s === 'contractsent') return '75';
  if (s === 'closedwon') return '95';
  return '25';
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
    logger.info(
      { module: 'phase2', fn: 'promoteManualForecastTicketToReady', ticketKeyNew, ticketKeyUsed },
      'Lookup: usado fallback key'
    );
  }

  if (!t) {
    return { moved: false, reason: 'missing_forecast_ticket', ticketKey: ticketKeyUsed };
  }

  const currentStage = String(t?.properties?.hs_pipeline_stage || '');

  if (currentStage === BILLING_TICKET_STAGE_READY_ENTRY) {
    return { moved: false, reason: 'already_ready_entry', ticketId: t.id };
  }

  if (!FORECAST_MANUAL_STAGES.has(currentStage)) {
    return { moved: false, reason: `not_manual_forecast_stage:${currentStage}`, ticketId: t.id };
  }

  const companyIds = await getDealCompanies(String(dealId)).catch(() => []);
  const contactIds =
    (typeof getDealContacts === 'function'
      ? await getDealContacts(String(dealId)).catch(() => [])
      : []);

  const expectedForecastStage = resolveManualForecastStageForDealStage(dealStage);

  let moved = false;
  let reason = '';

  if (currentStage !== expectedForecastStage) {
    try {
      await moveTicketToStage(t.id, BILLING_TICKET_STAGE_READY_ENTRY);
      moved = true;
      reason = `moved_from_unexpected_forecast_stage:${currentStage}_expected:${expectedForecastStage}`;
    } catch (err) {
      reportIfActionable({ objectType: 'ticket', objectId: String(t.id), message: 'Error al mover ticket a READY_ENTRY desde stage inesperado', err });
      throw err;
    }
  } else {
    try {
      await moveTicketToStage(t.id, BILLING_TICKET_STAGE_READY_ENTRY);
      moved = true;
      reason = 'moved';
    } catch (err) {
      reportIfActionable({ objectType: 'ticket', objectId: String(t.id), message: 'Error al mover ticket forecast a READY_ENTRY', err });
      throw err;
    }
  }

  if (lineItemId) {
    await createTicketAssociations(
      String(t.id),
      String(dealId),
      String(lineItemId),
      companyIds || [],
      contactIds || []
    );
  }

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

  const dealFacturacionActiva = parseBool(dp.facturacion_activa);

  logger.info(
    { module: 'phase2', fn: 'runPhase2', dealId, today, lookaheadDays: MANUAL_TICKET_LOOKAHEAD_DAYS, totalLineItems: lineItems.length, facturacionActiva: dealFacturacionActiva },
    'Inicio Phase 2'
  );

  if (!dealFacturacionActiva) {
    logger.info(
      { module: 'phase2', fn: 'runPhase2', dealId },
      'Deal sin facturacion_activa=true, saltando Phase 2'
    );
    return { ticketsCreated: 0, errors: [] };
  }

  let ticketsCreated = 0;
  const errors = [];

  const manualLineItems = (lineItems || []).filter((li) => {
    const lp = li?.properties || {};
    const raw = lp.facturacion_automatica;
    const isManual = raw !== true && raw !== 'true';
    return isManual;
  });

  logger.info(
    { module: 'phase2', fn: 'runPhase2', dealId, manualLineItemsCount: manualLineItems.length },
    'Line items manuales a procesar'
  );

  if (manualLineItems.length === 0) {
    return { ticketsCreated: 0, errors: [] };
  }

  for (const li of manualLineItems) {
    const lineItemId = String(li.id || li.properties?.hs_object_id);
    const lp = li.properties || {};

    // PAUSA: si el line item está en pausa, skip
    const isPaused = parseBool(lp.pausa);
    if (isPaused) {
      logger.info(
        { module: 'phase2', fn: 'runPhase2', dealId, lineItemId },
        'Line item en pausa, saltando Phase 2'
      );
      continue;
    }
    try {
      const persistedNext = (lp.billing_next_date ?? '').toString().slice(0, 10);

      const planYMD = resolvePlanYMD({
        lineItemProps: lp,
        context: { flow: 'PHASE2', dealId, lineItemId },
      });

      const nextBillingDate = planYMD;

      if (!nextBillingDate) {
        logger.info(
          { module: 'phase2', fn: 'runPhase2', dealId, lineItemId },
          'Sin próxima fecha de facturación, saltando'
        );
        continue;
      }

      const daysUntilBilling = diffDays(today, nextBillingDate);

      if (daysUntilBilling === null) {
        logger.warn(
          { module: 'phase2', fn: 'runPhase2', dealId, lineItemId, nextBillingDate },
          'No se pudo calcular días hasta facturación, saltando'
        );
        continue;
      }

      if (daysUntilBilling < 0) {
        continue;
      }

      if (daysUntilBilling > MANUAL_TICKET_LOOKAHEAD_DAYS) {
        continue;
      }

      const lineItemKey = lp.line_item_key ? String(lp.line_item_key).trim() : '';
      if (!lineItemKey) {
        logger.warn(
          { module: 'phase2', fn: 'runPhase2', dealId, lineItemId },
          'line_item_key vacío, Phase1 debería setearlo, saltando'
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
        logger.info(
          { module: 'phase2', fn: 'runPhase2', dealId, lineItemId, ticketId: promoted.ticketId, reason: promoted.reason },
          'Ticket promovido a READY'
        );
      } else {
        logger.debug(
          { module: 'phase2', fn: 'runPhase2', dealId, lineItemId, reason: promoted.reason, ticketId: promoted.ticketId, ticketKey: promoted.ticketKey },
          'Ticket no movido'
        );
        if (promoted.reason === 'missing_forecast_ticket') {
          errors.push({
            lineItemId,
            error: `Missing forecast ticket for ${promoted.ticketKey}`,
          });
        }
      }
    } catch (err) {
      logger.error(
        { module: 'phase2', fn: 'runPhase2', dealId, lineItemId: li.id, err },
        'Error procesando line item'
      );
      errors.push({ lineItemId: li.id, error: err?.message || 'Error desconocido' });
    }
  }

  logger.info(
    { module: 'phase2', fn: 'runPhase2', dealId, ticketsPromoted: ticketsCreated, errors: errors.length },
    'Phase 2 completada'
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

/*
 * CATCHES con reportHubSpotError agregados:
 *   - moveTicketToStage() en rama currentStage !== expectedForecastStage
 *   - moveTicketToStage() en rama currentStage === expectedForecastStage
 *     (ambos son tickets.basicApi.update internamente, objectType="ticket")
 *
 * NO reportados:
 *   - getDealCompanies / getDealContacts → lecturas, .catch(() => []) absorbe el error
 *   - createTicketAssociations → asociaciones excluidas (Regla 4)
 *   - syncLineItemAfterPromotion → delegado, ese módulo gestiona su reporte
 *   - catch externo de runPhase2 → el error ya fue reportado en moveTicketToStage
 *     antes del re-throw; el catch externo solo loguea y empuja a errors[]
 *
 * Confirmación: "No se reportan warns a HubSpot; solo errores 4xx (≠429)"
 *
 * ⚠️  BUG PREEXISTENTE (no corregido per Regla 5):
 *   La condición `if (ticketKeyUsed !== ticketKeyNew)` siempre es false porque
 *   ambas variables se asignan al mismo valor (`ticketKeyNew`) en las dos
 *   líneas anteriores; el log de fallback nunca se ejecuta.
 */