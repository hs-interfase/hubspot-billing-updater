// src/services/urgentBillingService.js

import { hubspotClient, getDealWithLineItems } from '../hubspotClient.js';
import { createInvoiceFromTicket, createAutoInvoiceFromLineItem, REQUIRED_TICKET_PROPS } from './invoiceService.js';
import { getTodayYMD, getTodayMillis, toHubSpotDateOnly, parseLocalDate, formatDateISO } from '../utils/dateUtils.js';
import { createAutoBillingTicket, updateTicket } from './tickets/ticketService.js';
import { isInvoiceIdValidForLineItem } from '../utils/invoiceValidation.js';
import { ensureLineItemKey } from '../utils/lineItemKey.js';
import { findMirrorLineItem } from './mirrorUtils.js';
import { mirrorDealToUruguay } from '../dealMirroring.js';
import logger from '../../lib/logger.js';
import { reportHubSpotError } from '../utils/hubspotErrorCollector.js';
import { countActivePlanInvoices } from '../utils/invoiceUtils.js';
import { recalcFromTickets } from './lineItems/recalcFromTickets.js';
import { sanitizeClonedLineItem } from './lineItems/cloneSanitizerService.js';
import { refreshMensajeFacturacionParaDeal } from '../jobs/cronMensajeFacturacion.js';

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
 * Núcleo de la facturación urgente de un Line Item.
 * NO contiene guard de facturar_ahora — eso es responsabilidad del caller.
 * Puede ser llamado tanto para el line item PY (desde processUrgentLineItem)
 * como para el mirror UY (desde _propagateToMirror), sin pasar por el portero.
 */
async function _executeUrgentBillingForLineItem(lineItemId) {
  logger.info(
    { module: 'urgentBillingService', fn: '_executeUrgentBillingForLineItem', lineItemId },
    'Inicio facturación urgente de Line Item'
  );

  // Siempre resetear facturar_ahora al terminar (idempotente para el mirror que ya lo tiene en false)
  const shouldResetFlag = true;

  try {
    // 1) Traer line item con fechas para calcular billingPeriodDate
    const lineItem = await hubspotClient.crm.lineItems.basicApi.getById(String(lineItemId), [
      'hs_object_id',
      'name',
      'facturar_ahora',
      'line_item_key',
      'invoice_key',
      'invoice_id',
      'of_line_item_py_origen_id',
      'cantidad_de_facturaciones_urgentes',
      'hs_recurring_billing_start_date',
      'recurringbillingstartdate',
      'last_billing_period',
      'last_ticketed_date',
      'billing_next_date',
      'billing_anchor_date',
      'billing_last_billed_date',
      'hs_recurring_billing_number_of_payments',
    ]);
const lineItemProps = lineItem.properties || {};

    // Reset inmediato — facturar_ahora siempre termina en false, pase lo que pase
    try {
      await hubspotClient.crm.lineItems.basicApi.update(String(lineItemId), {
        properties: { facturar_ahora: 'false' },
      });
      logger.info(
        { module: 'urgentBillingService', fn: '_executeUrgentBillingForLineItem', lineItemId },
        'facturar_ahora reseteado a false (inicio)'
      );
    } catch (resetErr) {
      logger.warn(
        { module: 'urgentBillingService', fn: '_executeUrgentBillingForLineItem', lineItemId, err: resetErr },
        'No se pudo resetear facturar_ahora al inicio, continuando'
      );
    }

    // ─── GUARD DE FACTURACIÓN ACTIVA ──────────────────────────────────────────
    const dealId = await getDealIdForLineItem(lineItemId);
    if (!dealId) {
      logger.error(
        { module: 'urgentBillingService', fn: '_executeUrgentBillingForLineItem', lineItemId },
        'Line Item no tiene deal asociado'
      );
      throw new Error('Line item no tiene deal asociado');
    }

    let dealForGuard;
    try {
      dealForGuard = await hubspotClient.crm.deals.basicApi.getById(dealId, ['facturacion_activa', 'dealname']);
    } catch (err) {
      logger.error(
        { module: 'urgentBillingService', fn: '_executeUrgentBillingForLineItem', lineItemId, dealId, err },
        'Error obteniendo deal para verificar facturacion_activa'
      );
      throw err;
    }

    const dealGuardProps = dealForGuard?.properties || {};
    if (!parseBool(dealGuardProps.facturacion_activa)) {
      const dealName = (dealGuardProps.dealname || dealId).slice(0, 100);
      const msg = `Falta activar la facturación. Pase el negocio a cierre ganado. Negocio: ${dealName}.`;
      logger.info(
        { module: 'urgentBillingService', fn: '_executeUrgentBillingForLineItem', lineItemId, dealId },
        'Bloqueado: facturacion_activa del deal no está en true'
      );
      await hubspotClient.crm.lineItems.basicApi.update(String(lineItemId), {
        properties: { of_billing_error: msg, facturar_ahora: 'false' },
      });
      return { skipped: true, reason: 'facturacion_activa_false' };
    }
    // ─── FIN GUARD DE FACTURACIÓN ACTIVA ──────────────────────────────────────

    // ─── GUARD DE MIRROR UY ───────────────────────────────────────────────────
    const pyOrigenLIId = (lineItemProps.of_line_item_py_origen_id || '').trim();
    if (pyOrigenLIId) {
      logger.info(
        { module: 'urgentBillingService', fn: '_executeUrgentBillingForLineItem', lineItemId, pyOrigenLIId },
        'LI es mirror UY — sincronizando deal espejo antes de facturar'
      );
      let pyDealId;
      try {
        pyDealId = await getDealIdForLineItem(pyOrigenLIId);
      } catch (err) {
        logger.error(
          { module: 'urgentBillingService', fn: '_executeUrgentBillingForLineItem', lineItemId, pyOrigenLIId, err },
          'Error obteniendo deal PY origen para sync de mirror'
        );
      }
      if (!pyDealId) {
        const msg = 'No se pudo sincronizar el mirror: deal PY origen no encontrado. Se reintentará automáticamente.';
        logger.error(
          { module: 'urgentBillingService', fn: '_executeUrgentBillingForLineItem', lineItemId, pyOrigenLIId },
          msg
        );
        await hubspotClient.crm.lineItems.basicApi.update(String(lineItemId), {
          properties: {
            of_billing_error: msg.slice(0, 250),
            of_billing_error_at: String(getTodayMillis()),
            facturar_ahora: 'true',
          },
        });
        return { skipped: true, reason: 'mirror_py_deal_not_found' };
      }
      try {
        await mirrorDealToUruguay(pyDealId);
        logger.info(
          { module: 'urgentBillingService', fn: '_executeUrgentBillingForLineItem', lineItemId, pyDealId },
          'Deal espejo UY sincronizado correctamente'
        );
      } catch (err) {
        const msg = `No se pudo sincronizar el mirror antes de facturar: ${String(err?.message || 'unknown').slice(0, 180)}. Se reintentará automáticamente.`;
        logger.error(
          { module: 'urgentBillingService', fn: '_executeUrgentBillingForLineItem', lineItemId, pyDealId, err },
          'Error sincronizando deal espejo — abortando facturación'
        );
        await hubspotClient.crm.lineItems.basicApi.update(String(lineItemId), {
          properties: {
            of_billing_error: msg.slice(0, 250),
            of_billing_error_at: String(getTodayMillis()),
            facturar_ahora: 'true',
          },
        });
        return { skipped: true, reason: 'mirror_sync_failed' };
      }
    }
    // ─── FIN GUARD DE MIRROR UY ──────────────────────────────────────────────

    // 2) Calcular billingPeriodDate (NO usar today para keys)
    let billingPeriodDate = getBillingPeriodDate(lineItemProps);
    const today = getTodayYMD();

    if (!billingPeriodDate) {
      const startDate = (lineItemProps.hs_recurring_billing_start_date || '').trim();
      if (startDate) {
        billingPeriodDate = startDate;
        logger.info(
          { module: 'urgentBillingService', fn: '_executeUrgentBillingForLineItem', lineItemId, billingPeriodDate },
          'Usando start_date como período (pago único)'
        );
} else {
  billingPeriodDate = today;
 logger.info(
  { module: 'urgentBillingService', fn: '_executeUrgentBillingForLineItem', lineItemId, billingPeriodDate },
  'Sin next ni start, usando today como período'
);

  // Persistir para que la key sea estable en reintentos
  try {
    await hubspotClient.crm.lineItems.basicApi.update(String(lineItemId), {
      properties: { hs_recurring_billing_start_date: toHubSpotDateOnly(today) },
    });
    logger.info(
      { module: 'urgentBillingService', fn: '_executeUrgentBillingForLineItem', lineItemId, today },
      'hs_recurring_billing_start_date seteado a today (fallback urgente)'
    );
  } catch (err) {
    logger.warn(
      { module: 'urgentBillingService', fn: '_executeUrgentBillingForLineItem', lineItemId, err },
      'No se pudo setear hs_recurring_billing_start_date, continuando'
    );
    // no throw — no bloquear la facturación por esto
  }
}
    }

    logger.debug(
      { module: 'urgentBillingService', fn: '_executeUrgentBillingForLineItem', lineItemId, billingPeriodDate, today },
      'Fechas de facturación urgente'
    );

    if (!billingPeriodDate) {
      const msg =
        'No se pudo facturar porque falta la fecha de facturación. ' +
        'Definir la fecha de facturación correspondiente en el ítem y volver a ejecutar "Facturar ahora".';

      await hubspotClient.crm.lineItems.basicApi.update(String(lineItemId), {
        properties: { of_billing_error: msg, facturar_ahora: 'false' },
      });

      return { skipped: true, reason: 'no_billing_period_date' };
    }

    // 3) dealId ya resuelto al inicio (guard de facturación activa)
    logger.info(
      { module: 'urgentBillingService', fn: '_executeUrgentBillingForLineItem', lineItemId, dealId, billingPeriodDate },
      'Procediendo con deal asociado'
    );

    // 4) Guardar invoice existente para validar después de tener el lik
    const existingInvoiceId = lineItemProps.invoice_id;

    // 5) Obtener deal completo
    const { deal, lineItems } = await getDealWithLineItems(dealId);
    const targetLineItem = lineItems.find(li => String(li.id) === String(lineItemId));
    if (!targetLineItem) throw new Error('Line item no encontrado en el deal');

    let lik = (targetLineItem.properties?.line_item_key || '').trim();
    if (!lik) lik = (lineItemProps.line_item_key || '').trim();

    if (!lik) {
      logger.warn(
        { module: 'urgentBillingService', fn: '_executeUrgentBillingForLineItem', lineItemId },
        'line_item_key vacío, generando con ensureLineItemKey'
      );

      const { key, shouldUpdate } = ensureLineItemKey({
        dealId: String(dealId),
        lineItem: targetLineItem,
      });

      lik = (key || '').trim();

      if (!lik) throw new Error('Urgent billing: ensureLineItemKey devolvió key vacía');

      if (shouldUpdate) {
        await hubspotClient.crm.lineItems.basicApi.update(String(lineItemId), {
          properties: { line_item_key: lik },
        });
        logger.info(
          { module: 'urgentBillingService', fn: '_executeUrgentBillingForLineItem', lineItemId, lik },
          'line_item_key seteada en HubSpot'
        );
      }

      targetLineItem.properties = { ...(targetLineItem.properties || {}), line_item_key: lik };
      targetLineItem.line_item_key = lik;
      lineItemProps.line_item_key = lik;
    }

if (!lik) throw new Error('Urgent billing: line_item_key sigue vacío (guardrail)');
    targetLineItem.line_item_key = lik;

    // 5a) Sanitización de clones — detectar si la key pertenece a otro line item
    const sanitizeUpdates = sanitizeClonedLineItem(targetLineItem, dealId, { debug: true });
    if (sanitizeUpdates) {
      logger.info(
        { module: 'urgentBillingService', fn: '_executeUrgentBillingForLineItem', lineItemId, oldLik: lik },
        'Clone detectado: sanitizando props operativas y regenerando line_item_key'
      );

      try {
        await hubspotClient.crm.lineItems.basicApi.update(String(lineItemId), { properties: sanitizeUpdates });
        targetLineItem.properties = { ...targetLineItem.properties, ...sanitizeUpdates };
        Object.assign(lineItemProps, sanitizeUpdates);
      } catch (err) {
        reportIfActionable({ objectType: 'line_item', objectId: String(lineItemId), message: 'Error sanitizando clone en urgent billing', err });
        throw new Error(`Clone sanitize failed: ${err?.message}`);
      }

      const { key: newLik } = ensureLineItemKey({ dealId: String(dealId), lineItem: targetLineItem, forceNew: true });
      if (!newLik) throw new Error('Urgent billing: ensureLineItemKey devolvió key vacía tras sanitizar clone');

      try {
        await hubspotClient.crm.lineItems.basicApi.update(String(lineItemId), {
          properties: { line_item_key: newLik },
        });
      } catch (err) {
        reportIfActionable({ objectType: 'line_item', objectId: String(lineItemId), message: 'Error seteando nueva line_item_key tras sanitizar clone', err });
        throw new Error(`Clone rekey failed: ${err?.message}`);
      }

      lik = newLik;
      targetLineItem.properties = { ...targetLineItem.properties, line_item_key: newLik };
      targetLineItem.line_item_key = newLik;
      lineItemProps.line_item_key = newLik;

      logger.info(
        { module: 'urgentBillingService', fn: '_executeUrgentBillingForLineItem', lineItemId, newLik },
        'Clone sanitizado y rekeyed exitosamente'
      );
    }

    // 5b) Idempotencia
    if (existingInvoiceId) {
      const validation = await isInvoiceIdValidForLineItem({
        dealId,
        lik,
        invoiceId: existingInvoiceId,
        billDateYMD: billingPeriodDate,
      });

      if (validation.valid) {
        logger.info(
          { module: 'urgentBillingService', fn: '_executeUrgentBillingForLineItem', lineItemId, invoiceId: existingInvoiceId },
          'Line Item ya tiene factura válida, saltando'
        );
        return { skipped: true, reason: 'already_invoiced', invoiceId: existingInvoiceId };
      }

      logger.warn(
        { module: 'urgentBillingService', fn: '_executeUrgentBillingForLineItem', lineItemId, invoiceId: existingInvoiceId },
        'invoice_id inválido, limpiando'
      );
      try {
        await hubspotClient.crm.lineItems.basicApi.update(String(lineItemId), {
          properties: { invoice_id: '', invoice_key: '' },
        });
        logger.info(
          { module: 'urgentBillingService', fn: '_executeUrgentBillingForLineItem', lineItemId },
          'Line Item limpiado de invoice_id inválido'
        );
      } catch (err) {
        reportIfActionable({ objectType: 'line_item', objectId: String(lineItemId), message: 'Error limpiando invoice_id inválido en line item', err });
        logger.warn(
          { module: 'urgentBillingService', fn: '_executeUrgentBillingForLineItem', lineItemId, err },
          'Error limpiando invoice_id inválido'
        );
      }
    }

    // 6) GUARD plan completo (va después de resolver lik, antes de crear ticket)
    const totalPayments = Number(lineItemProps.hs_recurring_billing_number_of_payments);
    const isAutoRenew = !Number.isFinite(totalPayments) || totalPayments === 0;

    if (!isAutoRenew) {
      const activeCount = await countActivePlanInvoices(lik);
      if (activeCount !== null && activeCount >= totalPayments) {
        logger.info(
          { module: 'urgentBillingService', fn: '_executeUrgentBillingForLineItem', lineItemId, lik, activeCount, totalPayments },
          'Plan completado, no se emite factura'
        );
        return { skipped: true, reason: 'plan_completed', activeCount, totalPayments };
      }
    }

    logger.info(
      { module: 'urgentBillingService', fn: '_executeUrgentBillingForLineItem', lineItemId, dealId, lik },
      'Procediendo a facturar'
    );

    // 7.a) Crear/reutilizar ticket con billingPeriodDate
    const { ticketId, created } = await createAutoBillingTicket(deal, targetLineItem, billingPeriodDate);

    await hubspotClient.crm.lineItems.basicApi.update(String(lineItemId), {
      properties: {
        last_ticketed_date: billingPeriodDate || today,
        last_billing_period: billingPeriodDate,
      },
    });

    logger.info(
      { module: 'urgentBillingService', fn: '_executeUrgentBillingForLineItem', lineItemId, ticketId, created },
      'Ticket creado/reutilizado'
    );

    // 7.b) Marcar ticket como urgente
    if (ticketId) {
      await updateTicket(ticketId, {
        of_facturacion_urgente: 'true',
        of_fecha_de_facturacion: today,
        fecha_resolucion_esperada: today,
      });

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
            { module: 'urgentBillingService', fn: '_executeUrgentBillingForLineItem', ticketId, readyStage },
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

    let ticketReload = null;
    if (ticketId) {
      ticketReload = await hubspotClient.crm.tickets.basicApi.getById(String(ticketId), ['of_invoice_id', 'of_invoice_status']);
      existingTicketInvoiceId = (ticketReload?.properties?.of_invoice_id || '').trim() || null;
    }
    const ticketInvoiceStatus = (ticketReload?.properties?.of_invoice_status || '').trim();

    if (existingTicketInvoiceId && ticketInvoiceStatus !== 'Cancelada') {
      logger.info(
        { module: 'urgentBillingService', fn: '_executeUrgentBillingForLineItem', ticketId, invoiceId: existingTicketInvoiceId },
        'Factura ya creada desde ticket, omitiendo auto-invoice'
      );
      invoiceIdFinal = existingTicketInvoiceId;
    } else {
      const invoiceResult = await createAutoInvoiceFromLineItem(deal, targetLineItem, billingPeriodDate, today);
      logger.info(
        { module: 'urgentBillingService', fn: '_executeUrgentBillingForLineItem', lineItemId, invoiceId: invoiceResult.invoiceId },
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
        { module: 'urgentBillingService', fn: '_executeUrgentBillingForLineItem', ticketId, invoiceId: invoiceIdFinal },
        'Ticket actualizado con invoice ID'
      );
    }
 // 8) Evidencia
    await updateUrgentBillingEvidence(lineItemId, lineItemProps);

    // 9) Recalc fechas del line item desde tickets reales (post-facturación urgente)
    try {
      await recalcFromTickets({
        lineItemKey: lik,
        dealId,
        lineItemId: String(lineItemId),
        lineItemProps,
        facturacionActiva: true,
        applyUpdate: true,
      });
    } catch (recalcErr) {
      logger.warn(
        { module: 'urgentBillingService', fn: '_executeUrgentBillingForLineItem', lineItemId, lik, err: recalcErr },
        'recalcFromTickets falló post-facturación urgente, no bloquea flujo'
      );
    }

    logger.info(
      { module: 'urgentBillingService', fn: '_executeUrgentBillingForLineItem', lineItemId, dealId, ticketId, invoiceId: invoiceIdFinal, billingPeriodDate },
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
      { module: 'urgentBillingService', fn: '_executeUrgentBillingForLineItem', lineItemId, err },
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
        { module: 'urgentBillingService', fn: '_executeUrgentBillingForLineItem', lineItemId },
        'of_billing_error guardado en Line Item'
      );
    } catch (updateErr) {
      reportIfActionable({ objectType: 'line_item', objectId: String(lineItemId), message: 'Error guardando of_billing_error en line item', err: updateErr });
      logger.error(
        { module: 'urgentBillingService', fn: '_executeUrgentBillingForLineItem', lineItemId, err: updateErr },
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
          { module: 'urgentBillingService', fn: '_executeUrgentBillingForLineItem', lineItemId },
          'Flag facturar_ahora reseteado (finally)'
        );
      } catch (err) {
        reportIfActionable({ objectType: 'line_item', objectId: String(lineItemId), message: 'Error reseteando flag facturar_ahora en line item', err });
        logger.error(
          { module: 'urgentBillingService', fn: '_executeUrgentBillingForLineItem', lineItemId, err },
          'Error reseteando flag facturar_ahora'
        );
      }
    }
  }
}

/**
 * Entry point público para facturación urgente de un Line Item.
 * Contiene el guard de intención del usuario (facturar_ahora = true).
 * Después de facturar el PY, propaga al mirror UY de forma asíncrona (fire-and-forget).
 */
export async function processUrgentLineItem(lineItemId) {
  const lineItem = await hubspotClient.crm.lineItems.basicApi.getById(
    String(lineItemId),
    ['facturar_ahora', 'name', 'facturacion_automatica'] // ← agregado
  );

  const props = lineItem?.properties || {};

  if (!parseBool(props.facturar_ahora)) {
    logger.info(
      { module: 'urgentBillingService', fn: 'processUrgentLineItem', lineItemId },
      'facturar_ahora no está en true, ignorando'
    );
    return { skipped: true, reason: 'facturar_ahora_false' };
  }

  // Guard: facturar ahora no aplica a line items con facturación automática
  if (parseBool(props.facturacion_automatica)) {
    const msg =
      'Facturar ahora no está disponible para líneas con facturación automática. ' +
      'Este ítem es procesado automáticamente por el motor de facturación.';
    try {
      await hubspotClient.crm.lineItems.basicApi.update(String(lineItemId), {
        properties: { facturar_ahora: 'false', of_billing_error: msg },
      });
    } catch (updateErr) {
      logger.error(
        { module: 'urgentBillingService', fn: 'processUrgentLineItem', lineItemId, err: updateErr },
        'Error escribiendo bloqueo automated en line item'
      );
    }
    logger.info(
      { module: 'urgentBillingService', fn: 'processUrgentLineItem', lineItemId },
      'Bloqueado: facturar_ahora en line item con facturacion_automatica=true'
    );
    return { skipped: true, reason: 'automated_billing_no_urgent' };
  }

// DESPUÉS
  // ─── GUARD DE FACTURACIÓN ACTIVA (antes de calcular fechas o entrar al núcleo) ───
  const dealIdEarly = await getDealIdForLineItem(lineItemId);
  if (!dealIdEarly) {
    const msg = 'No se pudo facturar: el ítem no tiene negocio asociado.';
    try {
      await hubspotClient.crm.lineItems.basicApi.update(String(lineItemId), {
        properties: { facturar_ahora: 'false', of_billing_error: msg },
      });
    } catch (updateErr) {
      logger.error(
        { module: 'urgentBillingService', fn: 'processUrgentLineItem', lineItemId, err: updateErr },
        'Error escribiendo error de deal no encontrado en line item'
      );
    }
    logger.error(
      { module: 'urgentBillingService', fn: 'processUrgentLineItem', lineItemId },
      'Bloqueado: line item sin deal asociado'
    );
    return { skipped: true, reason: 'no_deal_found' };
  }

  let dealEarly;
  try {
    dealEarly = await hubspotClient.crm.deals.basicApi.getById(dealIdEarly, ['facturacion_activa', 'dealname']);
  } catch (err) {
    logger.error(
      { module: 'urgentBillingService', fn: 'processUrgentLineItem', lineItemId, dealIdEarly, err },
      'Error obteniendo deal para verificar facturacion_activa'
    );
    // No bloqueamos — dejamos que _executeUrgentBillingForLineItem maneje el error
  }

  if (dealEarly && !parseBool(dealEarly.properties?.facturacion_activa)) {
    const dealName = (dealEarly.properties?.dealname || dealIdEarly).slice(0, 100);
    const msg = `Falta activar la facturación. Pase el negocio a cierre ganado. Negocio: ${dealName}.`;
    try {
      await hubspotClient.crm.lineItems.basicApi.update(String(lineItemId), {
        properties: { facturar_ahora: 'false', of_billing_error: msg },
      });
    } catch (updateErr) {
      logger.error(
        { module: 'urgentBillingService', fn: 'processUrgentLineItem', lineItemId, err: updateErr },
        'Error escribiendo bloqueo facturacion_activa en line item'
      );
    }
    try {
      await hubspotClient.crm.deals.basicApi.update(String(dealIdEarly), {
        properties: { of_billing_error: msg },
      });
    } catch (updateErr) {
      logger.error(
        { module: 'urgentBillingService', fn: 'processUrgentLineItem', dealIdEarly, err: updateErr },
        'Error escribiendo bloqueo facturacion_activa en deal'
      );
    }
    logger.info(
      { module: 'urgentBillingService', fn: 'processUrgentLineItem', lineItemId, dealIdEarly },
      'Bloqueado: facturacion_activa del deal no está en true'
    );
    return { skipped: true, reason: 'facturacion_activa_false' };
  }
  // ─── FIN GUARD DE FACTURACIÓN ACTIVA ─────────────────────────────────────────

  // Facturar PY — un error aquí sí bloquea (es lo principal)
  const result = await _executeUrgentBillingForLineItem(lineItemId);

  // Propagar al mirror UY — fire-and-forget, no bloquea la respuesta al caller
  _propagateToMirror(lineItemId).catch(() => {
    // Los errores ya son manejados y logueados dentro de _propagateToMirror
  });

  return result;
}

/**
 * Intenta facturar el line item espejo UY correspondiente al PY dado.
 * Si falla, deja facturar_ahora=true en el mirror para que el cron lo reintente,
 * y escribe of_billing_error para visibilidad del equipo UY en HubSpot.
 */
async function _propagateToMirror(pyLineItemId) {
  const log = logger.child({
    module: 'urgentBillingService',
    fn: '_propagateToMirror',
    pyLineItemId: String(pyLineItemId),
  });

  // 1) Obtener deal PY del line item original
  let pyDealId;
  try {
    pyDealId = await getDealIdForLineItem(pyLineItemId);
    if (!pyDealId) {
      log.info('Line item PY sin deal asociado, nada que propagar');
      return;
    }
  } catch (err) {
    log.error({ err }, 'Error obteniendo deal PY para propagación mirror');
    return;
  }

  // 2) Sincronizar/crear mirror completo — garantiza que el deal UY y sus LIs existan
  let mirrorResult;
  try {
    mirrorResult = await mirrorDealToUruguay(pyDealId);
  } catch (err) {
    log.error({ err, pyDealId }, 'Error en mirrorDealToUruguay — abortando propagación');
    return;
  }

  if (!mirrorResult?.mirrored) {
    log.info({ reason: mirrorResult?.reason }, 'Deal PY no tiene mirror UY activo, nada que propagar');
    return;
  }

  log.info({ mirrorDealId: mirrorResult.targetDealId }, 'Mirror UY sincronizado');

  // 3) Encontrar el line item espejo UY (ya existe gracias al sync anterior)
  let mirrorLineItemId;
  try {
    const found = await findMirrorLineItem(pyLineItemId);
    if (!found) {
      log.warn(
        { pyDealId, mirrorDealId: mirrorResult.targetDealId },
        'Mirror sincronizado pero no se encontró LI espejo — LI puede no tener uy=true'
      );
      return;
    }
    mirrorLineItemId = found.mirrorLineItemId;
  } catch (err) {
    log.error({ err }, 'Error buscando mirror line item tras sync');
    return;
  }

  log.info({ mirrorLineItemId }, 'Propagando facturación urgente al mirror UY');

  // 4) Facturar el mirror — el guard interno sincroniza de nuevo antes de emitir
  try {
    await _executeUrgentBillingForLineItem(mirrorLineItemId);
    log.info({ mirrorLineItemId }, 'Mirror UY facturado correctamente');
  } catch (err) {
    log.error({ err, mirrorLineItemId }, 'Error facturando mirror UY — marcando para reintento');

    try {
      await hubspotClient.crm.lineItems.basicApi.update(String(mirrorLineItemId), {
        properties: {
          facturar_ahora: 'true',
          of_billing_error: `mirror_propagation_failed: ${String(err?.message || 'unknown').slice(0, 200)}`,
          of_billing_error_at: String(getTodayMillis()),
        },
      });
      log.info({ mirrorLineItemId }, 'Mirror UY marcado con facturar_ahora=true para reintento');
    } catch (updateErr) {
      log.error({ updateErr, mirrorLineItemId }, 'No se pudo marcar el mirror para reintento');
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
    const ticket = await hubspotClient.crm.tickets.basicApi.getById(
      ticketId,
      REQUIRED_TICKET_PROPS
    );

    const ticketProps = ticket.properties || {};

    if (!parseBool(ticketProps.facturar_ahora)) {
      logger.info(
        { module: 'urgentBillingService', fn: 'processUrgentTicket', ticketId },
        'facturar_ahora no está en true, ignorando'
      );
      return { skipped: true, reason: 'facturar_ahora_false' };
    }

    shouldResetFlag = true;

    // Guard: facturacion_activa del deal debe estar en true
const dealId = (ticketProps.of_deal_id || '').trim();
if (dealId) {
  let dealProps = {};
  try {
    const deal = await hubspotClient.crm.deals.basicApi.getById(dealId, ['facturacion_activa', 'dealname']);
    dealProps = deal.properties || {};
  } catch (err) {
    logger.error(
      { module: 'urgentBillingService', fn: 'processUrgentTicket', ticketId, dealId, err },
      'Error obteniendo deal para verificar facturacion_activa'
    );
  }

  if (!parseBool(dealProps.facturacion_activa)) {
    const dealName = (dealProps.dealname || dealId).slice(0, 100);
    const fechaEsperada = (ticketProps.fecha_resolucion_esperada || 'sin fecha').slice(0, 20);
    const msg = `No se facturó porque facturación activa no está en true. Negocio: ${dealName}. Fecha esperada: ${fechaEsperada}.`;
    try {
      await hubspotClient.crm.tickets.basicApi.update(String(ticketId), {
        properties: { facturar_ahora: 'false', of_billing_error: msg },
      });
    } catch (updateErr) {
      logger.error(
        { module: 'urgentBillingService', fn: 'processUrgentTicket', ticketId, err: updateErr },
        'Error escribiendo bloqueo facturacion_activa en ticket'
      );
    }
    logger.info(
      { module: 'urgentBillingService', fn: 'processUrgentTicket', ticketId, dealId },
      'Bloqueado: facturacion_activa del deal no está en true'
    );
    return { skipped: true, reason: 'facturacion_activa_false' };
  }
}
/*
// Guard: solo tickets en etapa forecast son promovibles con facturar_ahora
const currentStage = (ticketProps.hs_pipeline_stage || '').trim();
if (currentStage && !FORECAST_MANUAL_STAGES.has(currentStage)) {
  const msg = `Facturar ahora solo está disponible para tickets en etapa forecast. Etapa actual: ${currentStage}.`;
  try {
    await hubspotClient.crm.tickets.basicApi.update(String(ticketId), {
      properties: { facturar_ahora: 'false', of_billing_error: msg },
    });
  } catch (updateErr) {
    logger.error(
      { module: 'urgentBillingService', fn: 'processUrgentTicket', ticketId, err: updateErr },
      'Error escribiendo bloqueo de stage en ticket'
    );
  }
  logger.info(
    { module: 'urgentBillingService', fn: 'processUrgentTicket', ticketId, currentStage },
    'Bloqueado: ticket no está en etapa forecast'
  );
  return { skipped: true, reason: 'invalid_stage_for_urgent' };
}
*/
    if (ticketProps.of_invoice_id && ticketProps.of_invoice_status !== 'Cancelada') {
      logger.info(
        { module: 'urgentBillingService', fn: 'processUrgentTicket', ticketId, invoiceId: ticketProps.of_invoice_id },
        'Ticket ya facturado, saltando'
      );
      return { skipped: true, reason: 'already_invoiced', invoiceId: ticketProps.of_invoice_id };
    }

    // GUARD plan completo
    const lik = (ticketProps.of_line_item_key || '').trim();

    if (lik) {
      let totalPayments = null;
      try {
        const liResp = await hubspotClient.crm.objects.searchApi.doSearch('line_items', {
          filterGroups: [{
            filters: [{ propertyName: 'line_item_key', operator: 'EQ', value: lik }]
          }],
          properties: ['hs_recurring_billing_number_of_payments'],
          limit: 1,
        });
        const liProps = liResp?.results?.[0]?.properties || {};
        totalPayments = Number(liProps.hs_recurring_billing_number_of_payments);
      } catch (err) {
        logger.warn(
          { module: 'urgentBillingService', fn: 'processUrgentTicket', ticketId, lik, err },
          'Error obteniendo totalPayments del line item, fail open'
        );
      }

      const isAutoRenew = !Number.isFinite(totalPayments) || totalPayments === 0;

      if (!isAutoRenew) {
        const activeCount = await countActivePlanInvoices(lik);
        if (activeCount !== null && activeCount >= totalPayments) {
          logger.info(
            { module: 'urgentBillingService', fn: 'processUrgentTicket', ticketId, lik, activeCount, totalPayments },
            'Plan completado, no se emite factura'
          );
          return { skipped: true, reason: 'plan_completed', activeCount, totalPayments };
        }
      }
    } else {
      logger.warn(
        { module: 'urgentBillingService', fn: 'processUrgentTicket', ticketId },
        'of_line_item_key vacío, omitiendo guard de plan completo'
      );
    }

    const invoiceResult = await createInvoiceFromTicket(ticket, 'AUTO_LINEITEM', null, { skipRefetch: true });

    if (!invoiceResult || !invoiceResult.invoiceId) {
      throw new Error('Error al crear factura de ticket');
    }

    logger.info(
      { module: 'urgentBillingService', fn: 'processUrgentTicket', ticketId, invoiceId: invoiceResult.invoiceId },
      'Factura creada desde ticket'
    );

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

// Acumular mensaje de facturación del deal con todos los tickets READY pendientes
try {
  const dealIdForMsg = (ticketProps.of_deal_id || '').trim();
  logger.info(
    { module: 'urgentBillingService', fn: 'processUrgentTicket', ticketId, dealIdForMsg },
    'refreshMensajeFacturacionParaDeal — intentando'
  );
  if (dealIdForMsg) {
    await refreshMensajeFacturacionParaDeal(dealIdForMsg);
  } else {
    logger.warn(
      { module: 'urgentBillingService', fn: 'processUrgentTicket', ticketId },
      'refreshMensajeFacturacionParaDeal — of_deal_id vacío, saltando'
    );
  }
} catch (err) {
  logger.warn(
    { module: 'urgentBillingService', fn: 'processUrgentTicket', ticketId, err },
    'refreshMensajeFacturacionParaDeal falló — no bloquea'
  );
}

    logger.info(
      { module: 'urgentBillingService', fn: 'processUrgentTicket', ticketId, invoiceId: invoiceResult.invoiceId },
      'Facturación urgente de Ticket completada'
    );

    return { success: true, invoiceId: invoiceResult.invoiceId, ticketId };
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
    } catch (updateErr) {
      reportIfActionable({ objectType: 'ticket', objectId: String(ticketId), message: 'Error guardando of_billing_error en ticket', err: updateErr });
      logger.error(
        { module: 'urgentBillingService', fn: 'processUrgentTicket', ticketId, err: updateErr },
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
 *   - _executeUrgentBillingForLineItem: lineItems.basicApi.update() limpieza invoice_id → objectType="line_item", NO re-throw
 *   - _executeUrgentBillingForLineItem: tickets.basicApi.update() mover a READY → objectType="ticket", re-throw
 *   - _executeUrgentBillingForLineItem catch externo: lineItems.basicApi.update() of_billing_error → objectType="line_item", NO re-throw (best-effort)
 *   - _executeUrgentBillingForLineItem finally: lineItems.basicApi.update() reset flag → objectType="line_item", NO re-throw
 *   - processUrgentTicket: tickets.basicApi.update() mover a READY → objectType="ticket", re-throw
 *   - processUrgentTicket catch externo: tickets.basicApi.update() of_billing_error → objectType="ticket", NO re-throw (best-effort)
 *   - processUrgentTicket finally: tickets.basicApi.update() reset flag → objectType="ticket", NO re-throw
 *
 * NO reportados:
 *   - updateTicket() → ya tiene reportIfActionable interno (ticketService.js migrado), evita doble reporte
 *   - createAutoBillingTicket() → delegado
 *   - lineItems.basicApi.update() en guard no_billing_period_date → cleanup, no acción de negocio
 *   - lineItems.basicApi.update() ensureLineItemKey shouldUpdate → inicialización
 *   - lineItems.basicApi.update() last_ticketed_date / last_billing_period → estado interno
 *   - getDealWithLineItems / getById / isInvoiceIdValidForLineItem → lecturas
 *   - associations.v4 → excluidas
 *   - createInvoiceFromTicket / createAutoInvoiceFromLineItem → servicios delegados
 *   - findMirrorLineItem → lookup, no update accionable
 *   - _propagateToMirror → fire-and-forget, errores capturados internamente
 *
 * Confirmación: "No se reportan warns a HubSpot; solo errores 4xx (≠429)"
 */