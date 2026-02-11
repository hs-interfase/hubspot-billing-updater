// src/services/urgentBillingService.js
import { hubspotClient, getDealWithLineItems } from '../hubspotClient.js';
import { createInvoiceFromTicket } from './invoiceService.js';
import { getTodayYMD, getTodayMillis, toHubSpotDateOnly, parseLocalDate, formatDateISO } from '../utils/dateUtils.js';
import { createAutoBillingTicket, updateTicket } from './tickets/ticketService.js';
import { isInvoiceIdValidForLineItem } from '../utils/invoiceValidation.js';
import { ensureLineItemKey } from '../utils/lineItemKey.js';

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

function getBillingPeriodDate(lineItemProps) {
  const next = (lineItemProps.billing_next_date || '').trim();
  if (!next) return null;

  const d = parseLocalDate(next);
  if (!d) return null;

  return formatDateISO(d); // YYYY-MM-DD
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
      'line_item_key',
      'invoice_key',
      'invoice_id',
      'cantidad_de_facturaciones_urgentes',
      // ✅ Incluir campos de fecha
      'hs_recurring_billing_start_date',
      'recurringbillingstartdate',
      'billing_last_period',
      'last_ticketed_date',
      'billing_next_date',
      'billing_anchor_date',
      'billing_last_billed_date',
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
 let billingPeriodDate = getBillingPeriodDate(lineItemProps);
const today = getTodayYMD();

// 🔥 Fallback para pago único urgente
if (!billingPeriodDate) {
  const startDate = (lineItemProps.hs_recurring_billing_start_date || '').trim();

  if (startDate) {
    billingPeriodDate = startDate;
    console.log('⚠️ Usando start_date como período (pago único)');
  } else {
    billingPeriodDate = today;
    console.log('⚠️ Sin next ni start → usando today como período');
  }
}

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

await hubspotClient.crm.lineItems.basicApi.update(String(lineItemId), {
  properties: {
    of_billing_error: msg,
    facturar_ahora: 'false',
  },
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
if (!targetLineItem) throw new Error('Line item no encontrado en el deal');

let lik = (targetLineItem.properties?.line_item_key || '').trim();

// ✅ Si no vino en targetLineItem, probá del getById inicial (si lo pediste)
if (!lik) lik = (lineItemProps.line_item_key || '').trim();

if (!lik) {
  console.warn('[urgent-lineitem] line_item_key vacío; generando con ensureLineItemKey...');

  const { key, shouldUpdate } = ensureLineItemKey({
    dealId: String(dealId),
    lineItem: targetLineItem,
  });

  lik = (key || '').trim();

  if (!lik) {
    throw new Error('Urgent billing: ensureLineItemKey devolvió key vacía');
  }

  if (shouldUpdate) {
    // Persistir en HubSpot (esto es lo que te faltaba)
    await hubspotClient.crm.lineItems.basicApi.update(String(lineItemId), {
      properties: { line_item_key: lik },
    });
    console.log('[urgent-lineitem] ✅ line_item_key seteada en HubSpot:', lik);
  }

  // Inyectar en memoria para el resto del flujo
  targetLineItem.properties = { ...(targetLineItem.properties || {}), line_item_key: lik };
  targetLineItem.line_item_key = lik;
  lineItemProps.line_item_key = lik; // opcional (solo para logs/consistencia local)
}

if (!lik) throw new Error('Urgent billing: line_item_key sigue vacío (guardrail)');

targetLineItem.line_item_key = lik;

console.log('[urgent-lineitem] ✅ usando line_item_key:', lik);
console.log('✅ Line Item encontrado, procediendo a facturar...\n');


    // ✅ 7.a) Crear/reutilizar ticket con billingPeriodDate (NOT today)
    const { ticketId, created } = await createAutoBillingTicket(
      deal, 
      targetLineItem, 
      billingPeriodDate  // ✅ CRITICAL: Use period date
    );
await hubspotClient.crm.lineItems.basicApi.update(String(lineItemId), {
  properties: {
    last_ticketed_date: billingPeriodDate || today,
  },
});

    console.log(`\n✅ Ticket ${created ? 'creado' : 'reutilizado'}: ${ticketId}`);
    console.log(`   ticketKey: ${dealId}::LI:${lineItemId}::${billingPeriodDate}`);

    // ✅ 7.b) Marcar ticket como urgente
    if (ticketId) {
      await updateTicket(ticketId, {
        of_facturacion_urgente: 'true',
        of_fecha_de_facturacion: today,
        fecha_resolucion_esperada : today,
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
    
let invoiceIdFinal = null;
// ✅ 7.c) Si el ticket ya creó una factura, NO crear otra automática
let existingTicketInvoiceId = null;

if (ticketId) {
  const ticketReload = await hubspotClient.crm.tickets.basicApi.getById(String(ticketId), ['of_invoice_id']);
  existingTicketInvoiceId = (ticketReload?.properties?.of_invoice_id || '').trim() || null;
}

if (existingTicketInvoiceId) {
  console.log(`\n✅ Factura ya creada desde ticket: ${existingTicketInvoiceId} (skip auto-invoice)`);
  invoiceIdFinal = existingTicketInvoiceId;
} else {
  const invoiceResult = await createAutoInvoiceFromLineItem(
    deal,
    targetLineItem,
    billingPeriodDate,
    today
  );
  console.log(`\n✅ Factura creada: ${invoiceResult.invoiceId}`);
  invoiceIdFinal = invoiceResult.invoiceId;
  await hubspotClient.crm.lineItems.basicApi.update(String(lineItemId), {
  properties: {
    billing_last_period: billingPeriodDate,
  },
});
}


// ✅ 7.d) Asegurar ticket actualizado (si hace falta)
if (ticketId && invoiceIdFinal) {
  await updateTicket(ticketId, { of_invoice_id: invoiceIdFinal });
  console.log('✅ Ticket actualizado con invoice ID');
}

    // 8) Evidencia
 await updateUrgentBillingEvidence(lineItemId, lineItemProps);

    console.log('\n🎉 Facturación urgente completada exitosamente');

    return {
      success: true,
      invoiceId: invoiceIdFinal,
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