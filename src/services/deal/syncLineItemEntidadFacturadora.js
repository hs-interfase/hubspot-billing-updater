// src/services/deal/syncLineItemEntidadFacturadora.js
//
// Escribe la ENTIDAD FACTURADORA (emisora) en el select `empresa_que_factura` del LINE
// ITEM según la regla de dos niveles de resolverEntidadFacturadora (país PY → ISA PY ·
// UY → producto con área de desempate · Mixto/otro → no tocar). Mismo patrón y enganche
// que syncLineItemAreaByCountry (phase1, antes de syncDealCatalogTags).
//
// 🔴 ALINEA SIEMPRE — REVIERTE la decisión del 23-jul (2-ago-2026).
// Hasta el 2-ago esto SOLO RELLENABA VACÍOS: «si el vendedor ya cargó el select, no se
// pisa». La usuaria lo cambió: la entidad facturadora es **límite duro**, igual que el
// área. Las dos son CONSECUENCIA del país y del producto, no una elección del vendedor
// — si el select no coincide con lo que resuelve la regla, se corrige.
// El texto viejo («solo rellena vacíos») está superado: no reintroducirlo.
//
// Único caso en que NO se toca: cuando la regla no resuelve (`valor` vacío — país
// Mixto/otro, o UY sin producto ni área). Ahí se deja lo que haya en vez de vaciarlo.
//
// La propagación al ticket NO vive acá: el snapshot (snapshotService.js:320) y
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
        'Área y producto contradicen la emisora: gana el área'
      );
    }
    if (actual === valor) continue; // ya coincide → idempotente

    // Corrección de una emisora que existía pero NO coincidía con la regla. Se loguea
    // aparte del relleno: son las que la política vieja («solo rellena vacíos») dejaba
    // desalineadas para siempre.
    if (actual) {
      logger.info(
        { module: MODULE, dealId, liId: id, de: actual, a: valor, metodo },
        'Entidad facturadora REALINEADA (no estaba vacía: no coincidía)'
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
