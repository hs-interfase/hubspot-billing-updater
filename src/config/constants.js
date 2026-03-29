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
  process.env.BILLING_TICKET_PIPELINE_ID || '';

export const TICKET_STAGES = {
  NEW: process.env.BILLING_TICKET_STAGE_ID || '',
  READY: process.env.BILLING_TICKET_STAGE_READY || '',
  INVOICED: process.env.BILLING_TICKET_STAGE_ID_BILLED || '',
  CANCELLED: process.env.BILLING_TICKET_STAGE_CANCELLED || '',
};

// Alias de entrada para READY manual (compatibilidad)
export const BILLING_TICKET_STAGE_READY_ENTRY = TICKET_STAGES.READY;

// Manual forecast stages por bucket de deal stage
export const BILLING_TICKET_FORECAST =
  process.env.BILLING_TICKET_FORECAST || '';
export const BILLING_TICKET_FORECAST_50 =
  process.env.BILLING_TICKET_FORECAST_50 || '';
export const BILLING_TICKET_FORECAST_75 =
  process.env.BILLING_TICKET_FORECAST_75 || '';
export const BILLING_TICKET_FORECAST_85 =
  process.env.BILLING_TICKET_FORECAST_85 || '';
export const BILLING_TICKET_FORECAST_95 =
  process.env.BILLING_TICKET_FORECAST_95 || '';

export const FORECAST_MANUAL_STAGES = new Set([
  BILLING_TICKET_FORECAST,
  BILLING_TICKET_FORECAST_50,
  BILLING_TICKET_FORECAST_75,
  BILLING_TICKET_FORECAST_85,
  BILLING_TICKET_FORECAST_95,
]);

// ===============================
// Stages post-emisión — MANUALES
// ===============================
export const BILLING_TICKET_STAGE_ID_CREATED =
  process.env.BILLING_TICKET_STAGE_ID_CREATED || '';

export const BILLING_TICKET_STAGE_ID_LATE =
  process.env.BILLING_TICKET_STAGE_ID_LATE || '';

export const BILLING_TICKET_STAGE_ID_PAID =
  process.env.BILLING_TICKET_PIPELINE_ID_PAID || '';

// ===============================
// Tickets AUTOMÁTICOS (pipeline + stages)
// ===============================
export const AUTOMATED_TICKET_PIPELINE =
  process.env.BILLING_AUTOMATED_PIPELINE_ID || '';

// READY automático (promoción automática)
export const BILLING_AUTOMATED_READY =
  process.env.BILLING_AUTOMATED_READY || '';

// Auto forecast stages por bucket de deal stage
export const BILLING_AUTOMATED_FORECAST =
  process.env.BILLING_AUTOMATED_FORECAST || '';
export const BILLING_AUTOMATED_FORECAST_50 =
  process.env.BILLING_AUTOMATED_FORECAST_50 || '';
export const BILLING_AUTOMATED_FORECAST_75 =
  process.env.BILLING_AUTOMATED_FORECAST_75 || '';
export const BILLING_AUTOMATED_FORECAST_85 =
  process.env.BILLING_AUTOMATED_FORECAST_85 || '';
export const BILLING_AUTOMATED_FORECAST_95 =
  process.env.BILLING_AUTOMATED_FORECAST_95 || '';

export const BILLING_AUTOMATED_CANCELLED =
  process.env.BILLING_AUTOMATED_CANCELLED || '';

// ===============================
// Stages post-emisión — AUTOMÁTICOS
// ===============================
export const BILLING_AUTOMATED_CREATED =
  process.env.BILLING_AUTOMATED_CREATED || '';

export const BILLING_AUTOMATED_LATE =
  process.env.BILLING_AUTOMATED_LATE || '';

export const BILLING_AUTOMATED_PAID =
  process.env.BILLING_AUTOMATED_PAID || '';

// ===============================
// Sets de stages — FORECAST
// ===============================
export const FORECAST_AUTO_STAGES = new Set([
  BILLING_AUTOMATED_FORECAST,
  BILLING_AUTOMATED_FORECAST_50,
  BILLING_AUTOMATED_FORECAST_75,
  BILLING_AUTOMATED_FORECAST_85,
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
// Sets semánticos para conteo de facturas_restantes
// ===============================

/**
 * PENDING_STAGES: tickets que reservan una obligación pero aún no facturaron.
 * Incluye todos los forecast + ready de ambos pipelines.
 */
export const PENDING_STAGES = new Set([
  // Manual forecast
  ...FORECAST_MANUAL_STAGES,
  // Manual ready
  TICKET_STAGES.NEW,
  TICKET_STAGES.READY,
  // Auto forecast
  ...FORECAST_AUTO_STAGES,
  // Auto ready
  BILLING_AUTOMATED_READY,
]);

/**
 * INVOICED_STAGES: tickets que ya generaron factura (se descuentan del total de payments).
 * Excluye CANCELLED (no cuenta como facturado).
 */
export const INVOICED_STAGES = new Set([
  // Manual post-ready
  BILLING_TICKET_STAGE_ID_CREATED,
  TICKET_STAGES.INVOICED,
  BILLING_TICKET_STAGE_ID_LATE,
  BILLING_TICKET_STAGE_ID_PAID,
  // Auto post-ready
  BILLING_AUTOMATED_CREATED,
  BILLING_AUTOMATED_LATE,
  BILLING_AUTOMATED_PAID,
]);

/**
 * EMITTED_STAGES: tickets con factura confirmada por Nodum.
 * Usado para promoción de deal 85% → 95%.
 * Excluye CREATED (factura HubSpot sin confirmación Nodum).
 */
export const EMITTED_STAGES = new Set([
  // Manual
  TICKET_STAGES.INVOICED,
  BILLING_TICKET_STAGE_ID_LATE,
  BILLING_TICKET_STAGE_ID_PAID,
  // Auto
  BILLING_AUTOMATED_LATE,
  BILLING_AUTOMATED_PAID,
]);

/**
 * COMPLETED_STAGES: tickets completamente pagados.
 * Usado para short-circuit en line items de 1 solo pago.
 */
export const COMPLETED_STAGES = new Set([
  BILLING_TICKET_STAGE_ID_PAID,
  BILLING_AUTOMATED_PAID,
]);

// ===============================
// Deal stages — pipeline de negocio
// ===============================
export const DEAL_STAGE_WON          = process.env.DEAL_STAGE_85  || 'closedwon';
export const DEAL_STAGE_EN_EJECUCION = process.env.DEAL_STAGE_95  || '';
export const DEAL_STAGE_FINALIZADO   = process.env.DEAL_STAGE_100 || '';
export const DEAL_STAGE_SUSPENDED    = process.env.DEAL_STAGE_SUSPENDED || '';
export const DEAL_STAGE_VOIDED       = process.env.DEAL_STAGE_VOIDED   || '';

// Stages activos para billing (bucket 95)
export const BILLING_ACTIVE_DEAL_STAGES = new Set([
  DEAL_STAGE_WON,
  DEAL_STAGE_EN_EJECUCION,
  DEAL_STAGE_FINALIZADO,
]);

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
 * FORECAST_TICKET_STAGES: unión de todos los stages forecast (manual + auto).
 * Usado para derivar billing_next_date desde tickets reales.
 */
export const FORECAST_TICKET_STAGES = new Set([
  ...FORECAST_MANUAL_STAGES,
  ...FORECAST_AUTO_STAGES,
]);

/**
 * Alias por compatibilidad con lo que veníamos hablando.
 */
export function isForecastTicketStage(stageId) {
  return isForecastStage(stageId);
}

/**
 * Devuelve true si el stage corresponde a un ticket ya facturado
 * (post-READY, excluyendo CANCELLED).
 */
export function isInvoicedStage(stageId) {
  if (!stageId) return false;
  return INVOICED_STAGES.has(String(stageId));
}

/**
 * Devuelve true si el stage indica pago completado.
 */
export function isCompletedStage(stageId) {
  if (!stageId) return false;
  return COMPLETED_STAGES.has(String(stageId));
}

// ===============================
// Otros
// ===============================
export const DEFAULT_CURRENCY = 'USD';

// DRY RUN mode (evita crear recursos reales en HubSpot)
export const isDryRun = () => {
  return (process.env.DRY_RUN || '').toString().toLowerCase() === 'true';
};

// Lookback para el cron (días hacia atrás en hs_lastmodifieddate)
export const CRON_LOOKBACK_DAYS = parseInt(process.env.CRON_LOOKBACK_DAYS || '3', 10);