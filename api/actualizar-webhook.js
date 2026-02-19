// api/actualizar.js
//
// Este endpoint expone un webhook para HubSpot. Cuando se activan
// las propiedades personalizadas ``actualizar`` o ``hs_billing_start_delay_type``
// en un line item, resuelve el negocio asociado y ejecuta el
// cálculo completo de facturación mediante la función ``runBilling``.
//
// El objetivo es evitar ejecutar runBilling de manera programada para
// todos los negocios. En su lugar, solo se procesa el deal cuyo
// line item fue modificado a propósito. Para ``actualizar`` se
// considera el valor truthy de la propiedad; una vez procesado se
// resetea a ``false`` para evitar re‑procesamientos. Para
// ``hs_billing_start_delay_type`` simplemente se recalcula la fase 1
// (a través de runBilling) que normaliza los retrasos en días/meses a
// una fecha concreta mediante ``normalizeBillingStartDelay``.

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

/**
 * Conversión básica de valores tipo HubSpot a booleanos. HubSpot puede
 * enviar strings como "true", "1", "yes", "si" o "sí" para
 * indicar verdadero. Cualquier otro valor se considera falso.
 *
 * @param {*} value Valor a interpretar.
 * @returns {boolean}
 */
function parseBool(value) {
  const s = String(value ?? "").trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes" || s === "si" || s === "sí";
}

/**
 * Obtiene el ``dealId`` asociado a un line item. Utiliza la API de
 * asociaciones v4 de HubSpot. Si hay múltiples deals asociados al
 * mismo line item, se devuelve el primero y se ignoran los demás.
 *
 * @param {string|number} lineItemId Identificador del line item.
 * @returns {Promise<string|null>} ID del deal asociado o null si no
 *   existen asociaciones.
 */
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

/**
 * Handler para el webhook. Espera llamadas POST desde HubSpot con un
 * cuerpo similar a:
 *
 * ```
 * {
 *   "objectId": "1234",
 *   "subscriptionType": "line_item.propertyChange",
 *   "propertyName": "actualizar",
 *   "propertyValue": "true"
 * }
 * ```
 *
 * El handler valida el payload, resuelve el deal asociado al line item,
 * verifica que la facturación esté activa en el negocio y ejecuta
 * runBilling sólo para ese deal. Para la propiedad ``actualizar``
 * restablece el valor a ``false`` después de procesar.
 *
 * @param {import('next').NextApiRequest} req
 * @param {import('next').NextApiResponse} res
 */
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
let billingResult = null;
try {
  const dealWithLineItems = await getDealWithLineItems(dealId);
  billingResult = await runPhasesForDeal(dealWithLineItems);
} catch (err) {
  logger.error({ module: MODULE, fn: 'processRecalculation', dealId, err }, 'Error ejecutando fases de facturación');
}
      } catch (err) {
        logger.error({ module: MODULE, fn: 'handler', dealId, err }, 'Error executing runBilling');
        // no aborta, se continúa a resetear flags
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

/*
 * CATCHES con reportHubSpotError agregados:
 *   - Reset de flag 'actualizar' en lineItems.basicApi.update() → objectType: 'line_item'
 *
 * NO reportados:
 *   - getDealIdForLineItem: es una lectura (associations.getPage), no un update accionable
 *   - deals.basicApi.getById: lectura, no aplica
 *   - runPhasesForDeal: lógica interna, el reporte corresponde a las capas inferiores
 *   - catch externo (Unexpected error): no hay update HubSpot en juego
 *
 * Confirmación: "No se reportan warns a HubSpot; solo errores 4xx (≠429)"
 */