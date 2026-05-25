// api/actualizar-webhook.js
import logger from '../lib/logger.js';
import { hubspotClient } from '../src/hubspotClient.js';
import { enqueue } from '../src/webhookQueue.js';
import { parseBool } from '../src/utils/parsers.js';

const MODULE = 'actualizar';

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
    const propertyName = payload?.propertyName;
    const propertyValue = payload?.propertyValue;
    const subscriptionType = payload?.subscriptionType;
    const eventId = payload?.eventId;

    const [objectType] = (subscriptionType || '').split('.');
    if (objectType !== 'line_item') {
      return res.status(200).json({ message: 'Not a line_item event, ignored' });
    }

    if (!['actualizar', 'hs_billing_start_delay_type'].includes(propertyName)) {
      return res.status(200).json({ message: 'Property not relevant, skipped' });
    }

    if (propertyName === 'actualizar' && !parseBool(propertyValue)) {
      return res.status(200).json({ message: 'actualizar flag not true, skipped' });
    }

    if (!objectId) {
      return res.status(400).json({ error: 'Missing objectId' });
    }

    logger.info({ module: MODULE, fn: 'handler', lineItemId: objectId, propertyName, propertyValue }, 'Webhook event received');

    const dealId = await getDealIdForLineItem(objectId);

    const queueId = await enqueue({
      source: 'actualizar-webhook',
      objectType: 'line_item',
      objectId,
      propertyName,
      propertyValue,
      dealId,
      actionType: 'recalc',
      priority: 0,
      eventId,
      rawPayload: payload,
    });

    return res.status(200).json({ queued: true, queueId, objectId, propertyName, dealId, action: 'recalc' });

  } catch (err) {
    logger.error({ module: MODULE, fn: 'handler', err }, 'Unexpected error processing webhook');
    return res.status(500).json({ error: 'Internal server error', message: err?.message || 'Unknown error' });
  }
}