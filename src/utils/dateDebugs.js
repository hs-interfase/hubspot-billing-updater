// src/utils/dateDebug.js
import logger from '../../lib/logger.js';

export function logDateEnvOnce() {
  const tz = process.env.BILLING_TZ || "America/Montevideo";
  logger.info({ tz }, "[dates] BILLING_TZ");
  logger.info({ nowISO: new Date().toISOString() }, "[dates] server now ISO");
  logger.info({ tzOffsetMin: new Date().getTimezoneOffset() }, "[dates] server tz offset (min)");
}
