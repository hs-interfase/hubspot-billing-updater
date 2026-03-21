// src/services/mirrorUtils.js
//
// Utilidades para resolver relaciones PY ↔ UY mirror en line items (y futuro: tickets).
// Este módulo es el punto central de lookup — no contiene lógica de negocio,
// solo resolución de IDs entre objetos espejados.

import { hubspotClient } from '../hubspotClient.js';
import logger from '../../lib/logger.js';

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

  // 3) Obtener IDs de line items del deal UY espejo
  let mirrorLiAssocResp;
  try {
    mirrorLiAssocResp = await hubspotClient.crm.associations.v4.basicApi.getPage(
      'deals',
      mirrorDealId,
      'line_items',
      100
    );
  } catch (err) {
    log.warn({ err, mirrorDealId }, 'No se pudo obtener line items del deal UY');
    return null;
  }

  const mirrorLiIds = (mirrorLiAssocResp.results || []).map(r => String(r.toObjectId));
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
  };
}