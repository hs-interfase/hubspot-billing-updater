# hubspot-billing-updater
conexión a API de hubspot para actualizar fecha y mensaje de aviso de facturación

## Description
Node.js serverless API for Vercel that connects to HubSpot CRM v3 API to manage billing information.

## Setup

1. Clone the repository
2. Install dependencies:
   ```bash
   npm install
   ```
3. Copy `.env.example` to `.env` and configure your HubSpot private app token:
   ```bash
   cp .env.example .env
   ```
4. Add your HubSpot private app token to `.env`

## API Endpoints

### GET /api/update-billing

Searches for HubSpot deals with `facturacion_frecuencia_de_facturacion` = "Recurrente" and returns basic deal data.

**Response:**
```json
{
  "success": true,
  "total": 5,
  "deals": [
    {
      "id": "123456789",
      "properties": {
        "dealname": "Example Deal",
        "amount": "1000",
        "dealstage": "closedwon",
        "facturacion_frecuencia_de_facturacion": "Recurrente",
        "closedate": "2024-01-15"
      }
    }
  ]
}
```

## Environment Variables

- `HUBSPOT_PRIVATE_TOKEN`: Your HubSpot private app token (required)

## Deployment

This project is designed to be deployed on Vercel. The `/api` folder contains serverless functions that will be automatically deployed.
