// src/config/validateEnv.js
//
// Valida variables de entorno requeridas al arrancar.
// Llamar antes de cualquier operación para fallar rápido con un mensaje claro.

import logger from '../../lib/logger.js';

// Variables sin las que la app no puede funcionar en absoluto.
const REQUIRED = [
  'HUBSPOT_PRIVATE_TOKEN',
  'DATABASE_URL',
];

// Variables importantes: si faltan el sistema arranca pero en modo degradado.
// Se logean como warning para que el operador lo note.
const IMPORTANT = [
  'BILLING_TICKET_PIPELINE_ID',
  'BILLING_AUTOMATED_PIPELINE_ID',
  'BILLING_TICKET_STAGE_ID',
  'BILLING_AUTOMATED_READY',
  'DEAL_STAGE_85',
  'DEAL_STAGE_95',
  'BILLING_TZ',
];

export function validateEnv() {
  const missing = REQUIRED.filter(key => !process.env[key]);

  if (missing.length > 0) {
    const msg = `Variables de entorno requeridas no definidas: ${missing.join(', ')}`;
    logger.fatal({ missing }, msg);
    throw new Error(msg);
  }

  const degraded = IMPORTANT.filter(key => !process.env[key]);
  if (degraded.length > 0) {
    logger.warn({ degraded }, 'Variables de entorno importantes no definidas — el sistema puede operar en modo degradado');
  }
}
