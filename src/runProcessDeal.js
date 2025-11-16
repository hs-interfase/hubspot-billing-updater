// src/runProcessDeal.js
import { processDeal } from './processDeal.js';
import { hubspotClient } from './hubspotClient.js';

// Función para listar deals disponibles
async function listAvailableDeals() {
  try {
    const searchRequest = {
      properties: ['dealname', 'dealstage', 'amount', 'closedate'],
      limit: 20
    };

    const response = await hubspotClient.crm.deals.searchApi.doSearch(searchRequest);
    const deals = response.results;

    console.log('📋 DEALS DISPONIBLES:\n');
    
    deals.forEach((deal, idx) => {
      console.log(`${idx + 1}. ID: ${deal.id}`);
      console.log(`   Nombre: ${deal.properties?.dealname || 'Sin nombre'}`);
      console.log(`   Stage: ${deal.properties?.dealstage || 'Sin stage'}`);
      console.log(`   Valor: ${deal.properties?.amount || 'Sin valor'}`);
      console.log('   ─────────────────────────────────');
    });

    return deals;
  } catch (error) {
    console.error('Error listando deals:', error.message);
    return [];
  }
}

async function main() {
  const command = process.argv[2];
  const dealId = process.argv[3];

  if (command === 'list') {
    await listAvailableDeals();
    return;
  }

  if (command === 'process') {
    if (!dealId) {
      console.error('❌ Uso: node src/runProcessDeal.js process <dealId>');
      console.error('');
      console.error('O para ver deals disponibles:');
      console.error('   node src/runProcessDeal.js list');
      process.exit(1);
    }

    try {
      console.log(`🔄 Procesando deal ${dealId}...`);
      
      const result = await processDeal(dealId);
      
      console.log('✅ Deal procesado exitosamente:');
      console.log(`   - Nombre: ${result.dealName}`);
      console.log(`   - ID: ${result.dealId}`);
      console.log(`   - Próxima fecha de facturación: ${result.nextBillingDate}`);
      console.log(`   - Line items procesados: ${result.lineItemsCount}`);
      console.log('');
      console.log('🎯 El deal ha sido actualizado en HubSpot con:');
      console.log('   - facturacion_proxima_fecha');
      console.log('   - facturacion_mensaje_proximo_aviso');
      
    } catch (err) {
      console.error('❌ Error procesando el deal:', err.message);
      process.exit(1);
    }
    return;
  }

  // Sin comando o comando inválido
  console.log('🚀 HUBSPOT DEAL PROCESSOR');
  console.log('');
  console.log('Uso:');
  console.log('  node src/runProcessDeal.js list              # Lista deals disponibles');
  console.log('  node src/runProcessDeal.js process <dealId>  # Procesa un deal específico');
  console.log('');
  console.log('¿Qué hace el procesamiento?');
  console.log('1. Lee el deal y sus line-items');
  console.log('2. Encuentra la fecha más próxima usando fecha_inicio_facturacion');
  console.log('3. Guarda esa fecha como facturacion_proxima_fecha');
  console.log('4. Genera un mensaje-resumen del line-item con esa fecha');
}

main();
