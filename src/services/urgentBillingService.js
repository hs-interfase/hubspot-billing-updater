// src/services/urgentBillingService.js

import { hubspotClient, getDealWithLineItems } from '../hubspotClient.js';
import { createAutoInvoiceFromLineItem, createInvoiceFromTicket } from './invoiceService.js';
import { getTodayYMD, getTodayMillis } from '../utils/dateUtils.js';
import { createAutoBillingTicket, updateTicket } from './tickets/ticketService.js';

/**
 * Helper robusto para truthy/falsey (HubSpot manda strings)
 */
function parseBool(v) {
  const s = String(v ?? '').trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'yes' || s === 'si' || s === 'sí';
}

/**
 * Obtiene el dealId asociado a un line item (FUENTE DE VERDAD: associations v4)
 */
async function getDealIdForLineItem(lineItemId) {
  const resp = await hubspotClient.crm.associations.v4.basicApi.getPage(
    'line_items',
    String(lineItemId),
    'deals',
    100
  );

  const dealIds = (resp.results || [])
    .map(r => String(r.toObjectId))
    .filter(Boolean);

  console.log('[urgent-lineitem] line_item->deals:', dealIds);

  if (dealIds.length === 0) return null;

  if (dealIds.length > 1) {
    console.warn('[urgent-lineitem] ⚠️ múltiples deals asociados, usando el primero:', dealIds[0]);
  }

  return dealIds[0];
}

/**
 * Actualiza las propiedades de evidencia de facturación urgente en un Line Item.
 */
async function updateUrgentBillingEvidence(lineItemId, currentProps = {}) {
  try {
    const cantidadActual = parseInt(currentProps.cantidad_de_facturaciones_urgentes || '0', 10);
    const billingDateYMD = getTodayYMD(); // YYYY-MM-DD en BILLING_TZ
    const midnightUTC = toHubSpotDateOnly(billingDateYMD); // Convierte a midnight UTC

    console.log(`[debug] ultima_fecha_facturacion_urgente: billingDateYMD=${billingDateYMD}, millis=${midnightUTC}`);

    const updateProps = {
      facturado_con_urgencia: 'true',
      ultima_fecha_facturacion_urgente: midnightUTC, // ms para HubSpot
      cantidad_de_facturaciones_urgentes: String(cantidadActual + 1),
    };

    await hubspotClient.crm.lineItems.basicApi.update(String(lineItemId), {
      properties: updateProps,
    });

    console.log(`✅ Evidencia de facturación urgente actualizada en Line Item ${lineItemId}`);
    console.log(`   - Cantidad total: ${cantidadActual + 1}`);
    console.log(`   - Última fecha: ${billingDateYMD}`);
  } catch (error) {
    console.error(`❌ Error actualizando evidencia urgente en Line Item ${lineItemId}:`, error.message);
    throw error;
  }
}

/**
 * Procesa la facturación urgente de un Line Item.
 *
 * Flujo:
 * 1. Lee line item + valida flag
 * 2. Resuelve deal asociado por associations v4 (robusto)
 * 3. Trae deal completo con line items (tu helper)
 * 4. Crea factura (tu service)
 * 5. Evidencia + reset flag
 */
export async function processUrgentLineItem(lineItemId) {
  console.log('\n🔥 === FACTURACIÓN URGENTE LINE ITEM ===');
  console.log(`Line Item ID: ${lineItemId}`);

  try {
    // 1) Traer line item (SIN intentar associations acá)
    const lineItem = await hubspotClient.crm.lineItems.basicApi.getById(String(lineItemId), [
      'hs_object_id',
      'name',
      'facturar_ahora',
      // ⚠️ acá tenías "invoice_id" pero tu sistema de evidencia usa "of_invoice_id" en otros lados.
      // Dejo ambos por compatibilidad: si uno existe, ya está facturado.
      'invoice_id',
      'of_invoice_id',
      'cantidad_de_facturaciones_urgentes',
    ]);

    const lineItemProps = lineItem.properties || {};

    console.log(`Line Item: ${lineItemProps.name || lineItemId}`);
    console.log('[urgent-lineitem] props:', JSON.stringify(lineItemProps, null, 2));

    // 2) Validar flag
    if (!parseBool(lineItemProps.facturar_ahora)) {
      console.log('⚠️ facturar_ahora no está en true, ignorando');
      return { skipped: true, reason: 'facturar_ahora_false' };
    }

    // 3) Idempotencia: ya tiene factura?
    const existingInvoiceId = lineItemProps.of_invoice_id || lineItemProps.invoice_id;
    if (existingInvoiceId) {
      console.log(`⚠️ Line Item ya tiene factura: ${existingInvoiceId}, ignorando`);
      return { skipped: true, reason: 'already_invoiced', invoiceId: existingInvoiceId };
    }

    // 4) Resolver dealId por associations v4
    const dealId = await getDealIdForLineItem(lineItemId);

    if (!dealId) {
      console.error('❌ Line Item no tiene deal asociado (según associations v4)');
      throw new Error('Line item no tiene deal asociado');
    }

    console.log(`Deal asociado (v4): ${dealId}`);

    // 5) Obtener deal completo con line items
    const { deal, lineItems } = await getDealWithLineItems(dealId);

    // 6) Buscar el line item específico
    const targetLineItem = lineItems.find(li => String(li.id) === String(lineItemId));
    if (!targetLineItem) {
      console.error(`❌ Line Item ${lineItemId} no encontrado en el deal ${dealId}`);
      throw new Error('Line item no encontrado en el deal');
    }

    console.log('✅ Line Item encontrado, procediendo a facturar...\n');

 // 7.a) Crear ticket primero
const { ticketId } = await createAutoBillingTicket(deal, targetLineItem, getTodayYMD());
console.log(`✅ Ticket creado: ${ticketId}`);

// 7.b) Crear factura
const invoiceResult = await createAutoInvoiceFromLineItem(deal, targetLineItem, getTodayYMD());

if (!invoiceResult || !invoiceResult.invoiceId) {
  console.error('❌ No se pudo crear la factura');
  throw new Error('Error al crear factura');
}

console.log(`✅ Factura creada: ${invoiceResult.invoiceId}`);

// 7.c) Asociar factura al ticket (prop custom)
if (ticketId) {
  await updateTicket(ticketId, { of_invoice_id: invoiceResult.invoiceId });
  console.log('✅ Ticket actualizado con invoice ID');

  // ✅ 7.d) Mover ticket a READY
  const readyStage = process.env.BILLING_TICKET_STAGE_READY;
  const pipelineId = process.env.BILLING_TICKET_PIPELINE_ID;

  if (readyStage) {
    const stageProps = {
      hs_pipeline_stage: readyStage,
      ...(pipelineId ? { hs_pipeline: pipelineId } : {}),
    };
    await hubspotClient.crm.tickets.basicApi.update(String(ticketId), {
      properties: stageProps,
    });
    console.log(`✅ Ticket movido a READY (${readyStage})`);
  }
}

    // 8) Evidencia
    await updateUrgentBillingEvidence(lineItemId, lineItemProps);

    // 9) Reset flag
    await hubspotClient.crm.lineItems.basicApi.update(String(lineItemId), {
      properties: { facturar_ahora: 'false' },
    });
    console.log('✅ Flag facturar_ahora reseteado a false');

    console.log('\n🎉 Facturación urgente completada exitosamente');

    return {
      success: true,
      invoiceId: invoiceResult.invoiceId,
      lineItemId: String(lineItemId),
      dealId: String(dealId),
    };
  } catch (error) {
    
    console.error('\n❌ Error en facturación urgente de Line Item:', error.message);
    console.error(error.stack);
 
  // ✅ Guardar error para debug + alertas
  try {
    await hubspotClient.crm.lineItems.basicApi.update(String(lineItemId), {
      properties: {
        of_billing_error: String(error?.message || 'unknown_error').slice(0, 250),
        of_billing_error_at: String(getTodayMillis()),
      },
    });
    console.log('⚠️ Guardado of_billing_error en Line Item (sin resetear facturar_ahora)');
  } catch (e) {
    console.error('❌ No se pudo guardar of_billing_error:', e.message);
  }

  throw error;
}
}

/**
 * Procesa la facturación urgente de un Ticket.
 * (Tu implementación actual — funciona bien — la dejo igual)
 */
export async function processUrgentTicket(ticketId) {
  console.log('\n🔥 === FACTURACIÓN URGENTE TICKET ===');
  console.log(`Ticket ID: ${ticketId}`);

  try {
    const ticket = await hubspotClient.crm.tickets.basicApi.getById(ticketId, [
      'subject',
      'facturar_ahora',
      'of_invoice_id',
    ]);

    const ticketProps = ticket.properties || {};
    console.log(`Ticket: ${ticketProps.subject || ticketId}`);
    console.log('Props:', JSON.stringify(ticketProps, null, 2));

    const facturarAhora = parseBool(ticketProps.facturar_ahora);
    if (!facturarAhora) {
      console.log('⚠️ facturar_ahora no está en true, ignorando');
      return { skipped: true, reason: 'facturar_ahora_false' };
    }

    if (ticketProps.of_invoice_id) {
      console.log(`⚠️ Ticket ya tiene factura: ${ticketProps.of_invoice_id}, ignorando`);
      return { skipped: true, reason: 'already_invoiced', invoiceId: ticketProps.of_invoice_id };
    }

    console.log('✅ Ticket válido, procediendo a facturar...\n');

    const invoiceResult = await createInvoiceFromTicket(ticket);

    if (!invoiceResult || !invoiceResult.invoiceId) {
      console.error('❌ No se pudo crear la factura del ticket');
      throw new Error('Error al crear factura de ticket');
    }

    console.log(`✅ Factura creada: ${invoiceResult.invoiceId}`);

    // Mover ticket a READY (flujo manual)
    const readyStage = process.env.BILLING_TICKET_STAGE_READY;
    const pipelineId = process.env.BILLING_TICKET_PIPELINE_ID;
    if (readyStage) {
      await hubspotClient.crm.tickets.basicApi.update(String(ticketId), {
        properties: {
          hs_pipeline_stage: readyStage,
          ...(pipelineId ? { hs_pipeline: pipelineId } : {}),
        },
      });
      console.log(`✅ Ticket movido a READY (${readyStage})`);
    }

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

    // ✅ Guardar error para debug + alertas (NO resetear facturar_ahora)
    try {
      await hubspotClient.crm.tickets.basicApi.update(ticketId, {
        properties: {
          of_billing_error: String(error?.message || 'unknown_error').slice(0, 250),
          of_billing_error_at: String(getTodayMillis()),
        },
      });
      console.log('⚠️ Guardado of_billing_error en Ticket (sin resetear facturar_ahora)');
    } catch (e) {
      console.error('❌ No se pudo guardar of_billing_error:', e.message);
    }

    throw error;
  }
}
