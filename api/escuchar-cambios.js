// api/escuchar-cambios.js

/**
 * Webhook unificado para HubSpot: Maneja facturación urgente y recálculos.
 * 
 * Propiedades soportadas:
 * 1. facturar_ahora (Line Item/Ticket) → Facturación urgente inmediata
 * 2. actualizar (Line Item) → Recalcula todas las fases de facturación
 * 3. hs_billing_start_delay_type (Line Item) → Normaliza delays a fechas
 * 
 * Configuración en HubSpot:
 * - Suscripciones en la misma URL: https://hubspot-billing-updater.vercel.app/api/escuchar-cambios
 * - Line Item → Property Change → facturar_ahora
 * - Ticket → Property Change → facturar_ahora
 * - Line Item → Property Change → actualizar
 * - Line Item → Property Change → hs_billing_start_delay_type
 */

import logger from '../lib/logger.js';
import { reportHubSpotError } from '../src/utils/hubspotErrorCollector.js';
import { processUrgentLineItem, processUrgentTicket } from '../src/services/urgentBillingService.js';
import { hubspotClient, getDealWithLineItems } from '../src/hubspotClient.js';
import { runPhasesForDeal } from '../src/phases/index.js';
import { parseBool } from '../src/utils/parsers.js';
import { processTicketUpdate } from '../src/services/tickets/ticketUpdateService.js';

const MODULE = 'escuchar-cambios';

function reportIfActionable({ objectType, objectId, message, err }) {
  const status = err?.response?.status ?? err?.statusCode ?? null;
  if (status === null) { reportHubSpotError({ objectType, objectId, message }); return; }
  if (status === 429 || status >= 500) return;
  if (status >= 400 && status < 500) reportHubSpotError({ objectType, objectId, message });
}

/**
 * Obtiene el dealId asociado a un line item.
 */
async function getDealIdForLineItem(lineItemId) {
  const resp = await hubspotClient.crm.associations.v4.basicApi.getPage(
    "line_items",
    String(lineItemId),
    "deals",
    100
  );
  const dealIds = (resp.results || [])
    .map((r) => String(r.toObjectId))
    .filter(Boolean);
  return dealIds.length ? dealIds[0] : null;
}

/**
 * Procesa eventos de "actualizar" o "hs_billing_start_delay_type".
 * Ejecuta las 3 fases de facturación para el deal asociado.
 * 
 * IMPORTANTE: Phase 1 SIEMPRE se ejecuta (mirroring, fechas, cupo).
 * Phase 2 y 3 solo se ejecutan si facturacion_activa=true.
 */
async function processRecalculation(lineItemId, propertyName) {
  logger.info({ module: MODULE, fn: 'processRecalculation', lineItemId, propertyName }, 'Iniciando recalculación');

  // 0. Setear Actualizar a False.
  if (propertyName === "actualizar") {
    try {
      await hubspotClient.crm.lineItems.basicApi.update(String(lineItemId), {
        properties: { actualizar: false },
      });
      logger.info({ module: MODULE, fn: 'processRecalculation', lineItemId }, 'Trigger "actualizar" reseteado a false (inicio)');
    } catch (err) {
      logger.warn({ module: MODULE, fn: 'processRecalculation', lineItemId, err }, 'No se pudo resetear "actualizar" al inicio');
      reportIfActionable({ objectType: 'line_item', objectId: lineItemId, message: 'No se pudo resetear "actualizar" al inicio', err });
      // si tu prioridad #1 es cortar loops igual, NO hagas throw acá.
      // Si querés ser más estricta: throw err;
    }
  }

  // 1. Obtener deal asociado
  const dealId = await getDealIdForLineItem(lineItemId);
  if (!dealId) {
    logger.error({ module: MODULE, fn: 'processRecalculation', lineItemId }, 'No se encontró deal asociado al line item');
    return { skipped: true, reason: 'No associated deal' };
  }

  // 2. Obtener deal info para logging
  const deal = await hubspotClient.crm.deals.basicApi.getById(String(dealId), [
    "facturacion_activa",
    "dealname",
  ]);
  const dealProps = deal?.properties || {};
  const dealName = dealProps.dealname || "Sin nombre";

  logger.info({ module: MODULE, fn: 'processRecalculation', dealId, dealName }, 'Deal resuelto');

  // 3. Ejecutar fases de facturación
  // Phase 1 se ejecuta SIEMPRE (mirroring, normalización de fechas, etc.)
  // Phase 2 y 3 verifican internamente facturacion_activa
  const dealWithLineItems = await getDealWithLineItems(dealId);
  const billingResult = await runPhasesForDeal(dealWithLineItems);

  logger.info({
    module: MODULE,
    fn: 'processRecalculation',
    dealId,
    ticketsCreated: billingResult.ticketsCreated || 0,
    invoicesEmitted: billingResult.autoInvoicesEmitted || 0,
  }, 'Recalculación completada');

  return {
    success: true,
    dealId,
    dealName,
    billingResult
  };
}

/**
 * Handler principal del webhook.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const payload = Array.isArray(req.body) ? req.body[0] : req.body;

    const objectId = payload?.objectId;
    const objectType = payload?.subscriptionType?.split('.')[0] || 'line_item';
    const propertyName = payload?.propertyName;
    const propertyValue = payload?.propertyValue;
    const eventId = payload?.eventId;

    logger.info({ module: MODULE, fn: 'handler', objectId, objectType, propertyName, propertyValue, eventId }, 'Evento webhook recibido');

    if (!objectId) {
      logger.error({ module: MODULE, fn: 'handler' }, 'Missing objectId');
      return res.status(400).json({ error: 'Missing objectId' });
    }

    // ====== RUTA 1: FACTURACIÓN URGENTE (facturar_ahora) ======
    if (propertyName === 'facturar_ahora') {
      logger.debug({ module: MODULE, fn: 'handler', objectId, propertyValue, parsed: parseBool(propertyValue) }, 'Validando facturar_ahora');

      if (!parseBool(propertyValue)) {
        logger.warn({ module: MODULE, fn: 'handler', objectId }, 'facturar_ahora no está en true, ignorando');
        return res.status(200).json({ message: 'Property value not true, skipped' });
      }

      let result;

      if (objectType === 'line_item') {
        result = await processUrgentLineItem(objectId);
      } else if (objectType === 'ticket') {
        result = await processUrgentTicket(objectId);
      } else {
        logger.error({ module: MODULE, fn: 'handler', objectType, objectId }, 'Tipo de objeto no soportado');
        return res.status(400).json({ error: `Unsupported object type: ${objectType}` });
      }

      if (result.skipped) {
        logger.warn({ module: MODULE, fn: 'handler', objectId, reason: result.reason }, 'Proceso omitido');
        return res.status(200).json({
          skipped: true,
          reason: result.reason,
          objectId,
          objectType,
        });
      }

      logger.info({ module: MODULE, fn: 'handler', objectId, objectType }, 'Facturación urgente completada');

      return res.status(200).json({
        success: true,
        action: 'urgent_billing',
        objectId,
        objectType,
        invoiceId: result.invoiceId,
        eventId,
      });
    }

    // ====== RUTA 2: RECALCULACIÓN (actualizar o hs_billing_start_delay_type) ======
    if (['actualizar', 'hs_billing_start_delay_type'].includes(propertyName)) {

      // CASO A: actualizar en TICKET → Procesamiento independiente
      if (propertyName === 'actualizar' && objectType === 'ticket') {
        logger.debug({ module: MODULE, fn: 'handler', objectId, propertyValue, parsed: parseBool(propertyValue) }, 'Validando actualizar en ticket');

        if (!parseBool(propertyValue)) {
          logger.warn({ module: MODULE, fn: 'handler', objectId }, 'Flag actualizar no está en true, ignorando');
          return res.status(200).json({
            message: 'actualizar flag not true, skipped',
            receivedValue: propertyValue
          });
        }

        try {
          const result = await processTicketUpdate(objectId);

          logger.info({ module: MODULE, fn: 'handler', ticketId: objectId }, 'Actualización de ticket completada');

          return res.status(200).json({
            success: true,
            action: 'ticket_update',
            objectId,
            ticketId: objectId,
            result,
            eventId,
          });
        } catch (err) {
          logger.error({ module: MODULE, fn: 'handler', ticketId: objectId, err }, 'Error procesando ticket');
          return res.status(200).json({
            error: true,
            message: err?.message || 'Error procesando ticket',
            objectId,
          });
        } finally {
          // Resetear flag actualizar en ticket
          try {
            await hubspotClient.crm.tickets.basicApi.update(String(objectId), {
              properties: { actualizar: false },
            });
            logger.info({ module: MODULE, fn: 'handler', ticketId: objectId }, "Flag 'actualizar' reseteado a false para ticket");
          } catch (err) {
            logger.error({ module: MODULE, fn: 'handler', ticketId: objectId, err }, "Error reseteando 'actualizar' en ticket");
            reportIfActionable({ objectType: 'ticket', objectId, message: "Error reseteando 'actualizar' en ticket", err });
          }
        }
      }

      // CASO B: hs_billing_start_delay_type solo aplica a LINE ITEMS
      if (propertyName === 'hs_billing_start_delay_type' && objectType !== 'line_item') {
        logger.warn({ module: MODULE, fn: 'handler', propertyName, objectType }, 'Propiedad solo aplica a line items, ignorando');
        return res.status(200).json({ message: 'Not a line_item event, ignored' });
      }

      // CASO C: actualizar en LINE ITEM (flujo original sin cambios)
      if (propertyName === 'actualizar' && objectType === 'line_item') {
        logger.debug({ module: MODULE, fn: 'handler', objectId, propertyValue, parsed: parseBool(propertyValue) }, 'Validando actualizar en line item');

        if (!parseBool(propertyValue)) {
          logger.warn({ module: MODULE, fn: 'handler', objectId }, 'Flag actualizar no está en true, ignorando');
          return res.status(200).json({
            message: 'actualizar flag not true, skipped',
            receivedValue: propertyValue
          });
        }
      }

      // CASO D: hs_billing_start_delay_type en LINE ITEM (continúa sin validar valor)
      // Solo ejecutar processRecalculation para LINE ITEMS (ambas propiedades)
      if (objectType === 'line_item') {
        const result = await processRecalculation(objectId, propertyName);

        if (result.skipped) {
          logger.warn({ module: MODULE, fn: 'handler', objectId, propertyName, reason: result.reason }, 'Recalculación omitida');
          return res.status(200).json({
            skipped: true,
            reason: result.reason,
            objectId,
            propertyName,
          });
        }

        // Resetear flag "actualizar" inmediatamente después de procesar (sin delay)
        if (propertyName === "actualizar") {
          try {
            await hubspotClient.crm.lineItems.basicApi.update(String(objectId), {
              properties: { actualizar: false },
            });
            logger.info({ module: MODULE, fn: 'handler', lineItemId: objectId }, "Flag 'actualizar' reseteado a false para line item (post-flujo)");
          } catch (err) {
            logger.error({ module: MODULE, fn: 'handler', lineItemId: objectId, err }, "Error reseteando 'actualizar' en line item (post-flujo)");
            reportIfActionable({ objectType: 'line_item', objectId, message: "Error reseteando 'actualizar' en line item (post-flujo)", err });
          }
        }

        logger.info({ module: MODULE, fn: 'handler', objectId, propertyName, dealId: result.dealId }, 'Recalculación completada');

        return res.status(200).json({
          success: true,
          action: 'recalculation',
          objectId,
          propertyName,
          dealId: result.dealId,
          dealName: result.dealName,
          billingResult: result.billingResult,
          eventId,
        });
      }
    }

    // ====== PROPIEDAD NO RECONOCIDA ======
    logger.warn({ module: MODULE, fn: 'handler', propertyName, objectId }, 'Propiedad no reconocida, ignorando');

    return res.status(200).json({
      message: 'Property not supported, skipped',
      propertyName
    });

  } catch (err) {
    logger.error({ module: MODULE, fn: 'handler', err }, 'Error inesperado procesando webhook');

    return res.status(500).json({
      error: 'Internal server error',
      message: err?.message || 'Unknown error',
    });
  }
}

/*
 * CATCHES con reportHubSpotError agregados:
 *   - processRecalculation: lineItems.basicApi.update reset "actualizar" al inicio → objectType: 'line_item'
 *   - handler CASO D: lineItems.basicApi.update reset "actualizar" post-flujo → objectType: 'line_item'
 *   - handler CASO A finally: tickets.basicApi.update reset "actualizar" en ticket → objectType: 'ticket'
 *
 * NO reportados:
 *   - associations.v4.basicApi.getPage (getDealIdForLineItem): lectura
 *   - deals.basicApi.getById: lectura
 *   - processUrgentLineItem / processUrgentTicket / runPhasesForDeal: lógica interna, reporte corresponde a capas inferiores
 *   - processTicketUpdate: ídem
 *   - catch externo (Unexpected error): no hay update HubSpot en juego
 *
 * Confirmación: "No se reportan warns a HubSpot; solo errores 4xx (≠429)"
 */