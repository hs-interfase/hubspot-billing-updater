// src/services/deal/syncDealCatalogTags.js
//
// Sincroniza 4 propiedades multi-select del NEGOCIO con la unión de los valores
// de sus line items:
//   - producto            ← nombre de catálogo (hs_product_id del line item)
//   - rubro               ← propiedad `servicio` del line item
//   - unidad_de_negocio   ← propiedad `unidad_de_negocio` del line item
//   - area                ← propiedad `area` del line item
//     ⚠️ El select `area` del DEAL trae una taxonomía propia (distinta de la del
//        line item); las opciones del LI que falten se auto-crean en el deal.
//
// Reglas (confirmadas con la usuaria):
//   - Reemplazo total (unión sin repetir), no merge. Cuenta TODAS las líneas.
//   - Si un valor no existe como opción del dropdown → se crea automáticamente.
//   - Comparación sin distinguir mayúsculas/acentos para no crear duplicados;
//     se guarda el texto original (solo trim).
//   - No-op si el set resultante ya coincide con lo que tiene el deal.

import { hubspotClient } from '../../hubspotClient.js';
import { fetchProductName } from '../../utils/productNames.js';
import logger from '../../../lib/logger.js';

const DEAL_OBJECT = 'deals';

const PROP_PRODUCTO = 'producto';
const PROP_RUBRO = 'rubro';
const PROP_UNIDAD = 'unidad_de_negocio';
const PROP_AREA = 'area';

// Cache de opciones por propiedad durante la vida del proceso (cron procesa
// deals secuencialmente). normKey(valor) -> valor interno real de la opción.
const optionsCache = new Map();

/** Normaliza solo para COMPARAR (no para guardar): trim + lowercase + sin acentos. */
function normKey(s) {
  return String(s ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '');
}

/** Dedupe preservando el primer texto visto (con su forma original). */
function dedupeByNorm(values) {
  const seen = new Set();
  const out = [];
  for (const raw of values) {
    const text = String(raw ?? '').trim();
    if (!text) continue;
    const k = normKey(text);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(text);
  }
  return out;
}

/**
 * Recolecta (puro, testeable) los tags de catálogo desde los line items.
 * @param {Array} lineItems
 * @param {{ productNameById?: Map<string,string> }} [opts]
 * @returns {{ producto: string[], rubro: string[], unidad_de_negocio: string[], area: string[] }}
 */
export function collectCatalogTags(lineItems, { productNameById = new Map() } = {}) {
  const lis = Array.isArray(lineItems) ? lineItems : [];
  const rubrosRaw = [];
  const unidadesRaw = [];
  const productosRaw = [];
  const areasRaw = [];

  for (const li of lis) {
    const p = li?.properties || {};
    if (p.servicio) rubrosRaw.push(p.servicio);
    if (p.unidad_de_negocio) unidadesRaw.push(p.unidad_de_negocio);
    if (p.area) areasRaw.push(p.area);

    const pid = String(p.hs_product_id ?? '').trim();
    if (pid) {
      const name = productNameById.get(pid);
      if (name) productosRaw.push(name);
    }
  }

  return {
    producto: dedupeByNorm(productosRaw),
    rubro: dedupeByNorm(rubrosRaw),
    unidad_de_negocio: dedupeByNorm(unidadesRaw),
    area: dedupeByNorm(areasRaw),
  };
}

/** Carga (y cachea) el mapa normKey -> valor interno de las opciones de la propiedad. */
async function loadOptions(propertyName) {
  if (optionsCache.has(propertyName)) return optionsCache.get(propertyName);
  const prop = await hubspotClient.crm.properties.coreApi.getByName(DEAL_OBJECT, propertyName);
  const map = new Map();
  for (const opt of prop?.options || []) {
    map.set(normKey(opt.value), opt.value);
  }
  optionsCache.set(propertyName, map);
  return map;
}

/**
 * Resuelve los valores deseados a valores internos de opciones, creando las que
 * falten. Devuelve la lista de valores internos a setear en el deal.
 */
async function ensureOptions(propertyName, desiredValues) {
  if (!desiredValues.length) return [];

  const map = await loadOptions(propertyName);
  const resolved = [];
  const toCreate = [];

  for (const text of desiredValues) {
    const k = normKey(text);
    if (map.has(k)) {
      resolved.push(map.get(k));
    } else {
      map.set(k, text); // optimista: la creamos abajo
      toCreate.push(text);
      resolved.push(text);
    }
  }

  if (toCreate.length > 0) {
    // Releer opciones actuales para no pisar nada y append las nuevas.
    const prop = await hubspotClient.crm.properties.coreApi.getByName(DEAL_OBJECT, propertyName);
    const existing = prop?.options || [];
    const maxOrder = existing.reduce((m, o) => Math.max(m, Number(o.displayOrder) || 0), 0);
    const newOptions = toCreate.map((label, i) => ({
      label,
      value: label,
      displayOrder: maxOrder + 1 + i,
      hidden: false,
    }));

    await hubspotClient.crm.properties.coreApi.update(DEAL_OBJECT, propertyName, {
      options: [...existing, ...newOptions],
    });
    logger.info(
      { module: 'syncDealCatalogTags', fn: 'ensureOptions', propertyName, created: toCreate },
      'Opciones nuevas creadas en propiedad multi-select del deal'
    );
  }

  return resolved;
}

/** ¿El valor actual (string `a;b;c`) representa el mismo conjunto que `arr`? */
function sameSet(currentStr, arr) {
  const cur = new Set(String(currentStr ?? '').split(';').map(s => s.trim()).filter(Boolean));
  if (cur.size !== arr.length) return false;
  for (const v of arr) if (!cur.has(v)) return false;
  return true;
}

/**
 * Sincroniza producto/rubro/unidad_de_negocio del deal con sus line items.
 * No tira: cualquier error queda logueado por el caller (envuelto en try/catch).
 *
 * @param {object} deal - deal con .id / .properties
 * @param {Array} lineItems
 * @param {{ resolveProductName?: (id:string)=>Promise<string> }} [opts]
 */
export async function syncDealCatalogTags(deal, lineItems, { resolveProductName = fetchProductName } = {}) {
  const dealId = String(deal?.id || deal?.properties?.hs_object_id || '').trim();
  if (!dealId) return;

  const lis = Array.isArray(lineItems) ? lineItems : [];

  // Resolver nombres de producto (únicos) por hs_product_id.
  const uniqueProductIds = [
    ...new Set(
      lis
        .map(li => String(li?.properties?.hs_product_id ?? '').trim())
        .filter(Boolean)
    ),
  ];
  const productNameById = new Map();
  for (const pid of uniqueProductIds) {
    const name = await resolveProductName(pid);
    if (name) productNameById.set(pid, name);
  }

  const tags = collectCatalogTags(lis, { productNameById });

  // Resolver/crear opciones para cada propiedad.
  const [resProducto, resRubro, resUnidad, resArea] = await Promise.all([
    ensureOptions(PROP_PRODUCTO, tags.producto),
    ensureOptions(PROP_RUBRO, tags.rubro),
    ensureOptions(PROP_UNIDAD, tags.unidad_de_negocio),
    ensureOptions(PROP_AREA, tags.area),
  ]);

  // Construir update solo con lo que cambió (reemplazo total).
  const current = deal?.properties || {};
  const updateProps = {};
  if (!sameSet(current[PROP_PRODUCTO], resProducto)) updateProps[PROP_PRODUCTO] = resProducto.join(';');
  if (!sameSet(current[PROP_RUBRO], resRubro)) updateProps[PROP_RUBRO] = resRubro.join(';');
  if (!sameSet(current[PROP_UNIDAD], resUnidad)) updateProps[PROP_UNIDAD] = resUnidad.join(';');
  if (!sameSet(current[PROP_AREA], resArea)) updateProps[PROP_AREA] = resArea.join(';');

  if (Object.keys(updateProps).length === 0) {
    logger.debug({ module: 'syncDealCatalogTags', dealId }, 'Tags de catálogo sin cambios (no-op)');
    return;
  }

  await hubspotClient.crm.deals.basicApi.update(dealId, { properties: updateProps });
  logger.info(
    { module: 'syncDealCatalogTags', dealId, updateProps },
    'Tags de catálogo del deal actualizados (producto/rubro/unidad_de_negocio/area)'
  );
}
