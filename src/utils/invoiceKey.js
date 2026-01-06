// src/utils/invoiceKey.js

const SEP = "::";

function toStr(v) {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

function isYMD(ymd) {
  return /^\d{4}-\d{2}-\d{2}$/.test(ymd);
}

/**
 * buildInvoiceKey(dealId, lineItemId, ymd)
 * Canonical format: <dealId>::<lineItemId>::<YYYY-MM-DD>
 */
export function buildInvoiceKey(dealId, lineItemId, ymd) {
  const d = toStr(dealId);
  const li = toStr(lineItemId);
  const date = toStr(ymd);

  if (!d) throw new Error("buildInvoiceKey: dealId requerido");
  if (!li) throw new Error("buildInvoiceKey: lineItemId requerido");
  if (!date) throw new Error("buildInvoiceKey: ymd requerido");
  if (!isYMD(date)) throw new Error(`buildInvoiceKey: ymd inválido "${date}" (esperado YYYY-MM-DD)`);

  return `${d}${SEP}${li}${SEP}${date}`;
}

/**
 * parseInvoiceKey(raw)
 * Accepts: "deal::li::YYYY-MM-DD" (canonical), also ":" or "|" as separators.
 * Returns:
 *  - { ok:true, dealId, lineItemId, ymd, canonical }
 *  - { ok:false, reason }
 */
export function parseInvoiceKey(raw) {
  const s = toStr(raw);
  if (!s) return { ok: false, reason: "empty" };

  let parts = null;

  if (s.includes(SEP)) parts = s.split(SEP);
  else if (s.includes("|")) parts = s.split("|");
  else if (s.includes(":")) parts = s.split(":");

  if (!parts || parts.length !== 3) return { ok: false, reason: "bad_format" };

  const dealId = toStr(parts[0]);
  const lineItemId = toStr(parts[1]);
  const ymd = toStr(parts[2]);

  if (!dealId) return { ok: false, reason: "missing_dealId" };
  if (!lineItemId) return { ok: false, reason: "missing_lineItemId" };
  if (!ymd) return { ok: false, reason: "missing_ymd" };
  if (!isYMD(ymd)) return { ok: false, reason: "bad_ymd" };

  const canonical = `${dealId}${SEP}${lineItemId}${SEP}${ymd}`;
  return { ok: true, dealId, lineItemId, ymd, canonical };
}

/**
 * invoiceKeyMatchesContext(raw, dealId, lineItemId)
 * Checks if raw invoice key belongs to the given dealId + lineItemId.
 * Returns:
 *  - { ok:true, parsed }
 *  - { ok:false, reason, parsed? }
 */
export function invoiceKeyMatchesContext(raw, dealId, lineItemId) {
  const parsed = parseInvoiceKey(raw);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };

  const d = toStr(dealId);
  const li = toStr(lineItemId);

  if (parsed.dealId !== d || parsed.lineItemId !== li) {
    return { ok: false, reason: "mismatch_context", parsed };
  }

  return { ok: true, parsed };
}
