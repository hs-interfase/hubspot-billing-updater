// src/phases/phase2.js
import { hubspotClient } from "../hubspotClient.js";
import { getDealWithLineItems } from "../hubspotClient.js";
import { syncLineItemTicketsForDeal } from "../tickets.js";
import { processCupoTickets, updateDealCupo } from "../cupo.js";
import { updateDealBillingFieldsFromLineItems } from "../dealBillingFields.js"; // <-- NUEVO

export async function runPhase2(dealId) {
  if (!dealId) throw new Error("runPhase2 requiere un dealId");

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // 0) Obtener negocio y line items
  let { deal, lineItems } = await getDealWithLineItems(dealId);

  // 0.1) Activar facturación en el deal (fase 2 = cierre ganado)
  try {
    await hubspotClient.crm.deals.basicApi.update(String(dealId), {
      properties: { facturacion_activa: "true" },
    });
    // refrescamos deal en memoria (opcional, pero prolijo)
    deal.properties = { ...(deal.properties || {}), facturacion_activa: "true" };
  } catch (err) {
    console.error("[phase2] Error activando facturacion_activa", err?.response?.body || err);
  }

  // 1) Sincronizar tickets (crea/actualiza/elimina tickets dentro de los próximos 30 días)
  let ticketsResult = { created: 0, updated: 0, deleted: 0 };
  try {
    ticketsResult = await syncLineItemTicketsForDeal({ deal, lineItems, today });
  } catch (err) {
    console.error("[phase2] Error al sincronizar tickets", err?.response?.body || err);
  }

  // 2) Procesar consumo de cupo a partir de tickets (global)
  //    (esto actualiza consumidos/restantes en line items, según tu cupo.js)
  try {
    await processCupoTickets();
  } catch (err) {
    console.error("[phase2] Error al procesar cupo en tickets", err?.response?.body || err);
  }

  // 3) Re-fetch: line items ya con consumos/saldos actualizados
  ({ deal, lineItems } = await getDealWithLineItems(dealId));

  // 4) Setear propiedades del deal de facturación (esto era tu pain principal)
  //    Querés que se vean en el deal en fase 2: próxima, última, mensaje, frecuencia
  try {
    await updateDealBillingFieldsFromLineItems({ dealId, deal, lineItems, today });
  } catch (err) {
    console.error("[phase2] Error actualizando campos de facturación del deal", err?.response?.body || err);
  }

  // 5) Actualizar cupo a nivel negocio (si corresponde)
  try {
    await updateDealCupo(dealId, lineItems);
  } catch (err) {
    console.error("[phase2] Error en updateDealCupo", err?.response?.body || err);
  }

  return {
    dealId,
    ticketsCreated: ticketsResult.created,
    ticketsUpdated: ticketsResult.updated,
    ticketsDeleted: ticketsResult.deleted,
    cupoUpdated: true,
  };
}
