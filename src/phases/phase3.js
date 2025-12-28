// src/phases/phase3.js

import { parseBool } from '../utils/parsers.js';
import { getTodayYMD, parseLocalDate, formatDateISO } from '../utils/dateUtils.js';
import { createAutoInvoiceFromLineItem } from '../services/invoiceService.js';

/**
 * PHASE 3: Emisión de facturas automáticas para line items con facturacion_automatica=true.
 * 
 * Lógica:
 * - Verificar que el DEAL tenga facturacion_activa=true
 * - Filtrar line items con facturacion_automatica=true
 * - Para cada line item, verificar si hoy es la fecha de facturación
 * - Si corresponde facturar HOY, emitir la factura automáticamente
 * - También procesa el flag "facturar_ahora" (disparo inmediato)
 * - Aplicar idempotencia: no duplicar facturas existentes
 * 
 * @param {Object} params
 * @param {Object} params.deal - Deal de HubSpot
 * @param {Array} params.lineItems - Line Items del Deal
 * @returns {Object} { invoicesEmitted, errors }
 */
export async function runPhase3({ deal, lineItems }) {
  const dealId = String(deal.id || deal.properties?.hs_object_id);
  const dp = deal.properties || {};
  const today = getTodayYMD();
  
  console.log(`   [Phase3] Hoy: ${today}`);
  console.log(`   [Phase3] Total line items: ${lineItems.length}`);
  
  // Verificar si el DEAL tiene facturacion_activa=true
  const dealFacturacionActiva = parseBool(dp.facturacion_activa);
  console.log(`   [Phase3] Deal facturacion_activa: ${dp.facturacion_activa} (parsed=${dealFacturacionActiva})`);
  
  if (!dealFacturacionActiva) {
    console.log(`   [Phase3] ⚠️  Deal NO tiene facturacion_activa=true, saltando Phase 3`);
    return { invoicesEmitted: 0, errors: [] };
  }
  
  let invoicesEmitted = 0;
  const errors = [];
  
  // Filtrar line items elegibles para facturación automática
  const autoLineItems = (lineItems || []).filter((li) => {
    const lp = li?.properties || {};
    const facturacionAutomatica = parseBool(lp.facturacion_automatica);
    
    return facturacionAutomatica;
  });
  
  console.log(`   [Phase3] Line items AUTOMÁTICOS (facturacion_automatica=true): ${autoLineItems.length}`);
  
  if (autoLineItems.length === 0) {
    console.log(`   [Phase3] No hay line items para facturación automática`);
    return { invoicesEmitted: 0, errors: [] };
  }
  
  for (const li of autoLineItems) {
    const lineItemId = String(li.id || li.properties?.hs_object_id);
    const lp = li.properties || {};
    const liName = lp.name || `LI ${lineItemId}`;
    
    console.log(`   [Phase3] Analizando: ${liName} (${lineItemId})`);
    
    try {
      // Verificar si ya tiene factura
      if (lp.of_invoice_id) {
        console.log(`      🔄 Ya tiene factura: ${lp.of_invoice_id} (idempotencia)`);
        continue;
      }
      
      // Verificar disparo manual (facturar_ahora)
      const facturarAhora = parseBool(lp.facturar_ahora);
      
      if (facturarAhora) {
        console.log(`      ⚡ FACTURAR AHORA activado, emitiendo factura inmediata...`);
        const result = await createAutoInvoiceFromLineItem(deal, li, today);
        
        if (result.created) {
          invoicesEmitted++;
          console.log(`      ✅ Factura creada: ${result.invoiceId}`);
        } else {
          console.log(`      🔄 Factura ya existía: ${result.invoiceId}`);
        }
        
        // Resetear flag facturar_ahora
        try {
          await resetFacturarAhoraFlag(lineItemId);
          console.log(`      🔄 Flag facturar_ahora reseteado`);
        } catch (e) {
          console.warn(`      ⚠️  No se pudo resetear facturar_ahora`);
        }
        
        continue;
      }
      
      // Verificar si hoy es día de facturación
      const nextBillingDate = getNextBillingDate(lp);
      
      if (!nextBillingDate) {
        console.log(`      ⚠️  Sin próxima fecha de facturación, saltando...`);
        continue;
      }
      
      if (nextBillingDate === today) {
        console.log(`      💰 ¡HOY ES DÍA DE FACTURACIÓN! (${today})`);
        const result = await createAutoInvoiceFromLineItem(deal, li, today);
        
        if (result.created) {
          invoicesEmitted++;
          console.log(`      ✅ Factura creada: ${result.invoiceId}`);
        } else {
          console.log(`      🔄 Factura ya existía: ${result.invoiceId}`);
        }
      } else {
        console.log(`      📅 Próxima facturación: ${nextBillingDate} (no es hoy)`);
      }
    } catch (err) {
      console.error(`      ❌ Error procesando:`, err?.message || err);
      errors.push({ lineItemId, error: err?.message || 'Error desconocido' });
    }
  }
  
  return { invoicesEmitted, errors };
}

/**
 * Obtiene la próxima fecha de facturación de un line item.
 * Busca en recurringbillingstartdate y fecha_2, fecha_3, ..., fecha_24.
 * Devuelve la fecha más cercana >= hoy.
 */

function getNextBillingDate(lineItemProps) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const allDates = [];
  
  // 1) Verificar todas las variantes de la fecha de inicio
  const startDate = lineItemProps.hs_recurring_billing_start_date ||  // ✅ AGREGADO: nombre con guiones
                    lineItemProps.recurringbillingstartdate || 
                    lineItemProps.fecha_inicio_de_facturacion;
  if (startDate) {
    const d = parseLocalDate(startDate);
    if (d) {
      allDates.push(d);
    }
  }
  
  // 2) Buscar en fecha_2, fecha_3, ..., fecha_24
  for (let i = 2; i <= 24; i++) {
    const dateKey = `fecha_${i}`;
    const dateValue = lineItemProps[dateKey];
    if (dateValue) {
      const d = parseLocalDate(dateValue);
      if (d) {
        allDates.push(d);
      }
    }
  }
  
  if (allDates.length === 0) {
    return null;
  }
  
  // 3) Filtrar solo fechas >= hoy
  const futureDates = allDates.filter(d => d >= today);
  
  if (futureDates.length === 0) {
    return null; // Todas las fechas son pasadas
  }
  
  // 4) Ordenar y devolver la más cercana
  futureDates.sort((a, b) => a.getTime() - b.getTime());
  return formatDateISO(futureDates[0]);
}

/**
 * Resetea el flag facturar_ahora a false después de procesar.
 */
async function resetFacturarAhoraFlag(lineItemId) {
  const { hubspotClient } = await import('../hubspotClient.js');
  await hubspotClient.crm.lineItems.basicApi.update(lineItemId, {
    properties: { facturar_ahora: 'false' },
  });
  console.log(`[Phase3] Flag facturar_ahora reseteado para line item ${lineItemId}`);
}