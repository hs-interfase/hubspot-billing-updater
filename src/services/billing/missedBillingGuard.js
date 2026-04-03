// src/services/billing/missedBillingGuard.js
//
// Guard de "missed billings": detecta tickets automáticos cuya fecha de
// facturación ya pasó pero nunca tuvieron factura emitida, e intenta
// recuperarlos.
//
// Cuándo se llama:
//   - Desde phase3.js, al inicio del loop de cada line item automático,
//     ANTES de procesar el día de hoy.
//
// Lógica (Modo A — conservador):
//   1. Para cada fecha del lookback (D-1 … D-N):
//      a. Construye el ticketKey esperado para ese ymd.
//      b. Busca el ticket en HubSpot.
//      c. Si no existe → solo logger.warn (Phase P no lo creó, no es nuestro).
//      d. Si existe pero YA tiene of_invoice_id → resuelto, skip.
//      e. Si existe SIN factura → "missed billing":
//         - Si está en FORECAST_AUTO_STAGE → promueve a READY.
//         - Intenta emitir la factura via createInvoiceFromTicket.
//         - Escribe of_billing_error en el ticket (sobreescribe).
//         - Si falla → también llama reportHubSpotError.
//
// Acumulación de of_billing_error:
//   - Dentro de la MISMA corrida del job: si un ticket ya tenía un error
//     guardado por un intento anterior en el MISMO día de hoy, se acumula
//     (append) para no perder contexto.
//   - Si el error guardado es de un día ANTERIOR a hoy: se sobreescribe.

import { hubspotClient } from '../../hubspotClient.js';
import { buildTicketKeyFromLineItemKey } from '../../utils/ticketKey.js';
import { createInvoiceFromTicket, REQUIRED_TICKET_PROPS } from '../invoiceService.js';
import { reportHubSpotError } from '../../utils/hubspotErrorCollector.js';
import { recalcFromTickets } from '../lineItems/recalcFromTickets.js';
import {
  FORECAST_AUTO_STAGES,
  BILLING_AUTOMATED_READY,
} from '../../config/constants.js';
import logger from '../../../lib/logger.js';

// ─── Constante configurable por env ──────────────────────────────────────────
const DEFAULT_LOOKBACK_DAYS = Number(process.env.BILLING_RETRY_LOOKBACK_DAYS ?? 7);

// ─── Retry con backoff exponencial para llamadas HubSpot ─────────────────────

/**
 * Ejecuta `fn` reintentando si HubSpot responde 429 (rate limit por segundo).
 *
 * @param {() => Promise<any>} fn        Función async a ejecutar
 * @param {Object}             [opts]
 * @param {number}             [opts.maxRetries=4]     Intentos máximos (1 original + 4 reintentos)
 * @param {number}             [opts.baseDelayMs=1000] Delay base en ms (se duplica con cada intento)
 * @param {string}             [opts.label='']         Etiqueta para el log
 */
async function withHubSpotRetry(fn, { maxRetries = 4, baseDelayMs = 1000, label = '' } = {}) {
  let attempt = 0;

  while (true) {
    try {
      return await fn();
    } catch (err) {
      const is429 = err?.code === 429 ||
                    err?.response?.status === 429 ||
                    String(err?.message).includes('429');

      if (!is429 || attempt >= maxRetries) {
        throw err;
      }

      attempt++;
      const delayMs = baseDelayMs * Math.pow(2, attempt - 1); // 1s, 2s, 4s, 8s

      logger.warn(
        { module: 'missedBillingGuard', label, attempt, maxRetries, delayMs },
        `HubSpot 429 rate limit, reintentando en ${delayMs}ms (intento ${attempt}/${maxRetries})`
      );

      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
}

// ─── Helpers locales ─────────────────────────────────────────────────────────

/**
 * Resta `days` días a un string YYYY-MM-DD y devuelve el resultado en el mismo
 * formato. Opera en UTC puro para evitar ambigüedades de DST.
 */
function subtractDays(ymd, days) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - days);
  return dt.toISOString().slice(0, 10);
}

/**
 * Busca un ticket por su of_ticket_key. Devuelve el primer resultado o null.
 * Recupera las propiedades mínimas necesarias para el guard.
 */
async function findTicketByKey(ticketKey) {
  const body = {
    filterGroups: [
      {
        filters: [
          { propertyName: 'of_ticket_key', operator: 'EQ', value: String(ticketKey) },
        ],
      },
    ],
    properties: [
      'hs_pipeline',
      'hs_pipeline_stage',
      'of_ticket_key',
      'of_line_item_key',
      'of_deal_id',
      'of_invoice_id',
      'of_billing_error',
      'of_billing_error_at',
    ],
    limit: 2,
  };

  const resp = await withHubSpotRetry(
    () => hubspotClient.crm.tickets.searchApi.doSearch(body),
    { label: `findTicketByKey:${ticketKey}` }
  );

  return (resp?.results || [])[0] ?? null;
}

/**
 * Promueve un ticket a BILLING_AUTOMATED_READY.
 */
async function promoteToReady(ticketId) {
  await withHubSpotRetry(
    () => hubspotClient.crm.tickets.basicApi.update(String(ticketId), {
      properties: { hs_pipeline_stage: String(BILLING_AUTOMATED_READY) },
    }),
    { label: `promoteToReady:${ticketId}` }
  );
}

/**
 * Escribe of_billing_error en el ticket.
 *
 * Regla de acumulación:
 *   - Si el error existente fue guardado HOY (mismo "today") → append.
 *   - Si es de un día anterior, o no existe → sobreescribe.
 *
 * @param {string} ticketId
 * @param {string} newMessage        Mensaje a escribir (ya recortado si hace falta)
 * @param {string} today             YYYY-MM-DD de hoy (para comparar)
 * @param {Object} existingProps     properties actuales del ticket
 */
async function writeBillingError(ticketId, newMessage, today, existingProps) {
  const existingError   = String(existingProps?.of_billing_error ?? '').trim();
  const existingErrorAt = String(existingProps?.of_billing_error_at ?? '').trim();

  let errorDate = '';
  if (existingErrorAt && /^\d+$/.test(existingErrorAt)) {
    errorDate = new Date(Number(existingErrorAt)).toISOString().slice(0, 10);
  }

  const isSameDay = errorDate === today;
  const finalMessage = (isSameDay && existingError)
    ? `${existingError}\n${newMessage}`.slice(0, 500)
    : newMessage.slice(0, 500);

  const nowMillis = String(Date.now());

  try {
    await withHubSpotRetry(
      () => hubspotClient.crm.tickets.basicApi.update(String(ticketId), {
        properties: {
          of_billing_error:    finalMessage,
          of_billing_error_at: nowMillis,
        },
      }),
      { label: `writeBillingError:${ticketId}` }
    );

    logger.info(
      { module: 'missedBillingGuard', ticketId, isSameDay },
      `of_billing_error ${isSameDay ? 'acumulado' : 'sobreescrito'} en ticket`
    );
  } catch (err) {
    // Best-effort: si falla la escritura del error no queremos romper el flujo.
    logger.error(
      { module: 'missedBillingGuard', ticketId, err },
      'No se pudo escribir of_billing_error en ticket'
    );
  }
}

// ─── Función principal exportada ─────────────────────────────────────────────

/**
 * Revisa los últimos `lookbackDays` días para un line item automático y
 * reintenta cualquier facturación que no haya sido emitida.
 *
 * @param {Object} params
 * @param {string} params.dealId
 * @param {string} params.lineItemId
 * @param {string} params.lineItemKey
 * @param {string} params.today          YYYY-MM-DD — fecha de hoy
 * @param {number} [params.lookbackDays] Días hacia atrás a revisar (default: 3)
 *
 * @returns {Promise<{ checked: number, retried: number, recovered: number, failed: number }>}
 */
export async function checkMissedBillingsForLineItem({
  dealId,
  lineItemId,
  lineItemKey,
  today,
  lookbackDays = DEFAULT_LOOKBACK_DAYS,
}) {
  const stats = { checked: 0, retried: 0, recovered: 0, failed: 0 };

  if (!lineItemKey) {
    logger.warn(
      { module: 'missedBillingGuard', dealId, lineItemId },
      'lineItemKey vacío, saltando guard'
    );
    return stats;
  }

  for (let i = 1; i <= lookbackDays; i++) {
    const ymd = subtractDays(today, i);
    stats.checked++;

    const ticketKey = buildTicketKeyFromLineItemKey(dealId, lineItemKey, ymd);

    // ── 1. Buscar ticket ──────────────────────────────────────────────────────
    let ticket;
    try {
      ticket = await findTicketByKey(ticketKey);
    } catch (err) {
      logger.error(
        { module: 'missedBillingGuard', dealId, lineItemId, ymd, ticketKey, err },
        'Error buscando ticket en lookback, continuando con siguiente fecha'
      );
      continue;
    }

    if (!ticket) {
      logger.debug(
        { module: 'missedBillingGuard', dealId, lineItemId, ymd, ticketKey },
        'MISSED_BILLING_NO_TICKET: no existe ticket forecast para fecha pasada'
      );
      continue;
    }

    const tp        = ticket.properties ?? {};
    const ticketId  = String(ticket.id);
    const hasInvoice = !!tp.of_invoice_id;

    // ── 2. ¿Ya tiene factura? → resuelto ────────────────────────────────────
    if (hasInvoice) {
      logger.debug(
        { module: 'missedBillingGuard', dealId, lineItemId, ymd, ticketId },
        'Período ya tiene factura emitida, ok'
      );
      continue;
    }

    // ── 3. Missed billing detectado ──────────────────────────────────────────
    stats.retried++;
    const currentStage = String(tp.hs_pipeline_stage ?? '');
    const isInForecast = FORECAST_AUTO_STAGES.has(currentStage);

    logger.warn(
      { module: 'missedBillingGuard', dealId, lineItemId, ymd, ticketId, currentStage, isInForecast },
      `MISSED_BILLING: ticket sin factura detectado para fecha ${ymd}`
    );

    try {
      // ── 3a. Promover a READY si hace falta ──────────────────────────────
      if (isInForecast) {
        await promoteToReady(ticketId);
        logger.info(
          { module: 'missedBillingGuard', dealId, lineItemId, ymd, ticketId },
          'Ticket promovido a READY para reintento'
        );
      }

      // ── 3b. Obtener ticket completo y emitir factura ─────────────────────
      const fullTicket = await withHubSpotRetry(
        () => hubspotClient.crm.tickets.basicApi.getById(ticketId, REQUIRED_TICKET_PROPS),
        { label: `getById:${ticketId}` }
      );
      await createInvoiceFromTicket(fullTicket, 'AUTO_LINEITEM', null, { skipRefetch: true });

      // ── 3c. Registrar el evento de reintento exitoso en of_billing_error ─
      const successMsg =
        `MISSED_BILLING: se esperaba facturar el ${ymd} (auto). ` +
        `Reintento ejecutado el ${today}. ` +
        `dealId=${dealId} lik=${lineItemKey} ticketId=${ticketId}.`;

      await writeBillingError(ticketId, successMsg, today, tp);

// DESPUÉS:
      stats.recovered++;
      logger.info(
        { module: 'missedBillingGuard', dealId, lineItemId, ymd, ticketId },
        successMsg
      );

      // Recalc fechas del line item desde tickets reales (post-facturación recuperada)
      try {
        await recalcFromTickets({
          lineItemKey,
          dealId,
          lineItemId,
          lineItemProps: null,
          facturacionActiva: true,
          applyUpdate: true,
        });
      } catch (recalcErr) {
        logger.warn(
          { module: 'missedBillingGuard', dealId, lineItemId, lineItemKey, err: recalcErr },
          'recalcFromTickets falló post-recovery, no bloquea flujo'
        );
      }

    } catch (err) {
      // ── 3d. Reintento fallido ────────────────────────────────────────────
      stats.failed++;

      const failMsg =
        `MISSED_BILLING_FAILED: se esperaba facturar el ${ymd} (auto). ` +
        `Reintento el ${today} también falló. ` +
        `dealId=${dealId} lik=${lineItemKey} ticketId=${ticketId}. ` +
        `error=${String(err?.message ?? err).slice(0, 120)}`;

      logger.error(
        { module: 'missedBillingGuard', dealId, lineItemId, ymd, ticketId, err },
        failMsg
      );

      await writeBillingError(ticketId, failMsg, today, tp);

      reportHubSpotError({
        objectType: 'ticket',
        objectId:   ticketId,
        message:    failMsg,
      });
    }
  }

  logger.info(
    { module: 'missedBillingGuard', dealId, lineItemId, lookbackDays, ...stats },
    'Guard de missed billings completado'
  );

  return stats;
}