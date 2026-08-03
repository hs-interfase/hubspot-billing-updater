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

  // ── NO-PARAGUAY: el área SALE DEL PRODUCTO, y hay que copiarla ───────────────
  // 🔴 2-ago-2026. Este módulo decía «Uruguay / Mixto / otro → se deja el área del
  // producto» y se iba sin hacer nada, asumiendo la herencia nativa de HubSpot. Esa
  // herencia SÓLO ocurre cuando el line item se crea desde el selector de productos
  // en la UI: los que crea el MOTOR por API (el espejo UY, entre otros) nacen con el
  // área VACÍA. Medido en sandbox: con los 13 productos ya cargados con su área, el
  // line item del espejo seguía sin área hasta que se agregó esta copia.
  //
  // Criterio de la usuaria (2-ago): «el área debe ser COHERENTE con el producto
  // seleccionado — o Paraguay en el caso de Paraguay. Siempre acorde al producto».
  //
  // ⚠️ ALINEA SIEMPRE, no sólo rellena vacíos: si el área del line item no coincide con
  // la de su producto, se corrige. Es DISTINTO de syncLineItemEntidadFacturadora, que sí
  // respeta lo cargado a mano (decisión 23-jul) — acá el área no es una elección del
  // vendedor sino una consecuencia del producto, así que cambiar el producto cambia el
  // área. Único caso en que NO se toca: cuando el PRODUCTO no tiene área cargada; ahí se
  // deja lo que haya en vez de vaciarlo.
  if (pais !== 'paraguay') {
    const pendientes = lis.filter(li => String(li?.properties?.hs_product_id || '').trim());
    if (!pendientes.length) return;

    const productIds = [...new Set(pendientes.map(li => String(li.properties.hs_product_id).trim()))];
    let areaPorProducto = {};
    try {
      const r = await hubspotClient.crm.products.batchApi.read({
        properties: ['area'],
        inputs: productIds.map(id => ({ id })),
      });
      areaPorProducto = Object.fromEntries(
        (r.results || []).map(p => [String(p.id), String(p.properties?.area || '').trim()])
      );
    } catch (err) {
      logger.warn(
        { module: 'syncLineItemAreaByCountry', dealId: String(deal?.id || ''), productIds, err: err?.message },
        'No se pudieron leer las áreas de los productos: se deja el área como está'
      );
      return;
    }

    const desdeProducto = [];
    const sinAreaEnElProducto = [];
    const corregidas = [];
    for (const li of pendientes) {
      const id = String(li?.id || li?.properties?.hs_object_id || '').trim();
      const area = areaPorProducto[String(li.properties.hs_product_id).trim()] || '';
      if (!id) continue;
      if (!area) { sinAreaEnElProducto.push({ liId: id, productId: li.properties.hs_product_id }); continue; }
      const actual = String(li?.properties?.area || '').trim();
      if (actual === area) continue; // ya coincide → idempotente
      if (actual) corregidas.push({ liId: id, de: actual, a: area });
      desdeProducto.push({ id, properties: { area } });
      if (li.properties) li.properties.area = area; // para el syncDealCatalogTags posterior
    }

    // Las que NO estaban vacías sino DESALINEADAS: se dejan trazadas aparte, porque son
    // las que un cambio de producto (o una carga a mano equivocada) venía dejando mal.
    if (corregidas.length) {
      logger.info(
        { module: 'syncLineItemAreaByCountry', dealId: String(deal?.id || ''), corregidas },
        'Área REALINEADA al producto (no estaba vacía: no coincidía)'
      );
    }

    if (sinAreaEnElProducto.length) {
      logger.info(
        { module: 'syncLineItemAreaByCountry', dealId: String(deal?.id || ''), pais, sinAreaEnElProducto },
        'Line items cuyo PRODUCTO no tiene área cargada (se dejan vacíos)'
      );
    }
    if (!desdeProducto.length) return;

    await hubspotClient.crm.lineItems.batchApi.update({ inputs: desdeProducto });
    logger.info(
      { module: 'syncLineItemAreaByCountry', dealId: String(deal?.id || ''), pais, count: desdeProducto.length },
      'Área de line items copiada DESDE EL PRODUCTO (país no-Paraguay)'
    );
    return;
  }

  // ── PARAGUAY: se fuerza, sin importar el producto ────────────────────────────
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
