const axios = require('axios');

/**
 * Vercel serverless function to search HubSpot deals
 * GET endpoint that searches for deals with facturacion_frecuencia_de_facturacion = "Recurrente"
 */
module.exports = async (req, res) => {
  // Only allow GET requests
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed. Use GET.' });
  }

  // Get the HubSpot private token from environment variables
  const hubspotToken = process.env.HUBSPOT_PRIVATE_TOKEN;

  if (!hubspotToken) {
    return res.status(500).json({ 
      error: 'HUBSPOT_PRIVATE_TOKEN environment variable is not configured' 
    });
  }

  try {
    // Search for deals with facturacion_frecuencia_de_facturacion = "Recurrente"
    // Using HubSpot CRM v3 API - Search endpoint for deals
    const response = await axios.post(
      'https://api.hubapi.com/crm/v3/objects/deals/search',
      {
        filterGroups: [
          {
            filters: [
              {
                propertyName: 'facturacion_frecuencia_de_facturacion',
                operator: 'EQ',
                value: 'Recurrente'
              }
            ]
          }
        ],
        properties: [
          'dealname',
          'amount',
          'dealstage',
          'facturacion_frecuencia_de_facturacion',
          'closedate'
        ],
        limit: 100
      },
      {
        headers: {
          'Authorization': `Bearer ${hubspotToken}`,
          'Content-Type': 'application/json'
        }
      }
    );

    // Extract and return basic deal data
    const deals = response.data.results.map(deal => ({
      id: deal.id,
      properties: deal.properties
    }));

    return res.status(200).json({
      success: true,
      total: deals.length,
      deals: deals
    });

  } catch (error) {
    console.error('Error searching HubSpot deals:', error.response?.data || error.message);
    
    return res.status(error.response?.status || 500).json({
      error: 'Failed to search HubSpot deals',
      message: error.response?.data?.message || error.message
    });
  }
};
