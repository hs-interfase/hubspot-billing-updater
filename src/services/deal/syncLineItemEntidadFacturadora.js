// src/services/deal/syncLineItemEntidadFacturadora.js
//
// Escribe la ENTIDAD FACTURADORA (emisora) en el select `empresa_que_factura` del LINE
// ITEM según la regla de dos niveles de resolverEntidadFacturadora (país PY → ISA PY ·
// UY → producto con área de desempate · Mixto/otro → no tocar). Mismo patrón y enganche
// que syncLineItemAreaByCountry (phase1, antes de syncDealCatalogTags).
//
// SOLO RELLENA VACÍOS: si el vendedor ya cargó el select, no se pisa (decisión usuaria
// 23-jul). La propagación al ticket NO vive acá: el snapshot (snapshotService.js:320) y
// el sync quirúrgico (syncLineItemPropToTicket.js) ya copian
// lp.empresa_que_factura → ticket.entidad_facturadora.
//
// Detrás del flag ENTIDAD_FACTURADORA_ENABLED (default OFF). Idempotente: un LI ya
// resuelto o irresoluble no genera escrituras.

import { hubspotClient } from '../../hubspotClient.js';
import { resolverEntidadFacturadora } from '../billing/resolverEntidadFacturadora.js';
import logger from '../../../lib/logger.js';

const MODULE = 'syncLineItemEntidadFacturadora';

export function entidadFacturadoraEnabled() {
  return String(process.env.ENTIDAD_FACTURADORA_ENABLED || '').toLowerCase() === 'true';
}

/**
 * Rellena empresa_que_factura en los line items del deal que la tengan vacía.
 * Muta también las props en memoria (igual que el sync de área) para que cualquier
 * consumidor posterior de la misma pasada vea el valor nuevo.
 *
 * @param {object} deal - deal con .id / .properties (incluye pais_operativo)
 * @param {Array} lineItems - line items con .id / .properties (empresa_que_factura, area, hs_product_id)
 */
export async function syncLineItemEntidadFacturadora(deal, lineItems) {
  if (!entidadFacturadoraEnabled()) return;

  const lis = Array.isArray(lineItems) ? lineItems : [];
  if (!lis.length) return;

  const paisOperativo = deal?.properties?.pais_operativo;
  const dealId = String(deal?.id || deal?.properties?.hs_object_id || '');

  const inputs = [];
  const sinResolver = [];
  for (const li of lis) {
    const id = String(li?.id || li?.properties?.hs_object_id || '').trim();
    if (!id) continue;
    const actual = String(li?.properties?.empresa_que_factura || '').trim();
    if (actual) continue; // ya cargada (a mano o por corrida previa) → no pisar

    const { valor, metodo } = resolverEntidadFacturadora({
      paisOperativo,
      productId: li?.properties?.hs_product_id,
      area: li?.properties?.area,
    });

    if (!valor) {
      sinResolver.push({ liId: id, metodo });
      continue;
    }
    if (metodo === 'area_gana_a_producto') {
      logger.warn(
        { module: MODULE, dealId, liId: id, area: li?.properties?.area, productId: li?.properties?.hs_product_id },
        'Área y producto contradicen la emisora (iSCert): gana el área'
      );
    }
    inputs.push({ id, properties: { empresa_que_factura: valor } });
    if (li.properties) li.properties.empresa_que_factura = valor; // reflejar en memoria
  }

  if (sinResolver.length) {
    logger.info(
      { module: MODULE, dealId, paisOperativo, sinResolver },
      'Line items sin entidad facturadora resoluble (se dejan vacíos)'
    );
  }
  if (!inputs.length) return;

  await hubspotClient.crm.lineItems.batchApi.update({ inputs });
  logger.info(
    { module: MODULE, dealId, paisOperativo, count: inputs.length },
    'empresa_que_factura (entidad facturadora) rellenada en line items'
  );
}
