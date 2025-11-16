// testHubspot.js
import 'dotenv/config';

const HUBSPOT_BASE_URL = process.env.HUBSPOT_BASE_URL || 'https://api.hubapi.com';
const HUBSPOT_PRIVATE_TOKEN = process.env.HUBSPOT_PRIVATE_TOKEN;

if (!HUBSPOT_PRIVATE_TOKEN) {
  console.error('Falta HUBSPOT_PRIVATE_TOKEN en el .env');
  process.exit(1);
}

async function main() {
  const url = `${HUBSPOT_BASE_URL}/crm/v3/objects/deals?limit=2`;

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${HUBSPOT_PRIVATE_TOKEN}`,
      'Content-Type': 'application/json',
    },
  });

  if (!res.ok) {
    console.error('Error en la llamada a HubSpot:', res.status, res.statusText);
    const text = await res.text();
    console.error(text);
    return;
  }

  const data = await res.json();
  console.log('Respuesta de HubSpot (deals):');
  console.dir(data, { depth: null });
}

main().catch(console.error);
