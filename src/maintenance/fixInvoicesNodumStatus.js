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
    console.log('\n' + '='.repeat(80));
    console.log('🔧 SINCRONIZACIÓN DE INVOICES CON ID_FACTURA_NODUM');
    console.log('='.repeat(80) + '\n');

    // 1. Buscar TODAS las invoices en Pendiente
    console.log('🔍 Buscando invoices en Pendiente...\n');
    
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
        'ticket_id',
      ],
      limit: 100,
    });

    const allInvoices = searchResp.data?.results || [];
    console.log(`📋 Total en Pendiente: ${allInvoices.length}\n`);

    // 2. Separar: CON id_factura_nodum vs SIN
    const withNodum = [];
    const withoutNodum = [];

    for (const inv of allInvoices) {
      const invId = inv.id;
      const nodumId = (inv.properties?.id_factura_nodum || '').trim();

      if (nodumId.length > 0) {
        withNodum.push({
          invId,
          nodumId,
          ticketId: inv.properties?.ticket_id,
        });
      } else {
        withoutNodum.push(invId);
      }
    }

    console.log(`✅ CON id_factura_nodum: ${withNodum.length}`);
    console.log(`❌ SIN id_factura_nodum: ${withoutNodum.length}\n`);

    if (withNodum.length === 0) {
      console.log('⚠️  No hay invoices para procesar\n');
      process.exit(0);
    }

    // 3. Mostrar qué se va a cambiar
    console.log('📋 INVOICES A PASAR A EMITIDA:');
    console.log('━'.repeat(80));
    withNodum.forEach((inv, i) => {
      console.log(`   [${(i + 1).toString().padStart(2)}] Invoice ${inv.invId} → id_nodum: ${inv.nodumId}`);
    });
    console.log('');

    // 4. Procesar
    console.log('⬆️  Procesando...\n');
    let succeeded = 0;
    let failed = 0;

    for (let i = 0; i < withNodum.length; i++) {
      const inv = withNodum[i];
      process.stdout.write(`[${(i + 1).toString().padStart(2)}/${withNodum.length}] ${inv.invId} ... `);

      try {
        // Actualizar invoice
        await hsClient.patch(`/crm/v3/objects/invoices/${inv.invId}`, {
          properties: { etapa_de_la_factura: 'Emitida' },
        });
        process.stdout.write('✓ Emitida');

        // Sincronizar ticket si existe
        if (inv.ticketId) {
          try {
            await hsClient.patch(`/crm/v3/objects/tickets/${inv.ticketId}`, {
              properties: {
                of_invoice_status: 'Emitida',
                numero_de_factura: inv.nodumId,
              },
            });
            process.stdout.write(' + Ticket ✓');
          } catch (e) {
            process.stdout.write(' (ticket fail)');
          }
        }

        process.stdout.write('\n');
        succeeded++;
      } catch (err) {
        process.stdout.write(`❌ ${err.response?.data?.message || err.message}\n`);
        failed++;
      }
    }

    console.log('\n' + '='.repeat(80));
    console.log(`📊 RESUMEN: ${succeeded}/${withNodum.length} exitosas, ${failed} errores`);
    console.log('='.repeat(80) + '\n');

    process.exit(failed > 0 ? 1 : 0);
  } catch (err) {
    console.error('\n❌ Error:', err.message);
    if (err.response?.data) {
      console.error('   Detalles:', JSON.stringify(err.response.data, null, 2));
    }
    process.exit(1);
  }
})();