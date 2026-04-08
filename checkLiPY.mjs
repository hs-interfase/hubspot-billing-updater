import { hubspotClient } from './src/hubspotClient.js';

const li = await hubspotClient.crm.lineItems.basicApi.getById(
  '54086419340',
  ['of_line_item_py_origen_id', 'pais_operativo', 'uy']
);
console.log(li.properties);
