// src/phases/phase3.js

import { parseBool } from '../utils/parsers.js';
import { getTodayYMD, parseLocalDate, formatDateISO } from '../utils/dateUtils.js';
import { createAutoInvoiceFromLineItem } from '../services/invoiceService.js';
import { createAutoBillingTicket, updateTicket } from '../services/ticketService.js';
import { hubspotClient } from '../hubspotClient.js';

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
    return { invoicesEmitted: 0, errors: [] };
  }

  let invoicesEmitted = 0;
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
      const existingInvoiceId = lp.of_invoice_id;
      const facturarAhora = parseBool(lp.facturar_ahora);
      const nextBillingDate = getNextBillingDate(lp); // YYYY-MM-DD o null

      // 1) Si ya tiene factura => no emitir. Pero asegurar ticket (siempre con una fecha razonable)
      if (existingInvoiceId) {
        console.log(`      [Phase3] idempotency: already has invoice`, { existingInvoiceId });

        const targetDate = nextBillingDate || today;
        try {
          await createAutoBillingTicket(deal, li, targetDate);
          console.log(`      [Phase3] ensured auto ticket`, { targetDate });
        } catch (e) {
          console.warn(`      [Phase3] could not ensure auto ticket`, e?.message);
        }
        continue;
      }

      // 2) FACTURAR AHORA (en automático)
      if (facturarAhora) {
        console.log(`      [Phase3] facturar_ahora=true => ticket->invoice`);

        // Ticket primero (siempre)
        const { ticketId } = await createAutoBillingTicket(deal, li, today);
        console.log(`      [Phase3] auto ticket ok`, { ticketId, targetDate: today });

        // Luego factura
        const result = await createAutoInvoiceFromLineItem(deal, li, today);
        if (result?.created) {
          invoicesEmitted++;
          console.log(`      [Phase3] invoice created`, { invoiceId: result.invoiceId });
        } else {
          console.log(`      [Phase3] invoice existed`, { invoiceId: result?.invoiceId });
        }

        // Asociar invoice -> ticket
        if (ticketId && result?.invoiceId) {
          await updateTicket(ticketId, { of_invoice_id: result.invoiceId });
          console.log(`      [Phase3] ticket updated with invoice`, { ticketId, invoiceId: result.invoiceId });
        }

        // Reset flag (para no repetir)
        await resetFacturarAhoraFlag(lineItemId);
        console.log(`      [Phase3] facturar_ahora reset`, { lineItemId });

        continue;
      }

      // 3) Facturación programada: solo si la próxima fecha == hoy
      if (!nextBillingDate) {
        console.log(`      [Phase3] no next billing date => skip`);
        continue;
      }

      if (nextBillingDate !== today) {
        console.log(`      [Phase3] nextBillingDate != today => skip`, { nextBillingDate });
        continue;
      }

      console.log(`      [Phase3] scheduled billing today => ticket->invoice`, { nextBillingDate });

      // Ticket primero
      const { ticketId } = await createAutoBillingTicket(deal, li, nextBillingDate);
      console.log(`      [Phase3] auto ticket ok`, { ticketId, targetDate: nextBillingDate });

      // Factura
      const result = await createAutoInvoiceFromLineItem(deal, li, today);
      if (result?.created) {
        invoicesEmitted++;
        console.log(`      [Phase3] invoice created`, { invoiceId: result.invoiceId });
      } else {
        console.log(`      [Phase3] invoice existed`, { invoiceId: result?.invoiceId });
      }

      // Asociar invoice -> ticket
      if (ticketId && result?.invoiceId) {
        await updateTicket(ticketId, { of_invoice_id: result.invoiceId });
        console.log(`      [Phase3] ticket updated with invoice`, { ticketId, invoiceId: result.invoiceId });
      }
    } catch (err) {
      console.error(`      [Phase3] error`, err?.message || err);
      errors.push({ dealId, lineItemId, error: err?.message || 'Unknown error' });
    }
  }

  console.log(`   [Phase3] done`, { dealId, invoicesEmitted, errors: errors.length });
  return { invoicesEmitted, errors };
}

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