// src/phases/phase3.js

import { hubspotClient } from '../hubspotClient.js';
import { parseBool } from '../utils/parsers.js';
import { getTodayYMD } from '../utils/dateUtils.js';
import { resolvePlanYMD } from '../utils/resolvePlanYMD.js';
import { propagateMirrorAfterAutoInvoice } from '../services/urgentBillingService.js';import { createTicketAssociations, getDealCompanies, getDealContacts } from '../services/tickets/ticketService.js';
import { buildTicketKeyFromLineItemKey } from '../utils/ticketKey.js';
import { syncLineItemAfterPromotion } from '../services/lineItems/syncAfterPromotion.js';
import { createInvoiceFromTicket, REQUIRED_TICKET_PROPS } from '../services/invoiceService.js';
import { countActivePlanInvoices } from '../utils/invoiceUtils.js';
import { checkMissedBillingsForLineItem } from '../services/billing/missedBillingGuard.js';
import logger from '../../lib/logger.js';
import { withRetry } from '../utils/withRetry.js';
import { reportHubSpotError } from '../utils/hubspotErrorCollector.js';
import { recalcFromTickets } from '../services/lineItems/recalcFromTickets.js';
import {
  BILLING_AUTOMATED_READY,
  BILLING_AUTOMATED_FORECAST,
  BILLING_AUTOMATED_FORECAST_50,
  BILLING_AUTOMATED_FORECAST_75,
  BILLING_AUTOMATED_FORECAST_85,
  BILLING_AUTOMATED_FORECAST_95,
  FORECAST_AUTO_STAGES,
  DEAL_STAGE_EN_EJECUCION,
  DEAL_STAGE_FINALIZADO
} from '../config/constants.js';

/**
 * PHASE 3 (AUTOMÁTICO):
 * - Requiere deal.facturacion_activa=true
 * - Solo procesa line items con facturacion_automatica == true
 *
 * Nuevo contrato (con Phase P):
 * - Phase 3 NO crea tickets.
 * - Phase 3 PROMUEVE el ticket forecast (AUTOMATED_FORECAST_*) a READY cuando corresponde,
 *   y luego delega a la lógica existente (la que crea invoice / mueve estados según factura).
 *
 * Reglas acordadas:
 * - Urgente (facturar_ahora==true): promover ticket forecast del planYMD a READY (si existe) y marcar urgente.
* - Programado: si planYMD <= HOY → promover a READY (incluye fechas pasadas).
 *
 * Idempotencia:
 * - Ticket se identifica por of_ticket_key = dealId::LIK::YYYY-MM-DD
 * - Si no existe el ticket forecast, se loggea error (Phase P debería haberlo creado).
 */

function reportIfActionable({ objectType, objectId, message, err }) {
  const status = err?.response?.status ?? err?.statusCode ?? null;
  if (status === null) { reportHubSpotError({ objectType, objectId, message }); return; }
  if (status === 429 || status >= 500) return;
  if (status >= 400 && status < 500) reportHubSpotError({ objectType, objectId, message });
}

function resolveDealBucket(dealstage) {
  const s = String(dealstage || '');
  if (s === 'decisionmakerboughtin') return '50';
  if (s === 'contractsent') return '75';
  if (s === 'closedwon') return '85';
  if (s === DEAL_STAGE_EN_EJECUCION) return '95';
  if (s === DEAL_STAGE_FINALIZADO) return '100';
  return '25';
}

function resolveAutoForecastStageForDealStage(dealstage) {
  const b = resolveDealBucket(dealstage);
  if (b === '50') return BILLING_AUTOMATED_FORECAST_50;
  if (b === '75') return BILLING_AUTOMATED_FORECAST_75;
  if (b === '85') return BILLING_AUTOMATED_FORECAST_85;
  if (b === '95') return BILLING_AUTOMATED_FORECAST_95;
  if (b === '100') return BILLING_AUTOMATED_FORECAST_95;
  return BILLING_AUTOMATED_FORECAST;
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

  const resp = await withRetry(
    () => hubspotClient.crm.tickets.searchApi.doSearch(body),
    { module: 'phase3', fn: 'findTicketByTicketKey', ticketKey }
  );
  return (resp?.results || [])[0] || null;
}

async function moveTicketToStage(ticketId, stageId) {
  return hubspotClient.crm.tickets.basicApi.update(String(ticketId), {
    properties: { hs_pipeline_stage: String(stageId) },
  });
}

/**
 * Promueve un ticket forecast automático a READY.
 */
async function promoteAutoForecastTicketToReady({
  dealId,
  dealStage,
  lineItemKey,
  billingYMD,
  lineItemId,
}) {
  if (!lineItemKey) {
    return { moved: false, reason: 'missing_line_item_key' };
  }

  const ticketKey = buildTicketKeyFromLineItemKey(dealId, lineItemKey, billingYMD);

  let t = await findTicketByTicketKey(ticketKey);

  // Retry por indexación HubSpot
  for (const delay of [500, 1000]) {
    if (t) break;
    await new Promise(r => setTimeout(r, delay));
    t = await findTicketByTicketKey(ticketKey);
  }

  if (!t) {
    return {
      moved: false,
      reason: 'missing_forecast_ticket',
      ticketKey,
    };
  }

  const currentStage = String(t?.properties?.hs_pipeline_stage || '');

  if (currentStage === BILLING_AUTOMATED_READY) {
    return { moved: false, reason: 'already_ready', ticketId: t.id };
  }

  if (!FORECAST_AUTO_STAGES.has(currentStage)) {
    return { moved: false, reason: `not_auto_forecast_stage:${currentStage}`, ticketId: t.id };
  }

  const companyIds = await getDealCompanies(String(dealId)).catch(() => []);
  const contactIds =
    (typeof getDealContacts === 'function'
      ? await getDealContacts(String(dealId)).catch(() => [])
      : []);

  const expectedForecastStage = resolveAutoForecastStageForDealStage(dealStage);
  let moved = false;
  let reason = '';

  if (currentStage !== expectedForecastStage) {
    try {
      await moveTicketToStage(t.id, BILLING_AUTOMATED_READY);
      moved = true;
      reason = `moved_from_unexpected_forecast_stage:${currentStage}_expected:${expectedForecastStage}`;
    } catch (err) {
      reportIfActionable({ objectType: 'ticket', objectId: String(t.id), message: 'Error al mover ticket a READY desde stage inesperado', err });
      throw err;
    }
  } else {
    try {
      await moveTicketToStage(t.id, BILLING_AUTOMATED_READY);
      moved = true;
      reason = 'moved';
    } catch (err) {
      reportIfActionable({ objectType: 'ticket', objectId: String(t.id), message: 'Error al mover ticket forecast a READY', err });
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
      expectedYMD: billingYMD,
    });

    // Recalc post-promoción (belt-and-suspenders):
    // syncLineItemAfterPromotion ya actualizó last_ticketed_date y billing_next_date.
    // recalcFromTickets mira TODOS los tickets para corregir/completar las 4 fechas.
    try {
      await recalcFromTickets({
        lineItemKey,
        dealId,
        lineItemId,
        lineItemProps: liProps,
        facturacionActiva: true, // Phase 3 solo corre si facturacionActiva=true
        applyUpdate: true,
      });
    } catch (err) {
      logger.warn(
        { module: 'phase3', fn: 'promoteAutoForecastTicketToReady', dealId, lineItemId, err },
        'recalcFromTickets falló (no bloquea promoción)'
      );
    }
  }

  return { moved, ticketId: t.id, reason };
}


export async function runPhase3({ deal, lineItems }) {
  const dealId = String(deal.id || deal.properties?.hs_object_id);
  const dp = deal.properties || {};
  const dealStage = String(dp.dealstage || '');
  const today = getTodayYMD();

  const dealFacturacionActiva = parseBool(dp.facturacion_activa);

  logger.info(
    { module: 'phase3', fn: 'runPhase3', dealId, today, totalLineItems: (lineItems || []).length, facturacionActiva: dealFacturacionActiva },
    'Inicio Phase 3'
  );

  if (!dealFacturacionActiva) {
    logger.info(
      { module: 'phase3', fn: 'runPhase3', dealId },
      'Deal sin facturacion_activa=true, saltando Phase 3'
    );
    return { invoicesEmitted: 0, ticketsEnsured: 0, errors: [] };
  }

  let invoicesEmitted = 0;
  let ticketsEnsured = 0;
  const errors = [];

  const autoLineItems = (lineItems || []).filter((li) => {
    const lp = li?.properties || {};
    return parseBool(lp.facturacion_automatica);
  });

  logger.info(
    { module: 'phase3', fn: 'runPhase3', dealId, autoLineItemsCount: autoLineItems.length },
    'Line items automáticos a procesar'
  );

  for (const li of autoLineItems) {
    const lineItemId = String(li.id || li.properties?.hs_object_id);
    const lp = li.properties || {};

// DESPUÉS
    // PAUSA: si el line item está en pausa, skip
    const isPaused = parseBool(lp.pausa);
    if (isPaused) {
      logger.info(
        { module: 'phase3', fn: 'runPhase3', dealId, lineItemId },
        'Line item en pausa, saltando Phase 3'
      );
      continue;
    }

    // MIRROR UY: line items espejo nunca se facturan automáticamente
    const esMirrorUY = (lp.of_line_item_py_origen_id || '').trim();
    if (esMirrorUY) {
      logger.info(
        { module: 'phase3', fn: 'runPhase3', dealId, lineItemId },
        'Line item es mirror UY, saltando Phase 3 (facturación manual)'
      );
      continue;
    }

    try {
      const facturarAhora = parseBool(lp.facturar_ahora);

      const billingPeriodDate = resolvePlanYMD({
        lineItemProps: lp,
        context: { flow: 'PHASE3', dealId, lineItemId },
      });

      if (!billingPeriodDate) {
        logger.info(
          { module: 'phase3', fn: 'runPhase3', dealId, lineItemId },
          'Sin planYMD, saltando'
        );
        continue;
      }

      const lineItemKey = lp.line_item_key ? String(lp.line_item_key).trim() : '';
      if (!lineItemKey) {
        logger.warn(
          { module: 'phase3', fn: 'runPhase3', dealId, lineItemId },
          'line_item_key vacío, Phase1 debería setearlo, saltando'
        );
        continue;
      }
try {
        await checkMissedBillingsForLineItem({
          dealId,
          lineItemId,
          lineItemKey,
          today,
        });
      } catch (err) {
        // Best-effort: error en el guard no detiene la facturación de hoy
        logger.error(
          { module: 'phase3', fn: 'runPhase3', dealId, lineItemId, err },
          'Error en missedBillingGuard, continuando con flujo normal'
        );
      }

      // Limpieza defensiva: facturar_ahora no aplica a automáticos (se facturan solo por fecha).
      // Si alguien lo activó manualmente, resetearlo para evitar confusión.

if (facturarAhora) {
  logger.info(
    { module: 'phase3', fn: 'runPhase3', dealId, lineItemId },
    'facturar_ahora detectado en line item automático, reseteando (no aplica a automáticos)'
  );
  try {
    await hubspotClient.crm.lineItems.basicApi.update(String(lineItemId), {
      properties: {
        facturar_ahora: 'false',
        of_billing_error: 'Facturar ahora no aplica a líneas con facturación automática. El ítem se procesa automáticamente por fecha.',
      },
    });
  } catch (resetErr) {
    logger.warn(
      { module: 'phase3', fn: 'runPhase3', dealId, lineItemId, err: resetErr },
      'Error reseteando facturar_ahora, continuando'
    );
  }
  // NO continue — dejar que siga a la lógica programada por fecha
}

      // 2) Facturación programada: solo si planYMD <= HOY
      if (billingPeriodDate > today) {
        continue;
      }

      const promoted = await promoteAutoForecastTicketToReady({
        dealId,
        dealStage,
        lineItemKey,
        billingYMD: billingPeriodDate,
        lineItemId,
      });

      if (promoted.moved) {
        ticketsEnsured++;

        // Leer ticket con todas las props requeridas para evitar re-lectura en invoiceService
        const ticket = await hubspotClient.crm.tickets.basicApi.getById(
          promoted.ticketId,
          REQUIRED_TICKET_PROPS
        );

        const totalPayments = Number(lp.hs_recurring_billing_number_of_payments);
        const isAutoRenew = !Number.isFinite(totalPayments) || totalPayments === 0;
        if (!isAutoRenew) {
          const activeCount = await countActivePlanInvoices(lineItemKey);
          if (activeCount !== null && activeCount >= totalPayments) {
            logger.info(
              { module: 'phase3', fn: 'runPhase3', dealId, lineItemId, lineItemKey, activeCount, totalPayments },
              'Plan completado, no se emite factura'
            );
            continue;
          }
        }
await createInvoiceFromTicket(ticket, 'AUTO_LINEITEM', null, { skipRefetch: true });
        invoicesEmitted++;

        // Propagar al mirror UY si corresponde — fire-and-forget, no bloquea Phase 3
        propagateMirrorAfterAutoInvoice(lineItemId).catch(() => {});

        logger.info(
          { module: 'phase3', fn: 'runPhase3', dealId, lineItemId, ticketId: promoted.ticketId },
          'Ticket promovido a READY (programado) y factura emitida'
        );
      } else {
        logger.info(
          { module: 'phase3', fn: 'runPhase3', dealId, lineItemId, reason: promoted.reason, ticketId: promoted.ticketId, ticketKey: promoted.ticketKey },
          'Ticket programado no promovido'
        );
        if (promoted.reason === 'missing_forecast_ticket') {
          errors.push({ dealId, lineItemId, error: `Missing forecast ticket for ${promoted.ticketKey}` });
        }
      }

    } catch (err) {
      logger.error(
        { module: 'phase3', fn: 'runPhase3', dealId, lineItemId, err },
        'Error procesando line item'
      );
      errors.push({ dealId, lineItemId, error: err?.message || 'Unknown error' });
    }
  }

  logger.info(
    { module: 'phase3', fn: 'runPhase3', dealId, invoicesEmitted, ticketsEnsured, errors: errors.length },
    'Phase 3 completada'
  );

  return { invoicesEmitted, ticketsEnsured, errors };
}