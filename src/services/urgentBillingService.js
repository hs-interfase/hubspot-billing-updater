// src/services/urgentBillingService.js

import { hubspotClient, getDealWithLineItems } from '../hubspotClient.js';
import { createAutoInvoiceFromLineItem, createInvoiceFromTicket } from './invoiceService.js';
import { getTodayYMD, getTodayMillis, toHubSpotDateOnly, parseLocalDate, formatDateISO } from '../utils/dateUtils.js';
import { createAutoBillingTicket, updateTicket } from './tickets/ticketService.js';
import { isInvoiceIdValidForLineItem } from '../utils/invoiceValidation.js';

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
 * ✅ CRITICAL: Calcula billingPeriodDate (nextBillingDate >= today)
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
 * ✅ FACTURACIÓN URGENTE DE LINE ITEM
 * 
 * REGLA CRÍTICA: Usa billingPeriodDate (nextBillingDate) para ticket key e invoice key,
 * NO usa TODAY. Esto evita duplicar tickets/invoices para la misma ocurrencia.
 */
export async function processUrgentLineItem(lineItemId) {
  console.log('\n🔥 === FACTURACIÓN URGENTE LINE ITEM ===');
  console.log(`Line Item ID: ${lineItemId}`);

  let shouldResetFlag = false;

  try {
    // 1) Traer line item CON TODAS las fechas para calcular billingPeriodDate
    const lineItem = await hubspotClient.crm.lineItems.basicApi.getById(String(lineItemId), [
      'hs_object_id',
      'name',
      'facturar_ahora',
      'invoice_key',
      'invoice_id',
      'cantidad_de_facturaciones_urgentes',
      // ✅ CRITICAL: Include all date fields for getBillingPeriodDate
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

    shouldResetFlag = true; // ✅ Flag is true, we MUST reset it in finally

    // ✅ 3) Calculate billingPeriodDate (SOURCE OF TRUTH for keys)
    const billingPeriodDate = getBillingPeriodDate(lineItemProps);
    const today = getTodayYMD();

    console.log('\n🔑 === BILLING PERIOD CALCULATION ===');
    console.log(`   billingPeriodDate: ${billingPeriodDate || 'NULL'}`);
    console.log(`   today: ${today}`);
    console.log(`   ℹ️  ticketKey will use: ${billingPeriodDate || 'N/A'} (NOT today)`);
    console.log(`   ℹ️  invoiceKey will use: ${billingPeriodDate || 'N/A'} (NOT today)`);
    console.log(`   ℹ️  hs_invoice_date will use: ${today} (urgent billing date)`);

    if (!billingPeriodDate) {
      console.error('❌ No billing period date found for this line item');
      console.error('   Check: hs_recurring_billing_start_date, fecha_inicio_de_facturacion, fecha_2..24');
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
        billDateYMD: billingPeriodDate  // ✅ Use period date, NOT today
      });

      if (validation.valid) {
        console.log(`✓ Line Item ya tiene factura válida: ${existingInvoiceId}`);
        console.log(`  Expected key: ${validation.expectedKey}`);
        console.log(`  Found key:    ${validation.foundKey}`);
        return { skipped: true, reason: 'already_invoiced', invoiceId: existingInvoiceId };
      }

      console.warn(`[urgent-lineitem] ⚠️ invoice_id presente pero NO válido, limpiando...`);
      try {
        await hubspotClient.crm.lineItems.basicApi.update(String(lineItemId), {
          properties: { invoice_id: '', of_invoice_id: '', invoice_key: '' },
        });
        console.log(`✓ Line Item limpiado`);
      } catch (cleanErr) {
        console.error(`⚠️ Error limpiando line item:`, cleanErr?.message);
      }
    }

    // 6) Obtener deal completo
    const { deal, lineItems } = await getDealWithLineItems(dealId);
    const targetLineItem = lineItems.find(li => String(li.id) === String(lineItemId));
    if (!targetLineItem) {
      console.error(`❌ Line Item ${lineItemId} no encontrado en el deal ${dealId}`);
      throw new Error('Line item no encontrado en el deal');
    }

    console.log('✅ Line Item encontrado, procediendo a facturar...\n');

    // ✅ 7.a) Ensure canonical ticket with billingPeriodDate (NOT today)
    const { ticketId, created } = await createAutoBillingTicket(
      deal, 
      targetLineItem, 
      billingPeriodDate  // ✅ CRITICAL: Use period date, NOT getTodayYMD()
    );
    
    console.log(`\n✅ Ticket ${created ? 'creado' : 'reutilizado'}: ${ticketId}`);
    console.log(`   ticketKey: ${dealId}::LI:${lineItemId}::${billingPeriodDate}`);

    // ✅ 7.b) Mark ticket as urgent billing
    if (ticketId) {
      await updateTicket(ticketId, {
        of_facturacion_urgente: 'true',
        of_fecha_facturacion: today,  // When vendor ordered it
        hs_resolution_due_date: today,  // Process today
      });
      console.log(`✅ Ticket marcado como facturación urgente`);

      // Move to READY stage
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
    }

    // 7.c) Crear factura con billingPeriodDate para invoiceKey
    const invoiceResult = await createAutoInvoiceFromLineItem(
      deal, 
      targetLineItem, 
      billingPeriodDate,  // ✅ CRITICAL: Use period date for invoiceKey
      today  // ✅ Invoice date (hs_invoice_date) = today
    );

    if (!invoiceResult || !invoiceResult.invoiceId) {
      console.error('❌ No se pudo crear la factura');
      throw new Error('Error al crear factura');
    }

    console.log(`\n✅ Factura creada: ${invoiceResult.invoiceId}`);
    console.log(`   invoiceKey: ${dealId}::${lineItemId}::${billingPeriodDate}`);

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
    console.error('\n❌ Error en facturación urgente de Line Item:', error.message);
    console.error(error.stack);
 
    // Guardar error para debug
    try {
      await hubspotClient.crm.lineItems.basicApi.update(String(lineItemId), {
        properties: {
          of_billing_error: String(error?.message || 'unknown_error').slice(0, 250),
          of_billing_error_at: String(getTodayMillis()),
        },
      });
      console.log('⚠️ Guardado of_billing_error en Line Item');
    } catch (e) {
      console.error('❌ No se pudo guardar of_billing_error:', e.message);
    }

    throw error;
  } finally {
    // ✅ ALWAYS reset facturar_ahora flag, even on errors
    if (shouldResetFlag) {
      try {
        await hubspotClient.crm.lineItems.basicApi.update(String(lineItemId), {
          properties: { facturar_ahora: 'false' },
        });
        console.log('✅ Flag facturar_ahora reseteado a false (finally)');
      } catch (resetError) {
        console.error('❌ Error reseteando facturar_ahora flag:', resetError.message);
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
      'of_facturacion_urgente',
      'of_fecha_de_facturacion',
      'hs_resolution_due_date',
    ]);

    const ticketProps = ticket.properties || {};
    console.log(`Ticket: ${ticketProps.subject || ticketId}`);

    const facturarAhora = parseBool(ticketProps.facturar_ahora);
    if (!facturarAhora) {
      console.log('⚠️ facturar_ahora no está en true, ignorando');
      return { skipped: true, reason: 'facturar_ahora_false' };
    }

    shouldResetFlag = true;

    if (ticketProps.of_invoice_id) {
      console.log(`⚠️ Ticket ya tiene factura: ${ticketProps.of_invoice_id}, ignorando');
      return { skipped: true, reason: 'already_invoiced', invoiceId: ticketProps.of_invoice_id };
    }

    console.log('✅ Ticket válido, procediendo a facturar...\n');

    // Mark as urgent before invoicing
    const today = getTodayYMD();
    await updateTicket(ticketId, {
      of_facturacion_urgente: 'true',
      of_fecha_facturacion: today,
      hs_resolution_due_date: today,
    });
    console.log('✅ Ticket marcado como facturación urgente');

    const invoiceResult = await createInvoiceFromTicket(ticket);

    if (!invoiceResult || !invoiceResult.invoiceId) {
      console.error('❌ No se pudo crear la factura del ticket');
      throw new Error('Error al crear factura de ticket');
    }

    console.log(`✅ Factura creada: ${invoiceResult.invoiceId}`);

    // Mover ticket a READY
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

    console.log('\n🎉 Facturación urgente de ticket completada exitosamente');

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
    // ✅ ALWAYS reset facturar_ahora flag
    if (shouldResetFlag) {
      try {
        await hubspotClient.crm.tickets.basicApi.update(ticketId, {
          properties: { facturar_ahora: 'false' },
        });
        console.log('✅ Flag facturar_ahora reseteado a false (finally)');
      } catch (resetError) {
        console.error('❌ Error reseteando facturar_ahora flag:', resetError.message);
      }
    }
  }
}