// src/webhookQueue.js
import pool, { acquireDealLock, releaseDealLock } from './db.js';
import logger from '../lib/logger.js';
import { processUrgentLineItem, processUrgentTicket } from './services/urgentBillingService.js';
import { hubspotClient, getDealWithLineItems } from './hubspotClient.js';
import { runPhasesForDealLocked } from './phases/index.js';
import { propagateDealCancellation } from './propagacion/deals/cancelDeal.js';
import { processTicketUpdate } from './services/tickets/ticketUpdateService.js';
import { parseBool } from './utils/parsers.js';
import { isDealCancelledStage } from './config/constants.js';
import { reportIfActionable } from './utils/errorReporting.js';

const MODULE = 'webhookQueue';

// ─── Tabla ───────────────────────────────────────────────────────────────────

export async function initWebhookQueueTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS webhook_queue (
      id              SERIAL PRIMARY KEY,
      event_id        TEXT,
      source          TEXT NOT NULL,
      object_type     TEXT NOT NULL,
      object_id       TEXT NOT NULL,
      property_name   TEXT,
      property_value  TEXT,
      deal_id         TEXT,
      owner_id        TEXT,
      action_type     TEXT NOT NULL,
      priority        INTEGER NOT NULL DEFAULT 0,
      status          TEXT NOT NULL DEFAULT 'pending',
      error           TEXT,
      raw_payload     JSONB,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      started_at      TIMESTAMPTZ,
      finished_at     TIMESTAMPTZ
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_wq_status_priority
      ON webhook_queue (status, priority DESC, created_at ASC)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_wq_deal_status
      ON webhook_queue (deal_id, status)
  `);

  logger.info({ module: MODULE }, 'Tabla webhook_queue lista.');
}

// ─── Enqueue ─────────────────────────────────────────────────────────────────

/**
 * Inserta un evento en la cola.
 *
 * @param {Object} params
 * @param {string} params.source         - 'escuchar-cambios' | 'actualizar-webhook'
 * @param {string} params.objectType     - 'line_item' | 'ticket' | 'deal'
 * @param {string} params.objectId
 * @param {string} [params.propertyName]
 * @param {string} [params.propertyValue]
 * @param {string} [params.dealId]       - puede ser null, se resuelve en el worker
 * @param {string} params.actionType     - 'urgent_line_item' | 'urgent_ticket' | 'recalc' | 'ticket_update' | 'deal_cancel'
 * @param {number} [params.priority=0]   - 1 = urgente, 0 = normal
 * @param {string} [params.eventId]
 * @param {Object} [params.rawPayload]
 * @returns {Promise<number>} id del registro insertado
 */
export async function enqueue({
  source,
  objectType,
  objectId,
  propertyName = null,
  propertyValue = null,
  dealId = null,
  ownerId = null,
  actionType,
  priority = 0,
  eventId = null,
  rawPayload = null,
}) {
  const res = await pool.query(
    `INSERT INTO webhook_queue
       (event_id, source, object_type, object_id, property_name, property_value,
        deal_id, action_type, priority, raw_payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id`,
    [
      eventId, source, objectType, objectId,
      propertyName, propertyValue,
      dealId, actionType, priority,
      rawPayload ? JSON.stringify(rawPayload) : null,
    ]
  );

  const id = res.rows[0].id;

  logger.info(
    { module: MODULE, fn: 'enqueue', queueId: id, actionType, objectId, dealId, priority },
    'Evento encolado'
  );

  return id;
}

// ─── Worker ──────────────────────────────────────────────────────────────────

let workerRunning = false;

async function processNext() {
  if (workerRunning) return; // evitar solapamiento si el intervalo es más corto que el procesamiento
  workerRunning = true;

  try {
    // 1) Tomar el pending más prioritario (con lock de fila)
    const pickRes = await pool.query(`
      SELECT *
        FROM webhook_queue
       WHERE status = 'pending'
       ORDER BY priority DESC, created_at ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED
    `);

    if (pickRes.rows.length === 0) return;

    const job = pickRes.rows[0];

    // 2) Deduplicar: si tiene deal_id, marcar como superseded los pending más viejos
    //    del mismo deal + action_type
    if (job.deal_id) {
      const collapsed = await pool.query(
        `UPDATE webhook_queue
            SET status = 'superseded', finished_at = NOW()
          WHERE status = 'pending'
            AND deal_id = $1
            AND action_type = $2
            AND id < $3
          RETURNING id`,
        [job.deal_id, job.action_type, job.id]
      );

      if (collapsed.rowCount > 0) {
        const collapsedIds = collapsed.rows.map(r => r.id);
        logger.info(
          { module: MODULE, fn: 'processNext', jobId: job.id, dealId: job.deal_id, collapsedIds },
          `Colapsados ${collapsed.rowCount} eventos duplicados → superseded`
        );
      }
    }

    // 3) Marcar como processing
    await pool.query(
      `UPDATE webhook_queue SET status = 'processing', started_at = NOW() WHERE id = $1`,
      [job.id]
    );

    logger.info(
      { module: MODULE, fn: 'processNext', jobId: job.id, actionType: job.action_type, objectId: job.object_id, dealId: job.deal_id },
      'Procesando evento de la cola'
    );

    // 4) Ejecutar según action_type
    try {
      const jobResult = await executeJob(job);

      if (jobResult && jobResult.reason === 'deal_locked') {
        // El deal está siendo procesado por el cron u otro worker → reintentar luego
        await pool.query(
          `UPDATE webhook_queue SET status = 'pending', started_at = NULL, created_at = now() WHERE id = $1`,
          [job.id]
        );
        logger.info(
          { module: MODULE, fn: 'processNext', jobId: job.id, actionType: job.action_type, dealId: job.deal_id },
          'Deal ocupado por otro proceso → reencolado para reintento'
        );
      } else {
        await pool.query(
          `UPDATE webhook_queue SET status = 'done', finished_at = NOW() WHERE id = $1`,
          [job.id]
        );
        logger.info(
          { module: MODULE, fn: 'processNext', jobId: job.id, actionType: job.action_type },
          'Evento procesado → done'
        );
      }
    } catch (err) {
      const errorMsg = err?.message || 'Unknown error';

      await pool.query(
        `UPDATE webhook_queue SET status = 'failed', error = $2, finished_at = NOW() WHERE id = $1`,
        [job.id, errorMsg]
      );

      logger.error(
        { module: MODULE, fn: 'processNext', jobId: job.id, actionType: job.action_type, err: errorMsg },
        'Evento procesado → failed'
      );
    }
  } catch (err) {
    // Error a nivel del worker (ej: falla de conexión a DB)
    logger.error({ module: MODULE, fn: 'processNext', err: err?.message }, 'Error en el worker de la cola');
  } finally {
    workerRunning = false;
  }
}

// ─── Ejecución por action_type ───────────────────────────────────────────────

async function executeJob(job) {
  const { action_type, object_id, object_type, deal_id, property_name } = job;

  switch (action_type) {
    case 'urgent_line_item': {
      const result = await processUrgentLineItem(object_id);
      if (result.skipped) {
        logger.info(
          { module: MODULE, fn: 'executeJob', jobId: job.id, reason: result.reason },
          'Facturación urgente de LI skipped'
        );
      } else {
        logger.info(
          { module: MODULE, fn: 'executeJob', jobId: job.id, objectId: object_id, invoiceId: result.invoiceId },
          'Facturación urgente de LI completada'
        );
      }
      return result;
    }

    case 'urgent_ticket': {
      const result = await processUrgentTicket(object_id);
      if (result.skipped) {
        logger.info(
          { module: MODULE, fn: 'executeJob', jobId: job.id, reason: result.reason },
          'Facturación urgente de ticket skipped'
        );
      } else {
        logger.info(
          { module: MODULE, fn: 'executeJob', jobId: job.id, objectId: object_id, invoiceId: result.invoiceId },
          'Facturación urgente de ticket completada'
        );
      }
      return result;
    }

    case 'recalc': {
      // Resetear flag "actualizar" al inicio (como hacía processRecalculation)
      if (property_name === 'actualizar' && object_type === 'line_item') {
        try {
          await hubspotClient.crm.lineItems.basicApi.update(String(object_id), {
            properties: { actualizar: false },
          });
        } catch (err) {
          logger.warn(
            { module: MODULE, fn: 'executeJob', jobId: job.id, objectId: object_id, err: err?.message },
            'No se pudo resetear "actualizar" al inicio'
          );
          reportIfActionable({
            objectType: 'line_item', objectId: object_id,
            message: 'No se pudo resetear "actualizar" al inicio (queue)', err,
          });
        }
      }

      // Resolver dealId si no vino
      let resolvedDealId = deal_id;
      if (!resolvedDealId && object_type === 'line_item') {
        resolvedDealId = await getDealIdForLineItem(object_id);
        if (!resolvedDealId) {
          throw new Error(`No se encontró deal asociado al line item ${object_id}`);
        }
        // Guardar dealId resuelto en la fila para visibilidad
        await pool.query(
          `UPDATE webhook_queue SET deal_id = $2 WHERE id = $1`,
          [job.id, resolvedDealId]
        );
      }

      // Verificar facturación activa
      const deal = await hubspotClient.crm.deals.basicApi.getById(String(resolvedDealId), [
        'facturacion_activa', 'dealname', 'hubspot_owner_id',
      ]);
      const dealProps = deal?.properties || {};

// Guardar owner_id en la fila para visibilidad
      if (dealProps.hubspot_owner_id) {
        await pool.query(
          `UPDATE webhook_queue SET owner_id = $2 WHERE id = $1`,
          [job.id, dealProps.hubspot_owner_id]
        );
      }

      const active = parseBool(dealProps.facturacion_activa);

      if (!active) {
        logger.info(
          { module: MODULE, fn: 'executeJob', jobId: job.id, dealId: resolvedDealId },
          'Deal con facturación inactiva, skip'
        );
        return { skipped: true, reason: 'facturacion_inactiva' };
      }

      // Delay defensivo (mismo que tenía processRecalculation)
      const RECALC_DELAY_MS = Number(process.env.RECALC_DELAY_MS ?? 5000);
      if (RECALC_DELAY_MS > 0) {
        await new Promise(r => setTimeout(r, RECALC_DELAY_MS));
      }

      const dealWithLineItems = await getDealWithLineItems(resolvedDealId);
      const billingResult = await runPhasesForDealLocked(dealWithLineItems, 'webhook_queue');
      logger.info(
        {
          module: MODULE, fn: 'executeJob', jobId: job.id,
          dealId: resolvedDealId,
          dealName: dealProps.dealname || 'Sin nombre',
          ticketsCreated: billingResult.ticketsCreated || 0,
          invoicesEmitted: billingResult.autoInvoicesEmitted || 0,
        },
        'Recalculación completada'
      );

      // Resetear flag post-flujo
      if (property_name === 'actualizar' && object_type === 'line_item') {
        try {
          await hubspotClient.crm.lineItems.basicApi.update(String(object_id), {
            properties: { actualizar: false },
          });
        } catch (err) {
          logger.error(
            { module: MODULE, fn: 'executeJob', jobId: job.id, objectId: object_id, err: err?.message },
            "Error reseteando 'actualizar' post-flujo"
          );
          reportIfActionable({
            objectType: 'line_item', objectId: object_id,
            message: "Error reseteando 'actualizar' post-flujo (queue)", err,
          });
        }
      }

      return billingResult;
    }

    case 'ticket_update': {
      const result = await processTicketUpdate(object_id);

      logger.info(
        { module: MODULE, fn: 'executeJob', jobId: job.id, objectId: object_id, propertiesCount: result.propertiesCount },
        'Ticket update completado'
      );

      // Resetear flag "actualizar" en el ticket
      try {
        await hubspotClient.crm.tickets.basicApi.update(String(object_id), {
          properties: { actualizar: false },
        });
      } catch (err) {
        logger.error(
          { module: MODULE, fn: 'executeJob', jobId: job.id, objectId: object_id, err: err?.message },
          "Error reseteando 'actualizar' en ticket"
        );
        reportIfActionable({
          objectType: 'ticket', objectId: object_id,
          message: "Error reseteando 'actualizar' en ticket (queue)", err,
        });
      }

      return result;
    }

    case 'deal_cancel': {
      const dealId = String(object_id);

      // Tomar el lock del deal (el mismo candado que usan cron y recalc). Si está
      // ocupado, devolver deal_locked → processNext lo reencola para reintento.
      const token = await acquireDealLock(dealId, 'webhook_deal_cancel');
      if (!token) {
        return { reason: 'deal_locked' };
      }

      try {
        const { deal, lineItems } = await getDealWithLineItems(dealId);

        // Re-verificar contra el estado ACTUAL: entre el evento y este momento el
        // deal pudo volver a un stage activo. Si ya no está cancelado, no
        // propagamos (evita desactivar facturación por un evento viejo).
        if (!isDealCancelledStage(deal?.properties?.dealstage)) {
          logger.info(
            { module: MODULE, fn: 'executeJob', jobId: job.id, dealId, dealStage: deal?.properties?.dealstage },
            'deal_cancel: el deal ya no está en stage cancelado, skip'
          );
          return { skipped: true, reason: 'stage_no_longer_cancelled' };
        }

        await propagateDealCancellation({
          dealId,
          dealProps: deal.properties,
          lineItems: Array.isArray(lineItems) ? lineItems : [],
        });

        logger.info(
          { module: MODULE, fn: 'executeJob', jobId: job.id, dealId, dealStage: deal?.properties?.dealstage },
          'deal_cancel: cancelación propagada'
        );
        return { cancelled: true };
      } finally {
        await releaseDealLock(dealId, token);
      }
    }

    default:
      throw new Error(`action_type desconocido: ${action_type}`);
  }
}

// ─── Helper: resolver dealId desde line item ─────────────────────────────────

async function getDealIdForLineItem(lineItemId) {
  const resp = await hubspotClient.crm.associations.v4.basicApi.getPage(
    'line_items',
    String(lineItemId),
    'deals',
    100
  );
  const dealIds = (resp.results || [])
    .map(r => String(r.toObjectId))
    .filter(Boolean);
  return dealIds.length ? dealIds[0] : null;
}

// ─── Health check (para healthAudit.js) ──────────────────────────────────────

/**
 * Revisa el estado de la cola de webhooks.
 * - Eventos 'failed' en las últimas 24h → warn
 * - Eventos 'pending' con más de 10 minutos de antigüedad → warn (worker posiblemente trabado)
 *
 * @returns {Promise<Object>} { status, failed, stale }
 */
export async function checkWebhookQueue() {
  const result = { status: 'ok', failed: {}, stale: {} };

  // Eventos failed en las últimas 24h
  const failedRes = await pool.query(`
    SELECT id, action_type, object_id, deal_id, error, created_at, finished_at
      FROM webhook_queue
     WHERE status = 'failed'
       AND finished_at >= NOW() - INTERVAL '24 hours'
     ORDER BY finished_at DESC
     LIMIT 10
  `);

  result.failed.count = failedRes.rowCount;
  if (failedRes.rowCount > 0) {
    result.failed.events = failedRes.rows.map(r => ({
      id: r.id,
      actionType: r.action_type,
      objectId: r.object_id,
      dealId: r.deal_id,
      error: r.error,
      failedAt: r.finished_at,
    }));
    result.status = 'warn';
  }

  // Eventos pending con más de 10 minutos (worker posiblemente trabado)
  const staleRes = await pool.query(`
    SELECT COUNT(*)::int AS count,
           MIN(created_at) AS oldest
      FROM webhook_queue
     WHERE status = 'pending'
       AND created_at < NOW() - INTERVAL '10 minutes'
  `);

  const staleCount = staleRes.rows[0]?.count || 0;
  result.stale.count = staleCount;
  if (staleCount > 0) {
    result.stale.oldest = staleRes.rows[0].oldest;
    result.status = 'warn';
  }

  return result;
}

// ─── Start / Stop ────────────────────────────────────────────────────────────

let workerInterval = null;

/**
 * Inicia el worker que procesa la cola cada `intervalMs` milisegundos.
 * @param {number} [intervalMs=2000]
 */
export function startWorker(intervalMs = 2000) {
  if (workerInterval) {
    logger.warn({ module: MODULE }, 'Worker ya estaba corriendo, ignorando startWorker duplicado');
    return;
  }

  workerInterval = setInterval(processNext, intervalMs);
  logger.info({ module: MODULE, intervalMs }, 'Worker de webhook_queue iniciado');
}

/**
 * Detiene el worker (útil para graceful shutdown).
 */
export function stopWorker() {
  if (workerInterval) {
    clearInterval(workerInterval);
    workerInterval = null;
    logger.info({ module: MODULE }, 'Worker de webhook_queue detenido');
  }
}