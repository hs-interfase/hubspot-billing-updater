import 'dotenv/config';
import { propagateInvoiceStateToTicket } from './src/propagacion/invoice.js';

const result = await propagateInvoiceStateToTicket('539442898842');
console.log('Resultado:', JSON.stringify(result, null, 2));
