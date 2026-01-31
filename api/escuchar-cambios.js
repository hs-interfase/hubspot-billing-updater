// api/escuchar-cambios.js

/**
 * Webhook unificado para HubSpot: Maneja facturación urgente y recálculos.
 * 
 * Propiedades soportadas:
 * 1. facturar_ahora (Line Item/Ticket) → Facturación urgente inmediata
 * 2. actualizar (Line Item) → Recalcula todas las fases de facturación
 * 3. hs_billing_start_delay_type (Line Item) → Normaliza delays a fechas
 * 
 * Configuración en HubSpot:
 * - Suscripciones en la misma URL: https://hubspot-billing-updater.vercel.app/api/escuchar-cambios
 * - Line Item → Property Change → facturar_ahora
 * - Ticket → Property Change → facturar_ahora
 * - Line Item → Property Change → actualizar
 * - Line Item → Property Change → hs_billing_start_delay_type
 */

import { processUrgentLineItem, processUrgentTicket } from '../src/services/urgentBillingService.js';
import { hubspotClient, getDealWithLineItems } from '../src/hubspotClient.js';
import { runPhasesForDeal } from '../src/phases/index.js';
import { parseBool } from '../src/utils/parsers.js';
import { processTicketUpdate } from '../src/services/tickets/ticketUpdateService.js';

/**
 * Obtiene el dealId asociado a un line item.
 */
async function getDealIdForLineItem(lineItemId) {
  const resp = await hubspotClient.crm.associations.v4.basicApi.getPage(
    "line_items",
    String(lineItemId),
    "deals",
    100
  );
  const dealIds = (resp.results || [])
    .map((r) => String(r.toObjectId))
    .filter(Boolean);
  return dealIds.length ? dealIds[0] : null;
}

/**
 * Procesa eventos de "actualizar" o "hs_billing_start_delay_type".
 * Ejecuta las 3 fases de facturación para el deal asociado.
 * 
 * IMPORTANTE: Phase 1 SIEMPRE se ejecuta (mirroring, fechas, cupo).
 * Phase 2 y 3 solo se ejecutan si facturacion_activa=true.
 */
async function processRecalculation(lineItemId, propertyName) {
  console.log(`\n🔄 [Recalculation] Procesando ${propertyName} para line item ${lineItemId}...`);
  
//0 Setear Actualizar a False.
  if (propertyName === "actualizar") {
    try {
      await hubspotClient.crm.lineItems.basicApi.update(String(lineItemId), {
        properties: { actualizar: false },
      });
      console.log(`🧯 Trigger "actualizar" reseteado a false (line item ${lineItemId})`);
    } catch (e) {
      console.warn(`⚠️ No pude resetear "actualizar" al inicio (line item ${lineItemId})`, e?.message || e);
      // si tu prioridad #1 es cortar loops igual, NO hagas throw acá.
      // Si querés ser más estricta: throw e;
    }
  }


  // 1. Obtener deal asociado
  const dealId = await getDealIdForLineItem(lineItemId);
  if (!dealId) {
    console.error(`❌ No se encontró deal asociado al line item ${lineItemId}`);
    return { skipped: true, reason: 'No associated deal' };
  }
  
  // 2. Obtener deal info para logging
  const deal = await hubspotClient.crm.deals.basicApi.getById(String(dealId), [
    "facturacion_activa",
    "dealname",
  ]);
  const dealProps = deal?.properties || {};
  const dealName = dealProps.dealname || "Sin nombre";
  
  console.log(`📋 Deal: ${dealName} (${dealId})`);
  
  // 3. Ejecutar fases de facturación
  // Phase 1 se ejecuta SIEMPRE (mirroring, normalización de fechas, etc.)
  // Phase 2 y 3 verifican internamente facturacion_activa
  console.log(`🚀 Ejecutando runPhasesForDeal...`);
  const dealWithLineItems = await getDealWithLineItems(dealId);
  const billingResult = await runPhasesForDeal(dealWithLineItems);
  
  console.log(`✅ Recalculación completada:`, {
    ticketsCreated: billingResult.ticketsCreated || 0,
    invoicesEmitted: billingResult.autoInvoicesEmitted || 0
  });
  
  return {
    success: true,
    dealId,
    dealName,
    billingResult
  };
}

/**
 * Handler principal del webhook.
 */
export default async function handler(req, res) {
  // Solo acepta POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  try {
    // Extraer datos del payload de HubSpot
    const payload = Array.isArray(req.body) ? req.body[0] : req.body;
    
    const objectId = payload?.objectId;
    const objectType = payload?.subscriptionType?.split('.')[0] || 'line_item';
    const propertyName = payload?.propertyName;
    const propertyValue = payload?.propertyValue;
    const eventId = payload?.eventId;
    
    console.log('\n' + '='.repeat(80));
    console.log('🔔 [WEBHOOK] Evento recibido:', {
      objectId,
      objectType,
      propertyName,
      propertyValue,
      eventId,
    });
    console.log('='.repeat(80));
    
    // Validaciones básicas
    if (!objectId) {
      console.error('❌ Missing objectId');
      return res.status(400).json({ error: 'Missing objectId' });
    }
    
    // ====== RUTA 1: FACTURACIÓN URGENTE (facturar_ahora) ======
    if (propertyName === 'facturar_ahora') {
      console.log(`🔍 Validando facturar_ahora: value="${propertyValue}", parsed=${parseBool(propertyValue)}`);
      
      if (!parseBool(propertyValue)) {
        console.log('⚠️ facturar_ahora no está en true, ignorando');
        return res.status(200).json({ message: 'Property value not true, skipped' });
      }
      
      let result;
      
      if (objectType === 'line_item') {
        console.log('📋 → Facturación urgente de Line Item...');
        result = await processUrgentLineItem(objectId);
      } else if (objectType === 'ticket') {
        console.log('🎫 → Facturación urgente de Ticket...');
        result = await processUrgentTicket(objectId);
      } else {
        console.error(`❌ Tipo de objeto no soportado: ${objectType}`);
        return res.status(400).json({ error: `Unsupported object type: ${objectType}` });
      }
      
      if (result.skipped) {
        console.log(`⚠️ Proceso omitido: ${result.reason}`);
        return res.status(200).json({
          skipped: true,
          reason: result.reason,
          objectId,
          objectType,
        });
      }
      
      console.log('✅ Facturación urgente completada');
      console.log('='.repeat(80) + '\n');
      
      return res.status(200).json({
        success: true,
        action: 'urgent_billing',
        objectId,
        objectType,
        invoiceId: result.invoiceId,
        eventId,
      });
    }
    
// ====== RUTA 2: RECALCULACIÓN (actualizar o hs_billing_start_delay_type) ======
if (['actualizar', 'hs_billing_start_delay_type'].includes(propertyName)) {
  
  // CASO A: actualizar en TICKET → Procesamiento independiente
  if (propertyName === 'actualizar' && objectType === 'ticket') {
    console.log(`🔍 Validando actualizar en ticket: value="${propertyValue}", parsed=${parseBool(propertyValue)}`);
    
    if (!parseBool(propertyValue)) {
      console.log('⚠️ Flag actualizar no está en true, ignorando');
      return res.status(200).json({ 
        message: 'actualizar flag not true, skipped',
        receivedValue: propertyValue
      });
    }
    
    console.log(`🎫 → Actualizando ticket ${objectId}...`);
    
    try {
      const result = await processTicketUpdate(objectId);
      
      console.log('✅ Actualización de ticket completada');
      
      return res.status(200).json({
        success: true,
        action: 'ticket_update',
        objectId,
        ticketId: objectId,
        result,
        eventId,
      });
    } catch (err) {
      console.error(`❌ Error procesando ticket ${objectId}:`, err?.message || err);
      return res.status(200).json({
        error: true,
        message: err?.message || 'Error procesando ticket',
        objectId,
      });
    } finally {
      // Resetear flag actualizar en ticket
      try {
        await hubspotClient.crm.tickets.basicApi.update(String(objectId), {
          properties: { actualizar: false },
        });
        console.log(`✅ Flag 'actualizar' reseteado a false para ticket ${objectId}`);
      } catch (err) {
        console.error(`⚠️ Error reseteando 'actualizar' en ticket:`, err.message);
      }
      console.log('='.repeat(80) + '\n');
    }
  }
  
  // CASO B: hs_billing_start_delay_type solo aplica a LINE ITEMS
  if (propertyName === 'hs_billing_start_delay_type' && objectType !== 'line_item') {
    console.log(`⚠️ ${propertyName} solo aplica a line items, ignorando`);
    return res.status(200).json({ message: 'Not a line_item event, ignored' });
  }
  
  // CASO C: actualizar en LINE ITEM (flujo original sin cambios)
  if (propertyName === 'actualizar' && objectType === 'line_item') {
    console.log(`🔍 Validando actualizar: value="${propertyValue}", parsed=${parseBool(propertyValue)}`);
    
    if (!parseBool(propertyValue)) {
      console.log('⚠️ Flag actualizar no está en true, ignorando');
      return res.status(200).json({ 
        message: 'actualizar flag not true, skipped',
        receivedValue: propertyValue
      });
    }
  }
  
  // CASO D: hs_billing_start_delay_type en LINE ITEM (continúa sin validar valor)
  // Solo ejecutar processRecalculation para LINE ITEMS (ambas propiedades)
  if (objectType === 'line_item') {
    console.log(`🔄 → Recalculación de facturación (${propertyName})...`);
    const result = await processRecalculation(objectId, propertyName);
    
    if (result.skipped) {
      console.log(`⚠️ Recalculación omitida: ${result.reason}`);
      console.log('='.repeat(80) + '\n');
      return res.status(200).json({
        skipped: true,
        reason: result.reason,
        objectId,
        propertyName,
      });
    }
    
    // Resetear flag "actualizar" inmediatamente después de procesar (sin delay)
    if (propertyName === "actualizar") {
      try {
        await hubspotClient.crm.lineItems.basicApi.update(String(objectId), {
          properties: { actualizar: false },
        });
        console.log(`✅ Flag 'actualizar' reseteado a false para line item ${objectId}`);
      } catch (err) {
        console.error(`⚠️ Error reseteando 'actualizar':`, err.message);
      }
    }
    
    console.log('✅ Recalculación completada');
    console.log('='.repeat(80) + '\n');
    
    return res.status(200).json({
      success: true,
      action: 'recalculation',
      objectId,
      propertyName,
      dealId: result.dealId,
      dealName: result.dealName,
      billingResult: result.billingResult,
      eventId,
    });
  }
}
    
    // ====== PROPIEDAD NO RECONOCIDA ======
    console.log(`⚠️ Propiedad no reconocida: ${propertyName}, ignorando`);
    console.log('='.repeat(80) + '\n');
    
    return res.status(200).json({ 
      message: 'Property not supported, skipped',
      propertyName 
    });
    
  } catch (err) {
    console.error('\n❌ [WEBHOOK] Error procesando webhook:', err?.message || err);
    console.error(err?.stack);
    console.log('='.repeat(80) + '\n');
    
    return res.status(500).json({
      error: 'Internal server error',
      message: err?.message || 'Unknown error',
    });
  }
}