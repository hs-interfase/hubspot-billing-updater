// src/config/constants.js

/**
 * Constantes globales para el proyecto de facturación.
 * (stages/pipelines + helpers de semántica)
 */

export const DEAL_STAGE_LOST = process.env.DEAL_STAGE_LOST || 'closedlost';

// Lookahead para tickets manuales (30 días)
export const MANUAL_TICKET_LOOKAHEAD_DAYS = 30;

// ===============================
// Tickets MANUALES (pipeline + stages)
// ===============================
export const TICKET_PIPELINE =
  process.env.BILLING_TICKET_PIPELINE_ID || '875213463';

export const TICKET_STAGES = {
  NEW: process.env.BILLING_TICKET_STAGE_ID || '1311451807', // Nueva orden de facturación
  READY: process.env.BILLING_TICKET_STAGE_READY || '1311451808', // Lista para facturar (promoción manual)
  INVOICED: process.env.BILLING_TICKET_STAGE_ID_BILLED || '1311451809', // Facturado
  CANCELLED: process.env.BILLING_TICKET_STAGE_CANCELLED || '1311451813', // Pausado/Cancelado
};

// Manual forecast stages por bucket de deal stage
export const BILLING_TICKET_FORECAST =
  process.env.BILLING_TICKET_FORECAST || '1311451803';
export const BILLING_TICKET_FORECAST_50 =
  process.env.BILLING_TICKET_FORECAST_50 || '1311451804';
export const BILLING_TICKET_FORECAST_75 =
  process.env.BILLING_TICKET_FORECAST_75 || '1311451805';
export const BILLING_TICKET_FORECAST_95 =
  process.env.BILLING_TICKET_FORECAST_95 || '1311451806';

export const FORECAST_MANUAL_STAGES = new Set([
  BILLING_TICKET_FORECAST,
  BILLING_TICKET_FORECAST_50,
  BILLING_TICKET_FORECAST_75,
  BILLING_TICKET_FORECAST_95,
]);

// ===============================
// Tickets AUTOMÁTICOS (pipeline + stages)
// ===============================
export const AUTOMATED_TICKET_PIPELINE =
  process.env.BILLING_AUTOMATED_PIPELINE_ID || '875177783';

// READY automático (promoción automática)
export const BILLING_AUTOMATED_READY =
  process.env.BILLING_AUTOMATED_READY || '1311404151';

// Auto forecast stages por bucket de deal stage
export const BILLING_AUTOMATED_FORECAST =
  process.env.BILLING_AUTOMATED_FORECAST || '1311404147';
export const BILLING_AUTOMATED_FORECAST_50 =
  process.env.BILLING_AUTOMATED_FORECAST_50 || '1311404148';
export const BILLING_AUTOMATED_FORECAST_75 =
  process.env.BILLING_AUTOMATED_FORECAST_75 || '1311404149';
export const BILLING_AUTOMATED_FORECAST_95 =
  process.env.BILLING_AUTOMATED_FORECAST_95 || '1311404150';

export const BILLING_AUTOMATED_CANCELLED =
  process.env.BILLING_AUTOMATED_CANCELLED || '1311404155';

export const FORECAST_AUTO_STAGES = new Set([
  BILLING_AUTOMATED_FORECAST,
  BILLING_AUTOMATED_FORECAST_50,
  BILLING_AUTOMATED_FORECAST_75,
  BILLING_AUTOMATED_FORECAST_95,
]);

// Alias por compatibilidad
export const AUTOMATED_TICKET_INITIAL_STAGE =
  process.env.BILLING_AUTOMATED_FORECAST || BILLING_AUTOMATED_FORECAST;

// Map de pipeline → stage de cancelación (usado en cancelForecastTickets)
export const CANCELLED_STAGE_BY_PIPELINE = {
  [TICKET_PIPELINE]: TICKET_STAGES.CANCELLED,
  [AUTOMATED_TICKET_PIPELINE]: BILLING_AUTOMATED_CANCELLED,
};

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