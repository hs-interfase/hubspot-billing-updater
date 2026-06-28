// diag_urgente.mjs
//
// READ-ONLY. Inspecciona los tickets READY de un deal y reporta el valor
// EXACTO de facturacion_urgente (y propiedades de nombre parecido),
// para diagnosticar por qué el banner urgente no aparece en el mensaje.
//
// Uso (raíz del proyecto, usa su .env):
//   node diag_urgente.mjs --deal 61027186492

import 'dotenv/config';
import { hubspotClient } from './src/hubspotClient.js';
import { TICKET_PIPELINE, TICKET_STAGES } from './src/config/constants.js';

const args = process.argv.slice(2);
const i = args.indexOf('--deal');
const DEAL_ID = i >= 0 && args[i + 1] ? args[i + 1] : '61027186492';

const sep = (t) => console.log(`\n${'─'.repeat(58)}\n${t}\n${'─'.repeat(58)}`);

// 1. ¿Existe la propiedad facturacion_urgente en el objeto Ticket?
sep('1. ¿Existe facturacion_urgente como propiedad de Ticket?');
try {
  const prop = await hubspotClient.crm.properties.coreApi.getByName('tickets', 'facturacion_urgente');
  console.log(`  ✅ Existe. type=${prop.type}  fieldType=${prop.fieldType}  label="${prop.label}"`);
} catch (err) {
  console.log(`  ❌ NO existe facturacion_urgente en Tickets (${err?.message || err}).`);
  console.log('     → El flujo urgente vendría fallando al escribirla. Hay que crearla:');
  console.log('       objeto Ticket, nombre interno facturacion_urgente, casilla única.');
}

// ¿Existe la duplicada que creaste a mano?
try {
  const dup = await hubspotClient.crm.properties.coreApi.getByName('tickets', 'facturacion_urgente');
  console.log(`  ⚠️  OJO: también existe "facturacion_urgente" (sin of_) en Tickets — label="${dup.label}". Esta es la que NO lee el código.`);
} catch {
  console.log('  (No existe "facturacion_urgente" sin prefijo en Tickets — bien.)');
}

// 2. Tickets READY del deal
sep(`2. Tickets READY del deal ${DEAL_ID}`);
const res = await hubspotClient.crm.tickets.searchApi.doSearch({
  filterGroups: [{
    filters: [
      { propertyName: 'hs_pipeline',      operator: 'EQ', value: String(TICKET_PIPELINE) },
      { propertyName: 'hs_pipeline_stage', operator: 'EQ', value: String(TICKET_STAGES.READY) },
      { propertyName: 'of_deal_id',        operator: 'EQ', value: String(DEAL_ID) },
    ],
  }],
  properties: [
    'subject', 'of_deal_id', 'facturacion_urgente',
    'of_fecha_de_facturacion', 'ticket_emitio_aviso_a_admin',
    'of_producto_nombres',
  ],
  limit: 50,
});

const tickets = res?.results || [];
console.log(`  Encontrados: ${tickets.length}`);
for (const t of tickets) {
  const p = t.properties || {};
  const raw = p.facturacion_urgente;
  const interpretado = String(raw ?? '').trim().toLowerCase() === 'true';
  console.log(`\n  Ticket ${t.id}  "${p.subject || ''}"`);
  console.log(`    facturacion_urgente (crudo):  ${JSON.stringify(raw)}`);
  console.log(`    → el builder lo ve como urgente?  ${interpretado ? '✅ SÍ' : '❌ NO'}`);
  console.log(`    of_fecha_de_facturacion:         ${p.of_fecha_de_facturacion || '(vacío)'}`);
  console.log(`    ticket_emitio_aviso_a_admin:     ${p.ticket_emitio_aviso_a_admin || '(vacío)'}`);
}

sep('VEREDICTO');
if (tickets.length === 0) {
  console.log('  No hay tickets READY para este deal — nada que mostrar en el mensaje.');
} else {
  const algunoUrgente = tickets.some(
    t => String(t.properties?.facturacion_urgente ?? '').trim().toLowerCase() === 'true'
  );
  if (algunoUrgente) {
    console.log('  ✅ Hay al menos un ticket urgente → el banner DEBERÍA aparecer.');
    console.log('     Si no aparece, el problema está en el build (revisar que esUrgente/STYLES estén bien).');
  } else {
    console.log('  ❌ Ningún ticket tiene facturacion_urgente=true.');
    console.log('     Por eso no sale el banner. Opciones:');
    console.log('       a) Setear facturacion_urgente=true a mano EN EL TICKET (no en el deal) y re-correr el dry.');
    console.log('       b) Probar el flujo real: facturar_ahora=true en un LI manual → el sistema lo marca solo.');
  }
}
console.log('');
