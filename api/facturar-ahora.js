// api/facturar-ahora.js

/**
 * Webhook para HubSpot: Disparar facturación inmediata cuando se activa "facturar_ahora".
 * 
 * Flujo:
 * 1. HubSpot envía un webhook cuando cambia la propiedad "facturar_ahora" de un line item
 * 2. Este endpoint valida el payload y dispara Phase 3 para ese line item específico
 * 3. Emite la factura automáticamente si facturacion_automatica=true
 * 
 * Configuración en HubSpot:
 * - Tipo: Property Change
 * - Objeto: Line Item
 * - Propiedad: facturar_ahora
 * - URL: https://tu-dominio.vercel.app/api/facturar-ahora
 * - Método: POST
 * 
 * Payload esperado (HubSpot):
 * {
 *   "objectId": "12345",
 *   "propertyName": "facturar_ahora",
 *   "propertyValue": "true",
 *   "changeSource": "CRM",
 *   "eventId": "...",
 *   "subscriptionId": "...",
 *   "portalId": 123456,
 *   "occurredAt": 1234567890
 * }
 */

import { hubspotClient, getDealWithLineItems } from '../src/hubspotClient.js';
import { runPhase3 } from '../src/phases/phase3.js';

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
    
    const lineItemId = payload?.objectId;
    const propertyName = payload?.propertyName;
    const propertyValue = payload?.propertyValue;
    
    console.log('[facturar-ahora] Webhook recibido:', { lineItemId, propertyName, propertyValue });
    
    // Validaciones básicas
    if (!lineItemId) {
      return res.status(400).json({ error: 'Missing objectId (line item ID)' });
    }
    
    if (propertyName !== 'facturar_ahora') {
      return res.status(400).json({ error: 'Invalid property, expected facturar_ahora' });
    }
    
    if (propertyValue !== 'true' && propertyValue !== true) {
      return res.status(200).json({ message: 'Property not true, skipping' });
    }
    
    // Obtener el line item de HubSpot
    const lineItem = await hubspotClient.crm.lineItems.basicApi.getById(
      lineItemId,
      [
        'name',
        'price',
        'quantity',
        'facturacion_activa',
        'facturacion_automatica',
        'facturar_ahora',
        'of_invoice_id',
        'hs_recurring_billing_start_date',
        'fecha_inicio_de_facturacion',
      ]
    );
    
    const lp = lineItem.properties || {};
    
    // Validar que sea elegible para facturación automática
    const facturacionActiva = lp.facturacion_activa === 'true' || lp.facturacion_activa === true;
    const facturacionAutomatica = lp.facturacion_automatica === 'true' || lp.facturacion_automatica === true;
    
    if (!facturacionActiva) {
      console.log('[facturar-ahora] Line item no tiene facturacion_activa=true');
      return res.status(200).json({ message: 'Line item not active for billing' });
    }
    
    if (!facturacionAutomatica) {
      console.log('[facturar-ahora] Line item no tiene facturacion_automatica=true, requiere ticket manual');
      return res.status(200).json({ message: 'Line item requires manual billing (ticket)' });
    }
    
    if (lp.of_invoice_id) {
      console.log('[facturar-ahora] Line item ya tiene factura:', lp.of_invoice_id);
      return res.status(200).json({ message: 'Invoice already exists', invoiceId: lp.of_invoice_id });
    }
    
    // Obtener el deal asociado
    const dealAssoc = await hubspotClient.crm.associations.v4.basicApi.getPage(
      'line_items',
      lineItemId,
      'deals',
      1
    );
    const dealId = dealAssoc.results?.[0]?.toObjectId;
    
    if (!dealId) {
      console.error('[facturar-ahora] Line item sin deal asociado');
      return res.status(400).json({ error: 'Line item has no associated deal' });
    }
    
    // Obtener deal completo
    const { deal, lineItems } = await getDealWithLineItems(dealId);
    
    // Filtrar solo este line item
    const targetLineItems = lineItems.filter((li) => String(li.id) === String(lineItemId));
    
    if (targetLineItems.length === 0) {
      console.error('[facturar-ahora] Line item no encontrado en el deal');
      return res.status(404).json({ error: 'Line item not found in deal' });
    }
    
    // Ejecutar Phase 3 solo para este line item
    console.log('[facturar-ahora] Ejecutando Phase 3 para line item:', lineItemId);
    const result = await runPhase3({ deal, lineItems: targetLineItems });
    
    console.log('[facturar-ahora] Resultado:', result);
    
    return res.status(200).json({
      success: true,
      lineItemId,
      invoicesEmitted: result.invoicesEmitted || 0,
      errors: result.errors || [],
    });
  } catch (err) {
    console.error('[facturar-ahora] Error procesando webhook:', err?.response?.body || err?.message || err);
    return res.status(500).json({
      error: 'Internal server error',
      message: err?.message || 'Unknown error',
    });
  }
}
