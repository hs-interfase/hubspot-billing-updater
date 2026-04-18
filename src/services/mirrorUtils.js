// src/services/mirrorUtils.js
//
// Utilidades para resolver relaciones PY ↔ UY mirror en line items (y futuro: tickets).
// Este módulo es el punto central de lookup — no contiene lógica de negocio,
// solo resolución de IDs entre objetos espejados.
import { hubspotClient } from '../hubspotClient.js';
import logger from '../../lib/logger.js';
import { reportHubSpotError } from '../utils/hubspotErrorCollector.js';
import { getAllAssociatedIds } from '../utils/hubspotAssociations.js';
import { withRetry } from '../utils/withRetry.js';
import {
  TICKET_PIPELINE,
  TICKET_STAGES,
  AUTOMATED_TICKET_PIPELINE,
  FORECAST_AUTO_STAGES,
} from '../config/constants.js';

/**
 * Dado el ID de un line item PY, encuentra su line item espejo en el deal UY.
 *
 * Flujo:
 *   pyLineItemId
 *     → deal asociado al LI (associations v4)
 *     → deal.properties.deal_uy_mirror_id
 *     → line items del deal UY (associations v4)
 *     → batch read → encontrar of_line_item_py_origen_id === pyLineItemId
 *
 * Protección anti-loop: si el deal del LI tiene es_mirror_de_py=true,
 * retorna null inmediatamente (no propagar desde UY hacia UY).
 *
 * @param {string|number} pyLineItemId
 * @returns {Promise<{ mirrorDealId: string, mirrorLineItemId: string } | null>}
 */
export async function findMirrorLineItem(pyLineItemId) {
  const log = logger.child({
    module: 'mirrorUtils',
    fn: 'findMirrorLineItem',
    pyLineItemId: String(pyLineItemId),
  });

  // 1) Obtener deal asociado al LI PY
  let dealAssocResp;
  try {
    dealAssocResp = await hubspotClient.crm.associations.v4.basicApi.getPage(
      'line_items',
      String(pyLineItemId),
      'deals',
      10
    );
  } catch (err) {
    log.warn({ err }, 'No se pudo obtener deal del line item PY');
    return null;
  }

  const dealId = String((dealAssocResp.results || [])[0]?.toObjectId || '').trim();
  if (!dealId) {
    log.warn('Line item PY sin deal asociado');
    return null;
  }

  // 2) Leer deal PY: verificar que no sea ya un mirror + obtener deal_uy_mirror_id
  let deal;
  try {
    deal = await hubspotClient.crm.deals.basicApi.getById(
      dealId,
      ['deal_uy_mirror_id', 'es_mirror_de_py']
    );
  } catch (err) {
    log.warn({ err, dealId }, 'No se pudo leer el deal PY');
    return null;
  }

  const dealProps = deal?.properties || {};

  // Anti-loop: si este LI pertenece a un deal que ya ES mirror, no propagar
  if (String(dealProps.es_mirror_de_py || '').toLowerCase() === 'true') {
    log.debug({ dealId }, 'Deal es mirror de PY, no se propaga para evitar loop');
    return null;
  }

  const mirrorDealId = String(dealProps.deal_uy_mirror_id || '').trim();
  if (!mirrorDealId) {
    log.debug({ dealId }, 'Deal PY sin deal_uy_mirror_id, nada que propagar');
    return null;
  }

  // 3) Obtener IDs de line items del deal UY espejo (con paginación completa)
  let mirrorLiIds;
  try {
    mirrorLiIds = await getAllAssociatedIds(hubspotClient, 'deals', mirrorDealId, 'line_items');
  } catch (err) {
    log.warn({ err, mirrorDealId }, 'No se pudo obtener line items del deal UY');
    return null;
  }
  if (!mirrorLiIds.length) {
    log.debug({ mirrorDealId }, 'Deal UY sin line items asociados');
    return null;
  }

  // 4) Batch read para encontrar el espejo por of_line_item_py_origen_id
  let batchResp;
  try {
    batchResp = await hubspotClient.crm.lineItems.batchApi.read({
      inputs: mirrorLiIds.map(id => ({ id })),
      properties: ['of_line_item_py_origen_id', 'name', 'uy', 'pais_operativo'],
    });
  } catch (err) {
    log.warn({ err, mirrorDealId }, 'No se pudo batch-read line items del deal UY');
    return null;
  }

  const pyId = String(pyLineItemId);
  const mirrorLi = (batchResp.results || []).find(li =>
    String(li.properties?.of_line_item_py_origen_id || '').trim() === pyId
  );

  if (!mirrorLi) {
    log.debug({ mirrorDealId, pyLineItemId }, 'No se encontró line item espejo UY para este PY');
    return null;
  }

  log.info(
    { mirrorDealId, mirrorLineItemId: mirrorLi.id, name: mirrorLi.properties?.name },
    'Line item espejo UY encontrado'
  );

  return {
    mirrorDealId,
    mirrorLineItemId: String(mirrorLi.id),
    pyDealId: dealId,
  };
}

/**
 * Dado el ID de un line item PY automático que acaba de facturar,
 * encuentra su ticket forecast en el mirror UY y lo promueve al pipeline
 * manual en stage "Próximos a Facturar" (TICKET_STAGES.NEW).
 * El admin luego lo mueve a "Listo para Facturar" (TICKET_STAGES.READY) para emitir.
 *
 * Solo debe llamarse cuando el LI PY es automático.
 * Para PY manuales usar notifyMirrorDealOnManualEmission.
 *
 * Diseñado para llamarse fire-and-forget desde phase3 y urgentBillingService.
 * Nunca lanza — todos los errores son capturados y logueados.
 *
 * @param {string|number} pyLineItemId  ID del line item PY que facturó
 */
export async function promoteMirrorTicketToManualReady(pyLineItemId, billingYMD) {
  const log = logger.child({
    module: 'mirrorUtils',
    fn: 'promoteMirrorTicketToManualReady',
    pyLineItemId: String(pyLineItemId),
  });

  // 1) Encontrar el LI UY espejo
  let mirrorInfo;
  try {
    mirrorInfo = await findMirrorLineItem(pyLineItemId);
  } catch (err) {
    log.warn({ err }, 'Error buscando mirror line item, abortando promoción');
    return;
  }

  if (!mirrorInfo) {
    log.debug('Sin mirror UY para este LI PY, nada que promover');
    return;
  }

const { mirrorLineItemId, mirrorDealId, pyDealId } = mirrorInfo;

  // 2) Leer LI UY: necesitamos line_item_key y facturacion_automatica
  let mirrorLi;
  try {
    mirrorLi = await hubspotClient.crm.lineItems.basicApi.getById(
      String(mirrorLineItemId),
    ['line_item_key', 'facturacion_automatica', 'name', 'hs_recurring_billing_number_of_payments', 'hs_recurring_billing_period']
    );
  } catch (err) {
    log.warn({ err, mirrorLineItemId }, 'Error leyendo LI UY, abortando');
    return;
  }

  const mirrorProps = mirrorLi?.properties || {};
  const mirrorLik = String(mirrorProps.line_item_key || '').trim();

  if (!mirrorLik) {
    log.warn({ mirrorLineItemId }, 'LI UY sin line_item_key, no se puede buscar ticket');
    return;
  }

  // 3) Buscar ticket forecast automático del LI UY por of_line_item_key
  let forecastTicket;
  try {
    if (!billingYMD) {
      log.warn({ mirrorLik }, 'billingYMD no recibido, no se puede buscar ticket por key exacta');
      return;
    }

    const { buildTicketKeyFromLineItemKey } = await import('../utils/ticketKey.js');
    const ticketKey = buildTicketKeyFromLineItemKey(mirrorDealId, mirrorLik, billingYMD);

    const searchBody = {
      filterGroups: [{
        filters: [
          { propertyName: 'of_ticket_key', operator: 'EQ', value: ticketKey },
        ],
      }],
      properties: ['hs_pipeline_stage', 'hs_pipeline', 'of_ticket_key', 'of_line_item_key'],
      limit: 2,
    };

    const resp = await withRetry(
      () => hubspotClient.crm.tickets.searchApi.doSearch(searchBody),
      { module: 'mirrorUtils', fn: 'promoteMirrorTicketToManualReady', ticketKey }
    );

    forecastTicket = (resp?.results || [])[0] || null;
  } catch (err) {
    log.warn({ err, mirrorLik }, 'Error buscando ticket forecast UY');
    return;
  }

  if (!forecastTicket) {
    log.info({ mirrorLik }, 'Sin ticket forecast automático UY para promover (puede no existir aún)');
    return;
  }

  const ticketId = String(forecastTicket.id);
  log.info({ ticketId, mirrorLik }, 'Ticket forecast UY encontrado, promoviendo a "Próximos a Facturar"');

  // 4) Mover ticket al pipeline manual en stage "Próximos a Facturar" (TICKET_STAGES.NEW).
  //    NO va a TICKET_STAGES.READY ("Listo para Facturar"): el admin debe revisarlo primero.
  try {
    await hubspotClient.crm.tickets.basicApi.update(ticketId, {
      properties: {
        hs_pipeline: TICKET_PIPELINE,
        hs_pipeline_stage: TICKET_STAGES.NEW,
      },
    });
    log.info({ ticketId }, 'Ticket UY movido a "Próximos a Facturar" (pipeline manual)');
  } catch (err) {
    log.error({ err, ticketId }, 'Error moviendo ticket UY a manual READY');
    return;
  }

  // 6) Notificar al deal UY que PY facturó y hay que facturar manualmente
  const productName = String(mirrorProps.name || '').trim() || 'Producto desconocido';
  const aviso = `Factura PY emitida. Deal PY: ${pyDealId} | Producto: ${productName} | LI PY: ${pyLineItemId} → LI UY: ${mirrorLineItemId}. Revisar y facturar manualmente en UY.`;

  reportHubSpotError({
    level: 'warn',
    objectType: 'deal',
    objectId: mirrorDealId,
    message: aviso,
  });

  log.info({ mirrorDealId, aviso }, 'Aviso de factura PY escrito en deal UY');
}


/**
 * Cuando un LI PY manual emite factura, escribe un aviso en el deal UY espejo
 * para que el equipo sepa que debe facturar manualmente.
 * No promueve ticket — Phase 2 ya lo hizo dentro de la ventana de 30 días.
 *
 * Diseñado para llamarse fire-and-forget desde phase3.
 * Nunca lanza — todos los errores son capturados y logueados.
 *
 * @param {string|number} pyLineItemId  ID del line item PY que facturó
 * @param {string} billingYMD           Fecha de facturación YYYY-MM-DD
 */
export async function notifyMirrorDealOnManualEmission(pyLineItemId, billingYMD) {
  const log = logger.child({
    module: 'mirrorUtils',
    fn: 'notifyMirrorDealOnManualEmission',
    pyLineItemId: String(pyLineItemId),
  });

  // 1) Encontrar el LI UY espejo
  let mirrorInfo;
  try {
    mirrorInfo = await findMirrorLineItem(pyLineItemId);
  } catch (err) {
    log.warn({ err }, 'Error buscando mirror line item, abortando aviso');
    return;
  }

  if (!mirrorInfo) {
    log.debug('Sin mirror UY para este LI PY, nada que notificar');
    return;
  }

  const { mirrorLineItemId, mirrorDealId, pyDealId } = mirrorInfo;

  // 2) Leer LI UY: solo necesitamos name
  let mirrorLi;
  try {
    mirrorLi = await hubspotClient.crm.lineItems.basicApi.getById(
      String(mirrorLineItemId),
      ['name']
    );
  } catch (err) {
    log.warn({ err, mirrorLineItemId }, 'Error leyendo LI UY, abortando aviso');
    return;
  }

  const productName = String(mirrorLi?.properties?.name || '').trim() || 'Producto desconocido';
  const aviso = `Factura PY emitida (manual). Deal PY: ${pyDealId} | Producto: ${productName} | LI PY: ${pyLineItemId} → LI UY: ${mirrorLineItemId} | Período: ${billingYMD}. Ticket UY ya promovido por Phase 2 — revisar y confirmar.`;

  reportHubSpotError({
    level: 'warn',
    objectType: 'deal',
    objectId: mirrorDealId,
    message: aviso,
  });

  log.info({ mirrorDealId, aviso }, 'Aviso de factura PY manual escrito en deal UY');
}