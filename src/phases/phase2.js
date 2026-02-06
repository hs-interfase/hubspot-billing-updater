// src/phases/phase2.js

import { parseBool } from '../utils/parsers.js';
import { getTodayYMD, parseLocalDate, diffDays, formatDateISO } from '../utils/dateUtils.js';
import { MANUAL_TICKET_LOOKAHEAD_DAYS } from '../config/constants.js';
import { createManualBillingTicket } from '../services/tickets/manualTicketService.js';
import { resolvePlanYMD } from '../utils/resolvePlanYMD.js';

// ✅ RENOMBRADO: ahora contamos por line_item_key (identidad estable)
import { countCanonicalTicketsForLineItemKey } from '../services/tickets/ticketService.js';

/**
 * PHASE 2: Generación de tickets manuales para line items con facturacion_automatica!=true.
 *
 * Lógica:
 * - Verificar que el DEAL tenga facturacion_activa=true
 * - Filtrar line items con facturacion_automatica!=true (false, null, undefined)
 * - Para cada line item, buscar la próxima fecha de facturación
 * - Si la fecha está dentro de los próximos X días (LOOKAHEAD), crear ticket
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
  console.log(
    `   [Phase2] Lookahead: ${MANUAL_TICKET_LOOKAHEAD_DAYS} días (hasta ${calculateLookaheadDate(
      today,
      MANUAL_TICKET_LOOKAHEAD_DAYS
    )})`
  );
  console.log(`   [Phase2] Total line items: ${lineItems.length}`);

  // Verificar si el DEAL tiene facturacion_activa=true
  const dealFacturacionActiva = parseBool(dp.facturacion_activa);
  console.log(
    `   [Phase2] Deal facturacion_activa: ${dp.facturacion_activa} (parsed=${dealFacturacionActiva})`
  );

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

    console.log(
      `   [Phase2] LI ${li.id}: facturacion_automatica=${facturacionAutomaticaRaw} → es manual: ${isManual}`
    );

    return isManual;
  });

  console.log(
    `   [Phase2] Line items MANUALES (facturacion_automatica!=true): ${manualLineItems.length}`
  );

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

    try {
      // Obtener la próxima fecha de facturación (FUENTE: billing_next_date si existe)
      const persistedNext = (lp.billing_next_date ?? '').toString().slice(0, 10);

      const planYMD = resolvePlanYMD({
        lineItemProps: lp,
        context: { flow: 'PHASE2', dealId, lineItemId },
      });

      console.log(
        `      → planYMD: ${planYMD || 'null'} (persisted billing_next_date=${persistedNext || 'null'})`
      );

      const nextBillingDate = planYMD; // en Phase2 “planYMD” ES la fecha que ticketear

      if (!nextBillingDate) {
        console.log(`      ⚠️  Sin próxima fecha de facturación, saltando...`);
        continue;
      }

      console.log(`      Próxima fecha encontrada: ${nextBillingDate}`);

      // Verificar si la fecha está dentro del lookahead
      const daysUntilBilling = diffDays(today, nextBillingDate);

      if (daysUntilBilling === null) {
        console.log(`      ⚠️  No se pudo calcular días hasta facturación, saltando...`);
        continue;
      }

      if (daysUntilBilling < 0) {
        console.log(`      📅 Fecha pasada (${nextBillingDate}), saltando...`);
        continue;
      }

      if (daysUntilBilling > MANUAL_TICKET_LOOKAHEAD_DAYS) {
        console.log(
          `      📅 Fecha ${nextBillingDate} en ${daysUntilBilling} días (fuera de lookahead de ${MANUAL_TICKET_LOOKAHEAD_DAYS} días)`
        );
        continue;
      }

      // Crear ticket (está dentro del lookahead)
      console.log(`      🎫 ¡DENTRO DEL LOOKAHEAD! Creando ticket...`);
      console.log(`      Fecha: ${nextBillingDate}, faltan ${daysUntilBilling} días`);

      // Número total de pagos configurado (string o número)
      const totalPaymentsRaw = lp.hs_recurring_billing_number_of_payments ?? lp.number_of_payments;
      const totalPayments = totalPaymentsRaw ? Number(totalPaymentsRaw) : 0;

      if (totalPayments > 0) {
        // ✅ NUEVO: identidad estable por line_item_key
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

// LEGACY (migración): usa startDate + fecha_2..fecha_24.
// Fuente de verdad nueva: lineItemProps.billing_next_date (priorizada arriba).

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
  const startDate =
    lineItemProps.hs_recurring_billing_start_date ||
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
  const futureDates = allDates.filter((d) => d >= today);

  if (futureDates.length === 0) {
    return null;
  }

  // 4) Ordenar y devolver la más cercana
  futureDates.sort((a, b) => a.getTime() - b.getTime());
  return formatDateISO(futureDates[0]);
}
