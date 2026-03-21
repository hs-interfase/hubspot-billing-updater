// src/services/tickets/ticketUpdateService.js
import { hubspotClient } from "../../hubspotClient.js";
import logger from "../../../lib/logger.js";

/**
 * Actualizar Ticket (SOLO LOG)
 * - Lee el ticket
 * - Loguea todas sus propiedades
 * - NO modifica nada en HubSpot
 */
export async function processTicketUpdate(ticketId) {
  const log = logger.child({ module: "ticketUpdateService", ticketId });

  log.info("\n" + "=".repeat(80));
  log.info(`[ticket:update] 🎫 Ticket ID: ${ticketId}`);
  log.info("=".repeat(80));

  const ticket = await hubspotClient.crm.tickets.basicApi.getById(
    String(ticketId),
    [] // ← vacío = todas las propiedades
  );

  const props = ticket?.properties || {};

  log.info("[ticket:update] 📋 PROPIEDADES DEL TICKET:");
  Object.entries(props).forEach(([key, value]) => {
    log.info({ key, value }, "ticket_property");
  });

  log.info("=".repeat(80) + "\n");

  return {
    ticketId,
    logged: true,
    propertiesCount: Object.keys(props).length,
    timestamp: new Date().toISOString(),
  };
}
