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

import { hubspotClient, getDealWithLineItems } from "../src/hubspotClient.js";
import { runPhasesForDeal } from "../src/phases/index.js";

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
  // Acepta únicamente POST
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  try {
    // HubSpot a veces envía arrays de eventos en el cuerpo, tomar el
    // primero. Si es un objeto simple, se usa directamente.
    const payload = Array.isArray(req.body) ? req.body[0] : req.body;

    const objectId = payload?.objectId;
    const propertyName = payload?.propertyName;
    const propertyValue = payload?.propertyValue;
    const subscriptionType = payload?.subscriptionType;

    // Validar que sea un line item
    const [objectType] = (subscriptionType || "").split(".");
    if (objectType !== "line_item") {
      return res.status(200).json({ message: "Not a line_item event, ignored" });
    }

    // Sólo atendemos a 'actualizar' o 'hs_billing_start_delay_type'
    if (!["actualizar", "hs_billing_start_delay_type"].includes(propertyName)) {
      return res.status(200).json({ message: "Property not relevant, skipped" });
    }

    // Para "actualizar" se requiere que el valor sea truthy
    if (propertyName === "actualizar" && !parseBool(propertyValue)) {
      return res.status(200).json({ message: "actualizar flag not true, skipped" });
    }

    if (!objectId) {
      return res.status(400).json({ error: "Missing objectId" });
    }

    console.log("[actualizar-webhook] Event received", {
      objectId,
      propertyName,
      propertyValue,
    });

    // Resolver el deal asociado
    const dealId = await getDealIdForLineItem(objectId);
    if (!dealId) {
      console.error(
        `[actualizar-webhook] No deal associated with line item ${objectId}`
      );
      return res.status(400).json({ error: "No associated deal" });
    }

    // Consultar facturacion_activa y nombre del negocio
    let deal;
    try {
      deal = await hubspotClient.crm.deals.basicApi.getById(String(dealId), [
        "facturacion_activa",
        "dealname",
      ]);
    } catch (e) {
      console.error(
        `[actualizar-webhook] Error fetching deal ${dealId}:`,
        e?.response?.body || e.message || e
      );
      return res.status(500).json({ error: "Error fetching deal" });
    }
    const dealProps = deal?.properties || {};
    const active = parseBool(dealProps.facturacion_activa);
    const dealName = dealProps.dealname || "";

    console.log(
      `[actualizar-webhook] Deal ${dealId} (${dealName}) facturacion_activa=${active}`
    );

    // Ejecutar runBilling solamente si facturacion_activa es true
    let billingResult = null;
    if (active) {
      try {
const dealWithLineItems = await getDealWithLineItems(dealId);
billingResult = await runPhasesForDeal(dealWithLineItems);
      } catch (err) {
        console.error(
          `[actualizar-webhook] Error executing runBilling for deal ${dealId}:`,
          err?.message || err
        );
        // no aborta, se continúa a resetear flags
      }
    }

    // Resetear flag "actualizar" a false para evitar disparadores repetidos
    if (propertyName === "actualizar") {
      try {
        await hubspotClient.crm.lineItems.basicApi.update(String(objectId), {
          properties: { actualizar: "false" },
        });
        console.log(
          `[actualizar-webhook] Flag 'actualizar' reset to false for line item ${objectId}`
        );
      } catch (resetErr) {
        console.error(
          `[actualizar-webhook] Error resetting 'actualizar' on line item ${objectId}:`,
          resetErr?.response?.body || resetErr.message || resetErr
        );
      }
    }

    return res.status(200).json({
      success: true,
      dealId: String(dealId),
      dealName,
      ranBilling: active,
      billingResult,
    });
  } catch (error) {
    console.error(
      "[actualizar-webhook] Unexpected error processing webhook:",
      error?.stack || error
    );
    return res.status(500).json({
      error: "Internal server error",
      message: error?.message || "Unknown error",
    });
  }
}