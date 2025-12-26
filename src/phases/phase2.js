// src/phases/phase2.js

import { parseBool } from '../utils/parsers.js';
import { getTodayYMD, parseLocalDate, diffDays, formatDateISO } from '../utils/dateUtils.js';
import { MANUAL_TICKET_LOOKAHEAD_DAYS } from '../config/constants.js';
import { createManualBillingTicket } from '../services/ticketService.js';

/**
 * PHASE 2: Generación de tickets manuales para line items con facturacion_automatica=false.
 * 
 * Lógica:
 * - Filtrar line items con facturacion_activa=true y facturacion_automatica=false
 * - Para cada line item, buscar la próxima fecha de facturación
 * - Si la fecha está dentro de los próximos 30 días (LOOKAHEAD), crear ticket
 * - Aplicar idempotencia: no duplicar tickets existentes
 * 
 * @param {Object} params
 * @param {Object} params.deal - Deal de HubSpot
 * @param {Array} params.lineItems - Line Items del Deal
 * @returns {Object} { ticketsCreated, errors }
 */
export async function runPhase2({ deal, lineItems }) {
  const dealId = String(deal.id || deal.properties?.hs_object_id);
  const today = getTodayYMD();
  
  console.log(`   [Phase2] Hoy: ${today}`);
  console.log(`   [Phase2] Total line items: ${lineItems.length}`);
  
  let ticketsCreated = 0;
  const errors = [];
  
  // Filtrar line items elegibles para tickets manuales
  const manualLineItems = (lineItems || []).filter((li) => {
    const lp = li?.properties || {};
    const facturacionActiva = parseBool(lp.facturacion_activa);
    const facturacionAutomatica = parseBool(lp.facturacion_automatica);
    
    return facturacionActiva && !facturacionAutomatica;
  });
  
  console.log(`   [Phase2] Line items MANUALES (facturacion_automatica=false): ${manualLineItems.length}`);
  
  if (manualLineItems.length === 0) {
    console.log(`   [Phase2] No hay line items para tickets manuales`);
    return { ticketsCreated: 0, errors: [] };
  }
  
  for (const li of manualLineItems) {
    const lineItemId = String(li.id || li.properties?.hs_object_id);
    const lp = li.properties || {};
    const liName = lp.name || `LI ${lineItemId}`;
    
    console.log(`   [Phase2] Analizando: ${liName} (${lineItemId})`);
    
    try {
      // Obtener la próxima fecha de facturación
      const nextBillingDate = getNextBillingDate(lp);
      
      if (!nextBillingDate) {
        console.log(`      ⚠️  Sin próxima fecha de facturación, saltando...`);
        continue;
      }
      
      // Verificar si la fecha está dentro del lookahead (30 días)
      const daysUntilBilling = diffDays(today, nextBillingDate);
      
      if (daysUntilBilling === null || daysUntilBilling < 0) {
        // Fecha pasada, no crear ticket
        console.log(`      📅 Fecha pasada (${nextBillingDate}), saltando...`);
        continue;
      }
      
      if (daysUntilBilling > MANUAL_TICKET_LOOKAHEAD_DAYS) {
        // Fecha muy lejana, esperar
        console.log(`      📅 Fecha ${nextBillingDate} en ${daysUntilBilling} días (fuera de lookahead de ${MANUAL_TICKET_LOOKAHEAD_DAYS} días)`);
        continue;
      }
      
      // Crear ticket
      console.log(`      🎫 Creando ticket: fecha ${nextBillingDate}, faltan ${daysUntilBilling} días`);
      const result = await createManualBillingTicket(deal, li, nextBillingDate);
      
      if (result.created) {
        ticketsCreated++;
        console.log(`      ✅ Ticket creado: ${result.ticketId}`);
      } else {
        console.log(`      🔄 Ticket ya existía: ${result.ticketId} (idempotencia)`);
      }
    } catch (err) {
      console.error(`[Phase2] Error procesando line item ${lineItemId}:`, err?.message || err);
      errors.push({ lineItemId, error: err?.message || 'Error desconocido' });
    }
  }
  
  console.log(`[Phase2] Completado: ${ticketsCreated} tickets creados, ${errors.length} errores`);
  
  return { ticketsCreated, errors };
}

/**
 * Obtiene la próxima fecha de facturación de un line item.
 * Prioriza: hs_recurring_billing_start_date o fecha_inicio_de_facturacion.
 * Si no existe, devuelve null.
 */
function getNextBillingDate(lineItemProps) {
  // Intentar con las propiedades estándar
  const startDate = lineItemProps.hs_recurring_billing_start_date || lineItemProps.fecha_inicio_de_facturacion;
  
  if (startDate) {
    const date = parseLocalDate(startDate);
    if (date) {
      return formatDateISO(date);
    }
  }
  
  // Si tienes fechas adicionales (fecha_2, fecha_3, ...), buscar la más próxima en el futuro
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
    // Ordenar y devolver la más cercana
    extraDates.sort((a, b) => a.getTime() - b.getTime());
    return formatDateISO(extraDates[0]);
  }
  
  return null;
}
