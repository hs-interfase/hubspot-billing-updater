// src/services/urgentBillingService.js

import { hubspotClient, getDealWithLineItems } from '../hubspotClient.js';
import { createAutoInvoiceFromLineItem } from './invoiceService.js';
import { createInvoiceFromTicket } from '../invoices.js';

/**
 * Obtiene la fecha actual en formato YYYY-MM-DD para HubSpot.
 */
function getTodayISO() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Actualiza las propiedades de evidencia de facturación urgente en un Line Item.
 * 
 * @param {string} lineItemId - ID del line item
 * @param {object} currentProps - Propiedades actuales del line item
 * @returns {Promise<void>}
 */
async function updateUrgentBillingEvidence(lineItemId, currentProps = {}) {
  try {
    const cantidadActual = parseInt(currentProps.cantidad_de_facturaciones_urgentes || '0', 10);
    
    const updateProps = {
      facturado_con_urgencia: 'true',
      ultima_fecha_facturacion_urgente: getTodayISO(),
      cantidad_de_facturaciones_urgentes: String(cantidadActual + 1),
    };

    await hubspotClient.crm.lineItems.basicApi.update(lineItemId, {
      properties: updateProps,
    });

    console.log(`✅ Evidencia de facturación urgente actualizada en Line Item ${lineItemId}`);
    console.log(`   - Cantidad total: ${cantidadActual + 1}`);
    console.log(`   - Última fecha: ${getTodayISO()}`);
  } catch (error) {
    console.error(`❌ Error actualizando evidencia urgente en Line Item ${lineItemId}:`, error.message);
    throw error;
  }
}

/**
 * Procesa la facturación urgente de un Line Item.
 * 
 * Flujo:
 * 1. Obtiene el deal asociado con todos sus line items
 * 2. Busca el line item específico
 * 3. Crea la factura automáticamente
 * 4. Actualiza evidencia de facturación urgente
 * 5. Resetea el flag facturar_ahora a false
 * 
 * @param {string} lineItemId - ID del line item a facturar
 * @returns {Promise<object>} Resultado con invoiceId y status
 */
export async function processUrgentLineItem(lineItemId) {
  console.log('\n🔥 === FACTURACIÓN URGENTE LINE ITEM ===');
  console.log(`Line Item ID: ${lineItemId}`);
  
  try {
    // 1. Obtener el line item para buscar su deal asociado
    const lineItem = await hubspotClient.crm.lineItems.basicApi.getById(lineItemId, [
      'hs_object_id',
      'name',
      'facturar_ahora',
      'invoice_id',
      'cantidad_de_facturaciones_urgentes',
    ], ['deals']);
    
    const lineItemProps = lineItem.properties || {};
    const associations = lineItem.associations || {};
    
    console.log(`Line Item: ${lineItemProps.name || lineItemId}`);
    
    // 2. Validar que tenga facturar_ahora = true
    const facturarAhora = lineItemProps.facturar_ahora === 'true' || lineItemProps.facturar_ahora === true;
    if (!facturarAhora) {
      console.log('⚠️ facturar_ahora no está en true, ignorando');
      return { skipped: true, reason: 'facturar_ahora_false' };
    }
    
    // 3. Validar que NO tenga ya una factura
    if (lineItemProps.invoice_id) {
      console.log(`⚠️ Line Item ya tiene factura: ${lineItemProps.invoice_id}, ignorando`);
      return { skipped: true, reason: 'already_invoiced', invoiceId: lineItemProps.invoice_id };
    }
    
    // 4. Obtener el deal asociado
    const dealAssociations = associations.deals?.results || [];
    if (dealAssociations.length === 0) {
      console.error('❌ Line Item no tiene deal asociado');
      throw new Error('Line item no tiene deal asociado');
    }
    
    const dealId = dealAssociations[0].id;
    console.log(`Deal asociado: ${dealId}`);
    
    // 5. Obtener deal completo con todos sus line items
    const { deal, lineItems } = await getDealWithLineItems(dealId);
    
    // 6. Buscar el line item específico en la lista
    const targetLineItem = lineItems.find(li => li.id === lineItemId);
    if (!targetLineItem) {
      console.error(`❌ Line Item ${lineItemId} no encontrado en el deal ${dealId}`);
      throw new Error('Line item no encontrado en el deal');
    }
    
    console.log('✅ Line Item encontrado, procediendo a facturar...\n');
    
    // 7. Crear la factura usando el servicio existente
    const invoiceResult = await createAutoInvoiceFromLineItem({
      deal,
      lineItem: targetLineItem,
      billingDate: getTodayISO(),
    });
    
    if (!invoiceResult || !invoiceResult.invoiceId) {
      console.error('❌ No se pudo crear la factura');
      throw new Error('Error al crear factura');
    }
    
    console.log(`✅ Factura creada: ${invoiceResult.invoiceId}`);
    
    // 8. Actualizar evidencia de facturación urgente
    await updateUrgentBillingEvidence(lineItemId, lineItemProps);
    
    // 9. Resetear facturar_ahora a false
    await hubspotClient.crm.lineItems.basicApi.update(lineItemId, {
      properties: { facturar_ahora: 'false' },
    });
    console.log('✅ Flag facturar_ahora reseteado a false');
    
    console.log('\n🎉 Facturación urgente completada exitosamente');
    
    return {
      success: true,
      invoiceId: invoiceResult.invoiceId,
      lineItemId,
      dealId,
    };
    
  } catch (error) {
    console.error('\n❌ Error en facturación urgente de Line Item:', error.message);
    console.error(error.stack);
    
    // Intentar resetear facturar_ahora incluso si falló
    try {
      await hubspotClient.crm.lineItems.basicApi.update(lineItemId, {
        properties: { facturar_ahora: 'false' },
      });
      console.log('⚠️ Flag facturar_ahora reseteado a false (después de error)');
    } catch (resetError) {
      console.error('❌ No se pudo resetear facturar_ahora:', resetError.message);
    }
    
    throw error;
  }
}

/**
 * Procesa la facturación urgente de un Ticket.
 *
 * Flujo:
 * 1. Obtiene el ticket
 * 2. Valida que tenga facturar_ahora = true
 * 3. Crea la factura usando la lógica legacy de tickets
 * 4. Resetea el flag facturar_ahora a false
 *
 * @param {string} ticketId - ID del ticket a facturar
 * @returns {Promise<object>} Resultado con invoiceId y status
 */
export async function processUrgentTicket(ticketId) {
  console.log('\n🔥 === FACTURACIÓN URGENTE TICKET ===');
  console.log(`Ticket ID: ${ticketId}`);

  try {
    // 1. Obtener el ticket
    const ticket = await hubspotClient.crm.tickets.basicApi.getById(ticketId, [
      'subject',
      'facturar_ahora',
      'of_invoice_id',
    ]);

    const ticketProps = ticket.properties || {};
    console.log(`Ticket: ${ticketProps.subject || ticketId}`);
    console.log('Props:', JSON.stringify(ticketProps, null, 2));

    // 2. Validar que tenga facturar_ahora = true
    const facturarAhora =
      ticketProps.facturar_ahora === 'true' || ticketProps.facturar_ahora === true;
    if (!facturarAhora) {
      console.log('⚠️ facturar_ahora no está en true, ignorando');
      return { skipped: true, reason: 'facturar_ahora_false' };
    }

    // 3. Validar que NO tenga ya una factura
    if (ticketProps.of_invoice_id) {
      console.log(`⚠️ Ticket ya tiene factura: ${ticketProps.of_invoice_id}, ignorando`);
      return { skipped: true, reason: 'already_invoiced', invoiceId: ticketProps.of_invoice_id };
    }

    console.log('✅ Ticket válido, procediendo a facturar...\n');

    // 4. Crear la factura usando el servicio que utiliza la API REST directa
    const invoiceResult = await createInvoiceFromTicket(ticket);

    if (!invoiceResult || !invoiceResult.invoiceId) {
      console.error('❌ No se pudo crear la factura del ticket');
      throw new Error('Error al crear factura de ticket');
    }

    console.log(`✅ Factura creada: ${invoiceResult.invoiceId}`);

    // 5. Resetear facturar_ahora a false
    await hubspotClient.crm.tickets.basicApi.update(ticketId, {
      properties: { facturar_ahora: 'false' },
    });
    console.log('✅ Flag facturar_ahora reseteado a false');

    console.log('\n🎉 Facturación urgente de ticket completada exitosamente');

    return {
      success: true,
      invoiceId: invoiceResult.invoiceId,
      ticketId,
    };
  } catch (error) {
    console.error('\n❌ Error en facturación urgente de Ticket:', error.message);
    console.error(error.stack);

    // Intentar resetear facturar_ahora incluso si falló
    try {
      await hubspotClient.crm.tickets.basicApi.update(ticketId, {
        properties: { facturar_ahora: 'false' },
      });
      console.log('⚠️ Flag facturar_ahora reseteado a false (después de error)');
    } catch (resetError) {
      console.error('❌ No se pudo resetear facturar_ahora:', resetError.message);
    }

    throw error;
  }
}