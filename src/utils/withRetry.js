// src/utils/withRetry.js

import logger from '../../lib/logger.js';

export const RETRY_CONFIG = {
  maxRetries:   4,
  baseDelayMs:  500,
  maxDelayMs:   10_000,
  jitterFactor: 0.3,
};

/**
 * Códigos de error de RED transitorios (sin status HTTP): el SDK/axios/node-fetch
 * los expone como err.code. Un socket hang up / connection reset en medio de una
 * call de HubSpot es transitorio → conviene reintentar (antes rompía la propagación
 * y escribía billing_error). Visto en volumen alto: ECONNRESET / socket hang up.
 */
const RETRYABLE_NET_CODES = new Set([
  'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND',
  'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_SOCKET', 'ERR_SOCKET_CONNECTION_TIMEOUT',
  // Railway → api.hubapi.com corta el body a mitad de respuesta (node-fetch/undici).
  // "Invalid response body while trying to fetch ...: Premature close". Es transitorio
  // (frecuente en cold-start del contenedor) → reintentar con socket nuevo lo resuelve.
  'ERR_STREAM_PREMATURE_CLOSE', 'UND_ERR_SOCKET', 'ECONNABORTED',
]);

/**
 * Devuelve true si el error justifica un reintento.
 * - 429  → rate limit (secondly o daily)
 * - 5xx  → error transitorio de HubSpot
 * - errores de red transitorios (ECONNRESET, socket hang up, etc.)
 * - 4xx ≠ 429 → error del caller, no reintentar
 */
export function isRetryable(status) {
  if (status === 429) return true;
  if (typeof status === 'number') return status >= 500 && status < 600;
  return typeof status === 'string' && RETRYABLE_NET_CODES.has(status);
}

/** Extrae el status HTTP de cualquier forma que lo arroje el SDK o axios */
export function extractStatus(err) {
  return err?.response?.status ?? err?.statusCode ?? err?.status ?? err?.code ?? err?.cause?.code ?? null;
}

/** Red transitoria detectada por MENSAJE (cuando no viene un code claro). */
export function isTransientNetworkMessage(err) {
  const msg = String(err?.message || err?.cause?.message || '');
  return /premature close|socket hang up|fetch failed|econnreset|etimedout|network|aborted|timeout/i.test(msg);
}

/**
 * Calcula el delay en ms para el próximo intento.
 * Prioriza Retry-After si viene en la respuesta; si no, usa backoff exponencial + jitter.
 *
 * @param {number} attempt  - índice 0-based del intento fallido
 * @param {string|null} retryAfterHeader
 */
export function calcDelay(attempt, retryAfterHeader) {
  if (retryAfterHeader) {
    const seconds = Number(retryAfterHeader);
    if (Number.isFinite(seconds) && seconds > 0) {
      // +100 ms de buffer para no llegar justo al límite
      return Math.min(seconds * 1000 + 100, RETRY_CONFIG.maxDelayMs);
    }
  }

  const exp    = RETRY_CONFIG.baseDelayMs * Math.pow(2, attempt);
  // jitter ±30 %: reduce la probabilidad de que varios workers reintentan a la vez
  const jitter = exp * RETRY_CONFIG.jitterFactor * (Math.random() * 2 - 1);
  return Math.min(Math.round(exp + jitter), RETRY_CONFIG.maxDelayMs);
}

/**
 * Ejecuta fn() con retry automático para errores 429 y 5xx.
 *
 * @param {() => Promise<any>} fn       - función async a ejecutar
 * @param {Object}             [context] - contexto extra para el log (módulo, operación…)
 * @returns {Promise<any>}
 *
 * @example
 * const result = await withRetry(
 *   () => hubspotClient.crm.tickets.basicApi.getById(id, props),
 *   { module: 'ticketService', fn: 'getTicket', ticketId: id }
 * );
 */
export async function withRetry(fn, context = {}) {
  const { maxRetries } = RETRY_CONFIG;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status     = extractStatus(err);
      const retryable  = isRetryable(status) || isTransientNetworkMessage(err);

      // No reintentar: error del caller (4xx ≠ 429) o ya agotamos reintentos
      if (!retryable || attempt === maxRetries) throw err;

      const retryAfter = err?.response?.headers?.['retry-after'] ?? null;
      const delay      = calcDelay(attempt, retryAfter);

      logger.warn(
        { ...context, status, attempt: attempt + 1, maxRetries, delayMs: delay },
        `[withRetry] HTTP ${status} → reintentando en ${delay}ms (${attempt + 1}/${maxRetries})`
      );

      await new Promise(r => setTimeout(r, delay));
    }
  }
}