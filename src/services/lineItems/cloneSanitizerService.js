/**
 * cloneSanitizerService
 *
 * Limpia estado operativo de un Line Item cuando su line_item_key
 * NO le pertenece (key mismatch).
 *
 * Regla:
 * - Si NO hay line_item_key → no actúa
 * - Si la key existe pero apunta a otro lineItemId → SUCIO → limpiar
 * - Devuelve `updates` (NO hace writes)
 */

function parseLineItemKey(lineItemKey) {
  if (!lineItemKey) return null;

  // formato esperado: <dealId>:<lineItemId>:<rand>
  const parts = String(lineItemKey).split(':');
  if (parts.length < 2) return null;

  return {
    dealId: parts[0],
    lineItemId: parts[1],
  };
}

export function sanitizeClonedLineItem(
  lineItem,
  dealId,
  { debug = false } = {}
) {
  if (!lineItem?.properties) return null;

  const key = lineItem.properties.line_item_key;
  if (!key) return null;

  const parsed = parseLineItemKey(key);
  if (!parsed) return null;

  const keyMismatch =
    String(parsed.dealId) !== String(dealId) ||
    String(parsed.lineItemId) !== String(lineItem.id);

  if (!keyMismatch) return null;

const OPERATIVE_PROPS_TO_RESET = [
  'billing_anchor_date',
  'billing_next_date',
  'last_billing_period',
  'last_ticketed_date',
  'billing_error',
  'billing_status',
  'cantidad_de_facturaciones_urgentes',
  'invoice_id',
  'invoice_key',
  'of_invoice_id',
  'of_invoice_key',
  'of_ticket_id',
  'of_ticket_key',
  ];

  const updates = {};

  for (const prop of OPERATIVE_PROPS_TO_RESET) {
    if (lineItem.properties[prop]) {
      updates[prop] = '';
    }
  }

  if (Object.keys(updates).length === 0) return null;

  if (debug) {
    console.log('[cloneSanitizerService]', {
      lineItemId: lineItem.id,
      dealId,
      line_item_key: key,
      parsedKey: parsed,
      reason: 'LINE_ITEM_KEY_MISMATCH',
      resetProps: Object.keys(updates),
    });
  }

  return updates;
}
