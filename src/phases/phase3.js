// src/phases/phase3.js

import { parseBool } from '../utils/parsers.js';
import { getTodayYMD, parseLocalDate, formatDateISO } from '../utils/dateUtils.js';
import { createAutoInvoiceFromLineItem } from '../services/invoiceService.js';
import { createAutoBillingTicket, updateTicket } from '../services/tickets/ticketService.js';
import { hubspotClient } from '../hubspotClient.js';
import { safeString } from '../utils/parsers.js';
import { generateInvoiceKey } from '../utils/idempotency.js';

/**
 * PHASE 3: Emisión de facturas automáticas para line items con facturacion_automatica=true
 * + Crea SIEMPRE el ticket en pipeline AUTOMÁTICOS (trazabilidad)
 *
 * Reglas:
 * - Si deal.facturacion_activa != true: no hace nada
 * - Solo procesa line items con facturacion_automatica == true
 * - Si line item ya tiene of_invoice_id: no emite factura (idempotencia), pero asegura ticket
 * - Si facturar_ahora == true: crea ticket->factura->asocia of_invoice_id al ticket->resetea flag
 * - Si nextBillingDate == hoy: crea ticket->factura->asocia of_invoice_id al ticket
 */
export async function runPhase3({ deal, lineItems }) {
  const dealId = String(deal.id || deal.properties?.hs_object_id);
  const dp = deal.properties || {};
  const today = getTodayYMD();

  console.log(`   [Phase3] start`, { dealId, today, lineItems: (lineItems || []).length });

  // Gate principal
  const dealFacturacionActiva = parseBool(dp.facturacion_activa);
  if (!dealFacturacionActiva) {
    console.log(`   [Phase3] Deal facturacion_activa != true. Skip.`);
    return { invoicesEmitted: 0, ticketsEnsured: 0, errors: [] };
    }

  let invoicesEmitted = 0;
    let ticketsEnsured = 0;
  const errors = [];

  // Solo automáticos
  const autoLineItems = (lineItems || []).filter((li) => {
    const lp = li?.properties || {};
    return parseBool(lp.facturacion_automatica);
  });

  console.log(`   [Phase3] autoLineItems=${autoLineItems.length}`);

for (const li of autoLineItems) {
  const lineItemId = String(li.id || li.properties?.hs_object_id);
  const lp = li.properties || {};
  const liName = lp.name || `LI ${lineItemId}`;

  console.log(`   [Phase3] Processing ${liName}`, { lineItemId });

  try {
    const facturarAhora = parseBool(lp.facturar_ahora);
    
    // ✅ CRITICAL FIX: billingPeriodDate is ALWAYS nextBillingDate
    // facturar_ahora changes WHEN we invoice (today), NOT which period
    const billingPeriodDate = getNextBillingDate(lp);

    console.log(`   [Phase3] 🔑 billingPeriodDate: ${billingPeriodDate || 'NULL'}, facturarAhora: ${facturarAhora}, today: ${today}`);

    if (!billingPeriodDate) {
      console.log(`      [Phase3] no billing period date => skip`);
      continue;
    }

    // 2) FACTURAR AHORA (urgente)
    if (facturarAhora) {
      console.log(`      [Phase3] ⚡ URGENT BILLING`);
      console.log(`         ticketKey: ${dealId}::LI:${lineItemId}::${billingPeriodDate}`);
      console.log(`         invoiceKey: ${dealId}::${lineItemId}::${billingPeriodDate}`);
      console.log(`         invoice_date: ${today} (urgent)`);

      // ✅ Ticket with PERIOD date (NOT today)
      const { ticketId, created } = await createAutoBillingTicket(deal, li, billingPeriodDate);
      if (ticketId) {
        ticketsEnsured++;
        
        // ✅ Mark ticket as urgent
        await updateTicket(ticketId, {
          of_facturacion_urgente: 'true',
          of_fecha_facturacion: today,  // When ordered
          fecha_de_resolucion_esperada: today,  // Process today
        });
        
        console.log(`      [Phase3] ticket ${created ? 'created' : 'reused'}: ${ticketId}`);
      }

      // Delegar a ticketService para facturación automática (único camino autorizado)
      console.log('[Phase3] delegating to createAutoBillingTicket (ticket is source of truth, no direct invoice)');
      const ticketResult = await createAutoBillingTicket(deal, li, billingPeriodDate);
      console.log('[Phase3] ticketService.createAutoBillingTicket result:', ticketResult);
      // Reset flag
      await resetFacturarAhoraFlag(lineItemId);
      console.log(`      [Phase3] facturar_ahora reset`);
      continue;
    }

    // 3) Facturación programada: solo si la próxima fecha == hoy
    if (billingPeriodDate !== today) {
      console.log(`      [Phase3] billingPeriodDate (${billingPeriodDate}) != today (${today}) => skip`);
      continue;
    }

    console.log(`      [Phase3] 📅 SCHEDULED BILLING TODAY`);
    console.log(`         ticketKey: ${dealId}::LI:${lineItemId}::${billingPeriodDate}`);
    console.log(`         invoiceKey: ${dealId}::${lineItemId}::${billingPeriodDate}`);

    // Ticket primero
    const { ticketId } = await createAutoBillingTicket(deal, li, billingPeriodDate);
    if (ticketId) ticketsEnsured++;
    console.log(`      [Phase3] ticket ok: ${ticketId}`);

    // Delegar a ticketService para facturación automática (único camino autorizado)
    console.log('[Phase3] delegating to createAutoBillingTicket (ticket is source of truth, no direct invoice)');
    const ticketResult = await createAutoBillingTicket(deal, li, billingPeriodDate);
    console.log('[Phase3] ticketService.createAutoBillingTicket result:', ticketResult);
  } catch (err) {
    console.error(`      [Phase3] error:`, err?.message || err);
    errors.push({ dealId, lineItemId, error: err?.message || 'Unknown error' });
  }
}

  console.log(`   [Phase3] done`, { dealId, invoicesEmitted, ticketsEnsured, errors: errors.length });  return { invoicesEmitted, ticketsEnsured, errors };}

/**
 * Resetea el flag facturar_ahora a false después de procesar.
 */
async function resetFacturarAhoraFlag(lineItemId) {
  await hubspotClient.crm.lineItems.basicApi.update(String(lineItemId), {
    properties: { facturar_ahora: 'false' },
  });
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
  const startDate = lineItemProps.hs_recurring_billing_start_date ||
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