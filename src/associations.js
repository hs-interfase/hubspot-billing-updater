// src/associations.js
import { hubspotClient } from "./services/hubspotClient.js";

const _assocTypeCache = new Map();

/**
 * Fallbacks HUBSPOT_DEFINED conocidos (útil cuando /labels devuelve [] para ciertos objetos).
 */
const HUBSPOT_DEFINED_FALLBACKS = new Map([
  ["invoices::deals", 175],
  ["invoices::contacts", 177],
  ["invoices::companies", 179],
  ["invoices::tickets", 986],
  ["invoices::line_items", 409],
]);

function normType(t) {
  return (t ?? "").toString().trim().toLowerCase();
}

export async function getDefaultAssocTypeId(fromType, toType) {
  const f = normType(fromType);
  const t = normType(toType);

  const key = `${f}::${t}`;
  if (_assocTypeCache.has(key)) return _assocTypeCache.get(key);

  // 0) Fallback directo
  if (HUBSPOT_DEFINED_FALLBACKS.has(key)) {
    const id = HUBSPOT_DEFINED_FALLBACKS.get(key);
    _assocTypeCache.set(key, id);
    return id;
  }

  const path = `/crm/v4/associations/${f}/${t}/labels`;

  const resp = await hubspotClient.apiRequest({ method: "GET", path });
  const results = resp?.body?.results || [];

  if (!results.length) {
    const fallback = HUBSPOT_DEFINED_FALLBACKS.get(key);
    if (fallback) {
      _assocTypeCache.set(key, fallback);
      return fallback;
    }

    // 👇 log mejorado para debug de portal/permisos
    throw new Error(
      `No pude resolver associationTypeId para ${f} -> ${t}. ` +
        `labels=[] (endpoint: ${path}). ` +
        `Tip: revisá scopes del private app (crm.schemas.read / crm.objects.*) o usa fallbacks.`
    );
  }

  const def =
    results.find((r) => r.associationCategory === "HUBSPOT_DEFINED") ||
    results.find((r) => r.category === "HUBSPOT_DEFINED") ||
    results[0];

  const typeId = def?.associationTypeId ?? def?.typeId ?? def?.id;

  if (!typeId) {
    throw new Error(
      `No pude resolver associationTypeId para ${f} -> ${t}. labels=${JSON.stringify(results)}`
    );
  }

  _assocTypeCache.set(key, typeId);
  return typeId;
}

export async function associateV4(fromType, fromId, toType, toId) {
  if (!fromId || !toId) return;

  const f = normType(fromType);
  const t = normType(toType);

  const associationTypeId = await getDefaultAssocTypeId(f, t);

  return hubspotClient.crm.associations.v4.basicApi.create(
    f,
    String(fromId),
    t,
    String(toId),
    [
      {
        associationCategory: "HUBSPOT_DEFINED",
        associationTypeId,
      },
    ]
  );
}

/**
 * Igual que associateV4 pero NUNCA hace throw (solo loguea).
 * Útil para que emisión de facturas no falle por una asociación.
 */
export async function safeAssociateV4(fromType, fromId, toType, toId) {
  try {
    return await associateV4(fromType, fromId, toType, toId);
  } catch (err) {
    console.warn(
      `[associations] WARN no se pudo asociar ${fromType}:${fromId} -> ${toType}:${toId}`,
      err?.response?.body || err?.message || err
    );
    return null;
  }
}
