// src/services/mirrorTicketsAndInvoices.js
//
// Mirror (espejo) de Tickets/Facturas basado en eventos del ORIGINAL,
// pero ejecutando la creación/actualización del espejo a través del DEAL MIRROR
// (y por ende sus LINE ITEMS duplicados).
//
// Objetivos:
// - No “ensuciar” archivos existentes: este módulo se importa y se llama desde tus handlers.
// - Unidireccional: ORIGINAL -> MIRROR (evita loops).
// - Montos/cantidades salen de line items del MIRROR (no se copian “a mano” desde el ticket original).
// - Se espeja solo una whitelist de props del ticket original al ticket espejo.
// - Enlace principal: of_mirror_ticket = originalTicketId
// - Auditoría: of_original_key = originalTicketKey (lo creaste)
//
// Requisitos esperados en tu repo (ajustá import paths según tu estructura):
// - hubspotClient con endpoints: crm.objects.(tickets|deals).basicApi.getById/update/create
// - función para resolver deal mirror desde deal original (si ya existe). Si no, implementás en adapter.
// - función para ejecutar billing en un deal (mirror) en modos: update/urgent/auto.
// - función para asegurar que line items del mirror estén up-to-date (si tu mirror ya lo hace en update, podés no usarla).

//import { logger } from "../";

// const log = logger.child({ module: "mirrorTicketsAndInvoices" });

/**
 * Ajustá estos nombres si tus properties difieren.
 */
export const MIRROR_PROPS = {
  // flags
  isMirror: "of_is_mirror", // boolean string "true"/"false" recomendado para evitar loops
  mirrorTicket: "of_mirror_ticket", // link principal: originalTicketId
  originalKey: "of_original_key", // audit: originalTicketKey (ya lo creaste)

  // triggers (si los escuchás)
  facturarAhora: "facturar_ahora",
  actualizar: "actualizar",
};

/**
 * Whitelist de propiedades del ticket original que se copian al ticket espejo.
 * Importante: NO incluir nada de cupo.
 * Importante 2: NO incluir montos/cantidad “real” si eso viene del line item mirror.
 *
 * Ajustá esta lista a las props reales que querés espejar.
 */
export const TICKET_MIRROR_ALLOWLIST = [
  "of_fecha_de_facturacion",
  "nota",
  "observaciones_ventas",
  "reventa",
  "renovacion_automatica",
  "of_producto_nombres",
  "of_descripcion_producto",
  "subject", // opcional: si querés mismo subject
];

/**
 * Util: parsea boolean strings de HS.
 */
function parseBool(v) {
  if (typeof v === "boolean") return v;
  const s = String(v ?? "").toLowerCase().trim();
  return s === "true" || s === "1" || s === "yes";
}

function pickProps(sourceProps, allowlist) {
  const out = {};
  for (const k of allowlist) {
    if (sourceProps?.[k] !== undefined) out[k] = sourceProps[k];
  }
  return out;
}

/**
 * -----------------------------------------------------------------------------
 * ADAPTER INTERFACE
 * -----------------------------------------------------------------------------
 * Para no tocar tus archivos actuales, este módulo trabaja con un "adapter".
 * Vos implementás el adapter en el lugar donde lo importes (ej. escuchar-cambios.js)
 * y lo pasás a las funciones.
 *
 * adapter debe proveer:
 * - getTicketById(ticketId) -> { id, properties, associations? }
 * - updateTicket(ticketId, properties)
 * - searchMirrorTicketByOriginalId(originalTicketId) -> ticket | null   (busca por of_mirror_ticket)
 * - createTicket(properties, associationsPayload?) -> ticket
 *
 * - getDealIdFromTicket(ticket) -> dealId
 * - getMirrorDealIdForDeal(originalDealId) -> mirrorDealId | null
 *
 * - runBillingForDeal(dealId, { mode, reason, source }) -> { ticketId?, invoiceId? , ...}
 *     mode: "update" | "urgent" | "auto"
 *     source: "mirror"|"original" (para logs)
 *
 * - ensureMirrorLineItemsUpToDate?(originalDealId, mirrorDealId, { reason })  (opcional)
 *
 * - getTicketKey?(ticket) -> string (si tenés of_ticket_key u otra)
 */

/**
 * -----------------------------------------------------------------------------
 * ENTRYPOINTS (para llamar desde tus webhooks/handlers)
 * -----------------------------------------------------------------------------
 */

/**
 * Handler: evento "facturar_ahora" en ticket original.
 * - Evita loops si el ticket ya es mirror.
 * - Resuelve deal original -> deal mirror.
 * - Ejecuta billing "urgent" en el deal mirror (crea/actualiza ticket mirror según tu lógica existente).
 * - Upsertea link y sync de whitelist desde el ticket original al ticket mirror.
 */
export async function onOriginalTicketFacturarAhora(adapter, originalTicketId, { reason = "facturar_ahora" } = {}) {
  const originalTicket = await adapter.getTicketById(originalTicketId);

  // Guard anti-loop: si el evento vino de un mirror, ignorar.
  if (parseBool(originalTicket?.properties?.[MIRROR_PROPS.isMirror])) {
console.log("[mirror] Ignorado: ticket es mirror (anti-loop)", { originalTicketId });
    return { skipped: true, why: "ticket_is_mirror" };
  }

  const originalDealId = await adapter.getDealIdFromTicket(originalTicket);
  if (!originalDealId) {
console.warn("[mirror] No se pudo resolver deal desde ticket original", { originalTicketId });
    return { skipped: true, why: "no_deal_from_ticket" };
  }

  const mirrorDealId = await adapter.getMirrorDealIdForDeal(originalDealId);
  if (!mirrorDealId) {
console.log("[mirror] Deal no tiene mirror, no aplica", { originalDealId, originalTicketId });
    return { skipped: true, why: "no_mirror_deal" };
  }

  // Opcional: asegurar que el mirror de line items esté actualizado antes de facturar.
  if (adapter.ensureMirrorLineItemsUpToDate) {
    await adapter.ensureMirrorLineItemsUpToDate(originalDealId, mirrorDealId, { reason });
  }

  // Ejecuta tu flujo existente de facturación urgente, pero en el deal mirror:
  const billingResult = await adapter.runBillingForDeal(mirrorDealId, {
    mode: "update",
    reason,
    source: "mirror",
  });

  // Idealmente runBillingForDeal retorna el ticketId creado/actualizado en mirror.
  // Si no retorna, haremos fallback buscando por of_mirror_ticket luego.
  let mirrorTicketId = billingResult?.ticketId;

  // Upsert mirror ticket: si no tenemos el ID, intentamos encontrarlo.
  const upsert = await upsertMirrorTicketLinkAndSync(adapter, {
    originalTicket,
    mirrorTicketId,
    mirrorDealId,
  });

  return { ok: true, ...upsert, billingResult };
}

/**
 * Handler: evento "actualizar" en deal original o equivalente.
 * La idea que dijiste: “si tiene mirror, ejecutar la misma función en el mirror”.
 *
 * - corre runBilling/update en el original (si vos querés desde el handler real)
 * - y luego corre runBilling/update en el mirror
 * - opcionalmente, si hay ticket original asociado y/o mirror, sincroniza whitelist
 *
 * OJO: este helper NO corre el update del original (para no duplicar lógica).
 * Este helper solo corre el update del MIRROR y hace sync ticket si le pasás ticket.
 */
export async function onOriginalActualizar(adapter, originalDealId, { originalTicketId = null, reason = "actualizar" } = {}) {
  const mirrorDealId = await adapter.getMirrorDealIdForDeal(originalDealId);
  if (!mirrorDealId) return { skipped: true, why: "no_mirror_deal" };

  if (adapter.ensureMirrorLineItemsUpToDate) {
    await adapter.ensureMirrorLineItemsUpToDate(originalDealId, mirrorDealId, { reason });
  }

  const billingResult = await adapter.runBillingForDeal(mirrorDealId, {
    mode: "update",
    reason,
    source: "mirror",
  });

  let syncResult = null;
  if (originalTicketId) {
    const originalTicket = await adapter.getTicketById(originalTicketId);
    syncResult = await upsertMirrorTicketLinkAndSync(adapter, {
      originalTicket,
      mirrorTicketId: billingResult?.ticketId,
      mirrorDealId,
    });
  }

  return { ok: true, mirrorDealId, billingResult, syncResult };
}

/**
 * -----------------------------------------------------------------------------
 * CORE: Upsert del ticket mirror + sync whitelist
 * -----------------------------------------------------------------------------
 */

/**
 * Upsert:
 * - garantiza que exista ticket mirror (si billingResult no lo creó, lo crea mínimo)
 * - setea of_mirror_ticket + of_original_key + isMirror
 * - sync allowlist desde ticket original
 */
export async function upsertMirrorTicketLinkAndSync(
  adapter,
  {
    originalTicket,
    mirrorTicketId = null,
    mirrorDealId = null,
  }
) {
  const originalTicketId = originalTicket?.id;
  if (!originalTicketId) throw new Error("originalTicket.id requerido");

  const originalProps = originalTicket.properties || {};
  const originalKey = adapter.getTicketKey ? adapter.getTicketKey(originalTicket) : originalProps.of_ticket_key;

  // 1) Encontrar ticket mirror
  let mirrorTicket = null;

  if (mirrorTicketId) {
    mirrorTicket = await adapter.getTicketById(mirrorTicketId);
  } else {
    mirrorTicket = await adapter.searchMirrorTicketByOriginalId(originalTicketId);
  }

  // 2) Si no existe, crear uno mínimo (fallback)
  if (!mirrorTicket) {
    if (!mirrorDealId) {
      // si no nos pasaron mirrorDealId, intentamos resolverlo desde el ticket original:
      const originalDealId = await adapter.getDealIdFromTicket(originalTicket);
      if (originalDealId) mirrorDealId = await adapter.getMirrorDealIdForDeal(originalDealId);
    }

    const createProps = {
      [MIRROR_PROPS.isMirror]: "true",
      [MIRROR_PROPS.mirrorTicket]: String(originalTicketId),
      ...(originalKey ? { [MIRROR_PROPS.originalKey]: String(originalKey) } : {}),
      // subject mínimo para no crear tickets “vacíos”
      subject: originalProps.subject ? `MIRROR - ${originalProps.subject}` : "MIRROR - Ticket",
    };

    // Si tu createTicket necesita associations al deal mirror, pasalo en associationsPayload.
    mirrorTicket = await adapter.createTicket(createProps, { mirrorDealId });
console.log("[mirror] Ticket mirror creado (fallback)", {
  originalTicketId,
  mirrorTicketId: mirrorTicket?.id,
  mirrorDealId,
});
  }

  const mirrorTicketIdFinal = mirrorTicket.id;

  // 3) Setear link + flags (idempotente)
  const linkUpdate = {
    [MIRROR_PROPS.isMirror]: "true",
    [MIRROR_PROPS.mirrorTicket]: String(originalTicketId),
    ...(originalKey ? { [MIRROR_PROPS.originalKey]: String(originalKey) } : {}),
  };

  // 4) Sync whitelist (SIN cupo, SIN montos)
  const mirrorPatch = {
    ...linkUpdate,
    ...pickProps(originalProps, TICKET_MIRROR_ALLOWLIST),
  };

  await adapter.updateTicket(mirrorTicketIdFinal, mirrorPatch);

  return {
    mirrorTicketId: mirrorTicketIdFinal,
    linked: true,
    syncedProps: Object.keys(mirrorPatch),
  };
}

/**
 * -----------------------------------------------------------------------------
 * (Opcional) Facturas: stubs para que lo enchufes igual que tickets
 * -----------------------------------------------------------------------------
 * Si querés, después completamos con tu modelo real de invoice:
 * - of_mirror_invoice
 * - of_original_invoice_key
 * - etc.
 */
export async function onOriginalInvoiceCreated(adapter, originalInvoiceId, opts = {}) {
  // Implementar cuando tengas claro dónde se crean y cómo se linkean.
console.log("[mirror] Invoice mirror: pendiente de implementar", { originalInvoiceId, opts });
  return { skipped: true, why: "not_implemented" };
}

/**
 * -----------------------------------------------------------------------------
 * Helpers recomendados para cron repair (opcional)
 * -----------------------------------------------------------------------------
 * Busca mirror faltante y lo crea/sync.
 */
export async function repairMirrorTicket(adapter, originalTicketId, { reason = "repair" } = {}) {
  const originalTicket = await adapter.getTicketById(originalTicketId);

  if (parseBool(originalTicket?.properties?.[MIRROR_PROPS.isMirror])) {
    return { skipped: true, why: "ticket_is_mirror" };
  }

  const originalDealId = await adapter.getDealIdFromTicket(originalTicket);
  const mirrorDealId = originalDealId ? await adapter.getMirrorDealIdForDeal(originalDealId) : null;
  if (!mirrorDealId) return { skipped: true, why: "no_mirror_deal" };

  // No corremos billing acá por default (repair solo upsert link/sync),
  // pero si preferís, podés disparar update del mirror antes de sync.
  return upsertMirrorTicketLinkAndSync(adapter, { originalTicket, mirrorDealId });
}
