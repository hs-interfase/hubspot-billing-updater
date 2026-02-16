// src/services/billing/recalcFacturasRestantes.js
import { isAutoRenew } from "./mode.js";

const INVOICE_LIK_PROP = "line_item_key"; // <- SOLO si existe en invoice. Si no, cambiá al nombre real.

export async function recalcFacturasRestantes({ hubspotClient, lineItemId, dealId }) {
  const id = String(lineItemId);

  console.log("[FR][enter]", { lineItemId: id });

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

  console.log("[FR][li-props]", {
    lineItemId: id,
    renovacion_automatica: properties?.renovacion_automatica,
    recurringbillingfrequency: properties?.recurringbillingfrequency,
    hs_recurring_billing_frequency: properties?.hs_recurring_billing_frequency,
    hs_recurring_billing_number_of_payments:
      properties?.hs_recurring_billing_number_of_payments,
    facturas_restantes: properties?.facturas_restantes,
    line_item_key: properties?.line_item_key,
  });

  // AUTO RENEW => no aplica facturas_restantes (limpia si existe)
  if (isAutoRenew({ properties })) {
    console.log("[FR][mode]", {
      lineItemId: id,
      mode: "AUTO_RENEW",
      action: "clear_or_skip",
    });

    const current = String(properties?.facturas_restantes ?? "").trim();
    if (current !== "") {
      console.log("[FR][auto_renew][clear]", { lineItemId: id, from: current, to: "" });
      await hubspotClient.crm.lineItems.basicApi.update(id, {
        properties: { facturas_restantes: "" },
      });
    } else {
      console.log("[FR][auto_renew][noop]", { lineItemId: id, facturas_restantes: "" });
    }

    return { mode: "AUTO_RENEW", facturas_restantes: null };
  }

  // PLAN FIJO => necesita total payments
  const totalRaw = properties?.hs_recurring_billing_number_of_payments;
  const cuotasTotales = Number.parseInt(String(totalRaw ?? ""), 10);

  console.log("[FR][plan_fijo]", { lineItemId: id, cuotasTotales, totalRaw });

  if (!Number.isFinite(cuotasTotales) || cuotasTotales <= 0) {
    const current = String(properties?.facturas_restantes ?? "").trim();
    console.log("[FR][skip]", {
      lineItemId: id,
      reason: "no_total_payments",
      totalRaw,
      cuotasTotales,
      current,
    });

    if (current !== "") {
      console.log("[FR][no_total_payments][clear]", { lineItemId: id, from: current, to: "" });
      await hubspotClient.crm.lineItems.basicApi.update(id, {
        properties: { facturas_restantes: "" },
      });
    }

    return {
      mode: "PLAN_FIJO",
      facturas_restantes: null,
      reason: "no_total_payments",
    };
  }

  // PLAN FIJO => necesita LIK
  const lik = String(properties?.line_item_key ?? "").trim();
  if (!lik) {
    console.log("[FR][skip]", {
      lineItemId: id,
      reason: "missing_line_item_key",
      line_item_key: properties?.line_item_key,
    });

    return {
      mode: "PLAN_FIJO",
      facturas_restantes: null,
      reason: "missing_line_item_key",
    };
  }

const countInvoices = await countInvoicesByLIK({
  hubspotClient,
  lik,
  dealId,
});

  console.log("[FR][count]", {
    lineItemId: id,
    lik,
    invoiceLikProp: INVOICE_LIK_PROP,
    countInvoices,
  });

  const restantes = Math.max(0, cuotasTotales - countInvoices);

  const currentRaw = String(properties?.facturas_restantes ?? "").trim();
  const nextRaw = String(restantes);

  console.log("[FR][compute]", {
    lineItemId: id,
    cuotasTotales,
    countInvoices,
    restantes,
    currentRaw,
    nextRaw,
  });

  if (currentRaw !== nextRaw) {
    console.log("[FR][write]", { lineItemId: id, from: currentRaw, to: nextRaw });
    await hubspotClient.crm.lineItems.basicApi.update(id, {
      properties: { facturas_restantes: nextRaw },
    });

    // Confirmación (releer)
    const liAfter = await hubspotClient.crm.lineItems.basicApi.getById(id, ["facturas_restantes"]);
    console.log("[FR][after-write]", {
      lineItemId: id,
      facturas_restantes: liAfter?.properties?.facturas_restantes,
    });
  } else {
    console.log("[FR][noop]", { lineItemId: id, facturas_restantes: currentRaw });
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
async function countInvoicesByLIK({ hubspotClient, lik, dealId }) {
  const v4 = hubspotClient?.crm?.associations?.v4?.basicApi;

  if (!v4?.getPage) {
    throw new Error("countInvoicesByLIK: Associations v4 API no disponible");
  }

  if (!dealId) {
    throw new Error("countInvoicesByLIK requiere dealId");
  }

  let after = undefined;
  let invoiceIds = [];
  let page = 0;

  // =====================================================
  // 1️⃣ Traer todas las invoices asociadas al DEAL
  // =====================================================
  while (true) {
    page += 1;

    const res = await v4.getPage(
      "deals",
      String(dealId),
      "invoices",
      100,
      after
    );

    const results = res?.results ?? [];

    invoiceIds.push(...results.map(r => r.toObjectId));

    const nextAfter = res?.paging?.next?.after;

    console.log("[FR][deal->invoices-page]", {
      page,
      dealId,
      got: results.length,
      nextAfter: nextAfter ?? null,
    });

    if (!nextAfter) break;
    after = nextAfter;
  }

  if (invoiceIds.length === 0) {
    console.log("[FR][deal->invoices-total]", { dealId, total: 0 });
    return 0;
  }

  // =====================================================
  // 2️⃣ Leer invoices y filtrar por LIK
  // =====================================================
  let count = 0;

  for (const invoiceId of invoiceIds) {
    const inv = await hubspotClient.crm.objects.basicApi.getById(
      "invoices",
      invoiceId,
      ["of_invoice_key", "etapa_de_la_factura"]
    );

    const invoiceKey = inv?.properties?.of_invoice_key || "";

    // of_invoice_key tiene formato:
    // dealId::LIK:<line_item_key>::YYYY-MM-DD
    if (invoiceKey.includes(lik)) {
      count++;
    }
  }

  console.log("[FR][deal->invoices-filtered]", {
    dealId,
    lik,
    matched: count,
    totalInvoicesOnDeal: invoiceIds.length,
  });

  return count;
}
