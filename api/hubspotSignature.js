// api/hubspotSignature.js
//
// Middleware que verifica la firma v3 de HubSpot en webhooks entrantes.
// Docs: https://developers.hubspot.com/docs/api/webhooks/validating-requests
//
// Requiere la variable HUBSPOT_CLIENT_SECRET (distinta del HUBSPOT_PRIVATE_TOKEN).
// Si no está definida, loggea un warning y deja pasar (para no romper en desarrollo).

import crypto from 'crypto';
import logger from '../lib/logger.js';

const CLIENT_SECRET = process.env.HUBSPOT_CLIENT_SECRET;
const MAX_AGE_MS = 5 * 60 * 1000; // 5 minutos — ventana anti-replay

export function verifyHubSpotSignature(req, res, next) {
  if (!CLIENT_SECRET) {
    logger.warn({ module: 'hubspotSignature' }, 'HUBSPOT_CLIENT_SECRET no definido — verificación de firma omitida');
    return next();
  }

  const sigV3 = req.headers['x-hubspot-signature-v3'];
  const timestamp = req.headers['x-hubspot-request-timestamp'];

  if (!sigV3 || !timestamp) {
    logger.warn({ module: 'hubspotSignature', url: req.originalUrl }, 'Webhook sin firma HubSpot');
    return res.status(401).json({ error: 'Missing HubSpot signature' });
  }

  const tsMs = Number(timestamp);
  if (isNaN(tsMs) || Date.now() - tsMs > MAX_AGE_MS) {
    logger.warn({ module: 'hubspotSignature', timestamp }, 'Timestamp de webhook expirado');
    return res.status(401).json({ error: 'Request timestamp expired' });
  }

  const fullUrl = req.protocol + '://' + req.get('host') + req.originalUrl;
  const rawBody = req.rawBody ?? '';
  const source = 'POST' + fullUrl + rawBody + timestamp;

  const expected = crypto
    .createHmac('sha256', CLIENT_SECRET)
    .update(source, 'utf8')
    .digest('base64');

  let valid = false;
  try {
    const a = Buffer.from(sigV3, 'base64');
    const b = Buffer.from(expected, 'base64');
    valid = a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    valid = false;
  }

  if (!valid) {
    logger.warn({ module: 'hubspotSignature', url: req.originalUrl }, 'Firma HubSpot inválida');
    return res.status(401).json({ error: 'Invalid HubSpot signature' });
  }

  next();
}
