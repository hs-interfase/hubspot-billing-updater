// src/utils/hubspotPortal.js
//
// Resuelve el portalId (hub id) de HubSpot para construir URLs de acceso a
// registros (tickets, deals) dentro de app.hubspot.com.
//
// Orden de resolución:
//   1. process.env.HUBSPOT_PORTAL_ID (si está seteado, se usa tal cual)
//   2. API account-info/v3/details usando HUBSPOT_PRIVATE_TOKEN (cacheado)
//
// Si no se puede resolver, retorna null y los builders simplemente omiten la URL.

import { hubspotClient } from '../hubspotClient.js';
import logger from '../../lib/logger.js';

let cachedPortalId = null;

export async function getPortalId() {
  if (cachedPortalId) return cachedPortalId;

  const envId = String(process.env.HUBSPOT_PORTAL_ID || '').trim();
  if (envId) {
    cachedPortalId = envId;
    return cachedPortalId;
  }

  try {
    const res = await hubspotClient.apiRequest({
      method: 'GET',
      path: '/account-info/v3/details',
    });

    // El SDK puede devolver un Response (fetch-like) o un objeto ya parseado.
    let body = res;
    if (res && typeof res.json === 'function') body = await res.json();
    else if (res && res.body) body = res.body;

    const portalId = body?.portalId ?? body?.hubId;
    if (portalId) {
      cachedPortalId = String(portalId);
      logger.info({ module: 'hubspotPortal', portalId: cachedPortalId }, 'portalId resuelto vía account-info');
      return cachedPortalId;
    }
  } catch (err) {
    logger.warn({ module: 'hubspotPortal', err: err?.message }, 'No se pudo resolver portalId — URLs se omitirán');
  }

  return null;
}

/** URL de un ticket en app.hubspot.com (object type 0-5). */
export function buildTicketUrl(portalId, ticketId) {
  if (!portalId || !ticketId) return null;
  return `https://app.hubspot.com/contacts/${portalId}/record/0-5/${ticketId}`;
}

/** URL de un deal/negocio en app.hubspot.com (object type 0-3). */
export function buildDealUrl(portalId, dealId) {
  if (!portalId || !dealId) return null;
  return `https://app.hubspot.com/contacts/${portalId}/record/0-3/${dealId}`;
}
