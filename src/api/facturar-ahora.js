// api/facturar-ahora.js

/**
 * Webhook para HubSpot: Disparar facturación inmediata cuando se activa "facturar_ahora".
 *
 * Flujo:
 * 1. HubSpot envía un webhook cuando cambia la propiedad "facturar_ahora" de un line item o ticket
 * 2. Este endpoint valida el payload y dispara el proceso de facturación urgente
 * 3. Emite la factura automáticamente
 *
 * Configuración en HubSpot:
 * - Tipo: Property Change
 * - Objeto: Line Item / Ticket
 * - Propiedad: facturar_ahora
 * - URL: https://hubspot-billing-updater.vercel.app/api/facturar-ahora
 * - Método: POST
 */

import { processUrgentLineItem, processUrgentTicket } from "../src/services/urgentBillingService.js";

/**
 * Normaliza distintos valores truthy que pueden venir en webhooks.
 */
function isTruthy(v) {
  if (v === true) return true;
  const s = String(v ?? "").trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes" || s === "si" || s === "sí";
}

/**
 * Handler principal del webhook.
 */
export default async function handler(req, res) {
  // Solo acepta POST
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    // HubSpot puede mandar array de eventos; tomamos el primero (lo más común)
    const payload = Array.isArray(req.body) ? req.body[0] : req.body;

    // Log extendido para debug (útil para ver si estás recibiendo sample events)
    console.log("[facturar-ahora] raw body:", JSON.stringify(req.body, null, 2));

    const objectId = payload?.objectId;
    const propertyName = payload?.propertyName;
    const propertyValue = payload?.propertyValue;
    const subscriptionType = payload?.subscriptionType; // "line_item.propertyChange" o "ticket.propertyChange"

    console.log("[facturar-ahora] Webhook recibido:", {
      objectId,
      propertyName,
      propertyValue,
      subscriptionType,
    });

    // Validaciones básicas
    if (!objectId) {
      return res.status(400).json({ error: "Missing objectId" });
    }

    if (propertyName !== "facturar_ahora") {
      // Para webhooks, es mejor NO responder 400 (evita reintentos innecesarios)
      return res.status(200).json({
        skipped: true,
        reason: "invalid_property",
        expected: "facturar_ahora",
        received: propertyName,
      });
    }

    // Solo procesamos cuando se activa (true)
    if (!isTruthy(propertyValue)) {
      console.log("⚠️ facturar_ahora is not true, ignoring", { propertyValue });
      return res.status(200).json({ skipped: true, reason: "facturar_ahora_false" });
    }

    // Detectar si es Line Item o Ticket según subscriptionType
    let result;

    if (subscriptionType?.includes("line_item")) {
      console.log("📦 Procesando Line Item urgente:", objectId);
      result = await processUrgentLineItem(objectId);
    } else if (subscriptionType?.includes("ticket")) {
      console.log("🎫 Procesando Ticket urgente:", objectId);
      result = await processUrgentTicket(objectId);
    } else {
      console.error("❌ Tipo de objeto desconocido:", subscriptionType);
      // Mejor 200 para evitar reintentos del webhook
      return res.status(200).json({ skipped: true, reason: "unknown_subscription_type" });
    }

    // Verificar si fue omitido (skip)
    if (result?.skipped) {
      console.log(`⚠️ Proceso omitido: ${result.reason}`);
      return res.status(200).json({
        skipped: true,
        reason: result.reason,
        invoiceId: result.invoiceId || null,
      });
    }

    // Éxito
    console.log("✅ Facturación urgente completada");
    return res.status(200).json({
      success: true,
      invoiceId: result?.invoiceId || null,
      objectId: result?.lineItemId || result?.ticketId || objectId,
    });
  } catch (err) {
    console.error("[facturar-ahora] Error procesando webhook:", err?.message || err);
    console.error(err?.stack);

    return res.status(500).json({
      error: "Internal server error",
      message: err?.message || "Unknown error",
    });
  }
}
