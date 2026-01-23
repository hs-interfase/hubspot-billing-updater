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
  mirrorDealId = null,
  mirrorLineItemId = null,
  logLabel = "mirrorFlagPropagation",
} = {}) {
  // 1) Propagar flag (idempotente)
  const propRes = await propagateToMirror({ mode, mirrorLineItemId, logLabel });

  // 2) Ejecutar acción en espejo según mode (solo line_item por ahora)
  try {
    if (mode === "line_item.actualizar") {
      if (!mirrorDealId) {
        return { ok: false, step: "execute", reason: "missing_mirrorDealId", mode, propRes };
      }
      const dealWithLineItems = await getDealWithLineItems(mirrorDealId);
      const billingResult = await runPhasesForDeal(dealWithLineItems);
      return { ok: true, mode, propRes, executed: "runPhasesForDeal", mirrorDealId, billingResult };
    }

    if (mode === "line_item.facturar_ahora") {
      if (!mirrorLineItemId) {
        return { ok: false, step: "execute", reason: "missing_mirrorLineItemId", mode, propRes };
      }
      const urgentRes = await processUrgentLineItem(mirrorLineItemId);
      return { ok: true, mode, propRes, executed: "processUrgentLineItem", mirrorLineItemId, urgentRes };
    }

    return { ok: true, mode, propRes, executed: "none" };
  } catch (e) {
    const msg = e?.message || String(e);
    console.error(`[${logLabel}] ⚠️ Error ejecutando acción en espejo`, {
      mode,
      mirrorDealId,
      mirrorLineItemId,
      msg,
    });
    return { ok: false, mode, propRes, error: msg };
  }
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
