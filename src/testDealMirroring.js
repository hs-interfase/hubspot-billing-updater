// src/testMirrorDealToUruguay.js
import { mirrorDealToUruguay } from './dealMirroring.js';

const dealId = process.argv[2];

if (!dealId) {
  console.error('Uso: node src/testMirrorDealToUruguay.js <dealId>');
  process.exit(1);
}

async function main() {
  try {
    const res = await mirrorDealToUruguay(dealId, {
      // si querés forzar IDs a mano en la prueba:
      // interfaseCompanyId: '1234567890',
      // beneficiaryCompanyId: '9876543210',
    });

    console.log('Resultado espejo PY -> UY:');
    console.log(JSON.stringify(res, null, 2));
  } catch (err) {
    console.error('Error en mirrorDealToUruguay:');
    console.error(err.response?.body || err.message || err);
    process.exit(1);
  }
}

main();
