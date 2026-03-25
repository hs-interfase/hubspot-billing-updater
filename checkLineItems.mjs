import { hubspotClient } from './src/hubspotClient.js';

const ids = ['52362055235', '53090632117'];
for (const id of ids) {
  const li = await hubspotClient.crm.lineItems.basicApi.getById(id, [
    'hs_recurring_billing_number_of_payments',
    'number_of_payments',
    'line_item_key',
    'recurringbillingfrequency',
    'hs_recurring_billing_start_date',
    'last_ticketed_date',
    'fechas_completas',
  ]);
  console.log(`\n=== ${id} ===`);
  console.log(JSON.stringify(li.properties, null, 2));
}
