// src/config/constants.js

/**
 * Constantes globales para el proyecto de facturación.
 * (stages/pipelines + helpers de semántica)
 */

// Lookahead para tickets manuales (30 días)
export const MANUAL_TICKET_LOOKAHEAD_DAYS = 30;

// ===============================
// Tickets MANUALES (pipeline + stages)
// ===============================
export const TICKET_PIPELINE =
  process.env.BILLING_TICKET_PIPELINE_ID || '832539959';

export const TICKET_STAGES = {
  NEW: process.env.BILLING_TICKET_STAGE_ID || '1234282360', // Nueva orden de facturación
  READY: process.env.BILLING_TICKET_STAGE_READY || '1250133337', // Lista para facturar (promoción manual)
  INVOICED: process.env.BILLING_TICKET_STAGE_ID_BILLED || '1234282361', // Facturado
  CANCELLED: process.env.BILLING_TICKET_STAGE_CANCELLED || '1234282363', // Pausado/Cancelado
};

// Manual forecast stages por bucket de deal stage (IDs reales)
export const BILLING_TICKET_FORECAST_25 = '1294744238';
export const BILLING_TICKET_FORECAST_50 = '1294744239';
export const BILLING_TICKET_FORECAST_75 = '1296492870';
export const BILLING_TICKET_FORECAST_95 = '1296492871';

export const FORECAST_MANUAL_STAGES = new Set([
  BILLING_TICKET_FORECAST_25,
  BILLING_TICKET_FORECAST_50,
  BILLING_TICKET_FORECAST_75,
  BILLING_TICKET_FORECAST_95,
]);

// ===============================
// Tickets AUTOMÁTICOS (pipeline + stages)
// ===============================
export const AUTOMATED_TICKET_PIPELINE =
  process.env.BILLING_AUTOMATED_PIPELINE_ID || '829156883';

// READY automático (promoción automática) — ID real
export const BILLING_AUTOMATED_READY =
  process.env.BILLING_AUTOMATED_READY || '1228755520';

// Auto forecast stages por bucket deal stage (IDs reales)
export const BILLING_AUTOMATED_FORECAST_25 = '1294745999';
export const BILLING_AUTOMATED_FORECAST_50 = '1294746000';
export const BILLING_AUTOMATED_FORECAST_75 = '1296489840';
export const BILLING_AUTOMATED_FORECAST_95 = '1296362566';

export const FORECAST_AUTO_STAGES = new Set([
  BILLING_AUTOMATED_FORECAST_25,
  BILLING_AUTOMATED_FORECAST_50,
  BILLING_AUTOMATED_FORECAST_75,
  BILLING_AUTOMATED_FORECAST_95,
]);

// Si tu código previo usaba este nombre, lo mantenemos como alias del "forecast inicial" automático.
export const AUTOMATED_TICKET_INITIAL_STAGE =
  process.env.BILLING_AUTOMATED_FORECAST || BILLING_AUTOMATED_FORECAST_25;

// ===============================
// Helpers semánticos
// ===============================

/**
 * Devuelve true si el ticket está todavía en FORECAST (promesa).
 * OJO: "promovido" (READY / AUTO_READY) debe devolver false.
 */
export function isForecastStage(stageId) {
  if (!stageId) return false;
  const id = String(stageId);
  return FORECAST_MANUAL_STAGES.has(id) || FORECAST_AUTO_STAGES.has(id);
}

/**
 * Alias por compatibilidad con lo que veníamos hablando.
 * (Si ya lo importaste en algún lado, no se rompe.)
 */
export function isForecastTicketStage(stageId) {
  return isForecastStage(stageId);
}

// ===============================
// Otros
// ===============================
export const DEFAULT_CURRENCY = 'USD';

// DRY RUN mode (evita crear recursos reales en HubSpot)
export const isDryRun = () => {
  return (process.env.DRY_RUN || '').toString().toLowerCase() === 'true';
};
