import { propagateInvoiceCancellation } from '../propagacion/invoice.js';

const result = await propagateInvoiceCancellation('535627410303');
console.log('Resultado:', JSON.stringify(result, null, 2));
