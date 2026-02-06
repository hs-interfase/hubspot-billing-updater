// src/phases/phase3.js

import { parseBool } from '../utils/parsers.js';
import { getTodayYMD } from '../utils/dateUtils.js';
import { createAutoBillingTicket, updateTicket } from '../services/tickets/ticketService.js';
import { resolvePlanYMD } from '../utils/resolvePlanYMD.js';

// ✅ RENOMBRADO: ahora contamos por line_item_key (identidad estable)
import { countCanonicalTicketsForLineItemKey } from '../services/tickets/ticketService.js';

/**
 * PHASE 3: Emisión de facturas automáticas para line items con facturacion_automatica=true
 * + Crea SIEMPRE el ticket en pipeline AUTOMÁTICOS (trazabilidad)
 *
 * Reglas:
 * - Si deal.facturacion_activa != true: no hace nada
 * - Solo procesa line items con facturacion_automatica == true
 * - Si facturar_ahora == true: delega a createAutoBillingTicket y luego marca ticket como urgente
 * - Si billingPeriodDate == hoy: delega a createAutoBillingTicket
 *
 * Nota:
 * - NO reseteamos facturar_ahora acá porque createAutoBillingTicket ya resetea triggers en su finally.
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

  let invoicesEmitted = 0; // (por ahora no lo alimentamos acá)
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

      const billingPeriodDate = resolvePlanYMD({
        lineItemProps: lp,
        context: { flow: 'PHASE3', dealId, lineItemId },
      });

      console.log(
        `   [Phase3] 🔑 billingPeriodDate(planYMD): ${billingPeriodDate || 'NULL'}, facturarAhora: ${facturarAhora}, today: ${today}`
      );

      if (!billingPeriodDate) {
        console.log(`      [Phase3] no billing period date => skip`);
        continue;
      }

      // ✅ Limitar por número de pagos (si aplica) usando line_item_key
      const totalPaymentsRaw = lp.hs_recurring_billing_number_of_payments ?? lp.number_of_payments;
      const totalPayments = totalPaymentsRaw ? Number(totalPaymentsRaw) : 0;

      if (totalPayments > 0) {
        const lineItemKey = lp.line_item_key ? String(lp.line_item_key).trim() : '';

        if (!lineItemKey) {
          console.log(
            `⚠️ line_item_key vacío para LI ${lineItemId}; no se puede aplicar límite de pagos. (Phase1 debería setearlo)`
          );
        } else {
          const issued = await countCanonicalTicketsForLineItemKey({ dealId, lineItemKey });
          if (issued >= totalPayments) {
            console.log(
              `⚠️ Pagos emitidos (${issued}) ≥ total pagos (${totalPayments}) para LI ${lineItemId}, se omite ticket`
            );
            continue;
          }
        }
      }

      // 2) FACTURAR AHORA (urgente)
      if (facturarAhora) {
        console.log(`      [Phase3] ⚡ URGENT BILLING`);
        console.log('[Phase3] delegating to createAutoBillingTicket');

        const ticketResult = await createAutoBillingTicket(deal, li, billingPeriodDate);
        console.log('[Phase3] ticketService.createAutoBillingTicket result:', ticketResult);

        if (ticketResult?.ticketId) {
          ticketsEnsured++;

          // ✅ Mark ticket as urgent (best-effort)
          try {
            await updateTicket(ticketResult.ticketId, {
              of_facturacion_urgente: 'true',
              of_fecha_de_facturacion: today,
            });
            console.log(`      [Phase3] ticket urgent marked: ${ticketResult.ticketId}`);
          } catch (e) {
            console.warn(
              `      [Phase3] ⚠️ could not mark ticket urgent (${ticketResult.ticketId}):`,
              e?.message || e
            );
          }
        }

        continue;
      }

      // 3) Facturación programada: solo si la próxima fecha == hoy
      if (billingPeriodDate !== today) {
        console.log(`      [Phase3] billingPeriodDate (${billingPeriodDate}) != today (${today}) => skip`);
        continue;
      }

      console.log(`      [Phase3] 📅 SCHEDULED BILLING TODAY`);
      console.log('[Phase3] delegating to createAutoBillingTicket');

      const ticketResult = await createAutoBillingTicket(deal, li, billingPeriodDate);
      console.log('[Phase3] ticketService.createAutoBillingTicket result:', ticketResult);

      if (ticketResult?.ticketId) {
        ticketsEnsured++;
        console.log(`      [Phase3] ticket ok: ${ticketResult.ticketId}`);
      }
    } catch (err) {
      console.error(`      [Phase3] error:`, err?.message || err);
      errors.push({ dealId, lineItemId, error: err?.message || 'Unknown error' });
    }
  }

  console.log(`   [Phase3] done`, { dealId, invoicesEmitted, ticketsEnsured, errors: errors.length });
  return { invoicesEmitted, ticketsEnsured, errors };
}
