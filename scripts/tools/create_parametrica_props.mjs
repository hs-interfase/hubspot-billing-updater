// scripts/tools/create_parametrica_props.mjs
//
// Crea las propiedades de line item que usa la pantalla de paramétricas
// (/parametrica) y que no existían en el portal:
//   - fecha_ultimo_ajuste       (date)   "Fecha último ajuste"
//   - porcentaje_ultimo_ajuste  (number) "Porcentaje último ajuste"
//
// Idempotente: consulta antes de crear; si ya existen no hace nada.
// Complementa a las que ya creó la usuaria a mano: ajuste_factura_aparte,
// monto_unitario_actual, monto_unitario_original, tipo_de_parametrica.
//
// Uso (toma HUBSPOT_PRIVATE_TOKEN de .env — portal pruebas por defecto;
// para prod pasar el token por env):
//   node scripts/tools/create_parametrica_props.mjs
//   HUBSPOT_PRIVATE_TOKEN=<token prod> node scripts/tools/create_parametrica_props.mjs

import 'dotenv/config';

const HS = 'https://api.hubapi.com';
const TOKEN = process.env.HUBSPOT_PRIVATE_TOKEN;
if (!TOKEN) {
  console.error('Falta HUBSPOT_PRIVATE_TOKEN');
  process.exit(1);
}

const headers = {
  Authorization: `Bearer ${TOKEN}`,
  'Content-Type': 'application/json',
};

const PROPS = [
  {
    name: 'fecha_ultimo_ajuste',
    label: 'Fecha último ajuste',
    description: 'Fecha del último ajuste de precio por paramétrica aplicado desde el motor.',
    groupName: 'lineiteminformation',
    type: 'date',
    fieldType: 'date',
  },
  {
    name: 'porcentaje_ultimo_ajuste',
    label: 'Porcentaje último ajuste',
    description: 'Porcentaje del último ajuste de precio por paramétrica aplicado desde el motor.',
    groupName: 'lineiteminformation',
    type: 'number',
    fieldType: 'number',
  },
];

async function main() {
  const acc = await fetch(`${HS}/account-info/v3/details`, { headers }).then((r) => r.json());
  console.log(`Portal: ${acc.portalId}`);

  for (const prop of PROPS) {
    const check = await fetch(`${HS}/crm/v3/properties/line_items/${prop.name}`, { headers });
    if (check.ok) {
      console.log(`✔ ${prop.name} ya existe — no se toca`);
      continue;
    }
    if (check.status !== 404) {
      throw new Error(`Error consultando ${prop.name}: ${check.status} ${await check.text()}`);
    }
    const res = await fetch(`${HS}/crm/v3/properties/line_items`, {
      method: 'POST',
      headers,
      body: JSON.stringify(prop),
    });
    if (!res.ok) {
      throw new Error(`Error creando ${prop.name}: ${res.status} ${await res.text()}`);
    }
    console.log(`+ ${prop.name} creada`);
  }
  console.log('Listo.');
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
