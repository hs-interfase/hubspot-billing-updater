// src/phases/phase3.js

import { hubspotClient } from '../hubspotClient.js';
import { parseBool } from '../utils/parsers.js';
import { getTodayYMD } from '../utils/dateUtils.js';
import { resolvePlanYMD } from '../utils/resolvePlanYMD.js';
import { updateTicket } from '../services/tickets/ticketService.js';

/**
 * PHASE 3 (AUTOMÁTICO):
 * - Requiere deal.facturacion_activa=true
 * - Solo procesa line items con facturacion_automatica == true
 *
 * Nuevo contrato (con Phase P):
 * - Phase 3 NO crea tickets.
 * - Phase 3 PROMUEVE el ticket forecast (AUTOMATED_FORECAST_*) a READY cuando corresponde,
 *   y luego delega a la lógica existente (la que crea invoice / mueve estados según factura).
 *
 * Reglas acordadas:
 * - Urgente (facturar_ahora==true): promover ticket forecast del planYMD a READY (si existe) y marcar urgente.
 * - Programado: solo si planYMD === HOY → promover a READY.
 *
 * Idempotencia:
 * - Ticket se identifica por of_ticket_key = dealId::LIK::YYYY-MM-DD
 * - Si no existe el ticket forecast, se loggea error (Phase P debería haberlo creado).
 */

// ====== STAGES (IDs reales) ======
const BILLING_AUTOMATED_READY = '1228755520';

// Auto forecast stages por bucket deal stage
const BILLING_AUTOMATED_FORECAST_25 = '1294745999';
const BILLING_AUTOMATED_FORECAST_50 = '1294746000';
const BILLING_AUTOMATED_FORECAST_75 = '1296489840';
const BILLING_AUTOMATED_FORECAST_95 = '1296362566';

const FORECAST_AUTO_STAGES = new Set([
  BILLING_AUTOMATED_FORECAST_25,
  BILLING_AUTOMATED_FORECAST_50,
  BILLING_AUTOMATED_FORECAST_75,
  BILLING_AUTOMATED_FORECAST_95,
]);

function buildTicketKey(dealId, lineItemKey, ymd) {
  return `${String(dealId)}::${String(lineItemKey)}::${String(ymd)}`;
}

function resolveDealBucket(dealstage) {
  const s = String(dealstage || '');
  if (s === 'decisionmakerboughtin') return '50';
  if (s === 'contractsent') return '75';
  if (s === 'closedwon') return '95';
  return '25'; // 5/10/25
}

function resolveAutoForecastStageForDealStage(dealstage) {
  const b = resolveDealBucket(dealstage);
  if (b === '50') return BILLING_AUTOMATED_FORECAST_50;
  if (b === '75') return BILLING_AUTOMATED_FORECAST_75;
  if (b === '95') return BILLING_AUTOMATED_FORECAST_95;
  return BILLING_AUTOMATED_FORECAST_25;
}

async function findTicketByTicketKey(ticketKey) {
  const body = {
    filterGroups: [
      {
        filters: [{ propertyName: 'of_ticket_key', operator: 'EQ', value: String(ticketKey) }],
      },
    ],
    properties: [
      'hs_pipeline_stage',
      'of_ticket_key',
      'fecha_resolucion_esperada',
      'of_line_item_key',
      'of_deal_id',
    ],
    limit: 2,
  };

  const resp = await hubspotClient.crm.tickets.searchApi.doSearch(body);
  return (resp?.results || [])[0] || null;
}

async function moveTicketToStage(ticketId, stageId) {
  return hubspotClient.crm.tickets.basicApi.update(String(ticketId), {
    properties: { hs_pipeline_stage: String(stageId) },
  });
}

/**
 * Promueve un ticket forecast automático a READY.
 * - No crea ticket.
 * - Solo mueve si está en forecast auto (cualquiera), idealmente el esperado por dealstage.
 */
async function promoteAutoForecastTicketToReady({ dealId, dealStage, lineItemKey, billingYMD }) {
  if (!lineItemKey) return { moved: false, reason: 'missing_line_item_key' };

  const ticketKey = buildTicketKey(dealId, lineItemKey, billingYMD);
  const t = await findTicketByTicketKey(ticketKey);

  if (!t) {
    return { moved: false, reason: 'missing_forecast_ticket', ticketKey };
  }

  const currentStage = String(t?.properties?.hs_pipeline_stage || '');

  // Si no está en forecast auto, NO tocar (puede ser real, o manual por error)
  if (!FORECAST_AUTO_STAGES.has(currentStage)) {
    return { moved: false, reason: `not_auto_forecast_stage:${currentStage}`, ticketId: t.id };
  }

  // Validación suave (log)
  const expectedForecastStage = resolveAutoForecastStageForDealStage(dealStage);
  if (currentStage !== expectedForecastStage) {
    await moveTicketToStage(t.id, BILLING_AUTOMATED_READY);
    return {
      moved: true,
      ticketId: t.id,
      reason: `moved_from_unexpected_forecast_stage:${currentStage}_expected:${expectedForecastStage}`,
    };
  }

  await moveTicketToStage(t.id, BILLING_AUTOMATED_READY);
  return { moved: true, ticketId: t.id };
}

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

  let invoicesEmitted = 0; // (si tu pipeline/servicio incrementa esto, podés conectarlo después)
  let ticketsEnsured = 0;  // (ahora significa "tickets promovidos a READY")
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
        `   [Phase3] 🔑 planYMD: ${billingPeriodDate || 'NULL'}, facturarAhora: ${facturarAhora}, today: ${today}`
      );

      if (!billingPeriodDate) {
        console.log(`      [Phase3] no planYMD => skip`);
        continue;
      }

      const lineItemKey = lp.line_item_key ? String(lp.line_item_key).trim() : '';
      if (!lineItemKey) {
        console.log(`      ⚠️ line_item_key vacío para LI ${lineItemId}; Phase1 debería setearlo. Skip.`);
        continue;
      }

      // 1) FACTURAR AHORA (urgente): promover a READY y marcar urgente
      if (facturarAhora) {
        console.log(`      [Phase3] ⚡ URGENT BILLING (promote forecast → READY)`);

        const promoted = await promoteAutoForecastTicketToReady({
          dealId,
          dealStage: dp.dealstage,
          lineItemKey,
          billingYMD: billingPeriodDate,
        });

        if (promoted.moved) {
          ticketsEnsured++;
          console.log(`      [Phase3] ✅ Ticket promovido a READY: ${promoted.ticketId}`);

          // ✅ Best-effort: marcar urgente
          try {
            await updateTicket(promoted.ticketId, {
              of_facturacion_urgente: 'true',
              of_fecha_de_facturacion: today,
            });
            console.log(`      [Phase3] ticket urgent marked: ${promoted.ticketId}`);
          } catch (e) {
            console.warn(
              `      [Phase3] ⚠️ could not mark ticket urgent (${promoted.ticketId}):`,
              e?.message || e
            );
          }
        } else {
          console.log(
            `      [Phase3] 🔄 No se promovió: ${promoted.reason} (${promoted.ticketId || promoted.ticketKey || 'sin ticket'})`
          );
          if (promoted.reason === 'missing_forecast_ticket') {
            errors.push({ dealId, lineItemId, error: `Missing forecast ticket for ${promoted.ticketKey}` });
          }
        }

        continue;
      }

      // 2) Facturación programada: SOLO si planYMD === HOY
      if (billingPeriodDate !== today) {
        console.log(`      [Phase3] planYMD (${billingPeriodDate}) != today (${today}) => skip`);
        continue;
      }

      console.log(`      [Phase3] 📅 SCHEDULED BILLING TODAY (promote forecast → READY)`);

      const promoted = await promoteAutoForecastTicketToReady({
        dealId,
        dealStage: dp.dealstage,
        lineItemKey,
        billingYMD: billingPeriodDate,
      });

      if (promoted.moved) {
        ticketsEnsured++;
        console.log(`      [Phase3] ✅ Ticket promovido a READY: ${promoted.ticketId}`);
      } else {
        console.log(
          `      [Phase3] 🔄 No se promovió: ${promoted.reason} (${promoted.ticketId || promoted.ticketKey || 'sin ticket'})`
        );
        if (promoted.reason === 'missing_forecast_ticket') {
          errors.push({ dealId, lineItemId, error: `Missing forecast ticket for ${promoted.ticketKey}` });
        }
      }

      // NOTA:
      // En tu sistema actual, el paso "READY → emitir invoice" ocurre en otro flujo
      // (ej. un handler o servicio que observa el stage READY y crea la factura / mueve a CREATED).
      // Por contrato, Phase3 solo promueve a READY cuando corresponde.
    } catch (err) {
      console.error(`      [Phase3] error:`, err?.message || err);
      errors.push({ dealId, lineItemId, error: err?.message || 'Unknown error' });
    }
  }

  console.log(`   [Phase3] done`, { dealId, invoicesEmitted, ticketsEnsured, errors: errors.length });
  return { invoicesEmitted, ticketsEnsured, errors };
}
