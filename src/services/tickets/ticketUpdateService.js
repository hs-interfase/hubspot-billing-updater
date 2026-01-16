// src/services/tickets/ticketUpdateService.js
import { hubspotClient } from "../../hubspotClient.js";

/**
 * Actualizar Ticket (SOLO LOG)
 * - Lee el ticket
 * - Loguea todas sus propiedades
 * - NO modifica nada en HubSpot
 */
export async function processTicketUpdate(ticketId) {
  console.log("\n" + "=".repeat(80));
  console.log(`[ticket:update] 🎫 Ticket ID: ${ticketId}`);
  console.log("=".repeat(80));

  const ticket = await hubspotClient.crm.tickets.basicApi.getById(
    String(ticketId),
    [] // ← vacío = todas las propiedades
  );

  const props = ticket.properties || {};

  console.log("[ticket:update] 📋 PROPIEDADES DEL TICKET:");
  Object.entries(props).forEach(([key, value]) => {
    console.log(`  ${key}: ${value}`);
  });

  console.log("=".repeat(80) + "\n");

  return {
    ticketId,
    logged: true,
    propertiesCount: Object.keys(props).length,
    timestamp: new Date().toISOString(),
  };
}
