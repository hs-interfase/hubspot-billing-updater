// src/testProcessDeal.js
import { processDeal } from '../processDeal.js';

const dealId = process.argv[2];

if (!dealId) {
  console.error('Uso: node src/testProcessDeal.js <dealId>');
  process.exit(1);
}

processDeal(dealId)
  .then((summary) => {
    console.log('Deal procesado correctamente:');
    console.dir(summary, { depth: null });
  })
  .catch((err) => {
    console.error('Error en processDeal:', err.response?.body || err.message || err);
  });
