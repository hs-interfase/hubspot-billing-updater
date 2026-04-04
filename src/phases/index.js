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
  EMITTED_STAGES,
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
    console.log(
      `🧹 PRE: Limpieza de tickets clonados/duplicados (por of_ticket_key/of_invoice_key)...`
    );
    const cleanupResult = await cleanupClonedTicketsForDeal({
      dealId,
      lineItems,
    });
    results.cleanup = cleanupResult || results.cleanup;
    console.log(
      `   ✅ Cleanup completado: scanned=${results.cleanup.scanned}, duplicates=${results.cleanup.duplicates}, deprecated=${results.cleanup.deprecated}\n`
    );
  } catch (err) {
    console.error(`   ❌ Error en Cleanup PRE:`, err?.message || err);
    results.cleanup.error = err?.message || "Error desconocido";
    // NO frenamos el proceso
  }

  // ========== PHASE 1: Fechas, calendario, cupo ==========
  try {
    console.log(`📅 PHASE 1: Actualizando fechas, calendario y cupo...`);

    // Solo pasamos sourceLineItemId si realmente vino (opcional)
    await runPhase1(dealId, { mode, sourceLineItemId });

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
    console.error(`   ❌ Error en Phase 1:`, err?.message || err);
    results.phase1.error = err?.message || "Error desconocido";
  }
// ========== CATCH-UP: promover forecasts atrasados + recalc fechas ==========
  // recalcFromTickets (bloque I1) detecta tickets forecast con fecha <= hoy
  // y los promueve a READY. Esto corrige el caso donde Phase 1 avanzó
  // billing_next_date y Phase 2/3 nunca encontraría el ticket atrasado.
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

        // Refetch line items para que Phase 2/3 vean las fechas actualizadas
        const refreshed = await getDealWithLineItems(dealId);
        currentDeal = refreshed?.deal || refreshed?.Deal || currentDeal;
        currentLineItems = Array.isArray(refreshed?.lineItems) ? refreshed.lineItems : currentLineItems;
      }
    }
  } catch (err) {
    logger.error(
      { module: 'phases/index', fn: 'runPhasesForDeal', dealId, err },
      'Error en catch-up de forecasts atrasados'
    );
  }
  // ========== PHASE 2: Tickets manuales ==========
  try {
    console.log(
      `🎫 PHASE 2: Generando tickets manuales (facturacion_automatica=false)...`
    );
    const phase2Result = await runPhase2({ deal, lineItems });
    results.phase2 = phase2Result;
    results.ticketsCreated = phase2Result.ticketsCreated || 0;
    console.log(
      `   ✅ Phase 2 completada: ${results.ticketsCreated} tickets manuales creados\n`
    );
  } catch (err) {
    console.error(`   ❌ Error en Phase 2:`, err?.message || err);
    results.phase2.error = err?.message || "Error desconocido";
  }

  // ========== PHASE 3: Facturas automáticas ==========
  try {
    console.log(
      `💰 PHASE 3: Emitiendo facturas automáticas (facturacion_automatica=true)...`
    );
    const phase3Result = await runPhase3({ deal, lineItems });
    results.phase3 = phase3Result;
    results.autoInvoicesEmitted = phase3Result.invoicesEmitted || 0;

    // Sumar tickets de Phase 3 al total
    const ticketsPhase3 = phase3Result.ticketsEnsured || 0;
    results.ticketsCreated += ticketsPhase3;

    console.log(
      `   ✅ Phase 3 completada: ${results.autoInvoicesEmitted} facturas emitidas, ${ticketsPhase3} tickets automáticos creados\n`
    );
  } catch (err) {
    console.error(`   ❌ Error en Phase 3:`, err?.message || err);
    results.phase3.error = err?.message || "Error desconocido";
  }

  console.log(`🏁 Deal ${dealId} completado:`);
  console.log(`   - Tickets totales: ${results.ticketsCreated}`);
  console.log(`   - Facturas: ${results.autoInvoicesEmitted}`);

  return results;
}

