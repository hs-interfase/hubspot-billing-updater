// src/services/billing/recalcFacturasRestantes.js
import { isAutoRenew } from './mode.js';

/**
 * Recalcula facturas_restantes SOLO para PLAN_FIJO:
 * facturas_restantes = max(0, cuotas_totales - invoices_asociadas)
 * Para RENOVACION_AUTOMATICA: deja facturas_restantes vacío ("").
 *
 * Reglas de modo: SIEMPRE via isAutoRenew(lineItem).
 */
export async function recalcFacturasRestantes({ hubspotClient, lineItemId }) {
  const id = String(lineItemId);

  // 1) Leer props mínimas del line item
  const { properties } = await hubspotClient.crm.lineItems.basicApi.getById(
    id,
    [
      "renovacion_automatica",
      "recurringbillingfrequency",
      "hs_recurring_billing_frequency",
      "hs_recurring_billing_number_of_payments",
      "facturas_restantes",
    ],
    undefined,
    undefined,
    false
  );

  // 2) AUTO_RENEW => no usamos facturas_restantes
  if (isAutoRenew({ properties })) {
    // idempotente: solo escribir si hace falta
    if (String(properties?.facturas_restantes ?? "").trim() !== "") {
      await hubspotClient.crm.lineItems.basicApi.update(id, {
        properties: { facturas_restantes: "" },
      });
    }
    return { mode: "AUTO_RENEW", facturas_restantes: null };
  }

  // 3) cuotas_totales (PLAN_FIJO)
  const totalRaw = properties?.hs_recurring_billing_number_of_payments;
  const cuotasTotales = Number.parseInt(String(totalRaw ?? ""), 10);

  if (!Number.isFinite(cuotasTotales) || cuotasTotales <= 0) {
    // No hay plan fijo bien definido => limpiar y salir
    if (String(properties?.facturas_restantes ?? "").trim() !== "") {
      await hubspotClient.crm.lineItems.basicApi.update(id, {
        properties: { facturas_restantes: "" },
      });
    }
    return { mode: "PLAN_FIJO", facturas_restantes: null, reason: "no_total_payments" };
  }

  // 4) Contar invoices asociadas al line item (paginado, tolerante a SDKs distintos)
  const countInvoices = await countAssociations({
    hubspotClient,
    fromObjectType: "line_items",
    fromObjectId: id,
    toObjectType: "invoices",
    pageSize: 500,
  });

  // 5) Calcular restantes
  const restantes = Math.max(0, cuotasTotales - countInvoices);

  // 6) Persistir (idempotente: solo si cambia)
  const currentRaw = String(properties?.facturas_restantes ?? "").trim();
  const nextRaw = String(restantes);

  if (currentRaw !== nextRaw) {
    await hubspotClient.crm.lineItems.basicApi.update(id, {
      properties: { facturas_restantes: nextRaw },
    });
  }

  return { mode: "PLAN_FIJO", facturas_restantes: restantes, countInvoices, cuotasTotales };
}

/**
 * Cuenta asociaciones from -> to de forma paginada.
 * Soporta:
 * - hubspotClient.crm.associations.v4.basicApi.getPage(fromType, fromId, toType, limit, after)
 * - (fallback) hubspotClient.crm.lineItems.associationsApi.getAll(fromId, toType) si existiera con esa firma
 */
async function countAssociations({
  hubspotClient,
  fromObjectType,
  fromObjectId,
  toObjectType,
  pageSize = 500,
}) {
  // Preferido: Associations v4 (paginado)
  const v4 = hubspotClient?.crm?.associations?.v4?.basicApi;
  if (v4?.getPage) {
    let after = undefined;
    let total = 0;

    while (true) {
      const page = await v4.getPage(
        fromObjectType,
        fromObjectId,
        toObjectType,
        pageSize,
        after
      );

      const results = page?.results ?? [];
      total += results.length;

      const nextAfter = page?.paging?.next?.after;
      if (!nextAfter) break;
      after = nextAfter;
    }

    return total;
  }

  // Fallback: algunos wrappers viejos exponen associationsApi en el objeto lineItems
  const liAssoc = hubspotClient?.crm?.lineItems?.associationsApi;
  if (liAssoc?.getAll) {
    const res = await liAssoc.getAll(fromObjectId, toObjectType);
    return Array.isArray(res?.results) ? res.results.length : 0;
  }

  throw new Error(
    "countAssociations: no hay API de asociaciones disponible (v4.getPage / lineItems.associationsApi.getAll)"
  );
}
