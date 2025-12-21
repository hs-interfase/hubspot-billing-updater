// src/testDealWithLineItems.js
import { getDealWithLineItems } from './getDealWithLineItems.js';

async function main() {
  const dealId = process.argv[2];

  if (!dealId) {
    console.error('Uso: node src/testDealWithLineItems.js <dealId>');
    process.exit(1);
  }

  try {
    const { deal, lineItems } = await getDealWithLineItems(dealId);

    console.log('DEAL:');
    console.dir(
      {
        id: deal.id,
        name: deal.properties?.dealname,
        stage: deal.properties?.dealstage,
        amount: deal.properties?.amount,
        closedate: deal.properties?.closedate,
      },
      { depth: null }
    );

    console.log('\nLINE ITEMS:');
    lineItems.forEach((li, idx) => {
      console.log(`\n#${idx + 1} – id: ${li.id}`);
      console.dir(li.properties, { depth: null });
    });
  } catch (err) {
    console.error('Error:', err.response?.body || err.message || err);
  }
}

main();
