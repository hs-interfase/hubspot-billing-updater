// src/processAllActiveDeals.js
import { hubspotClient } from './hubspotClient.js';
import { processDeal } from './processDeal.js';
import { processBagTickets } from './bagProcessor.js';

const FINAL_STAGES = ['closedwon', 'cierre_finalizado', 'cierre_ganado']; // ajustá si tus internal names son otros

async function processAllActiveDeals() {
  console.log('=== INICIO processAllActiveDeals ===');

  const searchRequest = {
    // Dos grupos de filtros que se comportan como OR:
    // 1) facturacion_activa = true
    // 2) facturacion_activa no seteada + etapa final
    filterGroups: [
      {
        filters: [
          {
            propertyName: 'facturacion_activa',
            operator: 'EQ',
            value: 'true',
          },
        ],
      },
      {
        filters: [
          {
            propertyName: 'facturacion_activa',
            operator: 'NOT_HAS_PROPERTY',
          },
          {
            propertyName: 'dealstage',
            operator: 'IN',
            values: FINAL_STAGES,
          },
        ],
      },
    ],
    properties: ['dealname', 'dealstage', 'facturacion_activa'],
    limit: 100,
  };

  console.log(
    'Search request que se envía a HubSpot:\n',
    JSON.stringify(searchRequest, null, 2)
  );

  try {
    const res = await hubspotClient.crm.deals.searchApi.doSearch(searchRequest);

    console.log('Respuesta cruda de HubSpot: keys =', Object.keys(res || {}));

    const deals = res.results || [];
    console.log(`Encontré ${deals.length} deals candidatos a facturación.`);

    for (const d of deals) {
      const props = d.properties || {};
      const dealId = d.id;
      const nombre = props.dealname || '(sin nombre)';
      const etapa = props.dealstage || '(sin etapa)';
      const factActivaRaw = props.facturacion_activa;
      const factActiva = factActivaRaw === 'true';

      console.log(
        `\n→ Revisando deal ${dealId} | "${nombre}" | etapa=${etapa} | facturacion_activa=${factActivaRaw}`
      );

      let debeProcesar = false;

      // Caso 1: ya está en true → procesar
      if (factActiva) {
        console.log('   - facturacion_activa ya es true → se procesa.');
        debeProcesar = true;
      }

      // Caso 2: etapa final + facturacion_activa null (no seteada)
      if (!factActivaRaw && FINAL_STAGES.includes(etapa)) {
        console.log(
          '   - Etapa final y facturacion_activa es null → la seteamos a true.'
        );

        await hubspotClient.crm.deals.basicApi.update(dealId, {
          properties: {
            facturacion_activa: 'true',
          },
        });

        debeProcesar = true;
      }

      if (!debeProcesar) {
        console.log(
          '   - No se procesa este deal (ni activa ni etapa final con null).'
        );
        continue;
      }

      // Llamar al motor por deal
      try {
        console.log(`   → Llamando a processDeal(${dealId})...`);
        const result = await processDeal(dealId);
        console.log('   Resultado processDeal:', result);
      } catch (err) {
        console.error(
          `   ! ERROR en processDeal para deal ${dealId}:`,
          err.response?.body || err
        );
      }
    }

    // 👇 NUEVO BLOQUE: procesar bolsas después de todos los deals
    try {
      console.log('\n=== Ejecutando processBagTickets (bolsas) ===');
      const bagResult = await processBagTickets();
      console.log('Resultado processBagTickets:', bagResult);
    } catch (err) {
      console.error(
        '=== ERROR en processBagTickets ===\n',
        err.response?.body || err
      );
    }

    console.log('\n=== FIN NORMAL processAllActiveDeals ===');
  } catch (err) {
    console.error(
      '=== ERROR en processAllActiveDeals (búsqueda de deals) ===\n',
      err.response?.body || err
    );
  }
}

processAllActiveDeals();