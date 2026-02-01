// src/utils/hubspotErrorCollector.js
import crypto from "node:crypto";

/**
 * Recolector de console.warn/error que:
 * - detecta objectType/objectId (meta o regex)
 * - arma mensaje humano
 * - acumula y sube a HubSpot en batch (debounce)
 *
 * Requiere que tengas hubspotClient disponible (tu wrapper o SDK).
 */

// Ajustá según tu wrapper real:
import { hubspotClient } from "../hubspotClient.js";

// ---- Config ----
const FLUSH_MS = Number(process.env.BILLING_ERR_FLUSH_MS || 1500);
const MAX_PROP_LEN = Number(process.env.BILLING_ERR_MAX_LEN || 6500); // ojo límites HS
const MAX_LINES = Number(process.env.BILLING_ERR_MAX_LINES || 30);

// Cola: key = `${objectType}:${objectId}` -> { lines: [], timer: null, flushing: false }
const queue = new Map();

// Para evitar loops si HubSpot falla y logueás error de eso mismo:
let isInternalLogging = false;

/** Saca strings "humanas" de args de console */
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

/**
 * Detecta contexto (objectType/objectId) desde:
 * - meta: { objectType, objectId } (preferido)
 * - o patrones en texto: ticketId, lineItemId, hs_object_id, etc.
 */
function detectContext(args, text) {
  // 1) meta estructurado (preferido)
  for (const a of args) {
    if (a && typeof a === "object") {
      const objectType = a.objectType || a.object_type || a.type;
      const objectId = a.objectId || a.object_id || a.id;
      if (objectType && objectId) {
        return { objectType: normalizeType(objectType), objectId: String(objectId) };
      }
    }
  }

  // 2) fallback regex sobre texto
  // Ajustá/extendé según tus logs reales
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
  return new Date().toISOString(); // si querés TZ local, lo cambiamos
}

/** Reduce líneas, corta largo, etc. */
function compactLines(lines) {
  const trimmed = lines.slice(-MAX_LINES); // últimas N
  let joined = trimmed.join("\n");
  if (joined.length > MAX_PROP_LEN) {
    joined = joined.slice(joined.length - MAX_PROP_LEN);
    // aseguramos que empiece en línea completa
    const idx = joined.indexOf("\n");
    if (idx > 0) joined = joined.slice(idx + 1);
  }
  return joined;
}

/** Lee el valor actual y le agrega líneas nuevas. */
async function appendToHubSpotProperty({ objectType, objectId, prop, newLines }) {
  // Dependiendo de tu SDK/wrapper:
  // - Tickets: hubspotClient.crm.tickets.basicApi...
  // - Line items: hubspotClient.crm.lineItems.basicApi...

  // 1) read actual
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

  // 2) update
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
    // Evitar recursion infinita si falla HS y eso vuelve a console.error
    isInternalLogging = true;
    try {
      // acá sí podés loguear a un archivo o a tu logger, pero con cuidado
      // eslint-disable-next-line no-console
      console.error("[hubspotErrorCollector][flush] failed:", e?.message || e);
    } finally {
      isInternalLogging = false;
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

  // Dedup simple: hash de la línea para no repetir exactos consecutivos
  const line = `${nowStamp()} ${level.toUpperCase()}: ${message}`;
  const last = item.lines[item.lines.length - 1];
  if (last === line) return;

  item.lines.push(line);
  scheduleFlush(key);
}

/**
 * Instala el intercept para console.warn/error.
 * Llamalo una vez en tu bootstrap (ej: src/index.js / api handler).
 */
export function installHubSpotConsoleCollector() {
  const originalWarn = console.warn.bind(console);
  const originalError = console.error.bind(console);

  console.warn = (...args) => {
    if (!isInternalLogging) {
      try {
        const text = formatArgs(args);
        const ctx = detectContext(args, text);
        if (ctx) enqueue({ level: "warn", ...ctx, message: text });
      } catch {}
    }
    return originalWarn(...args);
  };

  console.error = (...args) => {
    if (!isInternalLogging) {
      try {
        const text = formatArgs(args);
        const ctx = detectContext(args, text);
        if (ctx) enqueue({ level: "error", ...ctx, message: text });
      } catch {}
    }
    return originalError(...args);
  };

  // flush al cerrar proceso
  process.on("beforeExit", async () => {
    const keys = [...queue.keys()];
    for (const k of keys) await flushKey(k);
  });
}
