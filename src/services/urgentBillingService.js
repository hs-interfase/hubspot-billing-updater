// src/services/urgentBillingService.js

import { hubspotClient, getDealWithLineItems } from '../hubspotClient.js';
import { createInvoiceFromTicket } from './invoiceService.js';
import { getTodayYMD, getTodayMillis, toHubSpotDateOnly, parseLocalDate, formatDateISO } from '../utils/dateUtils.js';
import { createAutoBillingTicket, updateTicket } from './tickets/ticketService.js';
import { isInvoiceIdValidForLineItem } from '../utils/invoiceValidation.js';
import { ensureLineItemKey } from '../utils/lineItemKey.js';
import logger from '../../lib/logger.js';
import { reportHubSpotError } from '../utils/hubspotErrorCollector.js';

function reportIfActionable({ objectType, objectId, message, err }) {
  const status = err?.response?.status ?? err?.statusCode ?? null;
  if (status === null) { reportHubSpotError({ objectType, objectId, message }); return; }
  if (status === 429 || status >= 500) return;
  if (status >= 400 && status < 500) reportHubSpotError({ objectType, objectId, message });
}

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

  if (dealIds.length === 0) return null;

  if (dealIds.length > 1) {
    logger.warn(
      { module: 'urgentBillingService', fn: 'getDealIdForLineItem', lineItemId, dealIds },
      'Múltiples deals asociados al line item, usando el primero'
    );
  }

  return dealIds[0];
}

function getBillingPeriodDate(lineItemProps) {
  const next = (lineItemProps.billing_next_date || '').trim();
  if (!next) return null;

  const d = parseLocalDate(next);
  if (!d) return null;

  return formatDateISO(d);
}

/**
 * Actualiza las propiedades de evidencia de facturación urgente en un Line Item.
 */
async function updateUrgentBillingEvidence(lineItemId, currentProps = {}) {
  try {
    const cantidadActual = parseInt(currentProps.cantidad_de_facturaciones_urgentes || '0', 10);
    const billingDateYMD = getTodayYMD();
    const midnightUTC = toHubSpotDateOnly(billingDateYMD);

    const updateProps = {
      facturado_con_urgencia: 'true',
      ultima_fecha_facturacion_urgente: midnightUTC,
      cantidad_de_facturaciones_urgentes: String(cantidadActual + 1),
    };

    await hubspotClient.crm.lineItems.basicApi.update(String(lineItemId), {
      properties: updateProps,
    });

    logger.info(
      { module: 'urgentBillingService', fn: 'updateUrgentBillingEvidence', lineItemId, cantidadTotal: cantidadActual + 1, billingDateYMD },
      'Evidencia de facturación urgente actualizada en Line Item'
    );
  } catch (err) {
    reportIfActionable({ objectType: 'line_item', objectId: String(lineItemId), message: 'Error actualizando evidencia urgente en Line Item', err });
    logger.error(
      { module: 'urgentBillingService', fn: 'updateUrgentBillingEvidence', lineItemId, err },
      'Error actualizando evidencia urgente en Line Item'
    );
    throw err;
  }
}

/**
 * Procesa la facturación urgente de un Line Item.
 * CAMBIO CRÍTICO: Usa billingPeriodDate para ticket/invoice keys, NO today.
 */
export async function processUrgentLineItem(lineItemId) {
  logger.info(
    { module: 'urgentBillingService', fn: 'processUrgentLineItem', lineItemId },
    'Inicio facturación urgente de Line Item'
  );

  let shouldResetFlag = false;

  try {
    // 1) Traer line item con fechas para calcular billingPeriodDate
    const lineItem = await hubspotClient.crm.lineItems.basicApi.getById(String(lineItemId), [
      'hs_object_id',
      'name',
      'facturar_ahora',
      'line_item_key',
      'invoice_key',
      'invoice_id',
      'cantidad_de_facturaciones_urgentes',
      'hs_recurring_billing_start_date',
      'recurringbillingstartdate',
      'last_billing_period',
      'last_ticketed_date',
      'billing_next_date',
      'billing_anchor_date',
      'billing_last_billed_date',
    ]);

    const lineItemProps = lineItem.properties || {};

    // 2) Validar flag
    if (!parseBool(lineItemProps.facturar_ahora)) {
      logger.info(
        { module: 'urgentBillingService', fn: 'processUrgentLineItem', lineItemId },
        'facturar_ahora no está en true, ignorando'
      );
      return { skipped: true, reason: 'facturar_ahora_false' };
    }

    shouldResetFlag = true;

    // 3) Calcular billingPeriodDate (NO usar today para keys)
    let billingPeriodDate = getBillingPeriodDate(lineItemProps);
    const today = getTodayYMD();

    // Fallback para pago único urgente
    if (!billingPeriodDate) {
      const startDate = (lineItemProps.hs_recurring_billing_start_date || '').trim();
      if (startDate) {
        billingPeriodDate = startDate;
        logger.info(
          { module: 'urgentBillingService', fn: 'processUrgentLineItem', lineItemId, billingPeriodDate },
          'Usando start_date como período (pago único)'
        );
      } else {
        billingPeriodDate = today;
        logger.info(
          { module: 'urgentBillingService', fn: 'processUrgentLineItem', lineItemId, billingPeriodDate },
          'Sin next ni start, usando today como período'
        );
      }
    }

    logger.debug(
      { module: 'urgentBillingService', fn: 'processUrgentLineItem', lineItemId, billingPeriodDate, today },
      'Fechas de facturación urgente'
    );

    if (!billingPeriodDate) {
      const msg =
        'No se pudo facturar porque falta la fecha de facturación. ' +
        'Definir la fecha de facturación correspondiente en el ítem y volver a ejecutar "Facturar ahora".';

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
      logger.error(
        { module: 'urgentBillingService', fn: 'processUrgentLineItem', lineItemId },
        'Line Item no tiene deal asociado'
      );
      throw new Error('Line item no tiene deal asociado');
    }

    logger.info(
      { module: 'urgentBillingService', fn: 'processUrgentLineItem', lineItemId, dealId, billingPeriodDate },
      'Deal asociado encontrado'
    );

// 5) Guardar invoice existente para validar después de tener el lik
const existingInvoiceId = lineItemProps.invoice_id;

// 6) Obtener deal completo
const { deal, lineItems } = await getDealWithLineItems(dealId);
const targetLineItem = lineItems.find(li => String(li.id) === String(lineItemId));
if (!targetLineItem) throw new Error('Line item no encontrado en el deal');

let lik = (targetLineItem.properties?.line_item_key || '').trim();
if (!lik) lik = (lineItemProps.line_item_key || '').trim();

  if (!lik) {
  logger.warn(
    { module: 'urgentBillingService', fn: 'processUrgentLineItem', lineItemId },
    'line_item_key vacío, generando con ensureLineItemKey'
  );

  const { key, shouldUpdate } = ensureLineItemKey({
    dealId: String(dealId),
    lineItem: targetLineItem,
  });

  lik = (key || '').trim();

  if (!lik) {
    throw new Error('Urgent billing: ensureLineItemKey devolvió key vacía');
  }

  if (shouldUpdate) {
    await hubspotClient.crm.lineItems.basicApi.update(String(lineItemId), {
      properties: { line_item_key: lik },
    });
    logger.info(
      { module: 'urgentBillingService', fn: 'processUrgentLineItem', lineItemId, lik },
      'line_item_key seteada en HubSpot'
    );
  }

  targetLineItem.properties = { ...(targetLineItem.properties || {}), line_item_key: lik };
  targetLineItem.line_item_key = lik;
  lineItemProps.line_item_key = lik;
}


if (!lik) throw new Error('Urgent billing: line_item_key sigue vacío (guardrail)');

targetLineItem.line_item_key = lik;

// 6b) Idempotencia — ahora que tenemos lik, podemos validar correctamente
if (existingInvoiceId) {
  const validation = await isInvoiceIdValidForLineItem({
    dealId,
    lik,                 // ← correcto
    invoiceId: existingInvoiceId,
    billDateYMD: billingPeriodDate,
  });

  if (validation.valid) {
    logger.info(
      { module: 'urgentBillingService', fn: 'processUrgentLineItem', lineItemId, invoiceId: existingInvoiceId },
      'Line Item ya tiene factura válida, saltando'
    );
    return { skipped: true, reason: 'already_invoiced', invoiceId: existingInvoiceId };
  }

  logger.warn(
    { module: 'urgentBillingService', fn: 'processUrgentLineItem', lineItemId, invoiceId: existingInvoiceId },
    'invoice_id inválido, limpiando'
  );
  try {
    await hubspotClient.crm.lineItems.basicApi.update(String(lineItemId), {
      properties: { invoice_id: '', invoice_key: '' },
    });
    logger.info(
      { module: 'urgentBillingService', fn: 'processUrgentLineItem', lineItemId },
      'Line Item limpiado de invoice_id inválido'
    );
  } catch (err) {
    reportIfActionable({ objectType: 'line_item', objectId: String(lineItemId), message: 'Error limpiando invoice_id inválido en line item', err });
    logger.warn(
      { module: 'urgentBillingService', fn: 'processUrgentLineItem', lineItemId, err },
      'Error limpiando invoice_id inválido'
    );
  }
}

logger.info(
  { module: 'urgentBillingService', fn: 'processUrgentLineItem', lineItemId, dealId, lik },
  'Procediendo a facturar'
);

    // 7.a) Crear/reutilizar ticket con billingPeriodDate
    const { ticketId, created } = await createAutoBillingTicket(
      deal,
      targetLineItem,
      billingPeriodDate
    );

    await hubspotClient.crm.lineItems.basicApi.update(String(lineItemId), {
      properties: {
        last_ticketed_date: billingPeriodDate || today,
        last_billing_period: billingPeriodDate,
      },
    });

    logger.info(
      { module: 'urgentBillingService', fn: 'processUrgentLineItem', lineItemId, ticketId, created },
      'Ticket creado/reutilizado'
    );

    // 7.b) Marcar ticket como urgente
    if (ticketId) {
      await updateTicket(ticketId, {
        of_facturacion_urgente: 'true',
        of_fecha_de_facturacion: today,
        fecha_resolucion_esperada: today,
      });

      // Mover a READY
      const readyStage = process.env.BILLING_TICKET_STAGE_READY;
      const pipelineId = process.env.BILLING_TICKET_PIPELINE_ID;
      if (readyStage) {
        try {
          await hubspotClient.crm.tickets.basicApi.update(String(ticketId), {
            properties: {
              hs_pipeline_stage: readyStage,
              ...(pipelineId ? { hs_pipeline: pipelineId } : {}),
            },
          });
          logger.info(
            { module: 'urgentBillingService', fn: 'processUrgentLineItem', ticketId, readyStage },
            'Ticket movido a READY'
          );
        } catch (err) {
          reportIfActionable({ objectType: 'ticket', objectId: String(ticketId), message: 'Error moviendo ticket a READY (urgent line item)', err });
          throw err;
        }
      }
    }

    // 7.c) Si el ticket ya creó una factura, NO crear otra
    let invoiceIdFinal = null;
    let existingTicketInvoiceId = null;

    if (ticketId) {
      const ticketReload = await hubspotClient.crm.tickets.basicApi.getById(String(ticketId), ['of_invoice_id']);
      existingTicketInvoiceId = (ticketReload?.properties?.of_invoice_id || '').trim() || null;
    }

    if (existingTicketInvoiceId) {
      logger.info(
        { module: 'urgentBillingService', fn: 'processUrgentLineItem', ticketId, invoiceId: existingTicketInvoiceId },
        'Factura ya creada desde ticket, omitiendo auto-invoice'
      );
      invoiceIdFinal = existingTicketInvoiceId;
    } else {
      const invoiceResult = await createAutoInvoiceFromLineItem(
        deal,
        targetLineItem,
        billingPeriodDate,
        today
      );
      logger.info(
        { module: 'urgentBillingService', fn: 'processUrgentLineItem', lineItemId, invoiceId: invoiceResult.invoiceId },
        'Factura creada'
      );
      invoiceIdFinal = invoiceResult.invoiceId;
      await hubspotClient.crm.lineItems.basicApi.update(String(lineItemId), {
        properties: { last_billing_period: billingPeriodDate },
      });
    }

    // 7.d) Asegurar ticket actualizado con invoice ID
    if (ticketId && invoiceIdFinal) {
      await updateTicket(ticketId, { of_invoice_id: invoiceIdFinal });
      logger.info(
        { module: 'urgentBillingService', fn: 'processUrgentLineItem', ticketId, invoiceId: invoiceIdFinal },
        'Ticket actualizado con invoice ID'
      );
    }

    // 8) Evidencia
    await updateUrgentBillingEvidence(lineItemId, lineItemProps);

    logger.info(
      { module: 'urgentBillingService', fn: 'processUrgentLineItem', lineItemId, dealId, ticketId, invoiceId: invoiceIdFinal, billingPeriodDate },
      'Facturación urgente de Line Item completada'
    );

    return {
      success: true,
      invoiceId: invoiceIdFinal,
      lineItemId: String(lineItemId),
      dealId: String(dealId),
      ticketId: String(ticketId),
      billingPeriodDate,
    };
  } catch (err) {
    logger.error(
      { module: 'urgentBillingService', fn: 'processUrgentLineItem', lineItemId, err },
      'Error en facturación urgente de Line Item'
    );

    try {
      await hubspotClient.crm.lineItems.basicApi.update(String(lineItemId), {
        properties: {
          of_billing_error: String(err?.message || 'unknown_error').slice(0, 250),
          of_billing_error_at: String(getTodayMillis()),
        },
      });
      logger.warn(
        { module: 'urgentBillingService', fn: 'processUrgentLineItem', lineItemId },
        'of_billing_error guardado en Line Item'
      );
    } catch (err) {
      reportIfActionable({ objectType: 'line_item', objectId: String(lineItemId), message: 'Error guardando of_billing_error en line item', err });
      logger.error(
        { module: 'urgentBillingService', fn: 'processUrgentLineItem', lineItemId, err },
        'No se pudo guardar of_billing_error'
      );
    }

    throw err;
  } finally {
    if (shouldResetFlag) {
      try {
        await hubspotClient.crm.lineItems.basicApi.update(String(lineItemId), {
          properties: { facturar_ahora: 'false' },
        });
        logger.info(
          { module: 'urgentBillingService', fn: 'processUrgentLineItem', lineItemId },
          'Flag facturar_ahora reseteado (finally)'
        );
      } catch (err) {
        reportIfActionable({ objectType: 'line_item', objectId: String(lineItemId), message: 'Error reseteando flag facturar_ahora en line item', err });
        logger.error(
          { module: 'urgentBillingService', fn: 'processUrgentLineItem', lineItemId, err },
          'Error reseteando flag facturar_ahora'
        );
      }
    }
  }
}

/**
 * Procesa la facturación urgente de un Ticket.
 */
export async function processUrgentTicket(ticketId) {
  logger.info(
    { module: 'urgentBillingService', fn: 'processUrgentTicket', ticketId },
    'Inicio facturación urgente de Ticket'
  );

  let shouldResetFlag = false;

  try {
    const ticket = await hubspotClient.crm.tickets.basicApi.getById(ticketId, [
      'subject',
      'facturar_ahora',
      'of_invoice_id',
    ]);

    const ticketProps = ticket.properties || {};

    if (!parseBool(ticketProps.facturar_ahora)) {
      logger.info(
        { module: 'urgentBillingService', fn: 'processUrgentTicket', ticketId },
        'facturar_ahora no está en true, ignorando'
      );
      return { skipped: true, reason: 'facturar_ahora_false' };
    }

    shouldResetFlag = true;

    if (ticketProps.of_invoice_id) {
      logger.info(
        { module: 'urgentBillingService', fn: 'processUrgentTicket', ticketId, invoiceId: ticketProps.of_invoice_id },
        'Ticket ya tiene factura, saltando'
      );
      return { skipped: true, reason: 'already_invoiced', invoiceId: ticketProps.of_invoice_id };
    }

    const invoiceResult = await createInvoiceFromTicket(ticket);

    if (!invoiceResult || !invoiceResult.invoiceId) {
      throw new Error('Error al crear factura de ticket');
    }

    logger.info(
      { module: 'urgentBillingService', fn: 'processUrgentTicket', ticketId, invoiceId: invoiceResult.invoiceId },
      'Factura creada desde ticket'
    );

    // Mover a READY
    const readyStage = process.env.BILLING_TICKET_STAGE_READY;
    const pipelineId = process.env.BILLING_TICKET_PIPELINE_ID;
    if (readyStage) {
      try {
        await hubspotClient.crm.tickets.basicApi.update(String(ticketId), {
          properties: {
            hs_pipeline_stage: readyStage,
            ...(pipelineId ? { hs_pipeline: pipelineId } : {}),
          },
        });
        logger.info(
          { module: 'urgentBillingService', fn: 'processUrgentTicket', ticketId, readyStage },
          'Ticket movido a READY'
        );
      } catch (err) {
        reportIfActionable({ objectType: 'ticket', objectId: String(ticketId), message: 'Error moviendo ticket a READY (urgent ticket)', err });
        throw err;
      }
    }

    logger.info(
      { module: 'urgentBillingService', fn: 'processUrgentTicket', ticketId, invoiceId: invoiceResult.invoiceId },
      'Facturación urgente de Ticket completada'
    );

    return {
      success: true,
      invoiceId: invoiceResult.invoiceId,
      ticketId,
    };
  } catch (err) {
    logger.error(
      { module: 'urgentBillingService', fn: 'processUrgentTicket', ticketId, err },
      'Error en facturación urgente de Ticket'
    );

    try {
      await hubspotClient.crm.tickets.basicApi.update(ticketId, {
        properties: {
          of_billing_error: String(err?.message || 'unknown_error').slice(0, 250),
          of_billing_error_at: String(getTodayMillis()),
        },
      });
      logger.warn(
        { module: 'urgentBillingService', fn: 'processUrgentTicket', ticketId },
        'of_billing_error guardado en Ticket'
      );
    } catch (err) {
      reportIfActionable({ objectType: 'ticket', objectId: String(ticketId), message: 'Error guardando of_billing_error en ticket', err });
      logger.error(
        { module: 'urgentBillingService', fn: 'processUrgentTicket', ticketId, err },
        'No se pudo guardar of_billing_error en Ticket'
      );
    }

    throw err;
  } finally {
    if (shouldResetFlag) {
      try {
        await hubspotClient.crm.tickets.basicApi.update(ticketId, {
          properties: { facturar_ahora: 'false' },
        });
        logger.info(
          { module: 'urgentBillingService', fn: 'processUrgentTicket', ticketId },
          'Flag facturar_ahora reseteado (finally)'
        );
      } catch (err) {
        reportIfActionable({ objectType: 'ticket', objectId: String(ticketId), message: 'Error reseteando flag facturar_ahora en ticket', err });
        logger.error(
          { module: 'urgentBillingService', fn: 'processUrgentTicket', ticketId, err },
          'Error reseteando flag facturar_ahora en Ticket'
        );
      }
    }
  }
}

/*
 * CATCHES con reportHubSpotError agregados:
 *   - updateUrgentBillingEvidence: lineItems.basicApi.update() → objectType="line_item", re-throw
 *   - processUrgentLineItem: lineItems.basicApi.update() limpieza invoice_id → objectType="line_item", NO re-throw (warn absorbe)
 *   - processUrgentLineItem: tickets.basicApi.update() mover a READY → objectType="ticket", re-throw
 *   - processUrgentLineItem catch externo: lineItems.basicApi.update() of_billing_error → objectType="line_item", NO re-throw (best-effort)
 *   - processUrgentLineItem finally: lineItems.basicApi.update() reset flag → objectType="line_item", NO re-throw (finally no puede relanzar de forma segura)
 *   - processUrgentTicket: tickets.basicApi.update() mover a READY → objectType="ticket", re-throw
 *   - processUrgentTicket catch externo: tickets.basicApi.update() of_billing_error → objectType="ticket", NO re-throw (best-effort)
 *   - processUrgentTicket finally: tickets.basicApi.update() reset flag → objectType="ticket", NO re-throw
 *
 * NO reportados:
 *   - updateTicket() → ya tiene reportIfActionable interno (ticketService.js migrado), evita doble reporte
 *   - createAutoBillingTicket() → delegado
 *   - lineItems.basicApi.update() en guard no_billing_period_date → es un update de error/cleanup, no acción de negocio
 *   - lineItems.basicApi.update() ensureLineItemKey shouldUpdate → es inicialización, no update accionable
 *   - lineItems.basicApi.update() last_ticketed_date / last_billing_period → actualizaciones de estado interno, no accionables para cliente
 *   - getDealWithLineItems / getById / isInvoiceIdValidForLineItem → lecturas
 *   - associations.v4 → excluidas
 *   - createInvoiceFromTicket / createAutoInvoiceFromLineItem → servicios delegados
 *
 * Confirmación: "No se reportan warns a HubSpot; solo errores 4xx (≠429)"
 *
 * ⚠️  BUG PREEXISTENTE (no corregido per Regla 5):
 *   `createAutoInvoiceFromLineItem` se llama en processUrgentLineItem pero no está
 *   importada ni definida en este archivo; fallará en runtime con ReferenceError.
 */