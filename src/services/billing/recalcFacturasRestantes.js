// src/services/billing/recalcFacturasRestantes.js
import { isAutoRenew } from "./mode.js";

const INVOICE_LIK_PROP = "line_item_key"; // <- SOLO si existe en invoice. Si no, cambiá al nombre real.

export async function recalcFacturasRestantes({ hubspotClient, lineItemId }) {
  const id = String(lineItemId);

  const { properties } = await hubspotClient.crm.lineItems.basicApi.getById(
    id,
    [
      "renovacion_automatica",
      "recurringbillingfrequency",
      "hs_recurring_billing_frequency",
      "hs_recurring_billing_number_of_payments",
      "facturas_restantes",
      "line_item_key",
    ],
    undefined,
    undefined,
    false
  );

  if (isAutoRenew({ properties })) {
    if (String(properties?.facturas_restantes ?? "").trim() !== "") {
      await hubspotClient.crm.lineItems.basicApi.update(id, {
        properties: { facturas_restantes: "" },
      });
    }
    return { mode: "AUTO_RENEW", facturas_restantes: null };
  }

  const totalRaw = properties?.hs_recurring_billing_number_of_payments;
  const cuotasTotales = Number.parseInt(String(totalRaw ?? ""), 10);

  if (!Number.isFinite(cuotasTotales) || cuotasTotales <= 0) {
    if (String(properties?.facturas_restantes ?? "").trim() !== "") {
      await hubspotClient.crm.lineItems.basicApi.update(id, {
        properties: { facturas_restantes: "" },
      });
    }
    return { mode: "PLAN_FIJO", facturas_restantes: null, reason: "no_total_payments" };
  }

  const lik = String(properties?.line_item_key ?? "").trim();
  if (!lik) {
    console.log("[recalcFacturasRestantes] missing line_item_key", { lineItemId: id });
    return { mode: "PLAN_FIJO", facturas_restantes: null, reason: "missing_line_item_key" };
  }

  const countInvoices = await countInvoicesByLIK({
    hubspotClient,
    lik,
    invoiceLikProp: INVOICE_LIK_PROP,
  });

  const restantes = Math.max(0, cuotasTotales - countInvoices);

  const currentRaw = String(properties?.facturas_restantes ?? "").trim();
  const nextRaw = String(restantes);

  if (currentRaw !== nextRaw) {
    await hubspotClient.crm.lineItems.basicApi.update(id, {
      properties: { facturas_restantes: nextRaw },
    });
  }

  return {
    mode: "PLAN_FIJO",
    facturas_restantes: restantes,
    countInvoices,
    cuotasTotales,
    lik,
    invoiceLikProp: INVOICE_LIK_PROP,
  };
}

async function countInvoicesByLIK({ hubspotClient, lik, invoiceLikProp }) {
  const searchApi = hubspotClient?.crm?.objects?.searchApi;
  if (!searchApi?.doSearch) {
    throw new Error("countInvoicesByLIK: hubspotClient.crm.objects.searchApi.doSearch no disponible");
  }

  let after = undefined;
  let total = 0;

  while (true) {
    const res = await searchApi.doSearch("invoices", {
      filterGroups: [
        {
          filters: [
            {
              propertyName: invoiceLikProp,
              operator: "EQ",
              value: String(lik),
            },
          ],
        },
      ],
      properties: [invoiceLikProp],
      limit: 100,
      after,
    });

    const results = res?.results ?? [];
    total += results.length;

    const nextAfter = res?.paging?.next?.after;
    if (!nextAfter) break;
    after = nextAfter;
  }

  return total;
}
