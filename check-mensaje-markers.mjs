// check-mensaje-markers.mjs
// Uso: node check-mensaje-markers.mjs --deal 58655169389
//
// Usa el hubspotClient del proyecto (ya autenticado con HUBSPOT_PRIVATE_TOKEN).
// Si la propiedad está vacía, escribe un HTML de prueba con varios tipos de
// markers, relee, y compara qué sobrevivió.

import { hubspotClient } from './src/hubspotClient.js';

const dealId = process.argv.find((a, i) => process.argv[i - 1] === '--deal') || '58655169389';

async function main() {
  console.log(`\n🔍 Leyendo mensaje_de_facturacion del deal ${dealId}...\n`);

  const deal = await hubspotClient.crm.deals.basicApi.getById(dealId, ['mensaje_de_facturacion']);
  const raw = deal?.properties?.mensaje_de_facturacion || '';

  if (!raw) {
    console.log('⚠️  Propiedad vacía.');
    console.log('   → Escribiendo HTML de prueba con markers y releyendo.\n');

    const testHTML = [
      '<!--FECHA:2026-04-01-->',
      '<div data-fecha="2026-04-01" style="display:none"></div>',
      '<span style="font-size:0px">MARKER_INVISIBLE</span>',
      '<div style="font-family:Arial;">',
      '📋 Solicitud de Facturación — 2026-04-01',
      '<!--LINE_ITEMS_START-->',
      '<div>Line item de prueba</div>',
      '<!--LINE_ITEMS_END-->',
      '</div>',
    ].join('\n');

    console.log('📝 Escribiendo HTML de prueba...');
    await hubspotClient.crm.deals.basicApi.update(dealId, {
      properties: { mensaje_de_facturacion: testHTML },
    });

    console.log('⏳ Esperando 3 segundos...\n');
    await new Promise(r => setTimeout(r, 3000));

    console.log('🔍 Releyendo...\n');
    const reread = await hubspotClient.crm.deals.basicApi.getById(dealId, ['mensaje_de_facturacion']);
    const rereadRaw = reread?.properties?.mensaje_de_facturacion || '';

    analyzeHTML(testHTML, rereadRaw);

    // Limpiar
    await hubspotClient.crm.deals.basicApi.update(dealId, {
      properties: { mensaje_de_facturacion: '' },
    });
    console.log('\n🧹 Propiedad limpiada.');

  } else {
    console.log('=== VALOR ACTUAL (primeros 3000 chars) ===');
    console.log(raw.slice(0, 3000));
    analyzeHTML(null, raw);
  }
}

function analyzeHTML(original, actual) {
  console.log('\n=== ANÁLISIS DE SUPERVIVENCIA ===\n');

  const checks = [
    { name: '<!-- HTML comment (FECHA) -->', test: '<!--FECHA:' },
    { name: '<!-- HTML comment (START) -->', test: '<!--LINE_ITEMS_START-->' },
    { name: '<!-- HTML comment (END) -->',   test: '<!--LINE_ITEMS_END-->' },
    { name: 'data-fecha attribute',          test: 'data-fecha=' },
    { name: 'display:none div',             test: 'display:none' },
    { name: 'font-size:0px span',           test: 'font-size:0px' },
    { name: 'MARKER_INVISIBLE text',        test: 'MARKER_INVISIBLE' },
    { name: 'Emoji 📋',                     test: '📋' },
  ];

  for (const { name, test } of checks) {
    const present = actual.includes(test);
    console.log(`  ${present ? '✅' : '❌'} ${name}`);
  }

  if (original) {
    console.log('\n=== ESCRITO ===');
    console.log(original);
    console.log('\n=== RELEÍDO DE HUBSPOT ===');
    console.log(actual);
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
