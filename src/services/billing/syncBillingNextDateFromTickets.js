// src/services/billing/syncBillingNextDateFromTickets.js

import { hubspotClient } from '../../hubspotClient.js';
import { FORECAST_TICKET_STAGES } from '../../config/constants.js'; // Set combinado manual+auto
import { etapaUnicaEnabled } from '../../config/etapaUnicaFlags.js';
import { isTicketEngineManaged } from '../../utils/ticketFrontera.js';
import logger from '../../../lib/logger.js';
import { reportHubSpotError } from '../../utils/hubspotErrorCollector.js';

/**
 * Deriva billing_next_date del ticket NO NOTIFICADO más próximo del line item.
 *
 * TANDA C — es la fecha PRÓXIMA del plan (§2.5). Lo que cambia con
 * ETAPA_UNICA_ENABLED es la PARTICIÓN: de «etapa forecast» a «todavía no
 * notificado», que bajo la llave incluye «Próximos a facturar». Sin eso, con
 * todo el cronograma en la etapa única no queda ningún candidato y la fecha se
 * CONGELA (la salva el guard de abajo, que evita vaciarla, pero deja de avanzar).
 *
 * Reglas:
 *   - Solo tickets que el motor todavía maneja (flag OFF: stages FORECAST_*
 *     manual o automático — idéntico a hoy)
 *   - fecha_resolucion_esperada > todayYmd
 *   - fecha_resolucion_esperada > lastTicketedYmd (si existe; con la llave
 *     prendida el que llega acá es el piso NOTIFICADO)
 *   - Toma el mínimo (más cercano al futuro)
 *   - Si no hay ninguno → billing_next_date = ''
 *   - Solo escribe si el valor cambió (diff antes del PATCH)
 *
 * @param {object}   opts
 * @param {string}   opts.lineItemId
 * @param {Array}    opts.allTickets          - tickets ya traídos por Phase P (findTicketsByLineItemKey)
 * @param {string}   opts.todayYmd            - YYYY-MM-DD
 * @param {string}   [opts.lastTicketedYmd]   - YYYY-MM-DD o vacío
 * @param {string}   [opts.currentBillingNextDate] - valor actual en HubSpot (para diff)
 *
 * @returns {Promise<{ updated: boolean, oldValue: string, newValue: string }>}
 */
export async function syncBillingNextDateFromTickets({
  lineItemId,
  allTickets,
  todayYmd,
  lastTicketedYmd = '',
  currentBillingNextDate = '',
}) {
  const log = logger.child({ module: 'syncBillingNextDateFromTickets', lineItemId });

  // 1. Filtrar: solo NO notificado, solo futuro, solo mayor al piso
  const esCandidatoPorEtapa = etapaUnicaEnabled()
    ? (t) => isTicketEngineManaged(t)
    : (t) => FORECAST_TICKET_STAGES.has(String(t?.properties?.hs_pipeline_stage || ''));

  const candidates = (allTickets || []).filter((t) => {
    if (!esCandidatoPorEtapa(t)) return false;

    const fecha = String(t?.properties?.fecha_resolucion_esperada || '').slice(0, 10);
    if (!fecha) return false;
    if (fecha <= todayYmd) return false;
    if (lastTicketedYmd && fecha <= lastTicketedYmd) return false;

    return true;
  });

  // 2. Tomar el mínimo
  candidates.sort((a, b) => {
    const fa = String(a?.properties?.fecha_resolucion_esperada || '').slice(0, 10);
    const fb = String(b?.properties?.fecha_resolucion_esperada || '').slice(0, 10);
    return fa.localeCompare(fb);
  });

const rawNewValue = candidates.length > 0
    ? String(candidates[0].properties.fecha_resolucion_esperada).slice(0, 10)
    : '';

  const oldValue = String(currentBillingNextDate || '').slice(0, 10).trim();

  // ====== GUARD: no borrar billing_next_date si no hay candidatos ======
  // Si candidates=0 puede ser por lag de indexación de HubSpot Search
  // (ticket recién creado por Phase P no aparece aún) o porque todos los
  // forecasts tienen fecha pasada. En cualquier caso, NO borrar el valor
  // existente — recalcFromTickets lo corregirá en el próximo ciclo.
  let newValue = rawNewValue;
  if (!rawNewValue && oldValue) {
    log.debug(
      { oldValue, candidates: candidates.length },
      '[syncBillingNextDateFromTickets] GUARD: no hay candidatos pero existe billing_next_date, protegiendo valor actual'
    );
    return { updated: false, oldValue, newValue: oldValue };
  }

  log.debug(
    {
      candidates: candidates.length,
      oldValue: oldValue || '(vacío)',
      newValue: newValue || '(vacío)',
      lastTicketedYmd: lastTicketedYmd || null,
      todayYmd,
    },
    '[syncBillingNextDateFromTickets] resultado'
  );

  // 3. Noop si no cambió
  if (oldValue === newValue) {
    log.debug('[syncBillingNextDateFromTickets] sin cambio, noop');
    return { updated: false, oldValue, newValue };
  }

  // 4. Escribir
  try {
    await hubspotClient.crm.lineItems.basicApi.update(String(lineItemId), {
      properties: { billing_next_date: newValue },
    });

    log.info(
      { oldValue: oldValue || '(vacío)', newValue: newValue || '(vacío)' },
      '[syncBillingNextDateFromTickets] billing_next_date actualizado'
    );

    return { updated: true, oldValue, newValue };
  } catch (err) {
    const status = err?.response?.status ?? err?.statusCode ?? err?.code ?? null;
    const isTransient = status === 429 || (status !== null && status >= 500);

    log.error(
      { err, lineItemId, newValue },
      '[syncBillingNextDateFromTickets] error al actualizar billing_next_date'
    );

    if (!isTransient) {
      reportHubSpotError({
        objectType: 'line_item',
        objectId: String(lineItemId),
        message: `syncBillingNextDateFromTickets failed: ${err?.message || err}`,
      });
    }

    // No relanzar — es best-effort, no debe romper Phase P
    return { updated: false, oldValue, newValue };
  }
}