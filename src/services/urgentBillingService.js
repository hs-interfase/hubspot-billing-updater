// src/services/urgentBillingService.js

import { hubspotClient, getDealWithLineItems } from '../hubspotClient.js';
import { createAutoInvoiceFromLineItem, createInvoiceFromTicket } from './invoiceService.js';
import { getTodayYMD, getTodayMillis, toHubSpotDateOnly, parseLocalDate, formatDateISO } from '../utils/dateUtils.js';
import { createAutoBillingTicket, updateTicket } from './tickets/ticketService.js';
import { isInvoiceIdValidForLineItem } from '../utils/invoiceValidation.js';
import { determineTicketFrequency } from './snapshotService.js';


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
 * ✅ NUEVA: Calcula billingPeriodDate (nextBillingDate >= today)
 * SOURCE OF TRUTH para ticket key e invoice key.
 */
function getBillingPeriodDate(lineItemProps) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const allDates = [];
  
  // 1) Check all start date variants
  const startDate = lineItemProps.hs_recurring_billing_start_date ||
                    lineItemProps.recurringbillingstartdate || 
                    lineItemProps.fecha_inicio_de_facturacion;
  if (startDate) {
    const d = parseLocalDate(startDate);
    if (d) allDates.push(d);
  }
  
  // 2) Check fecha_2, fecha_3, ..., fecha_24
  for (let i = 2; i <= 24; i++) {
    const dateKey = `fecha_${i}`;
    const dateValue = lineItemProps[dateKey];
    if (dateValue) {
      const d = parseLocalDate(dateValue);
      if (d) allDates.push(d);
    }
  }
  
  if (allDates.length === 0) return null;
  
  // 3) Filter >= today
  const futureDates = allDates.filter(d => d >= today);
  if (futureDates.length === 0) return null;
  
  // 4) Return closest
  futureDates.sort((a, b) => a.getTime() - b.getTime());
  return formatDateISO(futureDates[0]);
}

/**
 * Actualiza las propiedades de evidencia de facturación urgente en un Line Item.
 */
async function updateUrgentBillingEvidence(lineItemId, currentProps = {}) {
  try {
    const cantidadActual = parseInt(currentProps.cantidad_de_facturaciones_urgentes || '0', 10);
    const billingDateYMD = getTodayYMD();
    const midnightUTC = toHubSpotDateOnly(billingDateYMD);

    console.log(`[debug] ultima_fecha_facturacion_urgente: billingDateYMD=${billingDateYMD}, millis=${midnightUTC}`);

    const updateProps = {
      facturado_con_urgencia: 'true',
      ultima_fecha_facturacion_urgente: midnightUTC,
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
 * ✅ UPDATED: Procesa la facturación urgente de un Line Item.
 * 
 * CAMBIO CRÍTICO: Usa billingPeriodDate para ticket/invoice keys, NO today.
 */
export async function processUrgentLineItem(lineItemId) {
  console.log('\n🔥 === FACTURACIÓN URGENTE LINE ITEM ===');
  console.log(`Line Item ID: ${lineItemId}`);

  let shouldResetFlag = false;

  try {
    // 1) Traer line item CON fechas para calcular billingPeriodDate
    const lineItem = await hubspotClient.crm.lineItems.basicApi.getById(String(lineItemId), [
      'hs_object_id',
      'name',
      'facturar_ahora',
      'invoice_key',
      'invoice_id',
      'cantidad_de_facturaciones_urgentes',
      // ✅ Incluir campos de fecha
      'hs_recurring_billing_start_date',
      'recurringbillingstartdate',
      'fecha_inicio_de_facturacion',
      'fecha_2', 'fecha_3', 'fecha_4', 'fecha_5', 'fecha_6',
      'fecha_7', 'fecha_8', 'fecha_9', 'fecha_10', 'fecha_11',
      'fecha_12', 'fecha_13', 'fecha_14', 'fecha_15', 'fecha_16',
      'fecha_17', 'fecha_18', 'fecha_19', 'fecha_20', 'fecha_21',
      'fecha_22', 'fecha_23', 'fecha_24',
    ]);

    const lineItemProps = lineItem.properties || {};
    
    console.log(`Line Item: ${lineItemProps.name || lineItemId}`);

    // 2) Validar flag
    if (!parseBool(lineItemProps.facturar_ahora)) {
      console.log('⚠️ facturar_ahora no está en true, ignorando');
      return { skipped: true, reason: 'facturar_ahora_false' };
    }

    shouldResetFlag = true; // ✅ MUST reset in finally

    // ✅ 3) Calcular billingPeriodDate (NO usar today para keys)
    const billingPeriodDate = getBillingPeriodDate(lineItemProps);
    const today = getTodayYMD();

    console.log('\n🔑 === BILLING DATES ===');
    console.log(`   billingPeriodDate: ${billingPeriodDate || 'NULL'}`);
    console.log(`   today: ${today}`);
    console.log(`   ⚠️  ticketKey usa: ${billingPeriodDate || 'N/A'} (NOT today)`);
    console.log(`   ⚠️  invoiceKey usa: ${billingPeriodDate || 'N/A'} (NOT today)`);

if (!billingPeriodDate) {
  console.error('❌ No billing period date found');

  const msg =
    'No se pudo facturar porque falta la fecha de facturación. ' +
    'Definir la fecha de facturación correspondiente en el ítem y volver a ejecutar “Facturar ahora”.';

  await updateLineItem(lineItem.id, {
    of_billing_error: msg,
    facturar_ahora: 'false',
  });

  return { skipped: true, reason: 'no_billing_period_date' };
}

    // 4) Resolver dealId
    const dealId = await getDealIdForLineItem(lineItemId);
    if (!dealId) {
      console.error('❌ Line Item no tiene deal asociado');
      throw new Error('Line item no tiene deal asociado');
    }
    console.log(`Deal asociado: ${dealId}`);

    // 5) Idempotencia validation
    const existingInvoiceId = lineItemProps.invoice_id;
    if (existingInvoiceId) {
      const validation = await isInvoiceIdValidForLineItem({
        dealId,
        lineItemId,
        invoiceId: existingInvoiceId,
        billDateYMD: billingPeriodDate  // ✅ Use period date
      });

      if (validation.valid) {
        console.log(`✓ Line Item ya tiene factura válida: ${existingInvoiceId}`);
        return { skipped: true, reason: 'already_invoiced', invoiceId: existingInvoiceId };
      }

      console.warn(`[urgent-lineitem] ⚠️ invoice_id inválido, limpiando...`);
      try {
        await hubspotClient.crm.lineItems.basicApi.update(String(lineItemId), {
          properties: { invoice_id: '', of_invoice_id: '', invoice_key: '' },
        });
        console.log(`✓ Line Item limpiado`);
      } catch (cleanErr) {
        console.error(`⚠️ Error limpiando:`, cleanErr?.message);
      }
    }

    // 6) Obtener deal completo
    const { deal, lineItems } = await getDealWithLineItems(dealId);
    const targetLineItem = lineItems.find(li => String(li.id) === String(lineItemId));
    if (!targetLineItem) {
      throw new Error('Line item no encontrado en el deal');
    }

    console.log('✅ Line Item encontrado, procediendo a facturar...\n');

    // ✅ 7.a) Crear/reutilizar ticket con billingPeriodDate (NOT today)
    const { ticketId, created } = await createAutoBillingTicket(
      deal, 
      targetLineItem, 
      billingPeriodDate  // ✅ CRITICAL: Use period date
    );
    
    console.log(`\n✅ Ticket ${created ? 'creado' : 'reutilizado'}: ${ticketId}`);
    console.log(`   ticketKey: ${dealId}::LI:${lineItemId}::${billingPeriodDate}`);

    // ✅ 7.b) Marcar ticket como urgente
    if (ticketId) {
      await updateTicket(ticketId, {
        of_facturacion_urgente: 'true',
        of_fecha_facturacion: today,
        fecha_esperada_de_facturacion : today,
      });
      console.log(`✅ Ticket marcado como urgente`);

      // Mover a READY
      const readyStage = process.env.BILLING_TICKET_STAGE_READY;
      const pipelineId = process.env.BILLING_TICKET_PIPELINE_ID;
      if (readyStage) {
        await hubspotClient.crm.tickets.basicApi.update(String(ticketId), {
          properties: {
            hs_pipeline_stage: readyStage,
            ...(pipelineId ? { hs_pipeline: pipelineId } : {}),
          },
        });
        console.log(`✅ Ticket movido a READY`);
      }
    }

// 7.c) Crear factura con billingPeriodDate para invoiceKey, today para hs_invoice_date
const invoiceResult = await createAutoInvoiceFromLineItem(
  deal, 
  targetLineItem, 
  billingPeriodDate,  // ✅ For invoiceKey
  today  // ✅ For hs_invoice_date
);
    console.log(`\n✅ Factura creada: ${invoiceResult.invoiceId}`);

    // 7.d) Asociar factura al ticket
    if (ticketId) {
      await updateTicket(ticketId, { of_invoice_id: invoiceResult.invoiceId });
      console.log('✅ Ticket actualizado con invoice ID');
    }

    // 8) Evidencia
    await updateUrgentBillingEvidence(lineItemId, lineItemProps);

    console.log('\n🎉 Facturación urgente completada exitosamente');

    return {
      success: true,
      invoiceId: invoiceResult.invoiceId,
      lineItemId: String(lineItemId),
      dealId: String(dealId),
      ticketId: String(ticketId),
      billingPeriodDate,
    };
  } catch (error) {
    console.error('\n❌ Error en facturación urgente:', error.message);
    console.error(error.stack);
 
    try {
      await hubspotClient.crm.lineItems.basicApi.update(String(lineItemId), {
        properties: {
          of_billing_error: String(error?.message || 'unknown_error').slice(0, 250),
          of_billing_error_at: String(getTodayMillis()),
        },
      });
      console.log('⚠️ Guardado of_billing_error');
    } catch (e) {
      console.error('❌ No se pudo guardar of_billing_error:', e.message);
    }

    throw error;
  } finally {
    // ✅ ALWAYS reset flag (even on errors)
    if (shouldResetFlag) {
      try {
        await hubspotClient.crm.lineItems.basicApi.update(String(lineItemId), {
          properties: { facturar_ahora: 'false' },
        });
        console.log('✅ Flag facturar_ahora reseteado (finally)');
      } catch (resetError) {
        console.error('❌ Error reseteando flag:', resetError.message);
      }
    }
  }
}

/**
 * Procesa la facturación urgente de un Ticket.
 */
export async function processUrgentTicket(ticketId) {
  console.log('\n🔥 === FACTURACIÓN URGENTE TICKET ===');
  console.log(`Ticket ID: ${ticketId}`);

  let shouldResetFlag = false;

  try {
    const ticket = await hubspotClient.crm.tickets.basicApi.getById(ticketId, [
      'subject',
      'facturar_ahora',
      'of_invoice_id',
    ]);

    const ticketProps = ticket.properties || {};
    console.log(`Ticket: ${ticketProps.subject || ticketId}`);

    if (!parseBool(ticketProps.facturar_ahora)) {
      console.log('⚠️ facturar_ahora no está en true, ignorando');
      return { skipped: true, reason: 'facturar_ahora_false' };
    }

    shouldResetFlag = true;

    if (ticketProps.of_invoice_id) {
      console.log(`⚠️ Ticket ya tiene factura: ${ticketProps.of_invoice_id}`);
      return { skipped: true, reason: 'already_invoiced', invoiceId: ticketProps.of_invoice_id };
    }

    console.log('✅ Ticket válido, procediendo a facturar...\n');

    const invoiceResult = await createInvoiceFromTicket(ticket);

    if (!invoiceResult || !invoiceResult.invoiceId) {
      throw new Error('Error al crear factura de ticket');
    }

    console.log(`✅ Factura creada: ${invoiceResult.invoiceId}`);

    // Mover a READY
    const readyStage = process.env.BILLING_TICKET_STAGE_READY;
    const pipelineId = process.env.BILLING_TICKET_PIPELINE_ID;
    if (readyStage) {
      await hubspotClient.crm.tickets.basicApi.update(String(ticketId), {
        properties: {
          hs_pipeline_stage: readyStage,
          ...(pipelineId ? { hs_pipeline: pipelineId } : {}),
        },
      });
      console.log(`✅ Ticket movido a READY`);
    }

    console.log('\n🎉 Facturación urgente de ticket completada');

    return {
      success: true,
      invoiceId: invoiceResult.invoiceId,
      ticketId,
    };
  } catch (error) {
    console.error('\n❌ Error en facturación urgente de Ticket:', error.message);
    console.error(error.stack);

    try {
      await hubspotClient.crm.tickets.basicApi.update(ticketId, {
        properties: {
          of_billing_error: String(error?.message || 'unknown_error').slice(0, 250),
          of_billing_error_at: String(getTodayMillis()),
        },
      });
      console.log('⚠️ Guardado of_billing_error en Ticket');
    } catch (e) {
      console.error('❌ No se pudo guardar of_billing_error:', e.message);
    }

    throw error;
  } finally {
    // ✅ ALWAYS reset flag
    if (shouldResetFlag) {
      try {
        await hubspotClient.crm.tickets.basicApi.update(ticketId, {
          properties: { facturar_ahora: 'false' },
        });
        console.log('✅ Flag facturar_ahora reseteado (finally)');
      } catch (resetError) {
        console.error('❌ Error reseteando flag:', resetError.message);
      }
    }
  }
}