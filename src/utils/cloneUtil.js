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
       // --- IRREGULAR (clave para tu caso) ---
    irregular: '',
    fecha_irregular_puntual: '',

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

// LEGACY: NO lo borres, Phase1 lo está importando
export function sanitizeLineItemDatesIfCloned(lineItem) {
  const props = lineItem?.properties || {};
  const lastTicketed = (props.last_ticketed_date || '').slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);

  if (lastTicketed && lastTicketed > today) {
    return {
      last_ticketed_date: '',
      billing_last_billed_date: '',
      billing_next_date: '',
      // ojo: Phase1 probablemente NO deba limpiar anchor acá
      // lo dejamos como estaba para no cambiar comportamiento
    };
  }
  return {};
}
