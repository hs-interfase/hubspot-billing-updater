// src/utils/ticketKey.js

const SEP = '::';

function isYMD(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function toStr(v) {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

// --- CANONICAL ONLY ---
export function buildTicketKeyFromLineItemKey(dealId, lineItemKey, ymd) {
  const d = toStr(dealId);
  const k = toStr(lineItemKey);
  const date = toStr(ymd);
  if (!d) throw new Error('buildTicketKeyFromLineItemKey: dealId requerido');
  if (!k) throw new Error('buildTicketKeyFromLineItemKey: lineItemKey requerido');
  if (!date) throw new Error('buildTicketKeyFromLineItemKey: ymd requerido');
  if (!isYMD(date)) {
    throw new Error(`buildTicketKeyFromLineItemKey: ymd inválido "${date}" (esperado YYYY-MM-DD)`);
  }
  return `${d}${SEP}LIK:${k}${SEP}${date}`;
}

// --- DISABLE LEGACY ---
export function buildTicketKeyFromStableLineId() {
  throw new Error('[legacy disabled] use LIK');
}
export function buildTicketKeyFromLineItemId() {
  throw new Error('[legacy disabled] use LIK');
}

// Parser mínimo para logs/debug.
export function parseTicketKeyFromLineItemKey(ticketKey) {
  const raw = toStr(ticketKey);
  if (!raw) return { ok: false, reason: 'empty' };
  const parts = raw.split(SEP);
  if (parts.length !== 3) return { ok: false, reason: 'bad_parts' };
  const dealId = parts[0];
  const mid = parts[1] || '';
  const ymd = parts[2];
  if (!mid.startsWith('LIK:')) return { ok: false, reason: 'missing_LIK_prefix' };
  const lineItemKey = mid.slice('LIK:'.length);
  if (!dealId || !lineItemKey || !isYMD(ymd)) return { ok: false, reason: 'invalid_fields' };
  const canonical = buildTicketKeyFromLineItemKey(dealId, lineItemKey, ymd);
  return { ok: true, dealId, lineItemKey, ymd, canonical };
}

