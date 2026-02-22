// src/phases/phase3.js

import { hubspotClient } from '../hubspotClient.js';
import { parseBool } from '../utils/parsers.js';
import { getTodayYMD } from '../utils/dateUtils.js';
import { resolvePlanYMD } from '../utils/resolvePlanYMD.js';
import { updateTicket } from '../services/tickets/ticketService.js';
import { createTicketAssociations, getDealCompanies, getDealContacts } from '../services/tickets/ticketService.js';
import { buildTicketKeyFromLineItemKey } from '../utils/ticketKey.js';
import { syncLineItemAfterPromotion } from '../services/lineItems/syncAfterPromotion.js';
import { createInvoiceFromTicket } from '../services/invoiceService.js';
import logger from '../../lib/logger.js';
import { reportHubSpotError } from '../utils/hubspotErrorCollector.js';

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
 * - Programado: solo si planYMD === HOY → promover a READY.
 *
 * Idempotencia:
 * - Ticket se identifica por of_ticket_key = dealId::LIK::YYYY-MM-DD
 * - Si no existe el ticket forecast, se loggea error (Phase P debería haberlo creado).
 */

// ====== STAGES (IDs reales) ======
const BILLING_AUTOMATED_READY = '1228755520';

const BILLING_AUTOMATED_FORECAST_25 = '1294745999';
const BILLING_AUTOMATED_FORECAST_50 = '1294746000';
const BILLING_AUTOMATED_FORECAST_75 = '1296489840';
const BILLING_AUTOMATED_FORECAST_95 = '1296362566';

const FORECAST_AUTO_STAGES = new Set([
  BILLING_AUTOMATED_FORECAST_25,
  BILLING_AUTOMATED_FORECAST_50,
  BILLING_AUTOMATED_FORECAST_75,
  BILLING_AUTOMATED_FORECAST_95,
]);

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
  if (s === 'closedwon') return '95';
  return '25';
}

function resolveAutoForecastStageForDealStage(dealstage) {
  const b = resolveDealBucket(dealstage);
  if (b === '50') return BILLING_AUTOMATED_FORECAST_50;
  if (b === '75') return BILLING_AUTOMATED_FORECAST_75;
  if (b === '95') return BILLING_AUTOMATED_FORECAST_95;
  return BILLING_AUTOMATED_FORECAST_25;
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
    for (const li of autoLineItems) {
    const lineItemId = String(li.id || li.properties?.hs_object_id);
    const lp = li.properties || {};

    // PAUSA: si el line item está en pausa, skip
    const isPaused = parseBool(lp.pausa);
    if (isPaused) {
      logger.info(
        { module: 'phase3', fn: 'runPhase3', dealId, lineItemId },
        'Line item en pausa, saltando Phase 3'
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

      // 1) FACTURAR AHORA (urgente)
      if (facturarAhora) {
        const promoted = await promoteAutoForecastTicketToReady({
          dealId,
          dealStage,
          lineItemKey,
          billingYMD: billingPeriodDate,
          lineItemId,
        });

        if (promoted.moved) {
          ticketsEnsured++;
          const ticket = await hubspotClient.crm.tickets.basicApi.getById(
            promoted.ticketId,
            ['of_ticket_key', 'of_line_item_key', 'of_deal_id']
          );

          await createInvoiceFromTicket(ticket);
          invoicesEmitted++;

          logger.info(
            { module: 'phase3', fn: 'runPhase3', dealId, lineItemId, ticketId: promoted.ticketId },
            'Ticket promovido a READY (urgente) y factura emitida'
          );

          // Best-effort: marcar urgente
          try {
            await updateTicket(promoted.ticketId, {
              of_facturacion_urgente: 'true',
              of_fecha_de_facturacion: today,
            });
            logger.info(
              { module: 'phase3', fn: 'runPhase3', dealId, lineItemId, ticketId: promoted.ticketId },
              'Ticket marcado como urgente'
            );
          } catch (err) {
            reportIfActionable({ objectType: 'ticket', objectId: String(promoted.ticketId), message: 'Error al marcar ticket como urgente', err });
            logger.warn(
              { module: 'phase3', fn: 'runPhase3', dealId, lineItemId, ticketId: promoted.ticketId, err },
              'No se pudo marcar ticket como urgente'
            );
          }
        } else {
          logger.info(
            { module: 'phase3', fn: 'runPhase3', dealId, lineItemId, reason: promoted.reason, ticketId: promoted.ticketId, ticketKey: promoted.ticketKey },
            'Ticket urgente no promovido'
          );
          if (promoted.reason === 'missing_forecast_ticket') {
            errors.push({ dealId, lineItemId, error: `Missing forecast ticket for ${promoted.ticketKey}` });
          }
        }

        continue;
      }

      // 2) Facturación programada: solo si planYMD === HOY
      if (billingPeriodDate !== today) {
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

        const ticket = await hubspotClient.crm.tickets.basicApi.getById(
          promoted.ticketId,
          ['of_ticket_key', 'of_line_item_key', 'of_deal_id']
        );

        await createInvoiceFromTicket(ticket);
        invoicesEmitted++;

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

      // 1) FACTURAR AHORA (urgente)
      if (facturarAhora) {
        const promoted = await promoteAutoForecastTicketToReady({
          dealId,
          dealStage,
          lineItemKey,
          billingYMD: billingPeriodDate,
          lineItemId,
        });

        if (promoted.moved) {
          ticketsEnsured++;
          const ticket = await hubspotClient.crm.tickets.basicApi.getById(
            promoted.ticketId,
            ['of_ticket_key', 'of_line_item_key', 'of_deal_id']
          );

          await createInvoiceFromTicket(ticket);
          invoicesEmitted++;

          logger.info(
            { module: 'phase3', fn: 'runPhase3', dealId, lineItemId, ticketId: promoted.ticketId },
            'Ticket promovido a READY (urgente) y factura emitida'
          );

          // Best-effort: marcar urgente
          try {
            await updateTicket(promoted.ticketId, {
              of_facturacion_urgente: 'true',
              of_fecha_de_facturacion: today,
            });
            logger.info(
              { module: 'phase3', fn: 'runPhase3', dealId, lineItemId, ticketId: promoted.ticketId },
              'Ticket marcado como urgente'
            );
          } catch (err) {
            reportIfActionable({ objectType: 'ticket', objectId: String(promoted.ticketId), message: 'Error al marcar ticket como urgente', err });
            logger.warn(
              { module: 'phase3', fn: 'runPhase3', dealId, lineItemId, ticketId: promoted.ticketId, err },
              'No se pudo marcar ticket como urgente'
            );
          }
        } else {
          logger.info(
            { module: 'phase3', fn: 'runPhase3', dealId, lineItemId, reason: promoted.reason, ticketId: promoted.ticketId, ticketKey: promoted.ticketKey },
            'Ticket urgente no promovido'
          );
          if (promoted.reason === 'missing_forecast_ticket') {
            errors.push({ dealId, lineItemId, error: `Missing forecast ticket for ${promoted.ticketKey}` });
          }
        }

        continue;
      }

      // 2) Facturación programada: solo si planYMD === HOY
      if (billingPeriodDate !== today) {
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

        const ticket = await hubspotClient.crm.tickets.basicApi.getById(
          promoted.ticketId,
          ['of_ticket_key', 'of_line_item_key', 'of_deal_id']
        );

        await createInvoiceFromTicket(ticket);
        invoicesEmitted++;

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

/*
 * CATCHES con reportHubSpotError agregados:
 *   - moveTicketToStage() rama currentStage !== expectedForecastStage → objectType="ticket"
 *   - moveTicketToStage() rama currentStage === expectedForecastStage → objectType="ticket"
 *   - updateTicket() en bloque "marcar urgente" (best-effort) → objectType="ticket"
 *     (no re-throw; el warn se loguea y se continúa)
 *
 * NO reportados:
 *   - getDealCompanies / getDealContacts → lecturas, .catch(() => []) absorbe
 *   - createTicketAssociations → asociaciones excluidas (Regla 4)
 *   - syncLineItemAfterPromotion → delegado
 *   - createInvoiceFromTicket → no es update de ticket/line_item; servicio externo
 *   - tickets.basicApi.getById → lectura
 *   - catch externo de runPhase3 → error ya reportado en moveTicketToStage antes del re-throw
 *
 * Confirmación: "No se reportan warns a HubSpot; solo errores 4xx (≠429)"
 *
 * ⚠️  BUGS PREEXISTENTES (no corregidos per Regla 5):
 *   1. Bloque `if (!t) { return { moved: false, ... } }` duplicado tras el retry loop;
 *      el segundo bloque es unreachable.
 *   2. En el catch externo del original se usaba `li.id` en lugar de `lineItemId`
 *      (que ya está definido en el mismo scope); se preservó el uso de `lineItemId`
 *      ya que estaba correctamente asignado antes del try — comportamiento idéntico.
 */