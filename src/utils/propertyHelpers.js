// src/utils/propertyHelpers.js

/**
 * Helpers para manejo robusto de propiedades de HubSpot:
 * - Validación de propiedades existentes (schema check)
 * - Construcción de updates sin valores vacíos
 * - Logging claro de qué se setea y qué falta
 */

import { hubspotClient } from '../hubspotClient.js';

// Cache de schemas por objectType
const schemaCache = new Map();

/**
 * Obtiene el schema de propiedades de un tipo de objeto de HubSpot.
 * Cachea el resultado para no llamar múltiples veces.
 * 
 * @param {string} objectType - 'deals', 'tickets', 'invoices', 'line_items'
 * @returns {Promise<Set<string>>} Set de nombres de propiedades que existen
 */
export async function getPropertySchema(objectType) {
  if (schemaCache.has(objectType)) {
    return schemaCache.get(objectType);
  }

  try {
    console.log(`[PropertySchema] Fetching schema for ${objectType}...`);
    const response = await hubspotClient.crm.properties.coreApi.getAll(objectType);
    const propertyNames = new Set(response.results.map(p => p.name));
    schemaCache.set(objectType, propertyNames);
    console.log(`[PropertySchema] ✅ Cached ${propertyNames.size} properties for ${objectType}`);
    return propertyNames;
  } catch (error) {
    console.error(`[PropertySchema] ❌ Error fetching schema for ${objectType}:`, error?.message);
    // Return empty set en caso de error para no romper el flujo
    const emptySet = new Set();
    schemaCache.set(objectType, emptySet);
    return emptySet;
  }
}

/**
 * Verifica si una propiedad existe en el schema de HubSpot.
 * 
 * @param {string} objectType - 'deals', 'tickets', 'invoices', 'line_items'
 * @param {string} propertyName - nombre de la propiedad
 * @returns {Promise<boolean>}
 */
export async function propertyExists(objectType, propertyName) {
  const schema = await getPropertySchema(objectType);
  return schema.has(propertyName);
}

/**
 * Construye un objeto de propiedades para update, removiendo valores vacíos/inválidos.
 * 
 * Reglas:
 * - Remueve null, undefined, "" (string vacío)
 * - Remueve NaN
 * - Retorna {} si no queda nada para setear
 * 
 * @param {Object} props - Objeto con propiedades a setear
 * @returns {Object} Objeto limpio o {}
 */
export function buildUpdateProps(props) {
  if (!props || typeof props !== 'object') return {};

  const cleaned = {};
  for (const [key, value] of Object.entries(props)) {
    // Skip null/undefined
    if (value === null || value === undefined) continue;
    
    // Skip empty strings (pero permitir "0", "false", etc.)
    if (value === '') continue;
    
    // Skip NaN
    if (typeof value === 'number' && isNaN(value)) {
      console.warn(`[buildUpdateProps] ⚠️ Skipping NaN value for key: ${key}`);
      continue;
    }
    
    cleaned[key] = value;
  }

  return cleaned;
}

/**
 * Valida propiedades contra schema de HubSpot y separa en válidas/inválidas.
 * 
 * @param {string} objectType - 'deals', 'tickets', 'invoices', 'line_items'
 * @param {Object} props - Propiedades a validar
 * @returns {Promise<{valid: Object, missing: string[]}>}
 */
export async function validateProperties(objectType, props) {
  const schema = await getPropertySchema(objectType);
  const valid = {};
  const missing = [];

  for (const [key, value] of Object.entries(props)) {
    if (schema.has(key)) {
      valid[key] = value;
    } else {
      missing.push(key);
    }
  }

  return { valid, missing };
}

/**
 * Construye propiedades de update validadas y limpia.
 * Combina buildUpdateProps + validateProperties.
 * 
 * @param {string} objectType - 'deals', 'tickets', 'invoices', 'line_items'
 * @param {Object} props - Propiedades a setear
 * @param {Object} options - { logPrefix: string }
 * @returns {Promise<Object>} Propiedades limpias y válidas para update
 */
export async function buildValidatedUpdateProps(objectType, props, options = {}) {
  const logPrefix = options.logPrefix || '[UpdateProps]';

  // 1) Limpiar valores vacíos/inválidos
  const cleaned = buildUpdateProps(props);
  
  if (Object.keys(cleaned).length === 0) {
    console.log(`${logPrefix} ⊘ SKIP_EMPTY_UPDATE - No properties to set`);
    return {};
  }

  // 2) Validar contra schema
  const { valid, missing } = await validateProperties(objectType, cleaned);

  if (missing.length > 0) {
    console.warn(`${logPrefix} ⚠️ MISSING_PROPS (${objectType}):`, missing.join(', '));
  }

  if (Object.keys(valid).length > 0) {
    console.log(`${logPrefix} ✅ SET_PROPS (${objectType}):`, Object.keys(valid).join(', '));
  }

  return valid;
}

/**
 * Calcula el estado del cupo según las reglas del negocio.
 * 
 * Reglas:
 * - Si no hay cupo (cupo_activo=false) => null
 * - Si cupo_restante <= 0 => "Agotado"
 * - Si cupo_restante <= cupo_umbral => "Bajo Umbral"
 * - Si cupo_restante > cupo_umbral => "Ok"
 * - Si hay datos inconsistentes => "Inconsistente"
 * 
 * @param {Object} dealProps - Propiedades del deal
 * @returns {string|null} "Ok" | "Bajo Umbral" | "Inconsistente" | "Agotado" | null
 */
export async function updateDealCupo(deal, lineItems) {
  if (!deal || !deal.id) return { consumido: 0, restante: 0 };

  const { consumido, restante } = computeCupoStatus(deal, lineItems);

  const properties = {
    cupo_consumido: String(consumido),
    cupo_restante: String(restante),
  };

  // 🔥 recalcular estado SIEMPRE
  const newEstado = calculateCupoEstado({
    ...deal.properties,
    ...properties,
  });

  // si no querés guardar "Desactivado" en el deal, acá podés omitirlo:
  if (newEstado && newEstado !== 'Desactivado') {
    properties.cupo_estado = newEstado;
  } else if (newEstado === 'Desactivado') {
    // opcional: limpiar estado
    properties.cupo_estado = '';
  }

  // opcional recomendado: si llega a <=0, apagar cupo_activo (consistencia)
  if (parseFloat(properties.cupo_restante) <= 0) {
    properties.cupo_activo = 'false';
  }

  try {
    await hubspotClient.crm.deals.basicApi.update(String(deal.id), { properties });
  } catch (err) {
    console.error('[cupo] Error actualizando cupo del deal', deal.id, err?.response?.body || err?.message);
  }

  return { consumido, restante };
}


