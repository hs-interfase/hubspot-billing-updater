// src/phases/activateBilling.js

import { hubspotClient } from '../hubspotClient.js';
import { parseBool } from '../utils/parsers.js';

/**
 * ACTIVACIÓN DE FACTURACIÓN Y CUPO
 * 
 * Se ejecuta cuando un deal llega a "Closed Won".
 * Activa automáticamente:
 * - facturacion_activa = true (en deal y line items con fechas)
 * - cupo_activo = true (SOLO en DEAL si tiene cupo configurado)
 * 
 * @param {Object} params
 * @param {Object} params.deal - Deal de HubSpot
 * @param {Array} params.lineItems - Line Items del Deal
 * @returns {Object} { activated }
 */
export async function activateBillingIfClosedWon({ deal, lineItems }) {
  const dealId = String(deal.id || deal.properties?.hs_object_id);
  const dp = deal.properties || {};
  
  console.log(`   [Activación] Verificando si activar facturación...`);
  
  // Verificar si el deal está en Closed Won
  const dealStage = dp.dealstage || '';
  const isClosedWon = dealStage.toLowerCase().includes('closedwon') || 
                      dealStage === 'closedwon' ||
                      dealStage === 'closed_won';
  
  console.log(`   [Activación] Deal stage: ${dealStage}`);
  console.log(`   [Activación] ¿Es Closed Won?: ${isClosedWon}`);
  
  if (!isClosedWon) {
    console.log(`   [Activación] Deal NO está en Closed Won, no se activa facturación`);
    return { activated: false, reason: 'No está en Closed Won' };
  }
  
  // Ya está en Closed Won, activar facturación
  console.log(`   [Activación] ✅ Deal en Closed Won, activando facturación...`);
  
  let dealUpdated = false;
  let lineItemsUpdated = 0;
  
  // 1) Activar facturacion_activa en DEAL (si no está ya)
  const dealFacturacionActiva = parseBool(dp.facturacion_activa);
  if (!dealFacturacionActiva) {
    console.log(`   [Activación] Activando facturacion_activa en Deal...`);
    try {
      await hubspotClient.crm.deals.basicApi.update(dealId, {
        properties: {
          facturacion_activa: 'true',
        },
      });
      dealUpdated = true;
      console.log(`   [Activación] ✅ facturacion_activa activada en Deal`);
    } catch (err) {
      console.error(`   [Activación] ❌ Error activando facturacion_activa en Deal:`, err?.message);
    }
  } else {
    console.log(`   [Activación] facturacion_activa ya estaba activa en Deal`);
  }
  
  // 2) Activar cupo_activo SOLO en DEAL (si tiene cupo configurado)
  const tipoCupo = dp.tipo_de_cupo || '';
  const cupoTotal = parseFloat(dp.cupo_total || dp.cupo_total_horas || dp.cupo_total_monto || 0);
  const cupoActivo = parseBool(dp.cupo_activo);
  
  // Verificar si al menos UN line item tiene parte_del_cupo=true
  const hasLineItemWithCupo = (lineItems || []).some(li => parseBool(li?.properties?.parte_del_cupo));
  
  if (tipoCupo && cupoTotal > 0 && hasLineItemWithCupo && !cupoActivo) {
    console.log(`   [Activación] Activando cupo_activo en DEAL (tipo: ${tipoCupo}, total: ${cupoTotal})...`);
    try {
      await hubspotClient.crm.deals.basicApi.update(dealId, {
        properties: {
          cupo_activo: 'true',
        },
      });
      dealUpdated = true;
      console.log(`   [Activación] ✅ cupo_activo activado en Deal`);
    } catch (err) {
      console.error(`   [Activación] ❌ Error activando cupo_activo:`, err?.message);
    }
  } else if (cupoActivo) {
    console.log(`   [Activación] cupo_activo ya estaba activo en Deal`);
  } else if (!hasLineItemWithCupo) {
    console.log(`   [Activación] No hay line items con parte_del_cupo=true, no se activa cupo`);
  }
  
  // 3) Activar facturacion_activa en LINE ITEMS que tengan fechas configuradas
  console.log(`   [Activación] Verificando ${lineItems.length} line items...`);
  
  for (const li of lineItems || []) {
    const lineItemId = String(li.id || li.properties?.hs_object_id);
    const lp = li.properties || {};
    
    const liFacturacionActiva = parseBool(lp.facturacion_activa);
const tieneFecha = lp.hs_recurring_billing_start_date || 
                   lp.recurringbillingstartdate || 
                   lp.fecha_inicio_de_facturacion;
const tieneFrecuencia = lp.hs_recurring_billing_frequency ||
                        lp.recurringbillingfrequency || 
                        lp.facturacion_frecuencia;

// Si tiene fecha O frecuencia, activar facturacion_activa
if ((tieneFecha || tieneFrecuencia) && !liFacturacionActiva) {
      console.log(`   [Activación]    Line Item ${lineItemId}: activando facturacion_activa...`);
      try {
        await hubspotClient.crm.lineItems.basicApi.update(lineItemId, {
          properties: {
            facturacion_activa: 'true',
          },
        });
        lineItemsUpdated++;
        console.log(`   [Activación]    ✅ Line Item ${lineItemId} activado`);
      } catch (err) {
        console.error(`   [Activación]    ❌ Error activando Line Item ${lineItemId}:`, err?.message);
      }
    } else if (liFacturacionActiva) {
      console.log(`   [Activación]    Line Item ${lineItemId}: ya estaba activo`);
    } else {
      console.log(`   [Activación]    Line Item ${lineItemId}: sin fecha/frecuencia, saltando...`);
    }
  }
  
  console.log(`   [Activación] ✅ Activación completada:`);
  console.log(`      - Deal actualizado: ${dealUpdated}`);
  console.log(`      - Line Items activados: ${lineItemsUpdated}`);
  
  return { 
    activated: true, 
    dealUpdated, 
    lineItemsUpdated 
  };
}