// src/phases/index.js

import { runPhase1 } from './phase1.js';
import { runPhaseP } from './phasep.js';
import { runPhase2 } from './phase2.js';
import { runPhase3 } from './phase3.js';
import { withRetry } from '../utils/withRetry.js';
import {
  DEAL_STAGE_WON,
  DEAL_STAGE_EN_EJECUCION,
  EMITTED_STAGES,
  isDealCancelledStage,
} from '../config/constants.js';
import { cleanupClonedTicketsForDeal } from '../services/tickets/ticketCleanupService.js';
import { recalcFromTickets } from '../services/lineItems/recalcFromTickets.js';
import { recalcContadores } from '../services/billing/recalcContadores.js';
import { hubspotClient, getDealWithLineItems } from '../hubspotClient.js';
import { propagateCancelledInvoicesForDeal } from '../propagacion/invoice.js';
import { propagateDealCancellation } from '../propagacion/deals/cancelDeal.js';
import * as dateUtils from '../utils/dateUtils.js';
import { parseBool } from '../utils/parsers.js';
import logger from '../../lib/logger.js';
import { assignTicketOwners } from '../services/tickets/assignTicketOwners.js';
import { acquireDealLock, releaseDealLock } from '../db.js';

/**
 * Igual que runPhasesForDeal, pero contiende por el candado deal_locks
 * (el mismo que usa el worker de webhook_queue). Si el deal está tomado,
 * NO espera: devuelve { skipped: true, reason: 'deal_locked' }.
 * Para entry points que NO pasan por la cola (crons, CLI).
 */
export async function runPhasesForDealLocked({ deal, lineItems }, ownerLabel = 'cron') {
  const dealId = String(deal?.id || deal?.properties?.hs_object_id || '');
  const token = await acquireDealLock(dealId, ownerLabel);
  if (!token) return { skipped: true, reason: 'deal_locked' };
  try {
    return await runPhasesForDeal({ deal, lineItems });
  } finally {
    await releaseDealLock(dealId, token);
  }
}

function isDealCancelled(dealProps) {
  return isDealCancelledStage(dealProps?.dealstage);
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

  const invoicedStagesArr = [...EMITTED_STAGES];

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

function filterActiveLineItems(lineItems) {
  return lineItems.filter(li => {
    const fc = String(li?.properties?.fechas_completas || '').trim().toLowerCase();
    return fc !== 'true';
  });
}

/**
 * PHASE R: Recalcular contadores derivados (STATELESS) por line item.
 *
 * Recompone los contadores de conteo puro al final de la corrida, cuando las
 * etapas de tickets ya están estables (tras promover/emitir). Resuelve el
 * desfase reportado (ej: clon 12→6 pagos): ni "Actualizar" ni el cron
 * recomputaban estos contadores; solo se actualizaban en un evento real de
 * facturación. Ver docs/SISTEMA_CONTADORES_BILLING.md.
 *
 * Delega cada línea en recalcContadores (1 búsqueda de tickets por LIK), que:
 *   - escribe los 3 contadores COSMÉTICOS (facturas_restantes, facturas_por_derivar, progreso_pagos);
 *   - reconcilia fechas_completas de forma SEGURA y BIDIRECCIONAL (espejo del estado real);
 *   - dispara alertas solo en la transición (sin spam).
 * NO toca pagos_restantes (stateful) ni pagos_emitidos (sin writer; ver doc).
 *
 * Itera sobre TODOS los line items (no solo los activos): queremos corregir
 * contadores incluso en líneas excluidas de P/2/3. Un error en una línea se
 * loguea y NO bloquea el resto.
 *
 * recalcContadores es inyectable para testear la orquestación sin API.
 *
 * @returns {Promise<{processed:number, skipped:number, errors:number}>}
 */
export async function runPhaseR({
  dealId,
  lineItems,
  hubspotClient: client = hubspotClient,
  recalcContadoresFn = recalcContadores,
}) {
  let processed = 0;
  let skipped = 0;
  let errors = 0;

  for (const li of Array.isArray(lineItems) ? lineItems : []) {
    const lp = li?.properties || {};
    const liId = String(li?.id || lp.hs_object_id || '');
    const lik = String(lp.line_item_key || '').trim();

    if (!liId || !lik) {
      skipped++;
      continue;
    }

    try {
      await recalcContadoresFn({ hubspotClient: client, lineItemId: liId, dealId });
      processed++;
    } catch (err) {
      errors++;
      logger.warn(
        { module: 'phases/index', fn: 'runPhaseR', dealId, lineItemId: liId, lik, err },
        'Phase R: recálculo de contadores falló para un line item (no bloquea)'
      );
    }
  }

  return { processed, skipped, errors };
}

export async function runPhasesForDeal({ deal, lineItems }) {
  const dealId = String(deal?.id || deal?.properties?.hs_object_id);


  try {
    let currentDeal = deal;
    let currentLineItems = Array.isArray(lineItems) ? lineItems : [];
    let activeLineItems = currentLineItems;

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
      phaseR: { processed: 0, skipped: 0, errors: 0 },
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

      activeLineItems = filterActiveLineItems(currentLineItems);
      if (activeLineItems.length < currentLineItems.length) {
        logger.info(
          { module: 'phases/index', fn: 'runPhasesForDeal', dealId, total: currentLineItems.length, active: activeLineItems.length, skipped: currentLineItems.length - activeLineItems.length },
          'Line items con fechas_completas=true excluidos de fases P/2/3'
        );
      }
    } catch (err) {
      logger.error(
        { module: 'phases/index', fn: 'runPhasesForDeal', dealId, err },
        'Error en Phase 1'
      );
      results.phase1.error = err?.message || 'Error desconocido';
    }

    // ========== CANCELACIÓN ==========
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
      const phasePResult = await runPhaseP({ deal: currentDeal, lineItems: activeLineItems });
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

    // ========== CATCH-UP: promover forecasts atrasados + recalc fechas ==========
    try {
      const dealFacturacionActiva = parseBool(currentDeal?.properties?.facturacion_activa);
      if (dealFacturacionActiva) {
        let catchUpPromoted = 0;
        for (const li of currentLineItems) {
          const lp = li?.properties || {};
          const lineItemKey = String(lp.line_item_key || lp.of_line_item_key || '').trim();
          if (!lineItemKey) continue;

          const fechasCompletas = String(lp.fechas_completas || '').trim().toLowerCase() === 'true';
          if (fechasCompletas) continue;

          const isPaused = parseBool(lp.pausa);
          if (isPaused) continue;

          try {
            const result = await recalcFromTickets({
              lineItemKey,
              dealId,
              lineItemId: String(li.id || lp.hs_object_id),
              lineItemProps: lp,
              facturacionActiva: true,
              applyUpdate: true,
            });
            catchUpPromoted += result?.pastDuePromoted || 0;
          } catch (err) {
            logger.warn(
              { module: 'phases/index', fn: 'runPhasesForDeal', dealId, lineItemId: li.id, err },
              'recalcFromTickets catch-up falló (no bloquea)'
            );
          }
        }

        if (catchUpPromoted > 0) {
          logger.info(
            { module: 'phases/index', fn: 'runPhasesForDeal', dealId, catchUpPromoted },
            'Catch-up: tickets forecast atrasados promovidos a READY'
          );
        }

        const refreshedAfterCatchUp = await getDealWithLineItems(dealId);
        currentDeal = refreshedAfterCatchUp?.deal || refreshedAfterCatchUp?.Deal || currentDeal;
        currentLineItems = Array.isArray(refreshedAfterCatchUp?.lineItems)
          ? refreshedAfterCatchUp.lineItems : currentLineItems;
        activeLineItems = filterActiveLineItems(currentLineItems);
      }
    } catch (err) {
      logger.error(
        { module: 'phases/index', fn: 'runPhasesForDeal', dealId, err },
        'Error en catch-up de forecasts atrasados'
      );
    }

    // ========== PHASE 2: Tickets manuales ==========
    try {
      const phase2Result = await runPhase2({ deal: currentDeal, lineItems: activeLineItems });
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
      const phase3Result = await runPhase3({ deal: currentDeal, lineItems: activeLineItems });
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

    // ========== PHASE R: Recalcular contadores derivados ==========
    // Va DESPUÉS de Phase 3 a propósito: recalcFacturasRestantes sella
    // fechas_completas, que Phase 1 lee para excluir LIs de P/2/3. Recomputar al
    // final hace que ese sello afecte la corrida siguiente, no la actual.
    // Lógica extraída a runPhaseR (testeable). Ver docs/SISTEMA_CONTADORES_BILLING.md.
    try {
      results.phaseR = await runPhaseR({ dealId, lineItems: currentLineItems, hubspotClient });
      logger.info(
        { module: 'phases/index', fn: 'runPhasesForDeal', dealId, ...results.phaseR },
        'Phase R completada (contadores recalculados)'
      );
    } catch (err) {
      logger.error(
        { module: 'phases/index', fn: 'runPhasesForDeal', dealId, err },
        'Error en Phase R'
      );
      results.phaseR.error = err?.message || 'Error desconocido';
    }

    logger.info(
      { module: 'phases/index', fn: 'runPhasesForDeal', dealId, ticketsCreated: results.ticketsCreated, autoInvoicesEmitted: results.autoInvoicesEmitted },
      'Deal completado'
    );

    return results;
  } finally {
// noop : el candado no libera el caller
  }
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