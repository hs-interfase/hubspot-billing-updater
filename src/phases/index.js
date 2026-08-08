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
import { recalcValorTotal } from '../services/deal/recalcValorTotal.js';
import { recalcContadores } from '../services/billing/recalcContadores.js';
import { createLineItemWriteBuffer } from '../services/lineItems/lineItemWriteBuffer.js';
import { hubspotClient, getDealWithLineItems } from '../hubspotClient.js';
import { propagateCancelledInvoicesForDeal } from '../propagacion/invoice.js';
import { propagateDealCancellation } from '../propagacion/deals/cancelDeal.js';
import * as dateUtils from '../utils/dateUtils.js';
import { parseBool } from '../utils/parsers.js';
import logger from '../../lib/logger.js';
import { assignTicketOwners } from '../services/tickets/assignTicketOwners.js';
import { associateAllTicketsOnClosedWon } from '../services/tickets/associateOnClosedWon.js';
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
    // ownerLabel identifica el entry point y decide si la corrida reconcilia
    // TODO en Phase R (ver FULL_RECONCILE_SOURCES).
    return await runPhasesForDeal({ deal, lineItems, source: ownerLabel });
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
 * ── EL FRENO (PHASE_R_SKIP_SEALED) ─────────────────────────────────────────
 * Cada línea cuesta 2 llamadas a HubSpot (getById + búsqueda de tickets por
 * LIK) en CADA corrida, también las que ya terminaron su ciclo. Con miles de
 * líneas selladas eso domina el costo de la pasada y no descubre nada nuevo.
 *
 * Con la llave prendida, las líneas con `fechas_completas=true` se saltean en
 * el camino caliente y se reconcilian solo en las corridas FULL. El
 * des-sellado (una línea sellada que volvió a tener cuotas pendientes) sigue
 * garantizado por tres vías:
 *   1. los writers event-driven (recalcFacturasRestantes) — inmediato;
 *   2. «Actualizar» sobre la línea — a pedido, es corrida FULL;
 *   3. cronWeekendFull — barrido semanal, es corrida FULL.
 * Por eso el freno NO puede volver a ser el latch de una sola vía que mataba
 * líneas: lo que se saltea es la RE-VERIFICACIÓN rutinaria, no la corrección.
 *
 * Llave apagada (default) ⇒ comportamiento idéntico al de hoy.
 *
 * recalcContadores es inyectable para testear la orquestación sin API.
 *
 * @param {boolean} [fullReconcile] - true ⇒ ignora el freno y revisa TODO.
 * @returns {Promise<{processed:number, skipped:number, sealedSkipped:number, errors:number}>}
 */
export async function runPhaseR({
  dealId,
  lineItems,
  hubspotClient: client = hubspotClient,
  recalcContadoresFn = recalcContadores,
  fullReconcile = false,
}) {
  let processed = 0;
  let skipped = 0;
  let sealedSkipped = 0;
  let errors = 0;

  const frenoActivo = parseBool(process.env.PHASE_R_SKIP_SEALED) && !fullReconcile;

  for (const li of Array.isArray(lineItems) ? lineItems : []) {
    const lp = li?.properties || {};
    const liId = String(li?.id || lp.hs_object_id || '');
    const lik = String(lp.line_item_key || '').trim();

    if (!liId || !lik) {
      skipped++;
      continue;
    }

    // El freno: línea con el ciclo cerrado ⇒ no se re-verifica en caliente.
    if (frenoActivo && String(lp.fechas_completas || '').trim().toLowerCase() === 'true') {
      sealedSkipped++;
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

  if (sealedSkipped > 0) {
    logger.debug(
      { module: 'phases/index', fn: 'runPhaseR', dealId, processed, sealedSkipped },
      'Phase R: líneas selladas salteadas por el freno (se reconcilian en la corrida FULL)'
    );
  }

  return { processed, skipped, sealedSkipped, errors };
}

/**
 * Entry points cuya corrida reconcilia TODO, freno incluido.
 *
 * `cronWeekendFull` es la red de seguridad periódica: garantiza que ninguna
 * línea sellada quede sin re-verificar más de una semana. `runBilling` y
 * `actualizar` son a pedido y por deal (costo despreciable), y son la salida
 * de emergencia cuando un contador se ve mal: dale Actualizar y se recalcula.
 */
const FULL_RECONCILE_SOURCES = new Set(['cronWeekendFull', 'runBilling', 'actualizar']);

export async function runPhasesForDeal({ deal, lineItems, source = null }) {
  const dealId = String(deal?.id || deal?.properties?.hs_object_id);

  // Buffer de escrituras de line items para todo el deal (batch con flag
  // LI_BATCH_WRITES_ENABLED=true; modo inmediato idéntico al previo con flag off).
  // Cada fase que lo usa flushea al terminar; el finally es red de seguridad.
  const liWriteBuffer = createLineItemWriteBuffer({ context: { dealId } });

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
      await runPhase1(dealId, { writeBuffer: liWriteBuffer });
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
      const phasePResult = await runPhaseP({ deal: currentDeal, lineItems: activeLineItems, writeBuffer: liWriteBuffer });
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

    // ========== PHASE P DEL ESPEJO UY ==========
    // 🔴 2-ago-2026: el negocio ESPEJO también necesita su cronograma.
    // Phase P corría SÓLO para el negocio que disparó el job, así que el espejo se
    // quedaba con line items y CERO tickets (medido en sandbox: 0 por asociación y 0
    // por of_line_item_key — las dos vías, o sea que de verdad no existían). El ticket
    // espejo es la pieza sobre la que la tanda D deja los avisos, así que sin él ese
    // camino entero queda sin probar.
    //
    // Se corre SOLO Phase P, no las fases completas: Phase 1 del espejo ya la hace
    // runPhase1 (procesa el espejo en su propio bloque) y volver a entrar por
    // runPhasesForDeal abriría una recursión — el espejo es un deal como cualquier otro.
    // Phase 2/3 del espejo dependen de SU facturacion_activa y no se tocan acá.
    try {
      const mirrorDealId = currentDeal?.properties?.deal_uy_mirror_id;
      if (mirrorDealId) {
        const mirrorFull = await getDealWithLineItems(String(mirrorDealId));
        const mirrorLis = filterActiveLineItems(mirrorFull?.lineItems || []);
        if (mirrorLis.length) {
          const rMirror = await runPhaseP({ deal: mirrorFull.deal || mirrorFull, lineItems: mirrorLis });
          results.phasePMirror = rMirror;
          logger.info(
            { module: 'phases/index', fn: 'runPhasesForDeal', dealId, mirrorDealId,
              created: rMirror?.created || 0, updated: rMirror?.updated || 0, deleted: rMirror?.deleted || 0 },
            'Phase P del espejo UY completada'
          );
        }
      }
    } catch (err) {
      logger.error(
        { module: 'phases/index', fn: 'runPhasesForDeal', dealId, err },
        'Error en Phase P del espejo UY (no bloquea el original)'
      );
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
            'Catch-up: tickets forecast atrasados promovidos (auto→READY / manual→PRÓXIMOS A FACTURAR)'
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

    // ========== ASOCIAR TICKETS AL NEGOCIO (CIERRE GANADO) ==========
    // Fase 3. Cuando el negocio está ganado (facturacion_activa), asocia de una
    // vez todos los tickets del deal que aún no lo estén, para que el cronograma
    // completo se vea desde el negocio (los forecast nacen sin asociar). Aditivo:
    // el descubrimiento del motor es por Search, no por asociación.
    //
    // FEATURE FLAG: apagado por default (ASSOC_ALL_ON_CLOSEDWON=true para prender).
    // DECISIÓN reunión 13-jul (resuelto "todos vs manuales"): solo el pipeline MANUAL
    // se asocia al ganar (ASSOC_CLOSEDWON_ONLY_MANUAL=true); el AUTOMÁTICO NO se asocia
    // y se muestra ordenado por fecha en la vista del negocio. No bloquea la corrida.
    if (parseBool(process.env.ASSOC_ALL_ON_CLOSEDWON)) {
      try {
        results.assocClosedWon = await associateAllTicketsOnClosedWon({
          dealId,
          dealProps: currentDeal?.properties,
        });
        logger.info(
          { module: 'phases/index', fn: 'runPhasesForDeal', dealId, ...results.assocClosedWon },
          'Asociación de tickets al cierre ganado completada'
        );
      } catch (err) {
        logger.error(
          { module: 'phases/index', fn: 'runPhasesForDeal', dealId, err },
          'Error asociando tickets al cierre ganado (no bloquea)'
        );
        results.assocClosedWon = { error: err?.message };
      }
    }

    // ========== PHASE R: Recalcular contadores derivados ==========
    // Va DESPUÉS de Phase 3 a propósito: recalcFacturasRestantes sella
    // fechas_completas, que Phase 1 lee para excluir LIs de P/2/3. Recomputar al
    // final hace que ese sello afecte la corrida siguiente, no la actual.
    // Lógica extraída a runPhaseR (testeable). Ver docs/SISTEMA_CONTADORES_BILLING.md.
    //
    // FEATURE FLAG: apagado por default. Se activa con PHASE_R_ENABLED=true (env).
    // Permite deployar sin que Phase R corra en el flujo automático, validar
    // puntualmente con scripts/fix/recalcContadores.mjs, y recién prenderlo en
    // Railway cuando se confirme — sin redeploy ni merge.
    if (parseBool(process.env.PHASE_R_ENABLED)) {
      try {
        results.phaseR = await runPhaseR({
          dealId,
          lineItems: currentLineItems,
          hubspotClient,
          fullReconcile: FULL_RECONCILE_SOURCES.has(String(source || '')),
        });
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
    } else {
      logger.debug(
        { module: 'phases/index', fn: 'runPhasesForDeal', dealId },
        'Phase R deshabilitado (PHASE_R_ENABLED != true), se saltea'
      );
    }

    // ========== DEAL TOTAL: VALOR del negocio ==========
    // Caso 1 (fin definido / pago único) = Σ subtotal_real de sus TICKETS; Caso 2
    // (auto-renew) = run-rate anual desde el LI (price×qty×mult. anual, regla 21-jul).
    // Escribe valor_total (USD) + valor_total_moneda_original (local) + margen_total_usd.
    // Dinámico: se recalcula en cada corrida. No bloquea el ciclo si falla.
    try {
      // Va al FINAL de runPhasesForDeal a propósito: los tickets de esta corrida ya
      // están creados/actualizados. Se le pasan los LIs ya cargados para el caso
      // auto-renew (evita re-leerlos de la API).
      const { total } = await recalcValorTotal({ dealId, lineItems: currentLineItems });
      results.valorTotal = total;
    } catch (err) {
      logger.error(
        { module: 'phases/index', fn: 'runPhasesForDeal', dealId, err },
        'Error en recalcValorTotal (no bloquea)'
      );
    }

    logger.info(
      { module: 'phases/index', fn: 'runPhasesForDeal', dealId, ticketsCreated: results.ticketsCreated, autoInvoicesEmitted: results.autoInvoicesEmitted, valorTotal: results.valorTotal },
      'Deal completado'
    );

    return results;
  } finally {
    // (el candado no lo libera este caller)
    // Red de seguridad del buffer: si alguna fase salió por error sin flushear,
    // persistir lo pendiente para no perder updates. Noop si está vacío.
    try {
      if (liWriteBuffer.pendingCount() > 0) {
        logger.error(
          { module: 'phases/index', fn: 'runPhasesForDeal', dealId, pending: liWriteBuffer.pendingCount() },
          'writeBuffer con updates pendientes al finalizar el deal — flush de seguridad (una fase salió sin flushear)'
        );
        await liWriteBuffer.flush();
      }
    } catch (err) {
      logger.error({ module: 'phases/index', fn: 'runPhasesForDeal', dealId, err }, 'Error en flush de seguridad del writeBuffer');
    }
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