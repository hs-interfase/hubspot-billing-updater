// src/phases/index.js

import { runPhase1 } from './phase1.js';
import { runPhaseP } from './phasep.js'; 
import { runPhase2 } from './phase2.js';
import { runPhase3 } from './phase3.js';
import { cleanupClonedTicketsForDeal } from '../services/tickets/ticketCleanupService.js';
import { getDealWithLineItems } from "../hubspotClient.js";
import { installHubSpotConsoleCollector } from "../utils/hubspotErrorCollector.js";
import * as dateUtils from '../utils/dateUtils.js';

installHubSpotConsoleCollector();

export async function runPhasesForDeal({ deal, lineItems }) {
  const dealId = String(deal.id || deal.properties?.hs_object_id);

  console.log(`\n🔄 INICIANDO PROCESAMIENTO DE FASES`);
  console.log(`   Deal ID: ${dealId}`);
  const dealLastMod = deal.properties?.hs_lastmodifieddate || deal.hs_lastmodifieddate;
  if (dealLastMod) {
    const formatted = dateUtils.formatDateISO(new Date(Number(dealLastMod)));
    console.log(`   Deal hs_lastmodifieddate: ${dealLastMod} (${formatted})`);
  } else {
    console.log('   Deal hs_lastmodifieddate: (no value)');
  }
  console.log(`   Line Items: ${lineItems.length}\n`);
  for (const li of lineItems) {
    const liLastMod = li.properties?.hs_lastmodifieddate || li.hs_lastmodifieddate;
    if (liLastMod) {
      const formatted = dateUtils.formatDateISO(new Date(Number(liLastMod)));
      console.log(`   LineItem ${li.id} hs_lastmodifieddate: ${liLastMod} (${formatted})`);
    } else {
      console.log(`   LineItem ${li.id} hs_lastmodifieddate: (no value)`);
    }
  }

  const results = {
    dealId,
    cleanup: { scanned: 0, duplicates: 0, deprecated: 0 },
    phase1: { success: false },
    phaseP: { success: false }, // ✅ ADD
    phase2: { ticketsCreated: 0 },
    phase3: { invoicesEmitted: 0, ticketsEnsured: 0 },
    ticketsCreated: 0,
    autoInvoicesEmitted: 0,
  };

  // ========== PRE: LIMPIEZA DE TICKETS CLONADOS ==========
  try {
    console.log(`🧹 PRE: Limpieza de tickets clonados/duplicados (por of_ticket_key/of_invoice_key)...`);
    const cleanupResult = await cleanupClonedTicketsForDeal({ dealId, lineItems });
    results.cleanup = cleanupResult || results.cleanup;
    console.log(
      `   ✅ Cleanup completado: scanned=${results.cleanup.scanned}, duplicates=${results.cleanup.duplicates}, deprecated=${results.cleanup.deprecated}\n`
    );
  } catch (err) {
    console.error(`   ❌ Error en Cleanup PRE:`, err?.message || err);
    results.cleanup.error = err?.message || 'Error desconocido';
  }

  // ========== PHASE 1: Fechas, calendario, cupo ==========
  try {
    console.log(`📅 PHASE 1: Actualizando fechas, calendario y cupo...`);
    await runPhase1(dealId);
    results.phase1.success = true;
    console.log(`   ✅ Phase 1 completada\n`);

    // ✅ Refetch post-Phase1
    console.log(`🔄 Refetch deal+lineItems post-Phase1...`);
    const refreshed = await getDealWithLineItems(dealId);

    deal = refreshed.deal || refreshed?.Deal || deal;

    const refreshedLineItems =
      refreshed.lineItems ||
      refreshed.line_items ||
      refreshed?.lineitems ||
      null;

    if (Array.isArray(refreshedLineItems) && refreshedLineItems.length >= 0) {
      lineItems = refreshedLineItems;
    }

    console.log(`   ✅ Refetch completado: lineItems=${lineItems.length}\n`);
  } catch (err) {
    console.error(`   ❌ Error en Phase 1:`, err?.message || err);
    results.phase1.error = err?.message || 'Error desconocido';
  }

  // ========== PHASE P: Forecast/Promesa ==========
// ========== PHASE P: Forecast/Promesa ==========
try {
  console.log(`🟣 PHASE P: Forecast/Promesa (tickets forecast)...`);
  const phasePResult = await runPhaseP({ deal, lineItems });
  results.phaseP = phasePResult;
  results.ticketsCreated += (phasePResult?.created || 0);
  const { created, updated, deleted, skipped } = phasePResult || {};
  console.log(
    `   ✅ Phase P completada: created=${created}, updated=${updated}, deleted=${deleted}, skipped=${skipped}\n`
  );
} catch (err) {
  console.error(`   ❌ Error en Phase P:`, err?.message || err);
  results.phaseP.error = err?.message || 'Error desconocido';
}

  // ========== PHASE 2: Tickets manuales ==========
  try {
    console.log(`🎫 PHASE 2: Generando tickets manuales (facturacion_automatica=false)...`);
    const phase2Result = await runPhase2({ deal, lineItems });
    results.phase2 = phase2Result;
    results.ticketsCreated = phase2Result.ticketsCreated || 0;
    console.log(`   ✅ Phase 2 completada: ${results.ticketsCreated} tickets manuales creados\n`);
  } catch (err) {
    console.error(`   ❌ Error en Phase 2:`, err?.message || err);
    results.phase2.error = err?.message || 'Error desconocido';
  }

  // ========== PHASE 3: Facturas automáticas ==========
  try {
    console.log(`💰 PHASE 3: Emitiendo facturas automáticas (facturacion_automatica=true)...`);
    const phase3Result = await runPhase3({ deal, lineItems });
    results.phase3 = phase3Result;
    results.autoInvoicesEmitted = phase3Result.invoicesEmitted || 0;

    const ticketsPhase3 = phase3Result.ticketsEnsured || 0;
    results.ticketsCreated += ticketsPhase3;

    console.log(
      `   ✅ Phase 3 completada: ${results.autoInvoicesEmitted} facturas emitidas, ${ticketsPhase3} tickets automáticos creados\n`
    );
  } catch (err) {
    console.error(`   ❌ Error en Phase 3:`, err?.message || err);
    results.phase3.error = err?.message || 'Error desconocido';
  }

  console.log(`🏁 Deal ${dealId} completado:`);
  console.log(`   - Tickets totales: ${results.ticketsCreated}`);
  console.log(`   - Facturas: ${results.autoInvoicesEmitted}`);

  return results;
}
