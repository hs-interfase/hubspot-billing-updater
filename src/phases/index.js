// src/phases/index.js

import { runPhase1 } from './phase1.js';
import { runPhase2 } from './phase2.js';
import { runPhase3 } from './phase3.js';
import { activateBillingIfClosedWon } from './activateBilling.js';

/**
 * Orquestador de las fases del proceso de facturación.
 * 
 * - Phase 1: Actualizar fechas, calendario, cupo (ANTES de Closed Won)
 * - Activación: Si está en Closed Won, activar facturacion_activa y cupo_activo
 * - Phase 2: Generar tickets manuales para line items con facturacion_automatica=false
 * - Phase 3: Emitir facturas automáticas para line items con facturacion_automatica=true
 * 
 * @param {Object} params
 * @param {Object} params.deal - Deal de HubSpot
 * @param {Array} params.lineItems - Line Items del Deal
 * @returns {Object} Resumen de ejecución
 */
export async function runPhasesForDeal({ deal, lineItems }) {
  const dealId = String(deal.id || deal.properties?.hs_object_id);
  
  console.log(`\n🔄 INICIANDO PROCESAMIENTO DE FASES`);
  console.log(`   Deal ID: ${dealId}`);
  console.log(`   Line Items: ${lineItems.length}\n`);
  
  const results = {
    dealId,
    phase1: { success: false },
    activation: { activated: false },
    phase2: { ticketsCreated: 0 },
    phase3: { invoicesEmitted: 0 },
    ticketsCreated: 0,
    autoInvoicesEmitted: 0,
  };
  
  // ========== PHASE 1: Fechas, calendario, cupo ==========
  try {
    console.log(`📅 PHASE 1: Actualizando fechas, calendario y cupo...`);
    await runPhase1(dealId);
    results.phase1.success = true;
    console.log(`   ✅ Phase 1 completada\n`);
  } catch (err) {
    console.error(`   ❌ Error en Phase 1:`, err?.message || err);
    results.phase1.error = err?.message || 'Error desconocido';
  }
  
  // ========== ACTIVACIÓN: Si Closed Won, activar facturación ==========
  try {
    console.log(`⚡ ACTIVACIÓN: Verificando si activar facturación (Closed Won)...`);
    const activationResult = await activateBillingIfClosedWon({ deal, lineItems });
    results.activation = activationResult;
    
    if (activationResult.activated) {
      console.log(`   ✅ Facturación activada (Deal en Closed Won)\n`);
      
      // Delay para eventual consistency de HubSpot API
      console.log(`   ⏳ Esperando 2 segundos para que HubSpot actualice propiedades...`);
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Si se activó, re-fetch el deal para tener los datos actualizados
      console.log(`   🔄 Recargando deal y line items con datos actualizados...`);
      const { getDealWithLineItems } = await import('../hubspotClient.js');
      const updated = await getDealWithLineItems(dealId);
      deal = updated.deal;
      lineItems = updated.lineItems;
      console.log(`   ✅ Datos actualizados\n`);
    } else {
      console.log(`   ⏭️  No se activó facturación: ${activationResult.reason}\n`);
    }
  } catch (err) {
    console.error(`   ❌ Error en Activación:`, err?.message || err);
    results.activation.error = err?.message || 'Error desconocido';
  }
  
  // ========== PHASE 2: Tickets manuales ==========
  try {
    console.log(`🎫 PHASE 2: Generando tickets manuales (facturacion_automatica=false)...`);
    const phase2Result = await runPhase2({ deal, lineItems });
    results.phase2 = phase2Result;
    results.ticketsCreated = phase2Result.ticketsCreated || 0;
    console.log(`   ✅ Phase 2 completada: ${results.ticketsCreated} tickets creados\n`);
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
    console.log(`   ✅ Phase 3 completada: ${results.autoInvoicesEmitted} facturas emitidas\n`);
  } catch (err) {
    console.error(`   ❌ Error en Phase 3:`, err?.message || err);
    results.phase3.error = err?.message || 'Error desconocido';
  }
  
  console.log(`🏁 Deal ${dealId} completado:`);
  console.log(`   - Tickets: ${results.ticketsCreated}`);
  console.log(`   - Facturas: ${results.autoInvoicesEmitted}`);
  
  return results;
}
