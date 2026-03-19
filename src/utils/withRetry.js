// src/utils/withRetry.js

import logger from '../../lib/logger.js';

export const RETRY_CONFIG = {
  maxRetries:   4,
  baseDelayMs:  500,
  maxDelayMs:   10_000,
  jitterFactor: 0.3,
};

/**
 * Devuelve true si el status HTTP justifica un reintento.
 * - 429  → rate limit (secondly o daily)
 * - 5xx  → error transitorio de HubSpot
 * - 4xx ≠ 429 → error del caller, no reintentar
 */
export function isRetryable(status) {
  return status === 429 || (status >= 500 && status < 600);
}

/** Extrae el status HTTP de cualquier forma que lo arroje el SDK o axios */
export function extractStatus(err) {
  return err?.response?.status ?? err?.statusCode ?? err?.status ?? err?.code ?? null;
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
      const retryable  = isRetryable(status);

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