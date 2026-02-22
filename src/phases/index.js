// src/phases/index.js

import { runPhase1 } from './phase1.js';
import { runPhaseP } from './phasep.js';
import { runPhase2 } from './phase2.js';
import { runPhase3 } from './phase3.js';

import { cleanupClonedTicketsForDeal } from '../services/tickets/ticketCleanupService.js';
import { getDealWithLineItems } from '../hubspotClient.js';
import { propagateDealCancellation } from '../propagacion/deals/cancelDeal.js';
import * as dateUtils from '../utils/dateUtils.js';
import logger from '../../lib/logger.js';

const DEAL_STAGE_LOST = process.env.DEAL_STAGE_LOST || 'closedlost';
const CANCELLED_STAGE_ID = process.env.CANCELLED_STAGE_ID || '';

function isDealCancelled(dealProps) {
  const stage = String(dealProps?.dealstage || '');
  return stage === DEAL_STAGE_LOST || (CANCELLED_STAGE_ID && stage === CANCELLED_STAGE_ID);
}

function formatHsLastModified(raw) {
  if (!raw) return '(no value)';
  const d = dateUtils.parseHubspotDate ? dateUtils.parseHubspotDate(raw) : new Date(raw);
  if (!d || Number.isNaN(d.getTime())) return '(invalid date)';
  const formatted = dateUtils.formatDateISO ? dateUtils.formatDateISO(d) : d.toISOString();
  return `${raw} (${formatted})`;
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