// api/update-billing.js
const axios = require("axios");

const HUBSPOT_BASE_URL = "https://api.hubapi.com";

/**
 * Construye el cuerpo del search:
 * - facturacion_frecuencia_de_facturacion = "Recurrente"
 * - facturacion_activa = true  O  sin propiedad facturacion_activa
 * - opcional: dealstage = HUBSPOT_CLOSED_WON_STAGE (si está seteado en env)
 */
function buildDealsSearchBody() {
  const closedWonStage = process.env.HUBSPOT_CLOSED_WON_STAGE || null;

  const baseFilters = [
    {
      propertyName: "facturacion_frecuencia_de_facturacion",
      operator: "EQ",
      value: "Recurrente"
    }
  ];

  if (closedWonStage) {
    baseFilters.push({
      propertyName: "dealstage",
      operator: "EQ",
      value: closedWonStage
    });
  }

  return {
    filterGroups: [
      {
        // Recurrente + facturacion_activa = true
        filters: [
          ...baseFilters,
          {
            propertyName: "facturacion_activa",
            operator: "EQ",
            value: "true"
          }
        ]
      },
      {
        // Recurrente + facturacion_activa no seteada
        filters: [
          ...baseFilters,
          {
            propertyName: "facturacion_activa",
            operator: "NOT_HAS_PROPERTY"
          }
        ]
      }
    ],
    properties: [
      "dealname",
      "dealstage",
      "facturacion_frecuencia_de_facturacion",
      "facturacion_activa",
      "facturacion_proxima_fecha"
    ],
    limit: 50
  };
}

async function fetchRecurrentDeals() {
  const token = process.env.HUBSPOT_PRIVATE_TOKEN;

  if (!token) {
    throw new Error(
      "Falta la variable de entorno HUBSPOT_PRIVATE_TOKEN (Private App Token de HubSpot)."
    );
  }

  const body = buildDealsSearchBody();

  const response = await axios.post(
    `${HUBSPOT_BASE_URL}/crm/v3/objects/deals/search`,
    body,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      }
    }
  );

  const results = response.data.results || [];

  // Devuelvo algo simplificado
  return results.map((deal) => ({
    id: deal.id,
    dealname: deal.properties.dealname,
    dealstage: deal.properties.dealstage,
    facturacion_frecuencia_de_facturacion:
      deal.properties.facturacion_frecuencia_de_facturacion,
    facturacion_activa: deal.properties.facturacion_activa,
    facturacion_proxima_fecha: deal.properties.facturacion_proxima_fecha
  }));
}

// Handler para Vercel: GET /api/update-billing
module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed. Use GET." });
    return;
  }

  try {
    const deals = await fetchRecurrentDeals();

    console.log(
      `Encontrados ${deals.length} negocios recurrentes para procesar:`
    );
    console.log(JSON.stringify(deals, null, 2));

    res.status(200).json({
      ok: true,
      count: deals.length,
      deals
    });
  } catch (err) {
    console.error("Error llamando a HubSpot:", err.response?.data || err.message);

    res.status(500).json({
      ok: false,
      error: err.message,
      hubspotResponse: err.response?.data || null
    });
  }
};
