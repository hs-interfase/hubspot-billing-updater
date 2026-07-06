// src/services/deal/syncLineItemAreaByCountry.js
//
// Regla de ÁREA por PAÍS OPERATIVO del NEGOCIO (decisión usuaria 2026-07-02):
//   - deal.pais_operativo === 'Paraguay' → TODAS las áreas de sus line items = 'Paraguay'
//   - deal.pais_operativo === 'Uruguay'  → se deja el área que hereda del PRODUCTO
//   - 'Mixto' u otro                     → no se toca (se deja el área del producto por línea)
//
// Corre en el motor (phase1) ANTES de syncDealCatalogTags, para que el área nueva se
// propague al negocio (syncDealCatalogTags sube la unión de las áreas de los LIs al deal).
//
// Detrás del flag AREA_BY_COUNTRY_ENABLED (default OFF): depende de que la opción
// 'Paraguay' exista en products.area (el line item hereda las opciones del producto).
//
// Idempotente: solo escribe los LIs cuya área difiere del valor esperado. Muta también
// las props en memoria para que el syncDealCatalogTags posterior tome el valor nuevo.

import { hubspotClient } from '../../hubspotClient.js';
import logger from '../../../lib/logger.js';

// Valor interno de la opción del select `area` para Paraguay (la que renombramos
// desde "ISA PY"). Override por env por si cambia el valor interno en HubSpot.
const AREA_PARAGUAY = process.env.AREA_PARAGUAY_VALUE || 'Paraguay';

export function areaByCountryEnabled() {
  return String(process.env.AREA_BY_COUNTRY_ENABLED || '').toLowerCase() === 'true';
}

/**
 * Fuerza el área de los line items a 'Paraguay' cuando el país operativo del negocio
 * es Paraguay. No hace nada para Uruguay / Mixto / otros (se respeta el área del producto).
 *
 * @param {object} deal - deal con .id / .properties (incluye pais_operativo)
 * @param {Array} lineItems - line items con .id / .properties.area
 */
export async function syncLineItemAreaByCountry(deal, lineItems) {
  if (!areaByCountryEnabled()) return;

  const lis = Array.isArray(lineItems) ? lineItems : [];
  if (!lis.length) return;

  const pais = String(deal?.properties?.pais_operativo || '').trim().toLowerCase();
  if (pais !== 'paraguay') return; // Uruguay / Mixto / otro → se deja el área del producto.

  const inputs = [];
  for (const li of lis) {
    const id = String(li?.id || li?.properties?.hs_object_id || '').trim();
    if (!id) continue;
    const current = String(li?.properties?.area || '').trim();
    if (current === AREA_PARAGUAY) continue; // ya está bien → idempotente
    inputs.push({ id, properties: { area: AREA_PARAGUAY } });
    if (li.properties) li.properties.area = AREA_PARAGUAY; // reflejar en memoria para syncDealCatalogTags
  }

  if (!inputs.length) return;

  await hubspotClient.crm.lineItems.batchApi.update({ inputs });
  logger.info(
    { module: 'syncLineItemAreaByCountry', dealId: String(deal?.id || deal?.properties?.hs_object_id || ''), pais, count: inputs.length, area: AREA_PARAGUAY },
    'Área de line items forzada a Paraguay por país operativo del negocio'
  );
}
