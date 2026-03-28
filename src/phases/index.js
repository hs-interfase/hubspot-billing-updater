// src/phases/index.js

import { runPhase1 } from './phase1.js';
import { runPhaseP } from './phasep.js';
import { runPhase2 } from './phase2.js';
import { runPhase3 } from './phase3.js';
import { withRetry } from '../utils/withRetry.js';
import {
  DEAL_STAGE_LOST,
  DEAL_STAGE_SUSPENDED,
  DEAL_STAGE_VOIDED,
  DEAL_STAGE_WON,
  DEAL_STAGE_EN_EJECUCION,
  INVOICED_TICKET_STAGES,
} from '../config/constants.js';
import { cleanupClonedTicketsForDeal } from '../services/tickets/ticketCleanupService.js';
import { hubspotClient, getDealWithLineItems } from '../hubspotClient.js';
import { propagateCancelledInvoicesForDeal } from '../propagacion/invoice.js';
import { propagateDealCancellation } from '../propagacion/deals/cancelDeal.js';
import * as dateUtils from '../utils/dateUtils.js';
import logger from '../../lib/logger.js';
import { assignTicketOwners } from '../services/tickets/assignTicketOwners.js';



function isDealCancelled(dealProps) {
  const stage = String(dealProps?.dealstage || '');
  return (
    stage === DEAL_STAGE_LOST ||
    stage === DEAL_STAGE_SUSPENDED ||
    stage === DEAL_STAGE_VOIDED
  );
}

function formatHsLastModified(raw) {
  if (!raw) return '(no value)';
  const d = dateUtils.parseHubspotDate ? dateUtils.parseHubspotDate(raw) : new Date(raw);
  if (!d || Number.isNaN(d.getTime())) return '(invalid date)';
  const formatted = dateUtils.formatDateISO ? dateUtils.formatDateISO(d) : d.toISOString();
  return `${raw} (${formatted})`;
}

/**
 * Si el deal está en 85% (closedwon) y tiene al menos un ticket
 * en etapas facturadas (invoiced/paid/late), lo promueve a 95% (En Ejecución).
 * Retorna true si se promovió.
 */
async function promoteToEjecucionIfNeeded(deal) {
  const dealId = String(deal.id || deal.properties?.hs_object_id);
  const currentStage = String(deal.properties?.dealstage || '');

  if (currentStage !== 'closedwon' && currentStage !== DEAL_STAGE_WON) {
    return false;
  }

  const invoicedStagesArr = [...INVOICED_TICKET_STAGES];

  // HubSpot Pro: max 5 filterGroups. Partimos en chunks de 5.
  let hasInvoicedTicket = false;
  for (let i = 0; i < invoicedStagesArr.length && !hasInvoicedTicket; i += 5) {
    const chunk = invoicedStagesArr.slice(i, i + 5);
    const body = {
      filterGroups: chunk.map(stage => ({
        filters: [
          { propertyName: 'of_deal_id', operator: 'EQ', value: dealId },
          { propertyName: 'hs_pipeline_stage', operator: 'EQ', value: stage },
        ],
      })),
      properties: ['hs_pipeline_stage'],
      limit: 1,
    };

    const resp = await withRetry(
      () => hubspotClient.crm.tickets.searchApi.doSearch(body),
      { module: 'phases/index', fn: 'promoteToEjecucionIfNeeded', dealId }
    );

    if ((resp?.results || []).length > 0) {
      hasInvoicedTicket = true;
    }
  }

  if (!hasInvoicedTicket) {
    logger.debug(
      { module: 'phases/index', fn: 'promoteToEjecucionIfNeeded', dealId },
      'Deal en 85% sin tickets facturados, no se promueve'
    );
    return false;
  }

  if (!DEAL_STAGE_EN_EJECUCION) {
    logger.warn(
      { module: 'phases/index', fn: 'promoteToEjecucionIfNeeded', dealId },
      'DEAL_STAGE_EN_EJECUCION no configurado, no se puede promover'
    );
    return false;
  }

  try {
    await hubspotClient.crm.deals.basicApi.update(dealId, {
      properties: { dealstage: DEAL_STAGE_EN_EJECUCION },
    });

    logger.info(
      { module: 'phases/index', fn: 'promoteToEjecucionIfNeeded', dealId, from: currentStage, to: DEAL_STAGE_EN_EJECUCION },
      'Deal promovido de 85% a 95% (En Ejecución)'
    );
    return true;
  } catch (err) {
    logger.error(
      { module: 'phases/index', fn: 'promoteToEjecucionIfNeeded', dealId, err },
      'Error promoviendo deal a 95%'
    );
    return false;
  }
}

export async function runPhasesForDeal({ deal, lineItems }) {
  let currentDeal = deal;
  let currentLineItems = Array.isArray(lineItems) ? lineItems : [];

  const dealId = String(currentDeal?.id || currentDeal?.properties?.hs_object_id);

  const dealLastMod =
    currentDeal?.properties?.hs_lastmodifieddate ??
    currentDeal?.hs_lastmodifieddate;

  logger.info(
    {
      module: 'phases/index',
      fn: 'runPhasesForDeal',
      dealId,
      dealLastModified: formatHsLastModified(dealLastMod),
      lineItemsCount: currentLineItems.length,
    },
    'Inicio procesamiento de fases'
  );

  const results = {
    dealId,
    cleanup: { scanned: 0, duplicates: 0, deprecated: 0 },
    phase1: { success: false },
    phaseP: { success: false },
    phase2: { ticketsCreated: 0 },
    phase3: { invoicesEmitted: 0, ticketsEnsured: 0 },
    ticketsCreated: 0,
    autoInvoicesEmitted: 0,
  };

  // ========== PRE: LIMPIEZA DE TICKETS CLONADOS ==========
  try {
    const cleanupResult = await cleanupClonedTicketsForDeal({
      dealId,
      lineItems: currentLineItems,
    });
    results.cleanup = cleanupResult || results.cleanup;
    logger.info(
      { module: 'phases/index', fn: 'runPhasesForDeal', dealId, ...results.cleanup },
      'Cleanup PRE completado'
    );
  } catch (err) {
    logger.error(
      { module: 'phases/index', fn: 'runPhasesForDeal', dealId, err },
      'Error en Cleanup PRE'
    );
    results.cleanup.error = err?.message || 'Error desconocido';
  }

  // ========== PHASE 1: Fechas, calendario, cupo ==========
  try {
    await runPhase1(dealId);
    results.phase1.success = true;
    logger.info(
      { module: 'phases/index', fn: 'runPhasesForDeal', dealId },
      'Phase 1 completada'
    );

    // Refetch post-Phase1
    const refreshed = await getDealWithLineItems(dealId);

    currentDeal = refreshed?.deal || refreshed?.Deal || currentDeal;

    const refreshedLineItems =
      refreshed?.lineItems ||
      refreshed?.line_items ||
      refreshed?.lineitems ||
      null;

    if (Array.isArray(refreshedLineItems)) {
      currentLineItems = refreshedLineItems;
    }

    logger.info(
      { module: 'phases/index', fn: 'runPhasesForDeal', dealId, lineItemsCount: currentLineItems.length },
      'Refetch post-Phase1 completado'
    );
  } catch (err) {
    logger.error(
      { module: 'phases/index', fn: 'runPhasesForDeal', dealId, err },
      'Error en Phase 1'
    );
    results.phase1.error = err?.message || 'Error desconocido';
  }

  // ========== CANCELACIÓN: si el deal está perdido/cancelado ==========
  if (isDealCancelled(currentDeal?.properties)) {
    logger.info(
      { module: 'phases/index', fn: 'runPhasesForDeal', dealId, dealStage: currentDeal?.properties?.dealstage },
      'Deal cancelado — propagando cancelación y saltando Phase P/2/3'
    );

    try {
      await propagateDealCancellation({
        dealId,
        dealProps: currentDeal?.properties,
        lineItems: currentLineItems,
      });
      results.cancellation = { propagated: true };
    } catch (err) {
      logger.error(
        { module: 'phases/index', fn: 'runPhasesForDeal', dealId, err },
        'Error en propagateDealCancellation'
      );
      results.cancellation = { propagated: false, error: err?.message };
    }

    logger.info(
      { module: 'phases/index', fn: 'runPhasesForDeal', dealId },
      'Deal completado (cancelado)'
    );

    return results;
  }
    try {
    const propagationResult = await propagateCancelledInvoicesForDeal(currentLineItems);
    results.invoicePropagation = propagationResult;
    logger.info(
      { module: 'phases/index', fn: 'runPhasesForDeal', dealId, ...propagationResult },
      'Propagación de facturas canceladas completada'
    );
  } catch (err) {
    // fail open: no bloqueamos las fases si falla la propagación
    logger.error(
      { module: 'phases/index', fn: 'runPhasesForDeal', dealId, err },
      'Error en propagación de facturas canceladas, continuando'
    );
  }

  
// ========== PROMOCIÓN 85% → 95% ==========
  try {
    const promoted = await promoteToEjecucionIfNeeded(currentDeal);
    if (promoted) {
      const refreshed = await getDealWithLineItems(dealId);
      currentDeal = refreshed?.deal || refreshed?.Deal || currentDeal;
      currentLineItems = Array.isArray(refreshed?.lineItems) ? refreshed.lineItems : currentLineItems;
      logger.info(
        { module: 'phases/index', fn: 'runPhasesForDeal', dealId },
        'Refetch post-promoción a 95% completado'
      );
    }
  } catch (err) {
    logger.error(
      { module: 'phases/index', fn: 'runPhasesForDeal', dealId, err },
      'Error en promoción a 95%'
    );
  }

  // ========== PHASE P: Forecast/Promesa ==========

  try {
    const phasePResult = await runPhaseP({ deal: currentDeal, lineItems: currentLineItems });
    results.phaseP = phasePResult;
    results.ticketsCreated += phasePResult?.created || 0;

    const { created, updated, deleted, skipped } = phasePResult || {};
    logger.info(
      { module: 'phases/index', fn: 'runPhasesForDeal', dealId, created, updated, deleted, skipped },
      'Phase P completada'
    );
  } catch (err) {
    logger.error(
      { module: 'phases/index', fn: 'runPhasesForDeal', dealId, err },
      'Error en Phase P'
    );
    results.phaseP.error = err?.message || 'Error desconocido';
  }

  // ========== ASIGNACIÓN DE OWNER EN TICKETS ==========
  try {
    const ownerResult = await assignTicketOwners({
      dealId,
      lineItems: currentLineItems,
      dealProps: currentDeal?.properties,
    });
    results.ownerAssignment = ownerResult;
    logger.info(
      { module: 'phases/index', fn: 'runPhasesForDeal', dealId, ...ownerResult },
      'Asignación de owner en tickets completada'
    );
  } catch (err) {
    logger.error(
      { module: 'phases/index', fn: 'runPhasesForDeal', dealId, err },
      'Error en assignTicketOwners'
    );
    results.ownerAssignment = { error: err?.message };
  }

  // ========== PHASE 2: Tickets manuales ==========
  try {
    const phase2Result = await runPhase2({ deal: currentDeal, lineItems: currentLineItems });
    results.phase2 = phase2Result;
    results.ticketsCreated = phase2Result?.ticketsCreated || 0;

    logger.info(
      { module: 'phases/index', fn: 'runPhasesForDeal', dealId, ticketsCreated: results.ticketsCreated },
      'Phase 2 completada'
    );
  } catch (err) {
    logger.error(
      { module: 'phases/index', fn: 'runPhasesForDeal', dealId, err },
      'Error en Phase 2'
    );
    results.phase2.error = err?.message || 'Error desconocido';
  }

  // ========== PHASE 3: Facturas automáticas ==========
  try {
    const phase3Result = await runPhase3({ deal: currentDeal, lineItems: currentLineItems });
    results.phase3 = phase3Result;
    results.autoInvoicesEmitted = phase3Result?.invoicesEmitted || 0;

    const ticketsPhase3 = phase3Result?.ticketsEnsured || 0;
    results.ticketsCreated += ticketsPhase3;

    logger.info(
      { module: 'phases/index', fn: 'runPhasesForDeal', dealId, autoInvoicesEmitted: results.autoInvoicesEmitted, ticketsPhase3 },
      'Phase 3 completada'
    );
  } catch (err) {
    logger.error(
      { module: 'phases/index', fn: 'runPhasesForDeal', dealId, err },
      'Error en Phase 3'
    );
    results.phase3.error = err?.message || 'Error desconocido';
  }

  logger.info(
    { module: 'phases/index', fn: 'runPhasesForDeal', dealId, ticketsCreated: results.ticketsCreated, autoInvoicesEmitted: results.autoInvoicesEmitted },
    'Deal completado'
  );

  return results;
}

/*
 * CATCHES con reportHubSpotError agregados: ninguno
 * NO reportados:
 *   - cleanupClonedTicketsForDeal → delegado; ese servicio gestiona su reporte
 *   - runPhase1/runPhaseP/runPhase2/runPhase3 → cada phase gestiona su propio reporte
 *   - propagateDealCancellation → cada módulo interno gestiona su reporte
 *   - getDealWithLineItems → lectura
 * Confirmación: "No se reportan warns a HubSpot; solo errores 4xx (≠429)"
 */