// src/config/constants.js

/**
 * Constantes globales para el proyecto de facturación.
 * (stages/pipelines + helpers de semántica)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * MAPA DE STAGES Y SU SEMÁNTICA (leer antes de modificar)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * PIPELINE MANUAL (TICKET_PIPELINE / BILLING_TICKET_PIPELINE_ID)
 * ──────────────────────────────────────────────────────────────
 * FORECAST stages (BILLING_TICKET_FORECAST / _50 / _75 / _85 / _95)
 *   → "Promesas de facturación". Uno por cada bucket de probabilidad del deal.
 *     Se crean en Phase P. No se tocan hasta que Phase 2 los promueve.
 *
 * TICKET_STAGES.NEW  (env: BILLING_TICKET_STAGE_ID)
 *   → "PRÓXIMOS A FACTURAR" (manual).
 *     Phase 2 promueve el ticket forecast aquí cuando faltan ≤30 días para facturar.
 *     Queda EDITABLE por el equipo de administración durante esa ventana.
 *     ⚠️  En phase2.js se llama localmente BILLING_TICKET_STAGE_READY_ENTRY
 *         pero apunta a TICKET_STAGES.NEW — no confundir con TICKET_STAGES.READY.
 *
 * TICKET_STAGES.READY  (env: BILLING_TICKET_STAGE_READY)
 *   → "LISTO PARA FACTURAR" (manual).
 *     El admin mueve el ticket aquí cuando está confirmado para emitir factura.
 *     La función legacy emitInvoicesForReadyTickets() (invoices.js) busca tickets
 *     en este stage para crear la factura ficticia en HubSpot.
 *     Exportado también como TICKET_STAGE_LISTO_MANUAL (alias explícito).
 *
 * TICKET_STAGES.INVOICED  (env: BILLING_TICKET_STAGE_ID_BILLED)
 *   → "EMITIDO" (manual). Admin confirma que Nodum emitió la factura real.
 *
 * TICKET_STAGES.CANCELLED  (env: BILLING_TICKET_STAGE_CANCELLED)
 *   → "CANCELADO" (manual).
 *
 * PIPELINE AUTOMÁTICO (AUTOMATED_TICKET_PIPELINE / BILLING_AUTOMATED_PIPELINE_ID)
 * ────────────────────────────────────────────────────────────────────────────────
 * FORECAST stages (BILLING_AUTOMATED_FORECAST / _50 / _75 / _85 / _95)
 *   → Equivalentes a los manuales pero en el pipeline automático.
 *
 * BILLING_AUTOMATED_READY  (env: BILLING_AUTOMATED_READY)
 *   → "LISTO PARA FACTURAR" (automático).
 *     Phase 3 promueve aquí cuando planYMD ≤ HOY y emite la factura ficticia
 *     en el mismo paso. No hay etapa intermedia editable.
 *     ⚠️  A diferencia del pipeline manual, aquí no existe el concepto de
 *         "próximos a facturar" separado: el ticket pasa directo de forecast a
 *         ready+factura en una sola operación.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PUNTOS DE MEZCLA CONOCIDOS
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. El término "READY" en el código puede referirse a dos cosas distintas:
 *    - TICKET_STAGES.NEW: "Próximos a Facturar" — Phase 2 promueve aquí
 *    - TICKET_STAGES.READY / TICKET_STAGE_LISTO_MANUAL: "Listo para Facturar" — admin confirma
 *    Usar siempre los alias explícitos (PROXIMOS_A_FACTURAR_STAGE, TICKET_STAGE_LISTO_MANUAL)
 *    en lugar de TICKET_STAGES.NEW / TICKET_STAGES.READY directamente.
 *
 * 2. El pipeline automático NO tiene etapa "Próximos a Facturar": Phase 3 promueve
 *    directo a BILLING_AUTOMATED_READY y emite la factura en el mismo paso.
 * ─────────────────────────────────────────────────────────────────────────────
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
  // "Próximos a Facturar": Phase 2 promueve aquí cuando faltan ≤30 días.
  // Editable por administración durante esa ventana.
  // Usar el alias PROXIMOS_A_FACTURAR_STAGE para mayor claridad.
  NEW: process.env.BILLING_TICKET_STAGE_ID || '',

  // "Listo para Facturar": el admin mueve el ticket aquí cuando confirma emisión.
  // La función emitInvoicesForReadyTickets() (invoices.js, legacy) lee este stage.
  // Usar el alias TICKET_STAGE_LISTO_MANUAL para mayor claridad.
  READY: process.env.BILLING_TICKET_STAGE_READY || '',

  // "Emitido": Nodum confirmó la factura real. Cuenta en EMITTED_STAGES.
  INVOICED: process.env.BILLING_TICKET_STAGE_ID_BILLED || '',

  CANCELLED: process.env.BILLING_TICKET_STAGE_CANCELLED || '',
};

// Alias explícitos para eliminar ambigüedad en el código:
// Usar estos en lugar de TICKET_STAGES.NEW / TICKET_STAGES.READY directamente.
export const PROXIMOS_A_FACTURAR_STAGE = TICKET_STAGES.NEW;    // Phase 2 promueve aquí
export const TICKET_STAGE_LISTO_MANUAL = TICKET_STAGES.READY;  // Admin confirma, emitInvoicesForReadyTickets lee aquí

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

// "Listo para Facturar" automático.
// Phase 3 promueve aquí y emite la factura ficticia en el mismo paso.
// ⚠️  A diferencia del pipeline manual, NO existe una etapa intermedia
//     de "Próximos a Facturar": el ticket pasa directo de forecast a ready+factura.
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
 * Incluye todos los stages pre-factura de ambos pipelines.
 */
export const PENDING_STAGES = new Set([
  // Manual — promesas (forecast)
  ...FORECAST_MANUAL_STAGES,
  // Manual — "Próximos a Facturar" (Phase 2 promueve aquí ≤30 días antes)
  TICKET_STAGES.NEW,
  // Manual — "Listo para Facturar" (admin confirma, espera emisión)
  TICKET_STAGES.READY,
  // Auto — promesas (forecast)
  ...FORECAST_AUTO_STAGES,
  // Auto — "Listo para Facturar" auto (Phase 3 promueve aquí y emite de inmediato)
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

/**
 * PROMOTED_STAGES: tickets que ya salieron del forecast (promovidos o más allá).
 * Usado por recalcFromTickets para calcular last_ticketed_date.
 * Excluye stages FORECAST y CANCELLED.
 */
export const PROMOTED_STAGES = new Set([
  // Manual — "Próximos a Facturar" (Phase 2 promovió desde forecast)
  TICKET_STAGES.NEW,
  // Manual — "Listo para Facturar" (admin confirmó)
  TICKET_STAGES.READY,
  // Manual — post-emisión
  BILLING_TICKET_STAGE_ID_CREATED,
  TICKET_STAGES.INVOICED,
  BILLING_TICKET_STAGE_ID_LATE,
  BILLING_TICKET_STAGE_ID_PAID,
  // Auto — "Listo para Facturar" auto (Phase 3 promovió y emitió)
  BILLING_AUTOMATED_READY,
  // Auto — post-emisión
  BILLING_AUTOMATED_CREATED,
  BILLING_AUTOMATED_LATE,
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

// Al final del archivo, antes del cierre
export const INVOICED_TICKET_STAGES = new Set([
  process.env.BILLING_TICKET_STAGE_ID_BILLED,
  process.env.BILLING_TICKET_STAGE_ID_LATE,
  process.env.BILLING_TICKET_PIPELINE_ID_PAID,
  process.env.BILLING_AUTOMATED_CREATED,
  process.env.BILLING_AUTOMATED_LATE,
  process.env.BILLING_AUTOMATED_PAID,
].filter(Boolean));

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