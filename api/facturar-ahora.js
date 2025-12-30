// api/facturar-ahora.js

/**
 * Webhook para HubSpot: Disparar facturación inmediata cuando se activa "facturar_ahora".
 * 
 * Flujo:
 * 1. HubSpot envía un webhook cuando cambia la propiedad "facturar_ahora" de un line item o ticket
 * 2. Este endpoint valida el payload y dispara la facturación urgente
 * 3. Emite la factura y guarda evidencia de facturación urgente
 * 
 * Configuración en HubSpot:
 * - Suscripción 1: Line Item → Property Change → facturar_ahora
 * - Suscripción 2: Ticket → Property Change → facturar_ahora
 * - URL: https://tu-dominio.vercel.app/api/facturar-ahora
 * - Método: POST
 * 
 * Payload esperado (HubSpot):
 * {
 *   "objectId": "12345",
 *   "objectType": "line_item" | "ticket",
 *   "propertyName": "facturar_ahora",
 *   "propertyValue": "true",
 *   "changeSource": "CRM",
 *   "eventId": "...",
 *   "subscriptionId": "...",
 *   "subscriptionType": "line_item.propertyChange" | "ticket.propertyChange",
 *   "portalId": 123456,
 *   "occurredAt": 1234567890
 * }
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
    // Extraer datos del payload de HubSpot (puede venir como array o objeto)
    const payload = Array.isArray(req.body) ? req.body[0] : req.body;
    
    const objectId = payload?.objectId;
    const objectType = payload?.subscriptionType?.split('.')[0] || 'line_item'; // 'line_item.propertyChange' → 'line_item'
    const propertyName = payload?.propertyName;
    const propertyValue = payload?.propertyValue;
    const eventId = payload?.eventId;
    
    console.log('\n🔥 [facturar-ahora] Webhook recibido:', {
      objectId,
      objectType,
      propertyName,
      propertyValue,
      eventId,
    });
    
    // Validaciones básicas
    if (!objectId) {
      console.error('❌ Missing objectId');
      return res.status(400).json({ error: 'Missing objectId' });
    }
    
    if (propertyName !== 'facturar_ahora') {
      console.log('⚠️ Property is not facturar_ahora, ignoring');
      return res.status(200).json({ message: 'Property not facturar_ahora, skipped' });
    }
    
    if (propertyValue !== 'true' && propertyValue !== true) {
      console.log('⚠️ facturar_ahora is not true, ignoring');
      return res.status(200).json({ message: 'Property value not true, skipped' });
    }
    
    // Determinar tipo de objeto y procesar
    let result;
    
    if (objectType === 'line_item') {
      console.log('📋 Procesando Line Item urgente...');
      result = await processUrgentLineItem(objectId);
    } else if (objectType === 'ticket') {
      console.log('🎫 Procesando Ticket urgente...');
      result = await processUrgentTicket(objectId);
    } else {
      console.error(`❌ Tipo de objeto no soportado: ${objectType}`);
      return res.status(400).json({ error: `Unsupported object type: ${objectType}` });
    }
    
    // Si el proceso fue omitido (ya facturado, etc.)
    if (result.skipped) {
      console.log(`⚠️ Proceso omitido: ${result.reason}`);
      return res.status(200).json({
        skipped: true,
        reason: result.reason,
        objectId,
        objectType,
      });
    }
    
    // Éxito
    console.log('✅ Facturación urgente completada');
    return res.status(200).json({
      success: true,
      objectId,
      objectType,
      invoiceId: result.invoiceId,
      eventId,
    });
    
  } catch (err) {
    console.error('\n❌ [facturar-ahora] Error procesando webhook:', err?.message || err);
    console.error(err?.stack);
    
    return res.status(500).json({
      error: 'Internal server error',
      message: err?.message || 'Unknown error',
    });
  }
}
