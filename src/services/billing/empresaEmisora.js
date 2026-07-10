// src/services/billing/empresaEmisora.js
//
// ÚNICA fuente del mapeo product_id → empresa emisora.
// Dedupe (2026-07-09): antes estaba COPIADO en buildMensajeFacturacion.js y
// buildMensajeMantsoft.js (valores idénticos) → riesgo de desincronización.
// Ahora ambos importan de acá. (Cada builder conserva su propio resolver: uno lee
// `producto_id` del ticket, el otro `hs_product_id` del line item.)

export const EMPRESA_EMISORA_MAP = {
  '33688819739': 'ISA',       // iGdoc
  '33695807329': 'ISA',       // Portal
  '33695559578': 'ISA',       // Flota
  '33688695870': 'ISA',       // iJServ
  '33688695865': 'Interfase', // PayRoll
  '33688819740': 'Interfase', // iSCert
  '33695559590': 'ISA PY',    // i2
  '33688695889': 'ISA PY',    // MiRecibo
  '33695559589': 'ISA PY',    // MiFactura
  '33688943634': 'ISA PY',    // Proyectos
};
