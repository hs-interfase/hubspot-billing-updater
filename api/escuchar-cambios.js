// api/escuchar-cambios.js
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

async function processRecalculation(lineItemId, propertyName) {
  logger.info({ module: MODULE, fn: 'processRecalculation', lineItemId, propertyName }, 'Iniciando recalculación');

  if (propertyName === "actualizar") {
    try {
      await hubspotClient.crm.lineItems.basicApi.update(String(lineItemId), {
        properties: { actualizar: false },
      });
      logger.info({ module: MODULE, fn: 'processRecalculation', lineItemId }, 'Trigger "actualizar" reseteado a false (inicio)');
    } catch (err) {
      logger.warn({ module: MODULE, fn: 'processRecalculation', lineItemId, err }, 'No se pudo resetear "actualizar" al inicio');
      reportIfActionable({ objectType: 'line_item', objectId: lineItemId, message: 'No se pudo resetear "actualizar" al inicio', err });
    }
  }

  const dealId = await getDealIdForLineItem(lineItemId);
  if (!dealId) {
    logger.error({ module: MODULE, fn: 'processRecalculation', lineItemId }, 'No se encontró deal asociado al line item');
    return { skipped: true, reason: 'No associated deal' };
  }

  const deal = await hubspotClient.crm.deals.basicApi.getById(String(dealId), [
    "facturacion_activa",
    "dealname",
  ]);
  const dealProps = deal?.properties || {};
  const dealName = dealProps.dealname || "Sin nombre";

  logger.info({ module: MODULE, fn: 'processRecalculation', dealId, dealName }, 'Deal resuelto');

  const dealWithLineItems = await getDealWithLineItems(dealId);
  const billingResult = await runPhasesForDeal(dealWithLineItems);

  logger.info({
    module: MODULE,
    fn: 'processRecalculation',
    dealId,
    ticketsCreated: billingResult.ticketsCreated || 0,
    invoicesEmitted: billingResult.autoInvoicesEmitted || 0,
  }, 'Recalculación completada');

  return { success: true, dealId, dealName, billingResult };
}

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

    // ====== RUTA 1: FACTURACIÓN URGENTE ======
    if (propertyName === 'facturar_ahora') {
      if (!parseBool(propertyValue)) {
        return res.status(200).json({ message: 'Property value not true, skipped' });
      }

      let result;
      if (objectType === 'line_item') {
        result = await processUrgentLineItem(objectId);
      } else if (objectType === 'ticket') {
        result = await processUrgentTicket(objectId);
      } else {
        return res.status(400).json({ error: `Unsupported object type: ${objectType}` });
      }

      if (result.skipped) {
        return res.status(200).json({ skipped: true, reason: result.reason, objectId, objectType });
      }

      return res.status(200).json({
        success: true,
        action: 'urgent_billing',
        objectId,
        objectType,
        invoiceId: result.invoiceId,
        eventId,
      });
    }

    // ====== RUTA 2: RECALCULACIÓN ======
    if (['actualizar', 'hs_billing_start_delay_type'].includes(propertyName)) {

      // CASO A: actualizar en TICKET
      if (propertyName === 'actualizar' && objectType === 'ticket') {
        if (!parseBool(propertyValue)) {
          return res.status(200).json({ message: 'actualizar flag not true, skipped', receivedValue: propertyValue });
        }

        try {
          const result = await processTicketUpdate(objectId);
          return res.status(200).json({ success: true, action: 'ticket_update', objectId, ticketId: objectId, result, eventId });
        } catch (err) {
          logger.error({ module: MODULE, fn: 'handler', ticketId: objectId, err }, 'Error procesando ticket');
          return res.status(200).json({ error: true, message: err?.message || 'Error procesando ticket', objectId });
        } finally {
          try {
            await hubspotClient.crm.tickets.basicApi.update(String(objectId), {
              properties: { actualizar: false },
            });
          } catch (err) {
            logger.error({ module: MODULE, fn: 'handler', ticketId: objectId, err }, "Error reseteando 'actualizar' en ticket");
            reportIfActionable({ objectType: 'ticket', objectId, message: "Error reseteando 'actualizar' en ticket", err });
          }
        }
      }

      // CASO B: hs_billing_start_delay_type solo para line items
      if (propertyName === 'hs_billing_start_delay_type' && objectType !== 'line_item') {
        return res.status(200).json({ message: 'Not a line_item event, ignored' });
      }

      // CASO C: actualizar en LINE ITEM — validar valor
      if (propertyName === 'actualizar' && objectType === 'line_item') {
        if (!parseBool(propertyValue)) {
          return res.status(200).json({ message: 'actualizar flag not true, skipped', receivedValue: propertyValue });
        }
      }

      // CASO D: ejecutar recalculación para line items
      if (objectType === 'line_item') {
        const result = await processRecalculation(objectId, propertyName);

        if (result.skipped) {
          return res.status(200).json({ skipped: true, reason: result.reason, objectId, propertyName });
        }

        if (propertyName === "actualizar") {
          try {
            await hubspotClient.crm.lineItems.basicApi.update(String(objectId), {
              properties: { actualizar: false },
            });
          } catch (err) {
            logger.error({ module: MODULE, fn: 'handler', lineItemId: objectId, err }, "Error reseteando 'actualizar' post-flujo");
            reportIfActionable({ objectType: 'line_item', objectId, message: "Error reseteando 'actualizar' post-flujo", err });
          }
        }

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
    return res.status(200).json({ message: 'Property not supported, skipped', propertyName });

  } catch (err) {
    logger.error({ module: MODULE, fn: 'handler', err }, 'Error inesperado procesando webhook');
    return res.status(500).json({ error: 'Internal server error', message: err?.message || 'Unknown error' });
  }
}