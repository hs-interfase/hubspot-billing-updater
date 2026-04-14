// src/utils/errorReporting.js
//
// Helper centralizado: reporta a HubSpot solo errores 4xx accionables (≠ 429).
// 429 y 5xx son transitorios → no se spamea HubSpot, solo se loggea.

import { reportHubSpotError } from './hubspotErrorCollector.js';

/**
 * Decide si el error merece reportarse como nota en HubSpot.
 * - Sin status HTTP conocido → reportar por precaución (puede ser error lógico).
 * - 429 o ≥ 500 → transitorio, no reportar.
 * - 4xx (excepto 429) → accionable, reportar.
 */
export function reportIfActionable({ objectType, objectId, message, err }) {
  const status = err?.response?.status ?? err?.statusCode ?? null;
  if (status === null) {
    reportHubSpotError({ objectType, objectId, message });
    return;
  }
  if (status === 429 || status >= 500) return;
  if (status >= 400 && status < 500) {
    reportHubSpotError({ objectType, objectId, message });
  }
}
