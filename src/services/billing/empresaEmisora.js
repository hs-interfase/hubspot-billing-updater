// src/services/billing/empresaEmisora.js
//
// ÚNICA fuente del mapeo product_id → empresa emisora.
// Dedupe (2026-07-09): antes estaba COPIADO en buildMensajeFacturacion.js y
// buildMensajeMantsoft.js (valores idénticos) → riesgo de desincronización.
// Ahora ambos importan de acá. (Cada builder conserva su propio resolver: uno lee
// `producto_id` del ticket, el otro `hs_product_id` del line item.)
//
// POR PORTAL (2026-07-17): los product_id difieren entre prod y pruebas. IDs tomados
// de `PRODUCTS` de la migración (definitivos/4_PROGRAMAS/migracion_pasoA_dryrun.mjs),
// misma correspondencia sandbox↔prod que usó la carga. Se resuelve por HUBSPOT_ENV
// (sandbox=pruebas; cualquier otro/ausente = prod, default seguro).

export const EMPRESA_EMISORA_MAP_BY_ENV = {
  prod: {
    '33688819739': 'ISA',       // iGDoc
    '33695807329': 'ISA',       // Portal
    '33695559578': 'ISA',       // Flota
    '33688695870': 'ISA',       // iJServ
    '33688695865': 'Interfase', // PayRoll
    '33688819740': 'Interfase', // iSCert (INT → Interfase)
    '46035674794': 'ISA',       // iSCert ISA (split 13-jul, D §1: ISA Cert → ISA UY)
    '33695559590': 'ISA PY',    // i2
    '33688695889': 'ISA PY',    // MiRecibo
    '33695559589': 'ISA PY',    // MiFactura
    '33688943634': 'ISA PY',    // Proyectos
  },
  sandbox: {
    '42010367402': 'ISA',       // iGDoc
    '42010181660': 'ISA',       // Portal
    '41943895219': 'ISA',       // Flota
    '41943895217': 'ISA',       // iJServ
    '42010367404': 'Interfase', // PayRoll
    '41948442381': 'Interfase', // iSCert
    '46035551908': 'ISA',       // iSCert ISA
    '42010181658': 'ISA PY',    // i2
    '42004648587': 'ISA PY',    // MiRecibo
    '42010181659': 'ISA PY',    // MiFactura
    '41943709577': 'ISA PY',    // Proyectos
  },
};

const EMISORA_ENV = String(process.env.HUBSPOT_ENV || 'production').toLowerCase() === 'sandbox'
  ? 'sandbox' : 'prod';

// Mapa resuelto para ESTE entorno (product_id del portal actual → empresa emisora).
export const EMPRESA_EMISORA_MAP = EMPRESA_EMISORA_MAP_BY_ENV[EMISORA_ENV];
