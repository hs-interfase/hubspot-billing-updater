// api/escuchar-cambios.js
import logger from '../lib/logger.js';
import { hubspotClient } from '../src/hubspotClient.js';
import { enqueue } from '../src/webhookQueue.js';
import { parseBool } from '../src/utils/parsers.js';
import { isDealCancelledStage } from '../src/config/constants.js';
import { LI_NOMBRE_PRODUCTO_PROP } from '../src/services/billing/nombreProductoSelect.js';
import { isTransferableLiProp } from '../src/services/lineItems/syncLineItemPropToTicket.js';
import { esEventoTicketValor, esTicketEditableParaValor } from '../src/utils/webhookRouteRules.js';

const MODULE = 'escuchar-cambios';

// Prop del ticket que apunta a su deal (misma que usan processUrgentTicket y recalcValorTotal)
const PROP_TICKET_DEAL_ID = process.env.PROP_TICKET_DEAL_ID || 'of_deal_id';

// ─── Helper: resolver dealId desde line item (para deduplicación en la cola) ─

async function getDealIdForLineItem(lineItemId) {
  try {
    const resp = await hubspotClient.crm.associations.v4.basicApi.getPage(
      'line_items',
      String(lineItemId),
      'deals',
      100
    );
    const dealIds = (resp.results || [])
      .map((r) => String(r.toObjectId))
      .filter(Boolean);
    return dealIds.length ? dealIds[0] : null;
  } catch (err) {
    logger.warn(
      { module: MODULE, fn: 'getDealIdForLineItem', lineItemId, err: err?.message },
      'No se pudo resolver dealId pre-enqueue, se resolverá en el worker'
    );
    return null;
  }
}

// ─── Helper: info de ruteo de un ticket (deal + pipeline/stage para el guard) ─

async function getTicketRoutingInfo(ticketId) {
  try {
    const ticket = await hubspotClient.crm.tickets.basicApi.getById(String(ticketId), [
      PROP_TICKET_DEAL_ID, 'hs_pipeline', 'hs_pipeline_stage',
    ]);
    const props = ticket?.properties || {};
    return {
      dealId: (props[PROP_TICKET_DEAL_ID] || '').trim() || null,
      pipeline: props.hs_pipeline,
      stage: props.hs_pipeline_stage,
    };
  } catch (err) {
    logger.warn(
      { module: MODULE, fn: 'getTicketRoutingInfo', ticketId, err: err?.message },
      'No se pudo leer el ticket pre-enqueue, se resolverá en el worker'
    );
    return null;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const payload = Array.isArray(req.body) ? req.body[0] : req.body;

    const objectId = payload?.objectId;
    const objectType = payload?.subscriptionType?.split('.')[0] || 'line_item';
    const propertyName = payload?.propertyName;
    const propertyValue = payload?.propertyValue;
    const eventId = payload?.eventId;

    logger.info({ module: MODULE, fn: 'handler', objectId, objectType, propertyName, propertyValue, eventId, changeSource: payload?.changeSource }, 'Evento webhook recibido');

    if (!objectId) {
      logger.error({ module: MODULE, fn: 'handler' }, 'Missing objectId');
      return res.status(400).json({ error: 'Missing objectId' });
    }

    // ====== RUTA 0: CANCELACIÓN DE DEAL (cambio de stage) ======
    // deal.propertyChange sobre 'dealstage'. Solo nos interesa si el stage
    // nuevo es de cancelación; cualquier otro cambio de stage se ignora.
    if (objectType === 'deal' && propertyName === 'dealstage') {
      if (!isDealCancelledStage(propertyValue)) {
        return res.status(200).json({ message: 'Dealstage no es de cancelación, skipped', propertyValue });
      }

      const queueId = await enqueue({
        source: 'escuchar-cambios',
        objectType: 'deal',
        objectId,
        propertyName,
        propertyValue,
        dealId: String(objectId),
        actionType: 'deal_cancel',
        priority: 1,
        eventId,
        rawPayload: payload,
      });
      return res.status(200).json({ queued: true, queueId, objectId, objectType, action: 'deal_cancel' });
    }

    // ====== RUTA 1: FACTURACIÓN URGENTE ======
    if (propertyName === 'facturar_ahora') {
      if (!parseBool(propertyValue)) {
        return res.status(200).json({ message: 'Property value not true, skipped' });
      }

      if (objectType === 'ticket') {
        // Tickets no tienen dealId directo para deduplicar, se encolan sin él
        const queueId = await enqueue({
          source: 'escuchar-cambios',
          objectType, objectId, propertyName, propertyValue,
          dealId: null,
          actionType: 'urgent_ticket',
          priority: 1,
          eventId,
          rawPayload: payload,
        });
        return res.status(200).json({ queued: true, queueId, objectId, objectType, action: 'urgent_ticket' });
      }

      // Flujo "facturar ahora" de line item ELIMINADO (2026-07, control de cambios N°5).
      // Responder 200 (no 4xx): HubSpot puede seguir mandando eventos de LI hasta que
      // se quite la suscripción, y un 4xx provoca reintentos/deshabilitación del webhook.
      return res.status(200).json({ message: 'facturar_ahora solo soportado en tickets, skipped', objectType });
    }

    // ====== RUTA 2: RECALCULACIÓN ======
    if (['actualizar', 'hs_billing_start_delay_type'].includes(propertyName)) {

      // CASO A: actualizar en TICKET
      if (propertyName === 'actualizar' && objectType === 'ticket') {
        if (!parseBool(propertyValue)) {
          return res.status(200).json({ message: 'actualizar flag not true, skipped', receivedValue: propertyValue });
        }

        const queueId = await enqueue({
          source: 'escuchar-cambios',
          objectType, objectId, propertyName, propertyValue,
          dealId: null,
          actionType: 'ticket_update',
          priority: 0,
          eventId,
          rawPayload: payload,
        });
        return res.status(200).json({ queued: true, queueId, objectId, action: 'ticket_update' });
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

      // CASO D: encolar recalculación para line items
      if (objectType === 'line_item') {
        const dealId = await getDealIdForLineItem(objectId);

        const queueId = await enqueue({
          source: 'escuchar-cambios',
          objectType, objectId, propertyName, propertyValue,
          dealId,
          actionType: 'recalc',
          priority: 0,
          eventId,
          rawPayload: payload,
        });

        return res.status(200).json({ queued: true, queueId, objectId, propertyName, dealId, action: 'recalc' });
      }
    }

    // ====== RUTA 3: CAMBIO DE PRODUCTO EN EL LINE ITEM (select nombre_producto) ======
    // Split producto 13-jul (D §3): el vendedor cambia el select `nombre_producto` del LI;
    // el motor reasocia el hs_product_id al producto elegido y re-corre las phases (de ahí
    // el producto del ticket, área, emisora y factura se recalculan solos).
    if (propertyName === LI_NOMBRE_PRODUCTO_PROP && objectType === 'line_item') {
      const dealId = await getDealIdForLineItem(objectId);
      const queueId = await enqueue({
        source: 'escuchar-cambios',
        objectType, objectId, propertyName, propertyValue,
        dealId,
        actionType: 'product_reassign',
        priority: 0,
        eventId,
        rawPayload: payload,
      });
      return res.status(200).json({ queued: true, queueId, objectId, propertyName, dealId, action: 'product_reassign' });
    }

    // ====== RUTA 4: SYNC QUIRÚRGICO LI→TICKET (prop editable del vendedor) ======
    // Tarea C (13-jul): el vendedor edita una prop del LI (sección de edición) que debe
    // reflejarse en el/los ticket(s) NO emitidos, pero SOLO esa prop (no re-snapshot del
    // ticket entero → no pisa lo que editó el responsable). Detrás de flag; con flag OFF
    // estas props caen al "skipped" de abajo (comportamiento actual). Excluye Frecuencia /
    // Término / Nº Pagos / Momento (isTransferableLiProp) y las props ya ruteadas arriba.
    if (
      objectType === 'line_item' &&
      parseBool(process.env.LI_PROP_SYNC_ENABLED) &&
      isTransferableLiProp(propertyName)
    ) {
      const dealId = await getDealIdForLineItem(objectId);
      const queueId = await enqueue({
        source: 'escuchar-cambios',
        objectType, objectId, propertyName, propertyValue,
        dealId,
        actionType: 'li_prop_sync',
        priority: 0,
        eventId,
        rawPayload: payload,
      });
      return res.status(200).json({ queued: true, queueId, objectId, propertyName, dealId, action: 'li_prop_sync' });
    }

    // ====== RUTA 5: FRECUENCIA / Nº DE PAGOS DEL LI → RECALCULAR VALOR ======
    // Regla del VALOR auto-renew (21-jul): price × qty × multiplicador anual de la
    // frecuencia. Cambiar la frecuencia o el nº de pagos cambia la clasificación
    // (auto-renew ↔ plan fijo) y el multiplicador → recalcular SOLO el VALOR del deal
    // (no re-corre phases; el ciclo de facturación sigue leyendo estas props por cron).
    // ⚠️ Requiere suscripción de webhook line_item.propertyChange para estas props.
    if (
      objectType === 'line_item' &&
      ['recurringbillingfrequency', 'hs_recurring_billing_frequency',
       'hs_recurring_billing_number_of_payments'].includes(propertyName)
    ) {
      const dealId = await getDealIdForLineItem(objectId);
      const queueId = await enqueue({
        source: 'escuchar-cambios',
        objectType, objectId, propertyName, propertyValue,
        dealId,
        actionType: 'valor_recalc',
        priority: 0,
        eventId,
        rawPayload: payload,
      });
      return res.status(200).json({ queued: true, queueId, objectId, propertyName, dealId, action: 'valor_recalc' });
    }

    // ====== RUTA 5b: MONTOS DEL TICKET EDITABLE → RECALCULAR VALOR ======
    // Para plan fijo / pago único el VALOR del deal = Σ subtotal_real de sus TICKETS
    // (recalcValorTotal). Si el responsable corrige montos de un ticket editable
    // (monto_unitario_real / cantidad_real / of_costo_usd / dolar), recalcular el VALOR.
    // Guard anti-tormenta: el motor escribe estas mismas props en tickets FORECAST
    // (re-snapshot masivo de phasep) → solo se encola si el ticket está en el pipeline
    // manual y su etapa NO es forecast (ver src/utils/webhookRouteRules.js).
    if (esEventoTicketValor(objectType, propertyName)) {
      const info = await getTicketRoutingInfo(objectId);

      if (info && !esTicketEditableParaValor(info)) {
        return res.status(200).json({ message: 'Ticket no editable (forecast/automático), skipped', propertyName });
      }

      const queueId = await enqueue({
        source: 'escuchar-cambios',
        objectType, objectId, propertyName, propertyValue,
        dealId: info?.dealId ?? null,
        actionType: 'valor_recalc',
        priority: 0,
        eventId,
        rawPayload: payload,
      });
      return res.status(200).json({ queued: true, queueId, objectId, propertyName, dealId: info?.dealId ?? null, action: 'valor_recalc' });
    }

    // ====== RUTA 6: CASILLA CANCELAR TICKET ======
    // Handler MÍNIMO (26-jul): el usuario marca `cancelar_ticket` en el ticket.
    // Solo cubre el caso simple (ticket manual sin factura viva → etapa CANCELADO);
    // NO toca factura, NO toca cupo, NO toca el espejo — eso llega con el flujo
    // completo de cancelar/revertir (en diseño). El worker resetea la casilla siempre.
    if (objectType === 'ticket' && propertyName === 'cancelar_ticket') {
      if (!parseBool(propertyValue)) {
        return res.status(200).json({ message: 'cancelar_ticket not true, skipped', receivedValue: propertyValue });
      }

      const queueId = await enqueue({
        source: 'escuchar-cambios',
        objectType, objectId, propertyName, propertyValue,
        dealId: null,
        actionType: 'ticket_cancel_request',
        priority: 1,
        eventId,
        rawPayload: payload,
      });
      return res.status(200).json({ queued: true, queueId, objectId, objectType, action: 'ticket_cancel_request' });
    }

    // ====== RUTA 7: CASILLA REVERTIR FACTURA ======
    // Flujo cancelar/revertir (Bloque 3): el usuario marca `revertir_factura` en
    // el ticket para cancelar la factura viva y dejar el ticket listo para
    // refacturar. El handler (processRevertTicketRequest) hace TODOS los guards
    // (llave CANCEL_REVERT_FLOW_ENABLED, pipeline automático, factura viva,
    // gate Nodum) y resetea la casilla siempre. Clon de la RUTA 6.
    if (objectType === 'ticket' && propertyName === 'revertir_factura') {
      if (!parseBool(propertyValue)) {
        return res.status(200).json({ message: 'revertir_factura not true, skipped', receivedValue: propertyValue });
      }

      const queueId = await enqueue({
        source: 'escuchar-cambios',
        objectType, objectId, propertyName, propertyValue,
        dealId: null,
        actionType: 'ticket_revert_request',
        priority: 1,
        eventId,
        rawPayload: payload,
      });
      return res.status(200).json({ queued: true, queueId, objectId, objectType, action: 'ticket_revert_request' });
    }

    // ====== PROPIEDAD NO RECONOCIDA ======
    return res.status(200).json({ message: 'Property not supported, skipped', propertyName });

  } catch (err) {
    logger.error({ module: MODULE, fn: 'handler', err }, 'Error inesperado procesando webhook');
    return res.status(500).json({ error: 'Internal server error', message: err?.message || 'Unknown error' });
  }
}