// src/utils/cloneUtils.js
export function sanitizeLineItemIfCloned({ isCloned }) {
  if (!isCloned) return {};

  return {
    // Fechas/historial
    last_ticketed_date: '',
    billing_last_billed_date: '',
    billing_next_date: '',

    // Anchor (para forzar recalculo desde fecha_inicio_de_facturacion / start_date)
    billing_anchor_date: '',

    // Referencias potencialmente clonadas (si existen como propiedades en tu portal)
    invoice_id: '',
    invoice_key: '',
    of_invoice_id: '',
    of_invoice_key: '',
    of_invoice_status: '',
    of_ticket_id: '',
    of_ticket_key: '',

    // (Opcional) si querés matar calendario legacy:
    // fecha_2: '', fecha_3: '', fecha_4: '', ... etc
  };
}
