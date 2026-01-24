// src/services/mirrori/mirrorFlagPropagation.js
//
// Responsabilidad única: propagar intención (actualizar / facturar_ahora)
// al OBJETO espejo correspondiente (line_item o ticket), según `mode`.
//
// No hace mirroring. No crea tickets. No corre billing.

import { hubspotClient } from "../../hubspotClient.js";
import { getDealWithLineItems } from "../../hubspotClient.js";
import { runPhasesForDeal } from "../../phases/index.js";
import { processUrgentLineItem } from "../urgentBillingService.js";

export async function propagateAndExecuteMirror({
  mode,
  mirrorDealId = null,       // (se mantiene por compatibilidad / logs)
  mirrorLineItemId = null,
  logLabel = "mirrorFlagPropagation",
} = {}) {
  // Guardrails mínimos
  if (!mode || typeof mode !== "string") {
    return { ok: false, step: "validate", reason: "missing_mode", mode };
  }
  if (!mirrorLineItemId) {
    return {
      ok: false,
      step: "validate",
      reason: "missing_mirrorLineItemId",
      mode,
      mirrorDealId,
      mirrorLineItemId,
    };
  }

  // 1) Propagar flag (esto es lo único que queremos hacer)
  const propRes = await propagateToMirror({ mode, mirrorLineItemId, logLabel });

  // 2) NO ejecutar nada acá.
  // La ejecución la hace el webhook cuando HubSpot dispare el evento del cambio de propiedad.
  return {
    ok: true,
    mode,
    propRes,
    executed: "none",
    note: "Webhook will process mirror event; no direct execution to avoid double processing.",
    mirrorDealId,
    mirrorLineItemId,
  };
}


function modeToFlag(mode) {
  if (!mode || typeof mode !== "string") return null;
  if (mode.endsWith(".actualizar")) return "actualizar";
  if (mode.endsWith(".facturar_ahora")) return "facturar_ahora";
  return null;
}

function isTrueish(v) {
  return String(v ?? "")
    .trim()
    .toLowerCase() === "true";
}

async function ensurePropertyTrueOnLineItem(lineItemId, propName) {
  const li = await hubspotClient.crm.lineItems.basicApi.getById(String(lineItemId), [propName]);
  const current = li?.properties?.[propName];

  if (isTrueish(current)) return { ok: true, changed: false, objectType: "line_item" };

  await hubspotClient.crm.lineItems.basicApi.update(String(lineItemId), {
    properties: { [propName]: true },
  });

  return { ok: true, changed: true, objectType: "line_item" };
}

async function ensurePropertyTrueOnTicket(ticketId, propName) {
  const t = await hubspotClient.crm.tickets.basicApi.getById(String(ticketId), [propName]);
  const current = t?.properties?.[propName];

  if (isTrueish(current)) return { ok: true, changed: false, objectType: "ticket" };

  await hubspotClient.crm.tickets.basicApi.update(String(ticketId), {
    properties: { [propName]: true },
  });

  return { ok: true, changed: true, objectType: "ticket" };
}

/**
 * Propaga el flag al espejo según `mode`.
 *
 * - Para modos de line_item.* => requiere mirrorLineItemId
 * - Para modos de ticket.*    => requiere mirrorTicketId
 */
export async function propagateToMirror({
  mode,
  mirrorLineItemId = null,
  mirrorTicketId = null,
  logLabel = "mirrorFlagPropagation",
} = {}) {
  const flag = modeToFlag(mode);
  if (!flag) return { ok: true, applied: false, reason: "mode_not_supported", mode };

  try {
    if (mode.startsWith("line_item.")) {
      if (!mirrorLineItemId) {
        return { ok: false, applied: false, reason: "missing_mirrorLineItemId", mode, flag };
      }
      const r = await ensurePropertyTrueOnLineItem(mirrorLineItemId, flag);
      return { ok: true, applied: r.changed, target: r.objectType, mode, flag };
    }

    if (mode.startsWith("ticket.")) {
      if (!mirrorTicketId) {
        return { ok: false, applied: false, reason: "missing_mirrorTicketId", mode, flag };
      }
      const r = await ensurePropertyTrueOnTicket(mirrorTicketId, flag);
      return { ok: true, applied: r.changed, target: r.objectType, mode, flag };
    }

    return { ok: true, applied: false, reason: "unknown_mode_prefix", mode, flag };
  } catch (e) {
    const msg = e?.message || String(e);
    console.error(`[${logLabel}] ⚠️ Error propagando flag`, { mode, flag, mirrorLineItemId, mirrorTicketId, msg });
    return { ok: false, applied: false, error: msg, mode, flag };
  }
}
