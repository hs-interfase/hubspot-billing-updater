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
 * canonicalizeLineItemId(raw)
 * Normaliza IDs legacy (no LIK) removiendo prefijos repetidos "LI:".
 *
 * Ejemplos:
 *   "123"        -> "123"
 *   "LI:123"     -> "123"
 *   "LI:LI:123"  -> "123"
 */
export function canonicalizeLineItemId(raw) {
  let s = toStr(raw);
  if (!s) return s;

  while (s.startsWith("LI:")) {
    s = s.substring(3).trim();
  }
  return s;
}

/**
 * canonicalizeLik(raw)
 * Para LIK NO tocamos nada salvo trim.
 * (Si querés namespace, que sea parte del valor, ej "PY:<uuid>" o "UY:<uuid>")
 */
export function canonicalizeLik(raw) {
  return toStr(raw);
}

/**
 * buildInvoiceKeyFromLIK(dealId, lik, ymd)
 * ✅ CANONICAL FORMAT: <dealId>::LIK:<lik>::<YYYY-MM-DD>
 */
export function buildInvoiceKeyFromLIK(dealId, lik, ymd) {
  const d = toStr(dealId);
  const k = canonicalizeLik(lik);
  const date = toStr(ymd);

  if (!d) throw new Error("buildInvoiceKeyFromLIK: dealId requerido");
  if (!k) throw new Error("buildInvoiceKeyFromLIK: lik requerido");
  if (!date) throw new Error("buildInvoiceKeyFromLIK: ymd requerido");
  if (!isYMD(date)) {
    throw new Error(`buildInvoiceKeyFromLIK: ymd inválido "${date}" (esperado YYYY-MM-DD)`);
  }

  return `${d}${SEP}LIK:${k}${SEP}${date}`;
}

/**
 * buildInvoiceKeyFromLineItemId(dealId, lineItemId, ymd)
 * LEGACY DISABLED: always throws
 */
export function buildInvoiceKeyFromLineItemId() {
  throw new Error('[legacy disabled] invoiceKey must use LIK');
}

/**
 * buildInvoiceKey(dealId, idValue, ymd, opts?)
 * Wrapper para no romper imports existentes.
 *
 * - Por defecto asume LIK (nuevo mundo).
 * - Si pasás opts.idType = "LI" usa lineItemId legacy.
 *
 * Ej:
 *  buildInvoiceKey(dealId, lik, ymd) -> LIK
 *  buildInvoiceKey(dealId, lineItemId, ymd, { idType:"LI" }) -> legacy
 */
export function buildInvoiceKey(dealId, idValue, ymd, opts = {}) {
  const idType = toStr(opts.idType).toUpperCase();
  if (idType === "LI") throw new Error('[legacy disabled] use LIK');
  // default: LIK
  return buildInvoiceKeyFromLIK(dealId, idValue, ymd);
}

/**
 * parseInvoiceKey(raw)
 *
 * Acepta:
 *  - "deal::LIK:<lik>::YYYY-MM-DD"   (nuevo)
 *  - "deal::LI:<id>::YYYY-MM-DD"     (legacy)
 *  - "deal::id::YYYY-MM-DD"          (legacy viejo sin tipo)
 *  - con separador "|" en vez de "::"
 *
 * Retorna:
 *  - { ok:true, dealId, idType, idValue, ymd, canonical }
 *  - { ok:false, reason }
 */
export function parseInvoiceKey(raw) {
  const s = toStr(raw);
  if (!s) return { ok: false, reason: "empty" };

  let parts = null;

  if (s.includes(SEP)) parts = s.split(SEP);
  else if (s.includes("|")) parts = s.split("|");

  if (!parts || parts.length !== 3) return { ok: false, reason: "bad_format" };

  const dealId = toStr(parts[0]);
  const middle = toStr(parts[1]);
  const ymd = toStr(parts[2]);

  if (!dealId) return { ok: false, reason: "missing_dealId" };
  if (!middle) return { ok: false, reason: "missing_id" };
  if (!ymd) return { ok: false, reason: "missing_ymd" };
  if (!isYMD(ymd)) return { ok: false, reason: "bad_ymd" };

  // Detectar tipo
  let idType = null;
  let idValue = null;

  if (middle.startsWith("LIK:")) {
    idType = "LIK";
    idValue = canonicalizeLik(middle.substring(4));
  } else {
    throw new Error('[legacy disabled] use LIK');
  }

  if (!idValue) return { ok: false, reason: "missing_idValue" };

  const canonical = buildInvoiceKeyFromLIK(dealId, idValue, ymd);
  return { ok: true, dealId, idType, idValue, ymd, canonical };
}

/**
 * invoiceKeyMatchesContext(raw, ctx)
 *
 * ctx puede ser:
 *  - { dealId, lik }        (nuevo)
 *  - { dealId, lineItemId } (legacy)
 *
 * Retorna:
 *  - { ok:true, parsed }
 *  - { ok:false, reason, parsed? }
 */
export function invoiceKeyMatchesContext(raw, ctx = {}) {
  const parsed = parseInvoiceKey(raw);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };

  const d = toStr(ctx.dealId);
  if (!d) return { ok: false, reason: "missing_ctx_dealId", parsed };

  if (parsed.dealId !== d) return { ok: false, reason: "mismatch_dealId", parsed };

  // Preferir LIK si está presente en contexto
  const lik = toStr(ctx.lik || ctx.lineItemKey || ctx.of_line_item_key);
  if (lik) {
    if (parsed.idType !== "LIK") return { ok: false, reason: "mismatch_idType_expected_LIK", parsed };
    if (parsed.idValue !== canonicalizeLik(lik)) return { ok: false, reason: "mismatch_lik", parsed };
    return { ok: true, parsed };
  }

  // fallback legacy: lineItemId
  const li = toStr(ctx.lineItemId || ctx.line_item_id);
  if (li) {
    if (parsed.idType !== "LI") return { ok: false, reason: "mismatch_idType_expected_LI", parsed };
    if (parsed.idValue !== canonicalizeLineItemId(li)) return { ok: false, reason: "mismatch_lineItemId", parsed };
    return { ok: true, parsed };
  }

  return { ok: false, reason: "missing_ctx_id", parsed };
}
