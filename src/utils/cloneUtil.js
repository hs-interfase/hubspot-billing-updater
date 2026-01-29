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

function ymd(raw) {
  return (raw ?? '').toString().slice(0, 10);
}

function extractDateFromTicketKey(ticketKey) {
  const k = (ticketKey ?? '').toString().trim();
  if (!k) return '';
  const parts = k.split('::');
  // formato esperado: dealId::LI:123::YYYY-MM-DD  (o PYLI:xxx)
  const d = parts[parts.length - 1] || '';
  return ymd(d);
}

/**
 * Phase1 sanitizer (NUEVA regla):
 * - Si line item tiene of_ticket_key y el startDate del LI es POSTERIOR a la fecha del ticketKey,
 *   ese key no le pertenece (clon UI dentro del mismo deal) => limpiar fuerte.
 *
 * NO usa "last_ticketed_date > hoy" (eso queda eliminado).
 */
export function sanitizeLineItemDatesIfCloned(lineItem) {
  const p = lineItem?.properties || {};

  const startYMD =
    ymd(p.hs_recurring_billing_start_date) ||
    ymd(p.fecha_inicio_de_facturacion) ||
    ymd(p.recurringbillingstartdate);

  const ticketKey = (p.of_ticket_key ?? '').toString().trim();
  const keyDateYMD = extractDateFromTicketKey(ticketKey);

  // Si falta info, no inferimos clon acá (regla B: no complicar)
  if (!startYMD || !ticketKey || !keyDateYMD) return {};

  // ✅ CLON: start > keyDate (el ticketKey viene “arrastrado” del item viejo)
  if (startYMD > keyDateYMD) {
    return sanitizeLineItemIfCloned({ isCloned: true });
  }

  return {};
}


// src/utils/cloneUtils.js
// (usa tu extractLineIdFromTicketKey - si está en ticketService, copialo tal cual acá para evitar imports raros)

function extractLineIdFromTicketKey(ticketKey) {
  if (!ticketKey) return null;
  const parts = ticketKey.split('::');
  if (parts.length !== 3) return null;

  let lineIdPart = parts[1];
  if (lineIdPart.startsWith('PYLI:')) return lineIdPart;

  while (lineIdPart.startsWith('LI:')) lineIdPart = lineIdPart.substring(3);
  return lineIdPart;
}

export function sanitizeLineItemIfClonedByTicketKey(lineItem) {
  const p = lineItem?.properties || {};
  const liTicketKey = (p.of_ticket_key || '').trim();
  if (!liTicketKey) return {}; // Regla B: si no hay key, no decidimos

  const ticketLineId = extractLineIdFromTicketKey(liTicketKey);

  const expectedPy = p.of_line_item_py_origen_id
    ? `PYLI:${String(p.of_line_item_py_origen_id).trim()}`
    : null;

  const belongsByKey =
    ticketLineId === String(lineItem.id) ||
    (expectedPy && ticketLineId === expectedPy);

  const isCloned = !belongsByKey;
  return sanitizeLineItemIfCloned({ isCloned });
}
