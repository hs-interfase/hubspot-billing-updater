// src/processDealsOnce.js
import { hubspotClient, getDealWithLineItems } from './hubspotClient.js';

// Por ahora trabajamos con appointmentscheduled (Prueba 1).
// Más adelante usaremos algo como process.env.HUBSPOT_CLOSED_WON_STAGE = 'closedwon'
const TARGET_STAGE = 'appointmentscheduled';

// Esta función luego será donde metas la lógica real de fechas
function computeNextBillingDateFromLineItems(lineItems) {
  // 🔴 Versión demo: pone “mañana”
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d;
}

// Un mensajito de texto para el deal
function buildNextBillingMessage(nextDate) {
  const yyyy = nextDate.getFullYear();
  const mm = String(nextDate.getMonth() + 1).padStart(2, '0');
  const dd = String(nextDate.getDate()).padStart(2, '0');

  return `Próxima factura estimada para el ${dd}/${mm}/${yyyy}. (mensaje de prueba)`;
}

async function processDealsOnce() {
  console.log('Buscando deals en etapa', TARGET_STAGE);

  const searchRequest = {
    filterGroups: [
      {
        filters: [
          {
            propertyName: 'dealstage',
            operator: 'EQ',
            value: TARGET_STAGE,
          },
          // Aquí luego podemos agregar:
          // { propertyName: 'facturacion_activa', operator: 'EQ', value: 'true' }
        ],
      },
    ],
    properties: ['dealname', 'dealstage'],
    limit: 10,
  };

  const res = await hubspotClient.crm.deals.searchApi.doSearch(searchRequest);

  if (!res.results.length) {
    console.log('No hay deals en esa etapa.');
    return;
  }

  console.log(`Encontrados ${res.results.length} deal(s).`);

  for (const d of res.results) {
    console.log('\nProcesando deal:', d.id, '-', d.properties.dealname);

    const { deal, lineItems } = await getDealWithLineItems(d.id);

    console.log(`  Line items encontrados: ${lineItems.length}`);

    const nextBillingDate = computeNextBillingDateFromLineItems(lineItems);
    const message = buildNextBillingMessage(nextBillingDate);

    // HubSpot espera fechas tipo YYYY-MM-DD para campos date
    const yyyy = nextBillingDate.getFullYear();
    const mm = String(nextBillingDate.getMonth() + 1).padStart(2, '0');
    const dd = String(nextBillingDate.getDate()).padStart(2, '0');
    const nextDateStr = `${yyyy}-${mm}-${dd}`;

    // Cambia estos nombres por los de tus propiedades reales del negocio:
    const updateBody = {
      properties: {
        facturacion_proxima_fecha: nextDateStr,
        facturacion_mensaje_proximo_aviso: message,
        facturacion_activa: 'true', // si tenés un boolean
      },
    };

    try {
      await hubspotClient.crm.deals.basicApi.update(deal.id, updateBody);
      console.log('  Deal actualizado con próxima fecha y mensaje.');
    } catch (err) {
      console.error('  Error actualizando deal:', err.response?.body || err);
    }
  }

  console.log('\nProceso terminado.');
}

processDealsOnce().catch((err) => {
  console.error('Error general:', err.response?.body || err);
});
