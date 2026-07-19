// scripts/tools/crear_props_ticket_victoria.mjs
//
// Crea en el objeto TICKET las propiedades que el motor snapshotea desde el LINE
// ITEM para la vista de Victoria (cards de contrato/pagos y de ajuste paramétrica).
// El motor las escribe en extractLineItemSnapshots (snapshotService.js).
//
// Idempotente: consulta antes de crear; si ya existe, no la toca.
//
// Uso (toma HUBSPOT_PRIVATE_TOKEN de .env — pruebas por defecto; prod pasando el token):
//   node scripts/tools/crear_props_ticket_victoria.mjs
//   HUBSPOT_PRIVATE_TOKEN=<token prod> node scripts/tools/crear_props_ticket_victoria.mjs

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

const GROUP = 'ticketinformation';

const PROPS = [
  // --- contrato / progreso de pagos ---
  { name: 'of_inicio_del_contrato', label: 'Inicio del contrato', type: 'date', fieldType: 'date',
    description: 'Inicio del contrato, copiado del line item por el motor.' },
  { name: 'of_fin_del_contrato', label: 'Fin del contrato', type: 'date', fieldType: 'date',
    description: 'Fin/vigencia del contrato, copiado del line item por el motor.' },
  { name: 'of_pagos_restantes', label: 'Pagos restantes', type: 'number', fieldType: 'number',
    description: 'Progreso de pagos: cuántos pagos quedan. Copiado del line item por el motor.' },
  // --- ajuste por paramétrica ---
  { name: 'of_tipo_de_parametrica', label: 'Tipo de paramétrica', type: 'string', fieldType: 'text',
    description: 'Tipo de paramétrica del último ajuste, copiado del line item por el motor.' },
  { name: 'of_monto_unitario_original', label: 'Monto unitario original', type: 'number', fieldType: 'number',
    description: 'Monto unitario previo al ajuste por paramétrica. Copiado del line item por el motor.' },
  { name: 'of_porcentaje_ultimo_ajuste', label: 'Porcentaje último ajuste', type: 'number', fieldType: 'number',
    description: 'Porcentaje del último ajuste por paramétrica. Copiado del line item por el motor.' },
  { name: 'of_fecha_ultimo_ajuste', label: 'Fecha último ajuste', type: 'date', fieldType: 'date',
    description: 'Fecha del último ajuste por paramétrica. Copiado del line item por el motor.' },
];

async function main() {
  const acc = await fetch(`${HS}/account-info/v3/details`, { headers }).then((r) => r.json());
  console.log(`Portal: ${acc.portalId}`);

  for (const prop of PROPS) {
    const check = await fetch(`${HS}/crm/v3/properties/tickets/${prop.name}`, { headers });
    if (check.ok) {
      console.log(`✔ ${prop.name} ya existe — no se toca`);
      continue;
    }
    if (check.status !== 404) {
      throw new Error(`Error consultando ${prop.name}: ${check.status} ${await check.text()}`);
    }
    const res = await fetch(`${HS}/crm/v3/properties/tickets`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...prop, groupName: GROUP }),
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
