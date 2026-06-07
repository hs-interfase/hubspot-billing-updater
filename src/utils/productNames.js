// src/utils/productNames.js
//
// Resolver el nombre de un producto del catálogo a partir de su hs_product_id.
// Cache en memoria para no pegarle a HubSpot por el mismo producto repetidas veces
// (mismo patrón que ya existía en src/jobs/cronExportReporte.js, ahora compartido).

import { hubspotClient } from '../hubspotClient.js';
import logger from '../../lib/logger.js';

const productNameCache = new Map(); // productId -> name (o '' si no se pudo resolver)

/**
 * Devuelve el nombre del producto del catálogo para un hs_product_id.
 * Nunca tira: ante error devuelve '' y cachea el fallo.
 *
 * @param {string|number} productId
 * @returns {Promise<string>}
 */
export async function fetchProductName(productId) {
  const id = String(productId ?? '').trim();
  if (!id) return '';
  if (productNameCache.has(id)) return productNameCache.get(id);

  try {
    const p = await hubspotClient.crm.products.basicApi.getById(id, ['name']);
    const name = p?.properties?.name || '';
    productNameCache.set(id, name);
    return name;
  } catch (err) {
    logger.warn({ module: 'productNames', fn: 'fetchProductName', productId: id, err: err?.message }, 'No se pudo resolver nombre de producto');
    productNameCache.set(id, '');
    return '';
  }
}
