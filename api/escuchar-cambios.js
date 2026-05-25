// api/escuchar-cambios.js
import logger from '../lib/logger.js';
import { hubspotClient } from '../src/hubspotClient.js';
import { enqueue } from '../src/webhookQueue.js';
import { parseBool } from '../src/utils/parsers.js';

const MODULE = 'escuchar-cambios';

// ─── Helper: resolver dealId desde line item (para deduplicación en la cola) ─

async function getDealIdForLineItem(lineItemId) {
  try {
    const resp = await hubspotClient.crm.associations.v4.basicApi.getPage(
      'line_items',
      String(lineItemId),
      'deals',
      100
    );
    const dealIds = (resp.results || [])
      .map((r) => String(r.toObjectId))
      .filter(Boolean);
    return dealIds.length ? dealIds[0] : null;
  } catch (err) {
    logger.warn(
      { module: MODULE, fn: 'getDealIdForLineItem', lineItemId, err: err?.message },
      'No se pudo resolver dealId pre-enqueue, se resolverá en el worker'
    );
    return null;
  }
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

      if (objectType === 'line_item') {
        const dealId = await getDealIdForLineItem(objectId);
        const queueId = await enqueue({
          source: 'escuchar-cambios',
          objectType, objectId, propertyName, propertyValue,
          dealId,
          actionType: 'urgent_line_item',
          priority: 1,
          eventId,
          rawPayload: payload,
        });
        return res.status(200).json({ queued: true, queueId, objectId, objectType, action: 'urgent_line_item' });

      } else if (objectType === 'ticket') {
        // Tickets no tienen dealId directo para deduplicar, se encolan sin él
        const queueId = await enqueue({
          source: 'escuchar-cambios',
          objectType, objectId, propertyName, propertyValue,
          dealId: null,
          actionType: 'urgent_ticket',
          priority: 1,
          eventId,
          rawPayload: payload,
        });
        return res.status(200).json({ queued: true, queueId, objectId, objectType, action: 'urgent_ticket' });

      } else {
        return res.status(400).json({ error: `Unsupported object type: ${objectType}` });
      }
    }

    // ====== RUTA 2: RECALCULACIÓN ======
    if (['actualizar', 'hs_billing_start_delay_type'].includes(propertyName)) {

      // CASO A: actualizar en TICKET
      if (propertyName === 'actualizar' && objectType === 'ticket') {
        if (!parseBool(propertyValue)) {
          return res.status(200).json({ message: 'actualizar flag not true, skipped', receivedValue: propertyValue });
        }

        const queueId = await enqueue({
          source: 'escuchar-cambios',
          objectType, objectId, propertyName, propertyValue,
          dealId: null,
          actionType: 'ticket_update',
          priority: 0,
          eventId,
          rawPayload: payload,
        });
        return res.status(200).json({ queued: true, queueId, objectId, action: 'ticket_update' });
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

      // CASO D: encolar recalculación para line items
      if (objectType === 'line_item') {
        const dealId = await getDealIdForLineItem(objectId);

        const queueId = await enqueue({
          source: 'escuchar-cambios',
          objectType, objectId, propertyName, propertyValue,
          dealId,
          actionType: 'recalc',
          priority: 0,
          eventId,
          rawPayload: payload,
        });

        return res.status(200).json({ queued: true, queueId, objectId, propertyName, dealId, action: 'recalc' });
      }
    }

    // ====== PROPIEDAD NO RECONOCIDA ======
    return res.status(200).json({ message: 'Property not supported, skipped', propertyName });

  } catch (err) {
    logger.error({ module: MODULE, fn: 'handler', err }, 'Error inesperado procesando webhook');
    return res.status(500).json({ error: 'Internal server error', message: err?.message || 'Unknown error' });
  }
}