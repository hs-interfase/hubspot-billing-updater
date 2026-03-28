#!/usr/bin/env node

import axios from 'axios';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../../.env') });

const token = process.env.HUBSPOT_PRIVATE_TOKEN;
const hsClient = axios.create({
  baseURL: 'https://api.hubapi.com',
  headers: { Authorization: `Bearer ${token}` },
  timeout: 30000,
});

// IDs de las 13 invoices que se pasaron a Emitida por error
const invoiceIds = [
  '535015266570',
  '535011162542',
  '535554546302',
  '535575313971',
  '535575198015',
  '535555632801',
  '536114018228',
  '536182934586',
  '536183958173',
  '538503814821',
  '541124889950',
  '542738350692',
  '543103959923',
];

(async () => {
  console.log('\n🔄 Revirtiendo 13 invoices a Pendiente...\n');

  let succeeded = 0;
  let failed = 0;

  for (let i = 0; i < invoiceIds.length; i++) {
    const invId = invoiceIds[i];
    process.stdout.write(`[${(i + 1).toString().padStart(2)}/13] ${invId} ... `);

    try {
      await hsClient.patch(`/crm/v3/objects/invoices/${invId}`, {
        properties: { etapa_de_la_factura: 'Pendiente' },
      });
      process.stdout.write('✓ Revertido a Pendiente\n');
      succeeded++;
    } catch (err) {
      process.stdout.write(`❌ ${err.message}\n`);
      failed++;
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log(`✅ ${succeeded}/13 revertidas, ${failed} errores`);
  console.log('='.repeat(60) + '\n');
})();
