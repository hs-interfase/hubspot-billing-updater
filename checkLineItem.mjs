// checkLineItem.mjs
import { hubspotClient } from './src/hubspotClient.js';

const liResp = await hubspotClient.crm.lineItems.basicApi.getById(
  '52362055235',
  ['line_item_key', 'facturacion_activa', 'facturacion_automatica', 'pausa',
   'billing_next_date', 'hs_recurring_billing_start_date', 'facturar_ahora',
   'hs_recurring_billing_number_of_payments']
);
console.log(JSON.stringify(liResp.properties, null, 2));
