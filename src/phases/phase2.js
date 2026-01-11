// src/phases/phase2.js

import { parseBool } from '../utils/parsers.js';
import { getTodayYMD, parseLocalDate, diffDays, formatDateISO } from '../utils/dateUtils.js';
import { MANUAL_TICKET_LOOKAHEAD_DAYS } from '../config/constants.js';
import { createManualBillingTicket } from '../services/tickets/manualTicketService.js';

/**
 * PHASE 2: Generación de tickets manuales para line items con facturacion_automatica!=true.
 * 
 * Lógica:
 * - Verificar que el DEAL tenga facturacion_activa=true
 * - Filtrar line items con facturacion_automatica!=true (false, null, undefined)
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
  const dp = deal.properties || {};
  const today = getTodayYMD();
  
  console.log(`   [Phase2] Hoy: ${today}`);
  console.log(`   [Phase2] Lookahead: ${MANUAL_TICKET_LOOKAHEAD_DAYS} días (hasta ${calculateLookaheadDate(today, MANUAL_TICKET_LOOKAHEAD_DAYS)})`);
  console.log(`   [Phase2] Total line items: ${lineItems.length}`);
  
  // Verificar si el DEAL tiene facturacion_activa=true
  const dealFacturacionActiva = parseBool(dp.facturacion_activa);
  console.log(`   [Phase2] Deal facturacion_activa: ${dp.facturacion_activa} (parsed=${dealFacturacionActiva})`);
  
  if (!dealFacturacionActiva) {
    console.log(`   [Phase2] ⚠️  Deal NO tiene facturacion_activa=true, saltando Phase 2`);
    return { ticketsCreated: 0, errors: [] };
  }
  
  let ticketsCreated = 0;
  const errors = [];
  
  // Filtrar line items elegibles para tickets manuales
  // Condición: facturacion_automatica !== true (puede ser false, null, undefined)
  const manualLineItems = (lineItems || []).filter((li) => {
    const lp = li?.properties || {};
    const facturacionAutomaticaRaw = lp.facturacion_automatica;
    
    // Solo incluir si facturacion_automatica NO es true (ni booleano ni string)
    const isManual = facturacionAutomaticaRaw !== true && facturacionAutomaticaRaw !== 'true';
    
    console.log(`   [Phase2] LI ${li.id}: facturacion_automatica=${facturacionAutomaticaRaw} → es manual: ${isManual}`);
    
    return isManual;
  });
  
  console.log(`   [Phase2] Line items MANUALES (facturacion_automatica!=true): ${manualLineItems.length}`);
  
  if (manualLineItems.length === 0) {
    console.log(`   [Phase2] No hay line items para tickets manuales`);
    return { ticketsCreated: 0, errors: [] };
  }
  
  for (const li of manualLineItems) {
    const lineItemId = String(li.id || li.properties?.hs_object_id);
    const lp = li.properties || {};
    const liName = lp.name || `LI ${lineItemId}`;
    
    console.log(`\n   [Phase2] Analizando: ${liName} (${lineItemId})`);
    console.log(`      facturacion_automatica: ${lp.facturacion_automatica || 'undefined/null'}`);
    console.log(`      recurringbillingstartdate: ${lp.recurringbillingstartdate || 'undefined'}`);
    console.log(`      hs_recurring_billing_start_date: ${lp.hs_recurring_billing_start_date || 'undefined'}`);
    console.log(`      fecha_inicio_de_facturacion: ${lp.fecha_inicio_de_facturacion || 'undefined'}`);
    console.log(`      fecha_2: ${lp.fecha_2 || 'undefined'}, fecha_3: ${lp.fecha_3 || 'undefined'}, fecha_4: ${lp.fecha_4 || 'undefined'}`);
    
    try {
      // Obtener la próxima fecha de facturación
      const nextBillingDate = getNextBillingDate(lp);
      
      console.log(`      → getNextBillingDate retornó: ${nextBillingDate}`);
      
      if (!nextBillingDate) {
        console.log(`      ⚠️  Sin próxima fecha de facturación, saltando...`);
        continue;
      }
      
      console.log(`      Próxima fecha encontrada: ${nextBillingDate}`);
      
      // Verificar si la fecha está dentro del lookahead (30 días)
      const daysUntilBilling = diffDays(today, nextBillingDate);
      
      if (daysUntilBilling === null) {
        console.log(`      ⚠️  No se pudo calcular días hasta facturación, saltando...`);
        continue;
      }
      
      if (daysUntilBilling < 0) {
        // Fecha pasada, no crear ticket
        console.log(`      📅 Fecha pasada (${nextBillingDate}), saltando...`);
        continue;
      }
      
      if (daysUntilBilling > MANUAL_TICKET_LOOKAHEAD_DAYS) {
        // Fecha muy lejana, esperar
        console.log(`      📅 Fecha ${nextBillingDate} en ${daysUntilBilling} días (fuera de lookahead de ${MANUAL_TICKET_LOOKAHEAD_DAYS} días)`);
        continue;
      }
      
      // Crear ticket (está dentro del lookahead)
      console.log(`      🎫 ¡DENTRO DEL LOOKAHEAD! Creando ticket...`);
      console.log(`      Fecha: ${nextBillingDate}, faltan ${daysUntilBilling} días`);
      
      const result = await createManualBillingTicket(deal, li, nextBillingDate);
      
      if (result.created) {
        ticketsCreated++;
        console.log(`      ✅ Ticket creado: ${result.ticketId}`);
      } else {
        console.log(`      🔄 Ticket ya existía: ${result.ticketId} (idempotencia)`);
      }
    } catch (err) {
      console.error(`      ❌ Error procesando:`, err?.message || err);
      errors.push({ lineItemId, error: err?.message || 'Error desconocido' });
    }
  }
  
  console.log(`\n   ✅ Phase 2 completada: ${ticketsCreated} tickets creados, ${errors.length} errores`);
  
  return { ticketsCreated, errors };
}

/**
 * Calcula la fecha límite del lookahead para mostrar en logs
 */
function calculateLookaheadDate(today, days) {
  const date = parseLocalDate(today);
  if (!date) return 'N/A';
  date.setDate(date.getDate() + days);
  return formatDateISO(date);
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