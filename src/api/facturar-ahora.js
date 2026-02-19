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
import logger from "../../lib/logger.js";

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
  const log = logger.child({ module: "api/facturar-ahora" });

  // Solo acepta POST
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    // HubSpot puede mandar array de eventos; tomamos el primero (lo más común)
    const payload = Array.isArray(req.body) ? req.body[0] : req.body;

    // Log extendido para debug (útil para ver si estás recibiendo sample events)
    log.debug({ rawBody: req.body }, "[facturar-ahora] raw body");

    const objectId = payload?.objectId;
    const propertyName = payload?.propertyName;
    const propertyValue = payload?.propertyValue;
    const subscriptionType = payload?.subscriptionType; // "line_item.propertyChange" o "ticket.propertyChange"

    const ctx = { objectId, propertyName, propertyValue, subscriptionType };
    const reqLog = log.child(ctx);

    reqLog.info("[facturar-ahora] Webhook recibido");

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
      reqLog.info({ propertyValue }, "facturar_ahora_not_true_ignoring");
      return res.status(200).json({ skipped: true, reason: "facturar_ahora_false" });
    }

    // Detectar si es Line Item o Ticket según subscriptionType
    let result;

    if (subscriptionType?.includes("line_item")) {
      reqLog.info({ objectId }, "procesando_line_item_urgente");
      result = await processUrgentLineItem(objectId);
    } else if (subscriptionType?.includes("ticket")) {
      reqLog.info({ objectId }, "procesando_ticket_urgente");
      result = await processUrgentTicket(objectId);
    } else {
      reqLog.error({ subscriptionType }, "unknown_subscription_type");
      // Mejor 200 para evitar reintentos del webhook
      return res.status(200).json({ skipped: true, reason: "unknown_subscription_type" });
    }

    // Verificar si fue omitido (skip)
    if (result?.skipped) {
      reqLog.info({ reason: result.reason, invoiceId: result.invoiceId || null }, "proceso_omitido");
      return res.status(200).json({
        skipped: true,
        reason: result.reason,
        invoiceId: result.invoiceId || null,
      });
    }

    // Éxito
    reqLog.info({ invoiceId: result?.invoiceId || null }, "facturacion_urgente_completada");
    return res.status(200).json({
      success: true,
      invoiceId: result?.invoiceId || null,
      objectId: result?.lineItemId || result?.ticketId || objectId,
    });
  } catch (err) {
    log.error({ err }, "[facturar-ahora] Error procesando webhook");
    return res.status(500).json({
      error: "Internal server error",
      message: err?.message || "Unknown error",
    });
  }
}
