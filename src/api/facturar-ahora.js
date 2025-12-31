// api/facturar-ahora.js

/**
 * Webhook para HubSpot: Disparar facturación inmediata cuando se activa "facturar_ahora".
 * 
 * Flujo:
 * 1. HubSpot envía un webhook cuando cambia la propiedad "facturar_ahora" de un line item o ticket
 * 2. Este endpoint valida el payload y dispara el proceso de facturación urgente
 * 3. Emite la factura automáticamente
 * 
 * Configuración en HubSpot:
 * - Tipo: Property Change
 * - Objeto: Line Item / Ticket
 * - Propiedad: facturar_ahora
 * - URL: https://hubspot-billing-updater.vercel.app/api/facturar-ahora
 * - Método: POST
 */

import { processUrgentLineItem, processUrgentTicket } from '../src/services/urgentBillingService.js';

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
    const propertyName = payload?.propertyName;
    const propertyValue = payload?.propertyValue;
    const subscriptionType = payload?.subscriptionType; // "line_item.propertyChange" o "ticket.propertyChange"
    
    console.log('[facturar-ahora] Webhook recibido:', { 
      objectId, 
      propertyName, 
      propertyValue,
      subscriptionType 
    });
    
    // Validaciones básicas
    if (!objectId) {
      return res.status(400).json({ error: 'Missing objectId' });
    }
    
    if (propertyName !== 'facturar_ahora') {
      return res.status(400).json({ error: 'Invalid property, expected facturar_ahora' });
    }
    
    if (propertyValue !== 'true' && propertyValue !== true) {
      console.log('⚠️ facturar_ahora is not true, ignoring');
      return res.status(200).json({ message: 'Property not true, skipping' });
    }
    
    // Detectar si es Line Item o Ticket según subscriptionType
    let result;
    
    if (subscriptionType?.includes('line_item')) {
      // Procesar Line Item
      console.log('📦 Procesando Line Item urgente:', objectId);
      result = await processUrgentLineItem(objectId);
      
    } else if (subscriptionType?.includes('ticket')) {
      // Procesar Ticket
      console.log('🎫 Procesando Ticket urgente:', objectId);
      result = await processUrgentTicket(objectId);
      
    } else {
      console.error('❌ Tipo de objeto desconocido:', subscriptionType);
      return res.status(400).json({ error: 'Unknown subscription type' });
    }
    
    // Verificar si fue omitido (skip)
    if (result.skipped) {
      console.log(`⚠️ Proceso omitido: ${result.reason}`);
      return res.status(200).json({ 
        skipped: true, 
        reason: result.reason,
        invoiceId: result.invoiceId || null
      });
    }
    
    // Éxito
    console.log('✅ Facturación urgente completada');
    return res.status(200).json({
      success: true,
      invoiceId: result.invoiceId,
      objectId: result.lineItemId || result.ticketId,
    });
    
  } catch (err) {
    console.error('[facturar-ahora] Error procesando webhook:', err?.message || err);
    console.error(err?.stack);
    return res.status(500).json({
      error: 'Internal server error',
      message: err?.message || 'Unknown error',
    });
  }
}