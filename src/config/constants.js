// src/config/constants.js

/**
 * Constantes globales para el proyecto de facturación.
 */

// Lookahead para tickets manuales (30 días)
export const MANUAL_TICKET_LOOKAHEAD_DAYS = 30;

// Pipeline y stages de tickets de facturación
export const TICKET_PIPELINE = process.env.BILLING_TICKET_PIPELINE_ID || '832539959';
export const TICKET_STAGES = {
  NEW: process.env.BILLING_TICKET_STAGE_ID || '1234282360',           // Nueva orden de facturación
  READY: process.env.BILLING_TICKET_STAGE_READY || '1250133337',      // Lista para facturar (día de facturación o un día antes)
  INVOICED: process.env.BILLING_TICKET_STAGE_ID_BILLED || '1234282361',  // Facturado (vendedor pidió facturar ahora)
  CANCELLED: process.env.BILLING_TICKET_STAGE_CANCELLED || '1234282363',   // Pausado/Cancelado (pausa o cierre perdido)
};

// Pipeline y stage para tickets automáticos
export const AUTOMATED_TICKET_PIPELINE = process.env.BILLING_AUTOMATED_PIPELINE_ID || '829156883';
export const AUTOMATED_TICKET_INITIAL_STAGE = process.env.BILLING_AUTOMATED_FORECAST || '1294745999';


// Moneda por defecto
export const DEFAULT_CURRENCY = 'USD';

// DRY RUN mode (evita crear recursos reales en HubSpot)
export const isDryRun = () => {
  return (process.env.DRY_RUN || '').toString().toLowerCase() === 'true';
};