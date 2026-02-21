// api/actualizar-webhook.js
import logger from '../lib/logger.js';
import { reportHubSpotError } from '../src/utils/hubspotErrorCollector.js';
import { hubspotClient, getDealWithLineItems } from "../src/hubspotClient.js";
import { runPhasesForDeal } from "../src/phases/index.js";

const MODULE = 'actualizar';

function reportIfActionable({ objectType, objectId, message, err }) {
  const status = err?.response?.status ?? err?.statusCode ?? null;
  if (status === null) { reportHubSpotError({ objectType, objectId, message }); return; }
  if (status === 429 || status >= 500) return;
  if (status >= 400 && status < 500) reportHubSpotError({ objectType, objectId, message });
}

function parseBool(value) {
  const s = String(value ?? "").trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes" || s === "si" || s === "sí";
}

async function getDealIdForLineItem(lineItemId) {
  const resp = await hubspotClient.crm.associations.v4.basicApi.getPage(
    "line_items",
    String(lineItemId),
    "deals",
    100
  );
  const dealIds = (resp.results || [])
    .map((r) => String(r.toObjectId))
    .filter(Boolean);
  if (!dealIds.length) return null;
  return dealIds[0];
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const payload = Array.isArray(req.body) ? req.body[0] : req.body;

    const objectId = payload?.objectId;
    const propertyName = payload?.propertyName;
    const propertyValue = payload?.propertyValue;
    const subscriptionType = payload?.subscriptionType;

    const [objectType] = (subscriptionType || "").split(".");
    if (objectType !== "line_item") {
      return res.status(200).json({ message: "Not a line_item event, ignored" });
    }

    if (!["actualizar", "hs_billing_start_delay_type"].includes(propertyName)) {
      return res.status(200).json({ message: "Property not relevant, skipped" });
    }

    if (propertyName === "actualizar" && !parseBool(propertyValue)) {
      return res.status(200).json({ message: "actualizar flag not true, skipped" });
    }

    if (!objectId) {
      return res.status(400).json({ error: "Missing objectId" });
    }

    logger.info({ module: MODULE, fn: 'handler', lineItemId: objectId, propertyName, propertyValue }, 'Webhook event received');

    const dealId = await getDealIdForLineItem(objectId);
    if (!dealId) {
      logger.error({ module: MODULE, fn: 'handler', lineItemId: objectId }, 'No deal associated with line item');
      return res.status(400).json({ error: "No associated deal" });
    }

    let deal;
    try {
      deal = await hubspotClient.crm.deals.basicApi.getById(String(dealId), [
        "facturacion_activa",
        "dealname",
      ]);
    } catch (err) {
      logger.error({ module: MODULE, fn: 'handler', dealId, err }, 'Error fetching deal');
      return res.status(500).json({ error: "Error fetching deal" });
    }

    const dealProps = deal?.properties || {};
    const active = parseBool(dealProps.facturacion_activa);
    const dealName = dealProps.dealname || "";

    logger.info({ module: MODULE, fn: 'handler', dealId, dealName, facturacion_activa: active }, 'Deal resolved');

    let billingResult = null;
    if (active) {
      try {
        const dealWithLineItems = await getDealWithLineItems(dealId);
        billingResult = await runPhasesForDeal(dealWithLineItems);
      } catch (err) {
        logger.error({ module: MODULE, fn: 'handler', dealId, err }, 'Error ejecutando fases de facturación');
        // no aborta, continúa a resetear flags
      }
    }

    if (propertyName === "actualizar") {
      try {
        await hubspotClient.crm.lineItems.basicApi.update(String(objectId), {
          properties: { actualizar: "false" },
        });
        logger.info({ module: MODULE, fn: 'handler', lineItemId: objectId }, "Flag 'actualizar' reset to false");
      } catch (err) {
        logger.error({ module: MODULE, fn: 'handler', lineItemId: objectId, err }, "Error resetting 'actualizar' flag");
        reportIfActionable({ objectType: 'line_item', objectId, message: "Error resetting 'actualizar' flag", err });
      }
    }

    return res.status(200).json({
      success: true,
      dealId: String(dealId),
      dealName,
      ranBilling: active,
      billingResult,
    });

  } catch (err) {
    logger.error({ module: MODULE, fn: 'handler', err }, 'Unexpected error processing webhook');
    return res.status(500).json({
      error: "Internal server error",
      message: err?.message || "Unknown error",
    });
  }
}