#!/usr/bin/env node
/**
 * diagTicketsMirror.mjs
 * Diagnóstico rápido de tickets específicos.
 *
 * Uso:
 *   node diagTicketsMirror.mjs
 */

import 'dotenv/config';
import { hubspotClient } from './src/hubspotClient.js';

const TICKET_IDS = [
  '44397453845', // UY automático listo para facturar
  '44375241004', // UY automático listo para facturar
  '44386461049', // manual próximo a facturar (bien)
  '44379423501', // manual mandado a facturar (raro)
  '44372603711', // manual mandado a facturar (raro)
  '44386318001', // cancelado
];

const PROPS = [
  'hs_object_id',
  'subject',
  'hs_pipeline',
  'hs_pipeline_stage',
  'of_ticket_key',
  'of_line_item_key',
  'of_deal_id',
  'of_invoice_id',
  'of_invoice_key',
  'of_invoice_status',
  'of_estado',
  'fecha_resolucion_esperada',
  'of_fecha_de_facturacion',
  'fecha_real_de_facturacion',
  'facturar_ahora',
  'of_facturacion_urgente',
  'of_pais_operativo',
  'createdate',
  'hs_lastmodifieddate',
];

// Stage labels conocidos (agregá más si querés)
const STAGE_LABELS = {
  // Manual pipeline 832539959
  '1234282360': 'MANUAL_READY',
  '1329838706': 'MANUAL_FORECAST_85',
  // Auto pipeline 829156883
  '1228755520': 'AUTO_READY',
  '1329913747': 'AUTO_FORECAST_85',
  '1228755521': 'AUTO_CREATED',
  '1228755522': 'AUTO_PAID',
  '1228755523': 'AUTO_CANCELLED',
};

const PIPELINE_LABELS = {
  '832539959': 'MANUAL',
  '829156883': 'AUTO',
};

function label(map, val) {
  return map[val] ? `${val} (${map[val]})` : (val || '—');
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  DIAGNÓSTICO DE TICKETS — MIRROR UY');
  console.log('═══════════════════════════════════════════════════════════\n');

  for (const ticketId of TICKET_IDS) {
    console.log(`─────────────────────────────────────────`);
    console.log(`🎫 TICKET ${ticketId}`);

    try {
      const t = await hubspotClient.crm.tickets.basicApi.getById(ticketId, PROPS);
      const p = t.properties || {};

      console.log(`   subject:              ${p.subject || '—'}`);
      console.log(`   pipeline:             ${label(PIPELINE_LABELS, p.hs_pipeline)}`);
      console.log(`   stage:                ${label(STAGE_LABELS, p.hs_pipeline_stage)}`);
      console.log(`   of_ticket_key:        ${p.of_ticket_key || '—'}`);
      console.log(`   of_line_item_key:     ${p.of_line_item_key || '—'}`);
      console.log(`   of_deal_id:           ${p.of_deal_id || '—'}`);
      console.log(`   of_invoice_id:        ${p.of_invoice_id || '—'}`);
      console.log(`   of_invoice_status:    ${p.of_invoice_status || '—'}`);
      console.log(`   of_estado:            ${p.of_estado || '—'}`);
      console.log(`   fecha_esperada:       ${p.fecha_resolucion_esperada || '—'}`);
      console.log(`   fecha_facturacion:    ${p.of_fecha_de_facturacion || '—'}`);
      console.log(`   fecha_real:           ${p.fecha_real_de_facturacion || '—'}`);
      console.log(`   facturar_ahora:       ${p.facturar_ahora || '—'}`);
      console.log(`   urgente:              ${p.of_facturacion_urgente || '—'}`);
      console.log(`   pais_operativo:       ${p.of_pais_operativo || '—'}`);
      console.log(`   createdate:           ${p.createdate || '—'}`);
      console.log(`   lastmodified:         ${p.hs_lastmodifieddate || '—'}`);

      // Verificar si tiene invoice asociada
      if (p.of_invoice_id) {
        try {
          const inv = await hubspotClient.crm.objects.basicApi.getById(
            'invoices', p.of_invoice_id,
            ['of_invoice_key', 'etapa_de_la_factura', 'monto_a_facturar', 'hs_createdate']
          );
          const ip = inv.properties || {};
          console.log(`   → INVOICE ${p.of_invoice_id}:`);
          console.log(`       etapa:    ${ip.etapa_de_la_factura || '—'}`);
          console.log(`       monto:    ${ip.monto_a_facturar || '—'}`);
          console.log(`       key:      ${ip.of_invoice_key || '—'}`);
          console.log(`       created:  ${ip.hs_createdate || '—'}`);
        } catch {
          console.log(`   → INVOICE ${p.of_invoice_id}: no encontrada o error al leer`);
        }
      }

      // Ver LI asociado
      const lik = p.of_line_item_key;
      if (lik) {
        try {
          const liResp = await hubspotClient.crm.objects.searchApi.doSearch('line_items', {
            filterGroups: [{ filters: [{ propertyName: 'line_item_key', operator: 'EQ', value: lik }] }],
            properties: ['name', 'facturacion_automatica', 'facturar_ahora', 'billing_next_date', 'of_line_item_py_origen_id'],
            limit: 1,
          });
          const li = liResp?.results?.[0];
          if (li) {
            const lp = li.properties || {};
            console.log(`   → LINE ITEM ${li.id}:`);
            console.log(`       name:           ${lp.name || '—'}`);
            console.log(`       automatica:     ${lp.facturacion_automatica || '—'}`);
            console.log(`       facturar_ahora: ${lp.facturar_ahora || '—'}`);
            console.log(`       billing_next:   ${lp.billing_next_date || '—'}`);
            console.log(`       py_origen_id:   ${lp.of_line_item_py_origen_id || '—'}`);
          } else {
            console.log(`   → LINE ITEM: no encontrado para lik ${lik}`);
          }
        } catch (err) {
          console.log(`   → LINE ITEM: error buscando por lik: ${err.message}`);
        }
      }

    } catch (err) {
      const status = err?.response?.status ?? err?.statusCode;
      if (status === 404) {
        console.log(`   ❌ No encontrado (404)`);
      } else {
        console.log(`   ❌ Error: ${err.message}`);
      }
    }

    console.log();
  }

  console.log('═══════════════════════════════════════════════════════════');
  console.log('  FIN DIAGNÓSTICO');
  console.log('═══════════════════════════════════════════════════════════');
}

main().catch(err => {
  console.error('\n❌ Error fatal:', err.message);
  process.exit(1);
});
