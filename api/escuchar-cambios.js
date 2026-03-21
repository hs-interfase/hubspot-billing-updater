// api/escuchar-cambios.js
<<<<<<< HEAD

/**
 * Webhook unificado para HubSpot: Maneja facturación urgente y recálculos.
 *
 * Propiedades soportadas:
 * 1. facturar_ahora (Line Item/Ticket) → Facturación urgente inmediata
 * 2. actualizar (Line Item) → Recalcula todas las fases de facturación
 *
 * Configuración en HubSpot:
 * - Suscripciones en la misma URL: https://hubspot-billing-updater.vercel.app/api/escuchar-cambios
 * - Line Item → Property Change → facturar_ahora
 * - Ticket → Property Change → facturar_ahora
 * - Line Item → Property Change → actualizar
 */

import {
  processUrgentLineItem,
  processUrgentTicket,
} from "../src/services/urgentBillingService.js";
import { hubspotClient, getDealWithLineItems } from "../src/hubspotClient.js";
import { runPhasesForDeal } from "../src/phases/index.js";
import { parseBool } from "../src/utils/parsers.js";
import { processTicketUpdate } from "../src/services/tickets/ticketUpdateService.js";
=======
import logger from '../lib/logger.js';
import { reportHubSpotError } from '../src/utils/hubspotErrorCollector.js';
import { processUrgentLineItem, processUrgentTicket } from '../src/services/urgentBillingService.js';
import { hubspotClient, getDealWithLineItems } from '../src/hubspotClient.js';
import { runPhasesForDeal } from '../src/phases/index.js';
import { parseBool } from '../src/utils/parsers.js';
import { processTicketUpdate } from '../src/services/tickets/ticketUpdateService.js';
>>>>>>> pruebas

const MODULE = 'escuchar-cambios';

function reportIfActionable({ objectType, objectId, message, err }) {
  const status = err?.response?.status ?? err?.statusCode ?? null;
  if (status === null) { reportHubSpotError({ objectType, objectId, message }); return; }
  if (status === 429 || status >= 500) return;
  if (status >= 400 && status < 500) reportHubSpotError({ objectType, objectId, message });
}

async function getDealIdForLineItem(lineItemId) {
  const resp = await hubspotClient.crm.associations.v4.basicApi.getPage(
    "line_items",
    String(lineItemId),
    "deals",
    100
  );
  const dealIds = (resp.results || [])
    .map((r) => String(r.toObjectId))
    .filter(Boolean);
  return dealIds.length ? dealIds[0] : null;
}

<<<<<<< HEAD
/**
 * Procesa eventos de "actualizar".
 * Ejecuta las 3 fases de facturación para el deal asociado.
 *
 * IMPORTANTE: Phase 1 SIEMPRE se ejecuta (mirroring, fechas, cupo).
 * Phase 2 y 3 solo se ejecutan si facturacion_activa=true.
 */
// api/escuchar-cambios.js (solo la función)

async function processRecalculation(lineItemId, propertyName, { mode } = {}) {
  console.log(
    `\n🔄 [Recalculation] Procesando ${propertyName} para line item ${lineItemId}...`
  );

  // 1) Obtener deal asociado
  const dealId = await getDealIdForLineItem(lineItemId);
  if (!dealId) {
    console.error(`❌ No se encontró deal asociado al line item ${lineItemId}`);
    return { skipped: true, reason: "No associated deal" };
  }

  // 2) Obtener deal info para logging
=======
async function processRecalculation(lineItemId, propertyName) {
  logger.info({ module: MODULE, fn: 'processRecalculation', lineItemId, propertyName }, 'Iniciando recalculación');

  if (propertyName === "actualizar") {
    try {
      await hubspotClient.crm.lineItems.basicApi.update(String(lineItemId), {
        properties: { actualizar: false },
      });
      logger.info({ module: MODULE, fn: 'processRecalculation', lineItemId }, 'Trigger "actualizar" reseteado a false (inicio)');
    } catch (err) {
      logger.warn({ module: MODULE, fn: 'processRecalculation', lineItemId, err }, 'No se pudo resetear "actualizar" al inicio');
      reportIfActionable({ objectType: 'line_item', objectId: lineItemId, message: 'No se pudo resetear "actualizar" al inicio', err });
    }
  }

  const dealId = await getDealIdForLineItem(lineItemId);
  if (!dealId) {
    logger.error({ module: MODULE, fn: 'processRecalculation', lineItemId }, 'No se encontró deal asociado al line item');
    return { skipped: true, reason: 'No associated deal' };
  }

>>>>>>> pruebas
  const deal = await hubspotClient.crm.deals.basicApi.getById(String(dealId), [
    "facturacion_activa",
    "dealname",
  ]);
  const dealProps = deal?.properties || {};
  const dealName = dealProps.dealname || "Sin nombre";

<<<<<<< HEAD
  console.log(`📋 Deal: ${dealName} (${dealId})`);
  console.log(`🚀 Ejecutando runPhasesForDeal... mode=${mode || "none"}`);

  // 3) Ejecutar fases de facturación
  const dealWithLineItems = await getDealWithLineItems(dealId);

  // sourceLineItemId SOLO tiene sentido en triggers de line_item con intención
  const shouldPassSource =
    typeof mode === "string" && mode.startsWith("line_item.");
  const sourceLineItemId = shouldPassSource ? String(lineItemId) : undefined;

  const billingResult = await runPhasesForDeal({
    ...dealWithLineItems,
    mode,
    sourceLineItemId,
  });

  console.log("✅ Recalculación completada:", {
    ticketsCreated: billingResult.ticketsCreated || 0,
    invoicesEmitted: billingResult.autoInvoicesEmitted || 0,
  });
=======
  logger.info({ module: MODULE, fn: 'processRecalculation', dealId, dealName }, 'Deal resuelto');

  const dealWithLineItems = await getDealWithLineItems(dealId);
  const billingResult = await runPhasesForDeal(dealWithLineItems);

  logger.info({
    module: MODULE,
    fn: 'processRecalculation',
    dealId,
    ticketsCreated: billingResult.ticketsCreated || 0,
    invoicesEmitted: billingResult.autoInvoicesEmitted || 0,
  }, 'Recalculación completada');
>>>>>>> pruebas

  return { success: true, dealId, dealName, billingResult };
}

<<<<<<< HEAD

/**
 * Handler principal del webhook.
 */
export default async function handler(req, res) {
  // Solo acepta POST
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
=======
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
>>>>>>> pruebas
  }

  try {
    const payload = Array.isArray(req.body) ? req.body[0] : req.body;

    const objectId = payload?.objectId;
    const objectType = payload?.subscriptionType?.split(".")[0] || "line_item";
    const propertyName = payload?.propertyName;
    const propertyValue = payload?.propertyValue;
    const eventId = payload?.eventId;

<<<<<<< HEAD
    // Definir mode explícito según objectType y propertyName
    let mode = "";
    if (objectType === "line_item" && propertyName === "actualizar")
      mode = "line_item.actualizar";
    else if (objectType === "line_item" && propertyName === "facturar_ahora")
      mode = "line_item.facturar_ahora";
    else if (objectType === "ticket" && propertyName === "actualizar")
      mode = "ticket.actualizar";
    else if (objectType === "ticket" && propertyName === "facturar_ahora")
      mode = "ticket.facturar_ahora";

    console.log("\n" + "=".repeat(80));
    console.log("🔔 [WEBHOOK] Evento recibido:", {
      objectId,
      objectType,
      propertyName,
      propertyValue,
      eventId,
      mode,
    });
    console.log("=".repeat(80));

    // Validaciones básicas
    if (!objectId) {
      console.error("❌ Missing objectId");
      return res.status(400).json({ error: "Missing objectId" });
    }

    // ====== RUTA 1: FACTURACIÓN URGENTE (facturar_ahora) ======
    if (propertyName === "facturar_ahora") {
      console.log(
        `🔍 Validando facturar_ahora: value="${propertyValue}", parsed=${parseBool(
          propertyValue
        )}`
      );

      if (!parseBool(propertyValue)) {
        console.log("⚠️ facturar_ahora no está en true, ignorando");
        return res
          .status(200)
          .json({ message: "Property value not true, skipped" });
      }

      let result;

      if (objectType === "line_item") {
        console.log("📋 → Facturación urgente de Line Item...");
        result = await processUrgentLineItem(objectId);
      } else if (objectType === "ticket") {
        console.log("🎫 → Facturación urgente de Ticket...");
        result = await processUrgentTicket(objectId);
      } else {
        console.error(`❌ Tipo de objeto no soportado: ${objectType}`);
        return res
          .status(400)
          .json({ error: `Unsupported object type: ${objectType}` });
=======
    logger.info({ module: MODULE, fn: 'handler', objectId, objectType, propertyName, propertyValue, eventId }, 'Evento webhook recibido');

    if (!objectId) {
      logger.error({ module: MODULE, fn: 'handler' }, 'Missing objectId');
      return res.status(400).json({ error: 'Missing objectId' });
    }

    // ====== RUTA 1: FACTURACIÓN URGENTE ======
    if (propertyName === 'facturar_ahora') {
      if (!parseBool(propertyValue)) {
        return res.status(200).json({ message: 'Property value not true, skipped' });
      }

      let result;
      if (objectType === 'line_item') {
        result = await processUrgentLineItem(objectId);
      } else if (objectType === 'ticket') {
        result = await processUrgentTicket(objectId);
      } else {
        return res.status(400).json({ error: `Unsupported object type: ${objectType}` });
>>>>>>> pruebas
      }

      if (result.skipped) {
        return res.status(200).json({ skipped: true, reason: result.reason, objectId, objectType });
      }

<<<<<<< HEAD
      console.log("✅ Facturación urgente completada");
      console.log("=".repeat(80) + "\n");

=======
>>>>>>> pruebas
      return res.status(200).json({
        success: true,
        action: "urgent_billing",
        objectId,
        objectType,
        invoiceId: result.invoiceId,
        eventId,
      });
    }

<<<<<<< HEAD
    // ====== RUTA 2: RECALCULACIÓN (actualizar) ======
    if (["actualizar" ].includes(propertyName)) {
      // CASO A: actualizar en TICKET → Procesamiento independiente
      if (propertyName === "actualizar" && objectType === "ticket") {
        console.log(
          `🔍 Validando actualizar en ticket: value="${propertyValue}", parsed=${parseBool(
            propertyValue
          )}`
        );

        if (!parseBool(propertyValue)) {
          console.log("⚠️ Flag actualizar no está en true, ignorando");
          return res.status(200).json({
            message: "actualizar flag not true, skipped",
            receivedValue: propertyValue,
          });
        }

        console.log(`🎫 → Actualizando ticket ${objectId}...`);

        try {
          const result = await processTicketUpdate(objectId);

          console.log("✅ Actualización de ticket completada");

          return res.status(200).json({
            success: true,
            action: "ticket_update",
            objectId,
            ticketId: objectId,
            result,
            eventId,
          });
        } catch (err) {
          console.error(
            `❌ Error procesando ticket ${objectId}:`,
            err?.message || err
          );
          return res.status(200).json({
            error: true,
            message: err?.message || "Error procesando ticket",
            objectId,
          });
        } finally {
          // Resetear flag actualizar en ticket
=======
    // ====== RUTA 2: RECALCULACIÓN ======
    if (['actualizar', 'hs_billing_start_delay_type'].includes(propertyName)) {

      // CASO A: actualizar en TICKET
      if (propertyName === 'actualizar' && objectType === 'ticket') {
        if (!parseBool(propertyValue)) {
          return res.status(200).json({ message: 'actualizar flag not true, skipped', receivedValue: propertyValue });
        }

        try {
          const result = await processTicketUpdate(objectId);
          return res.status(200).json({ success: true, action: 'ticket_update', objectId, ticketId: objectId, result, eventId });
        } catch (err) {
          logger.error({ module: MODULE, fn: 'handler', ticketId: objectId, err }, 'Error procesando ticket');
          return res.status(200).json({ error: true, message: err?.message || 'Error procesando ticket', objectId });
        } finally {
>>>>>>> pruebas
          try {
            await hubspotClient.crm.tickets.basicApi.update(String(objectId), {
              properties: { actualizar: false },
            });
<<<<<<< HEAD
            console.log(
              `✅ Flag 'actualizar' reseteado a false para ticket ${objectId}`
            );
          } catch (err) {
            console.error(
              "⚠️ Error reseteando 'actualizar' en ticket:",
              err.message
            );
          }
          console.log("=".repeat(80) + "\n");
        }
      }

      // CASO B: actualizar en LINE ITEM (validar value=true)
      if (propertyName === "actualizar" && objectType === "line_item") {
        console.log(
          `🔍 Validando actualizar: value="${propertyValue}", parsed=${parseBool(
            propertyValue
          )}`
        );

        if (!parseBool(propertyValue)) {
          console.log("⚠️ Flag actualizar no está en true, ignorando");
          return res.status(200).json({
            message: "actualizar flag not true, skipped",
            receivedValue: propertyValue,
          });
        }
      }

      // CASO C: hs_billing_start_delay_type en LINE ITEM (continúa sin validar valor)
      if (objectType === "line_item") {
        console.log(`🔄 → Recalculación de facturación (${propertyName})...`);

        const result = await processRecalculation(objectId, propertyName, {
          mode,
          sourceLineItemId: objectId 
        });

        if (result.skipped) {
          console.log(`⚠️ Recalculación omitida: ${result.reason}`);
          console.log("=".repeat(80) + "\n");
          return res.status(200).json({
            skipped: true,
            reason: result.reason,
            objectId,
            propertyName,
          });
        }

        // Resetear flag "actualizar" inmediatamente después de procesar (sin delay)
=======
          } catch (err) {
            logger.error({ module: MODULE, fn: 'handler', ticketId: objectId, err }, "Error reseteando 'actualizar' en ticket");
            reportIfActionable({ objectType: 'ticket', objectId, message: "Error reseteando 'actualizar' en ticket", err });
          }
        }
      }

      // CASO B: hs_billing_start_delay_type solo para line items
      if (propertyName === 'hs_billing_start_delay_type' && objectType !== 'line_item') {
        return res.status(200).json({ message: 'Not a line_item event, ignored' });
      }

      // CASO C: actualizar en LINE ITEM — validar valor
      if (propertyName === 'actualizar' && objectType === 'line_item') {
        if (!parseBool(propertyValue)) {
          return res.status(200).json({ message: 'actualizar flag not true, skipped', receivedValue: propertyValue });
        }
      }

      // CASO D: ejecutar recalculación para line items
      if (objectType === 'line_item') {
        const result = await processRecalculation(objectId, propertyName);

        if (result.skipped) {
          return res.status(200).json({ skipped: true, reason: result.reason, objectId, propertyName });
        }

>>>>>>> pruebas
        if (propertyName === "actualizar") {
          try {
            await hubspotClient.crm.lineItems.basicApi.update(String(objectId), {
              properties: { actualizar: false },
            });
<<<<<<< HEAD
            console.log(
              `✅ Flag 'actualizar' reseteado a false para line item ${objectId}`
            );
          } catch (err) {
            console.error("⚠️ Error reseteando 'actualizar':", err.message);
          }
        }

        console.log("✅ Recalculación completada");
        console.log("=".repeat(80) + "\n");

        return res.status(200).json({
          success: true,
          action: "recalculation",
=======
          } catch (err) {
            logger.error({ module: MODULE, fn: 'handler', lineItemId: objectId, err }, "Error reseteando 'actualizar' post-flujo");
            reportIfActionable({ objectType: 'line_item', objectId, message: "Error reseteando 'actualizar' post-flujo", err });
          }
        }

        return res.status(200).json({
          success: true,
          action: 'recalculation',
>>>>>>> pruebas
          objectId,
          propertyName,
          dealId: result.dealId,
          dealName: result.dealName,
          billingResult: result.billingResult,
          eventId,
        });
      }
    }

    // ====== PROPIEDAD NO RECONOCIDA ======
<<<<<<< HEAD
    console.log(`⚠️ Propiedad no reconocida: ${propertyName}, ignorando`);
    console.log("=".repeat(80) + "\n");
    return res.status(200).json({
      message: "Property not supported, skipped",
      propertyName,
    });
  } catch (err) {
    console.error("\n❌ [WEBHOOK] Error procesando webhook:", err?.message || err);
    console.error(err?.stack);
    console.log("=".repeat(80) + "\n");

    return res.status(500).json({
      error: "Internal server error",
      message: err?.message || "Unknown error",
    });
  }
}
=======
    return res.status(200).json({ message: 'Property not supported, skipped', propertyName });

  } catch (err) {
    logger.error({ module: MODULE, fn: 'handler', err }, 'Error inesperado procesando webhook');
    return res.status(500).json({ error: 'Internal server error', message: err?.message || 'Unknown error' });
  }
}
>>>>>>> pruebas
