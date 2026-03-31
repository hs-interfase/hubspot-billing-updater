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

(async () => {
  try {
    console.log('\n🔍 Analizando invoices en Pendiente...\n');

    // Buscar TODAS las invoices en Pendiente
    const searchResp = await hsClient.post('/crm/v3/objects/invoices/search', {
      filterGroups: [
        {
          filters: [
            { propertyName: 'etapa_de_la_factura', operator: 'EQ', value: 'Pendiente' },
          ],
        },
      ],
      properties: [
        'id_factura_nodum',
        'etapa_de_la_factura',
      ],
      limit: 100,
    });

    const allInvoices = searchResp.data?.results || [];
    console.log(`📋 Total de invoices en Pendiente: ${allInvoices.length}\n`);

    // Separar: CON id_factura_nodum vs SIN
    const withNodum = [];
    const withoutNodum = [];

    for (const inv of allInvoices) {
      const invId = inv.id;
      const nodumId = (inv.properties?.id_factura_nodum || '').trim();

      if (nodumId.length > 0) {
        withNodum.push({ invId, nodumId });
      } else {
        withoutNodum.push(invId);
      }
    }

    // Mostrar resultados
    console.log('✅ INVOICES CON id_factura_nodum (deberían pasar a Emitida):');
    console.log('━'.repeat(70));
    if (withNodum.length === 0) {
      console.log('   (ninguna)');
    } else {
      withNodum.forEach((inv, i) => {
        console.log(`   [${(i + 1).toString().padStart(2)}] Invoice ${inv.invId}`);
        console.log(`       id_factura_nodum: ${inv.nodumId}\n`);
      });
    }

    console.log('\n❌ INVOICES SIN id_factura_nodum (deberían quedarse en Pendiente):');
    console.log('━'.repeat(70));
    if (withoutNodum.length === 0) {
      console.log('   (ninguna)');
    } else {
      withoutNodum.forEach((invId, i) => {
        console.log(`   [${(i + 1).toString().padStart(2)}] Invoice ${invId}`);
      });
    }

    console.log('\n' + '='.repeat(70));
    console.log(`📊 RESUMEN:`);
    console.log(`   Con id_factura_nodum:    ${withNodum.length}`);
    console.log(`   Sin id_factura_nodum:    ${withoutNodum.length}`);
    console.log(`   Total:                   ${allInvoices.length}`);
    console.log('='.repeat(70) + '\n');

  } catch (err) {
    console.error('\n❌ Error:', err.message);
    if (err.response?.data) {
      console.error('   Detalles:', JSON.stringify(err.response.data, null, 2));
    }
    process.exit(1);
  }
})();
