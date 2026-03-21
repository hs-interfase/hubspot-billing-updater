// src/utils/hubspotErrorCollector.js
import { hubspotClient } from "../hubspotClient.js";

// ---- Config ----
const FLUSH_MS = Number(process.env.BILLING_ERR_FLUSH_MS || 1500);
const MAX_PROP_LEN = Number(process.env.BILLING_ERR_MAX_LEN || 6500); // ojo límites HS
const MAX_LINES = Number(process.env.BILLING_ERR_MAX_LINES || 30);

// Cola: key = `${objectType}:${objectId}` -> { lines: [], timer: null, flushing: false }
const queue = new Map();

// Para evitar loops si HubSpot falla y eso se vuelve a reportar:
let isInternalReporting = false;

/** Saca strings "humanas" de input */
function formatArgs(args) {
  return args
    .map((a) => {
      if (a instanceof Error) return `${a.name}: ${a.message}`;
      if (typeof a === "string") return a;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(" ");
}

function normalizeType(t) {
  const s = String(t).toLowerCase().trim();
  if (s === "lineitem" || s === "line_item" || s === "line item") return "line_item";
  if (s === "ticket") return "ticket";
  return s;
}

function getPropForType(objectType) {
  if (objectType === "ticket") return "of_billing_error";
  if (objectType === "line_item") return "billing_error";
  return null;
}

function nowStamp() {
  return new Date().toISOString();
}

/** Reduce líneas, corta largo, etc. */
function compactLines(lines) {
  const trimmed = lines.slice(-MAX_LINES); // últimas N
  let joined = trimmed.join("\n");
  if (joined.length > MAX_PROP_LEN) {
    joined = joined.slice(joined.length - MAX_PROP_LEN);
    const idx = joined.indexOf("\n");
    if (idx > 0) joined = joined.slice(idx + 1);
  }
  return joined;
}

/**
 * Detecta contexto (objectType/objectId) desde:
 * - meta: { objectType, objectId } (preferido)
 * - o patrones en texto: ticketId, lineItemId, etc.
 */
function detectContextFromText(text) {
  const ticketMatch =
    text.match(/ticket(?:Id|_id)?[:=\s]+(\d+)/i) ||
    text.match(/objectType[:=\s]+"?ticket"?[,\s]+objectId[:=\s]+"?(\d+)/i);

  if (ticketMatch) return { objectType: "ticket", objectId: ticketMatch[1] };

  const liMatch =
    text.match(/line[_\s-]?item(?:Id|_id)?[:=\s]+(\d+)/i) ||
    text.match(/lineItemId[:=\s]+(\d+)/i) ||
    text.match(/objectType[:=\s]+"?line_item"?[,\s]+objectId[:=\s]+"?(\d+)/i);

  if (liMatch) return { objectType: "line_item", objectId: liMatch[1] };

  return null;
}

/** Lee el valor actual y le agrega líneas nuevas. */
async function appendToHubSpotProperty({ objectType, objectId, prop, newLines }) {
  let current = "";
  if (objectType === "ticket") {
    const r = await hubspotClient.crm.tickets.basicApi.getById(objectId, [prop]);
    current = r?.properties?.[prop] || "";
  } else if (objectType === "line_item") {
    const r = await hubspotClient.crm.lineItems.basicApi.getById(objectId, [prop]);
    current = r?.properties?.[prop] || "";
  } else {
    return;
  }

  const merged = compactLines([current, ...newLines].filter(Boolean).join("\n").split("\n"));

  const payload = { properties: { [prop]: merged } };

  if (objectType === "ticket") {
    await hubspotClient.crm.tickets.basicApi.update(objectId, payload);
  } else if (objectType === "line_item") {
    await hubspotClient.crm.lineItems.basicApi.update(objectId, payload);
  }
}

async function flushKey(key) {
  const item = queue.get(key);
  if (!item || item.flushing) return;
  item.flushing = true;

  try {
    const [objectType, objectId] = key.split(":");
    const prop = getPropForType(objectType);
    if (!prop) return;

    const lines = item.lines.splice(0, item.lines.length);
    if (!lines.length) return;

    await appendToHubSpotProperty({ objectType, objectId, prop, newLines: lines });
  } catch (e) {
    // ⚠️ INTENCIONAL: NO usar logger aquí para evitar dependencia circular
    // (este módulo es la base del sistema de reporte; logger depende de él
    // indirectamente). console.error es la única salida segura en este catch.
    isInternalReporting = true;
    try {
      // eslint-disable-next-line no-console
      console.error("[hubspotErrorCollector][flush] failed:", e?.message || e);
    } finally {
      isInternalReporting = false;
    }
  } finally {
    item.flushing = false;
  }
}

function scheduleFlush(key) {
  const item = queue.get(key);
  if (!item) return;
  if (item.timer) return;

  item.timer = setTimeout(async () => {
    item.timer = null;
    await flushKey(key);
  }, FLUSH_MS);
}

function enqueue({ level, objectType, objectId, message }) {
  const key = `${objectType}:${objectId}`;
  if (!queue.has(key)) queue.set(key, { lines: [], timer: null, flushing: false });

  const item = queue.get(key);

  const line = `${nowStamp()} ${String(level).toUpperCase()}: ${message}`;
  const last = item.lines[item.lines.length - 1];
  if (last === line) return;

  item.lines.push(line);
  scheduleFlush(key);
}

/**
 * API NUEVA: reportar un warning/error asociado a un objeto HubSpot.
 *
 * Uso recomendado (explícito):
 *   reportHubSpotError({
 *     level: "error",
 *     objectType: "ticket",
 *     objectId: ticketId,
 *     message: "No se pudo actualizar ticket ..."
 *   })
 *
 * Uso con meta + args estilo console:
 *   reportHubSpotError({ meta: { objectType:"ticket", objectId: id }, args:[err, "msg"] })
 */
export function reportHubSpotError(input = {}) {
  if (isInternalReporting) return;

  try {
    const level = input.level || "error";

    // 1) contexto explícito
    let objectType = input.objectType;
    let objectId = input.objectId;

    // 2) contexto en meta
    const meta = input.meta;
    if ((!objectType || !objectId) && meta && typeof meta === "object") {
      objectType = meta.objectType || meta.object_type || meta.type || objectType;
      objectId = meta.objectId || meta.object_id || meta.id || objectId;
    }

    // 3) mensaje (string / args)
    let message = input.message;
    if (!message && Array.isArray(input.args)) message = formatArgs(input.args);
    if (!message && typeof input.text === "string") message = input.text;

    message = message ? String(message) : "";

    // 4) si no hay contexto explícito, intentar detectar desde el texto (opcional)
    if ((!objectType || !objectId) && message) {
      const ctx = detectContextFromText(message);
      if (ctx) {
        objectType = ctx.objectType;
        objectId = ctx.objectId;
      }
    }

    if (!objectType || !objectId) return;

    objectType = normalizeType(objectType);
    objectId = String(objectId);

    enqueue({ level, objectType, objectId, message });
  } catch {
    // silencioso por diseño
  }
}

export function reportHubSpotWarn(input = {}) {
  return reportHubSpotError({ ...input, level: "warn" });
}

/** Forzar flush manual (recomendado al final del cron) */
export async function flushHubSpotErrors() {
  const keys = [...queue.keys()];
  for (const k of keys) {
    await flushKey(k);
  }
}