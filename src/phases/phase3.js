// src/phases/phase3.js
//
// Fase 3: emisión de facturas.
// Este módulo se mantiene como stub porque la lógica de facturación
// (generación de invoices) no se refactoriza en esta entrega.
// Sirve de punto de integración para la futura Fase 3.

export async function runPhase3(dealId) {
  // Aquí iría la lógica de creación/emisión de facturas en HubSpot
  // a partir de los tickets de facturación. No se reimplementa en esta refactorización.
  console.log('[phase3] Fase 3 no implementada. dealId:', dealId);
  return {
    dealId,
    invoiceCreated: false,
  };
}
