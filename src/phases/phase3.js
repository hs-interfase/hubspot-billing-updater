// src/phases/phase3.js

import { parseBool } from '../utils/parsers.js';
import { getTodayYMD, parseLocalDate, formatDateISO } from '../utils/dateUtils.js';
import { createAutoInvoiceFromLineItem } from '../services/invoiceService.js';

/**
 * PHASE 3: Emisión de facturas automáticas para line items con facturacion_automatica=true.
 * 
 * Lógica:
 * - Filtrar line items con facturacion_activa=true y facturacion_automatica=true
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
  const today = getTodayYMD();
  
  console.log(`   [Phase3] Hoy: ${today}`);
  console.log(`   [Phase3] Total line items: ${lineItems.length}`);
  
  let invoicesEmitted = 0;
  const errors = [];
  
  // Filtrar line items elegibles para facturación automática
  const autoLineItems = (lineItems || []).filter((li) => {
    const lp = li?.properties || {};
    const facturacionActiva = parseBool(lp.facturacion_activa);
    const facturacionAutomatica = parseBool(lp.facturacion_automatica);
    
    return facturacionActiva && facturacionAutomatica;
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
 */
function getNextBillingDate(lineItemProps) {
  const startDate = lineItemProps.hs_recurring_billing_start_date || lineItemProps.fecha_inicio_de_facturacion;
  
  if (startDate) {
    const date = parseLocalDate(startDate);
    if (date) {
      return formatDateISO(date);
    }
  }
  
  // Buscar en fechas extras (fecha_2, fecha_3, ...)
  const today = new Date();
  const extraDates = [];
  
  for (let i = 2; i <= 24; i++) {
    const dateKey = `fecha_${i}`;
    const dateValue = lineItemProps[dateKey];
    if (dateValue) {
      const d = parseLocalDate(dateValue);
      if (d && d >= today) {
        extraDates.push(d);
      }
    }
  }
  
  if (extraDates.length > 0) {
    extraDates.sort((a, b) => a.getTime() - b.getTime());
    return formatDateISO(extraDates[0]);
  }
  
  return null;
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
