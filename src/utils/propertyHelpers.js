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
 * - Si cupo_activo=false => "SIN_CUPO"
 * - Si cupo_restante <= 0 => "SIN_CUPO"
 * - Si cupo_restante <= cupo_umbral => "BAJO_UMBRAL"
 * - Si cupo_restante > cupo_umbral => "OK"
 * 
 * @param {Object} dealProps - Propiedades del deal
 * @returns {string|null} "SIN_CUPO" | "BAJO_UMBRAL" | "OK" | null
 */
export function calculateCupoEstado(dealProps) {
  const cupoActivo = String(dealProps.cupo_activo || '').toLowerCase() === 'true';
  const cupoRestante = parseFloat(dealProps.cupo_restante);
  const cupoUmbral = parseFloat(dealProps.cupo_umbral);

  // Si no está activo o restante <= 0
  if (!cupoActivo || cupoRestante <= 0) {
    return 'SIN_CUPO';
  }

  // Si hay umbral definido y estamos por debajo
  if (!isNaN(cupoUmbral) && cupoRestante <= cupoUmbral) {
    return 'BAJO_UMBRAL';
  }

  // Cupo OK
  return 'OK';
}
