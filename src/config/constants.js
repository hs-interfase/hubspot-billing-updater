// src/config/constants.js

/**
 * Constantes globales para el proyecto de facturación.
 */

// Lookahead para tickets manuales (30 días)
export const MANUAL_TICKET_LOOKAHEAD_DAYS = 30;

// Pipeline y stages de tickets (ajusta según tu portal)
export const TICKET_PIPELINE = '0'; // ID del pipeline de tickets
export const TICKET_STAGES = {
  NEW: '1',           // Nueva orden de facturación
  IN_REVIEW: '2',     // En revisión
  READY: '3',         // Lista para facturar
  INVOICED: '4',      // Facturada
  CANCELLED: '999',   // Cancelada
};

// Moneda por defecto
export const DEFAULT_CURRENCY = 'USD';

// DRY RUN mode (evita crear recursos reales en HubSpot)
export const isDryRun = () => {
  return (process.env.DRY_RUN || '').toString().toLowerCase() === 'true';
};
