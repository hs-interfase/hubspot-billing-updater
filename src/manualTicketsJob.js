import { hubspotClient } from '../hubspotClient.js';

/*
 * Genera tickets para line items con `facturacion_activa=true` y
 * `facturacion_automatica=false`. Copia snapshots del precio/cantidad para que
 * el responsable pueda ajustar horas reales y disparar la facturación.
 */

async function createTicketForLineItem(deal, lineItem, invoiceDate) {
  const dp = deal.properties || {};
  const lp = lineItem.properties || {};
  const dealId = String(deal.id || dp.hs_object_id);
  const lineItemId = String(lineItem.id || lp.hs_object_id);
  const precio = parseFloat(lp.price) || 0;
  const cantidad = parseFloat(lp.quantity) || 0;
  const totalOriginal = (precio * cantidad).toString();
  const ticketProps = {
    subject: `${dp.dealname || 'Negocio'} - ${lp.name || 'Producto'}`,
    of_deal_id: dealId,
    of_line_item_ids: lineItemId,
    of_fecha_de_facturacion: invoiceDate,
    of_moneda: dp.deal_currency_code || 'USD',
    precio_hora_snapshot: precio.toString(),
    horas_previstas_snapshot: cantidad.toString(),
    monto_original_snapshot: totalOriginal,
    responsable_asignado: lp.responsable_asignado || dp.responsable_asignado || undefined,
    hs_pipeline: process.env.BILLING_TICKET_PIPELINE_ID,
    hs_pipeline_stage: process.env.BILLING_TICKET_STAGE_NEW,
  };
  try {
    const createResp = await hubspotClient.crm.tickets.basicApi.create({
      properties: ticketProps,
    });
    const ticketId = createResp.id || createResp.result?.id;
    const assocCalls = [];
    assocCalls.push(
      hubspotClient.crm.associations.v4.basicApi.create(
        'tickets',
        ticketId,
        'deals',
        dealId,
        []
      )
    );
    assocCalls.push(
      hubspotClient.crm.associations.v4.basicApi.create(
        'tickets',
        ticketId,
        'line_items',
        lineItemId,
        []
      )
    );
    await Promise.all(assocCalls);
    console.log(`[manualTickets] Ticket ${ticketId} creado para line item ${lineItemId}`);
  } catch (err) {
    console.error('[manualTickets] Error creando ticket', err?.response?.body || err?.message || err);
  }
}

export async function generateTicketsForDeal(deal, lineItems) {
  let created = 0;
  for (const li of lineItems || []) {
    const lp = li.properties || {};
    const isActive = lp.facturacion_activa === true || lp.facturacion_activa === 'true';
    const isAutomatic = lp.facturacion_automatica === true || lp.facturacion_automatica === 'true';
    if (!isActive || isAutomatic) continue;
    let invoiceDate = lp.hs_recurring_billing_start_date || lp.fecha_inicio_de_facturacion;
    if (!invoiceDate) {
      invoiceDate = lp.fecha_1 || null;
    }
    try {
      await createTicketForLineItem(deal, li, invoiceDate);
      created++;
    } catch (e) {
      console.error('[manualTickets] Error generando ticket para line item', li.id, e?.message);
    }
  }
  return { created };
}
