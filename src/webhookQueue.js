// src/webhookQueue.js
import pool, { acquireDealLock, releaseDealLock } from './db.js';
import logger from '../lib/logger.js';
import { sendAlert } from '../lib/alertService.js';
import { processUrgentTicket } from './services/urgentBillingService.js';
import { hubspotClient, getDealWithLineItems } from './hubspotClient.js';
import { runPhasesForDealLocked } from './phases/index.js';
import { propagateDealCancellation } from './propagacion/deals/cancelDeal.js';
import { processTicketUpdate } from './services/tickets/ticketUpdateService.js';
import { processCancelTicketRequest } from './services/tickets/cancelTicketRequest.js';
import { processRevertTicketRequest } from './services/tickets/revertTicketInvoiceRequest.js';
import { cancelRevertFlowEnabled } from './config/cancelRevertFlags.js';
import { parseBool } from './utils/parsers.js';
import { isDealCancelledStage } from './config/constants.js';
import { reportIfActionable } from './utils/errorReporting.js';
import { reassignLineItemProduct } from './services/billing/nombreProductoSelect.js';
import { syncLineItemPropToTickets } from './services/lineItems/syncLineItemPropToTicket.js';
import { syncDealPropToTickets } from './services/deal/syncDealPropToTicket.js';
import { recalcValorTotal } from './services/deal/recalcValorTotal.js';
import { syncTicketCompanyLabels } from './services/tickets/syncTicketCompanyLabels.js';
import { decideReapAction, clasificarJobRescatado } from './utils/webhookQueueRules.js';

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
      finished_at     TIMESTAMPTZ,
      attempts        INTEGER NOT NULL DEFAULT 0,
      reaped_at       TIMESTAMPTZ
    )
  `);

  // Columnas agregadas después del deploy inicial (tablas ya existentes en Railway)
  await pool.query(`ALTER TABLE webhook_queue ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0`);
  await pool.query(`ALTER TABLE webhook_queue ADD COLUMN IF NOT EXISTS reaped_at TIMESTAMPTZ`);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_wq_status_priority
      ON webhook_queue (status, priority DESC, created_at ASC)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_wq_deal_status
      ON webhook_queue (deal_id, status)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_wq_status_started
      ON webhook_queue (status, started_at)
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
 * @param {string} params.actionType     - 'urgent_ticket' | 'recalc' | 'ticket_update' | 'deal_cancel' | 'product_reassign' | 'li_prop_sync' | 'deal_prop_sync' | 'valor_recalc' | 'ticket_cancel_request' | 'ticket_revert_request' | 'ticket_label_sync'
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

/**
 * Id del job que este proceso está ejecutando ahora mismo (null si ninguno).
 * El reaper lo usa para NO tocar un job que sigue vivo: `processing` viejo solo
 * es huérfano si nadie lo está corriendo.
 * Válido con 1 réplica (el escenario actual). Con varias réplicas habría que
 * mover esto a la fila (worker_id + heartbeat), como hace cronLock.
 */
let currentJobId = null;

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
    currentJobId = job.id;

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
        await alertIfReapedJobLostItsWork(job, jobResult);
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
    currentJobId = null;
    workerRunning = false;
  }
}

// ─── Reaper de jobs huérfanos ────────────────────────────────────────────────

async function alertIfReapedJobLostItsWork(job, jobResult) {
  const veredicto = clasificarJobRescatado(job, jobResult);
  if (!veredicto) return;

  const contexto = {
    module: MODULE, fn: 'alertIfReapedJobLostItsWork',
    jobId: job.id, actionType: job.action_type,
    objectType: job.object_type, objectId: job.object_id,
    dealId: job.deal_id, attempts: job.attempts,
  };

  // El camino de ticket se auto-recupera: alcanza con dejar rastro.
  if (veredicto.severidad === 'warn') {
    logger.warn(contexto, veredicto.mensaje);
    return;
  }

  logger.error(contexto, veredicto.mensaje);

  await sendAlert(veredicto.severidad, veredicto.mensaje, {
    jobId: job.id,
    actionType: job.action_type,
    objectType: job.object_type,
    objectId: job.object_id,
    dealId: job.deal_id,
    detalle: veredicto.detalle,
  }).catch(err =>
    logger.error({ ...contexto, err: err?.message }, 'No se pudo enviar la alerta')
  );
}

/**
 * Devuelve a la cola los jobs que quedaron en `processing` sin nadie corriéndolos
 * (típicamente: redeploy de Railway a mitad de un job). Sin esto quedan huérfanos
 * para siempre y el `facturar_ahora` se pierde sin factura y sin alerta.
 *
 * Se corre al boot (donde por definición nada está en vuelo) y periódicamente,
 * saltando siempre el job que este proceso tiene en la mano.
 *
 * @param {Object} [opts]
 * @param {number} [opts.staleMinutes]  - antigüedad de `started_at` para considerarlo huérfano
 * @param {number} [opts.maxAttempts]   - tras N rescates se marca `failed` en vez de reintentar
 * @returns {Promise<{ requeued: number, failed: number, ids: number[] }>}
 */
export async function reapStaleProcessingJobs({
  staleMinutes = Number(process.env.WEBHOOK_QUEUE_REAP_MINUTES ?? 15),
  maxAttempts = Number(process.env.WEBHOOK_QUEUE_MAX_ATTEMPTS ?? 3),
} = {}) {
  const summary = { requeued: 0, failed: 0, ids: [] };

  const staleRes = await pool.query(
    `SELECT id, attempts, action_type, object_id, deal_id, started_at
       FROM webhook_queue
      WHERE status = 'processing'
        AND started_at < NOW() - ($1 || ' minutes')::interval
        AND ($2::int IS NULL OR id <> $2::int)
      ORDER BY id ASC`,
    [String(staleMinutes), currentJobId]
  );

  for (const job of staleRes.rows) {
    const { status, attempts } = decideReapAction(job, maxAttempts);

    if (status === 'failed') {
      await pool.query(
        `UPDATE webhook_queue
            SET status = 'failed', attempts = $2, reaped_at = NOW(),
                error = $3, finished_at = NOW()
          WHERE id = $1`,
        [job.id, attempts, `Job huérfano: quedó en processing y se rescató ${attempts} veces sin completarse`]
      );
      summary.failed += 1;
    } else {
      await pool.query(
        `UPDATE webhook_queue
            SET status = 'pending', attempts = $2, reaped_at = NOW(),
                started_at = NULL, created_at = NOW()
          WHERE id = $1`,
        [job.id, attempts]
      );
      summary.requeued += 1;
    }

    summary.ids.push(job.id);

    logger.warn(
      {
        module: MODULE, fn: 'reapStaleProcessingJobs',
        jobId: job.id, actionType: job.action_type, objectId: job.object_id,
        dealId: job.deal_id, startedAt: job.started_at, attempts, nuevoEstado: status,
      },
      status === 'failed'
        ? 'Job huérfano superó el máximo de rescates → failed'
        : 'Job huérfano devuelto a pending'
    );
  }

  if (summary.failed > 0) {
    await sendAlert(
      'critical',
      `${summary.failed} job(s) de la cola de webhooks abandonados tras ${maxAttempts} intentos`,
      { jobIds: summary.ids, staleMinutes, maxAttempts }
    ).catch(err =>
      logger.error({ module: MODULE, fn: 'reapStaleProcessingJobs', err: err?.message }, 'No se pudo enviar la alerta')
    );
  }

  if (summary.requeued > 0 || summary.failed > 0) {
    logger.info(
      { module: MODULE, fn: 'reapStaleProcessingJobs', ...summary },
      `Reaper: ${summary.requeued} reencolados, ${summary.failed} abandonados`
    );
  }

  return summary;
}

// ─── Ejecución por action_type ───────────────────────────────────────────────

async function executeJob(job) {
  const { action_type, object_id, object_type, deal_id, property_name, property_value } = job;

  switch (action_type) {
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

    case 'product_reassign': {
      // Split producto 13-jul (D §3): el vendedor cambió el select nombre_producto del LI.
      // Reasociar hs_product_id al producto elegido y, si cambió, re-correr las phases del
      // deal para que producto del ticket / área / emisora / factura se recalculen.
      // Usar el valor del evento (property_value): evita que una corrida de cron que
      // sincronizó nombre_producto←ID en el ínterin pise el cambio deliberado del vendedor.
      const swap = await reassignLineItemProduct(object_id, property_value);
      if (!swap.changed) {
        logger.info(
          { module: MODULE, fn: 'executeJob', jobId: job.id, objectId: object_id, reason: swap.reason, nombre: swap.nombre },
          'product_reassign sin cambio (no se recalcula)'
        );
        return { skipped: true, reason: swap.reason };
      }

      // Resolver dealId si no vino
      let resolvedDealId = deal_id;
      if (!resolvedDealId) {
        resolvedDealId = await getDealIdForLineItem(object_id);
        if (!resolvedDealId) {
          throw new Error(`No se encontró deal asociado al line item ${object_id}`);
        }
        await pool.query(`UPDATE webhook_queue SET deal_id = $2 WHERE id = $1`, [job.id, resolvedDealId]);
      }

      // Verificar facturación activa (mismo criterio que recalc)
      const deal = await hubspotClient.crm.deals.basicApi.getById(String(resolvedDealId), [
        'facturacion_activa', 'dealname', 'hubspot_owner_id',
      ]);
      const dProps = deal?.properties || {};
      if (dProps.hubspot_owner_id) {
        await pool.query(`UPDATE webhook_queue SET owner_id = $2 WHERE id = $1`, [job.id, dProps.hubspot_owner_id]);
      }
      if (!parseBool(dProps.facturacion_activa)) {
        logger.info(
          { module: MODULE, fn: 'executeJob', jobId: job.id, dealId: resolvedDealId },
          'product_reassign: deal con facturación inactiva, producto reasignado sin recalcular'
        );
        return { reassigned: true, recalculated: false, reason: 'facturacion_inactiva', ...swap };
      }

      const dealWithLineItems = await getDealWithLineItems(resolvedDealId);
      const billingResult = await runPhasesForDealLocked(dealWithLineItems, 'webhook_queue');
      logger.info(
        {
          module: MODULE, fn: 'executeJob', jobId: job.id, dealId: resolvedDealId,
          oldProductId: swap.oldId, newProductId: swap.newId, nombre: swap.nombre,
          ticketsCreated: billingResult.ticketsCreated || 0,
        },
        'product_reassign completado (producto reasignado + phases re-corridas)'
      );
      return { reassigned: true, recalculated: true, ...swap, ...billingResult };
    }

    case 'li_prop_sync': {
      // Tarea C (13-jul): el vendedor editó una prop del LI; sincronizar SOLO esa prop a
      // los tickets NO emitidos del LI (quirúrgico, sin re-snapshot). El dealId solo se usa
      // para leer moneda/país/cupo del deal (contexto del snapshot); si falta, se resuelve.
      let resolvedDealId = deal_id;
      if (!resolvedDealId) {
        resolvedDealId = await getDealIdForLineItem(object_id);
        if (resolvedDealId) {
          await pool.query(`UPDATE webhook_queue SET deal_id = $2 WHERE id = $1`, [job.id, resolvedDealId]);
        }
      }
      const result = await syncLineItemPropToTickets({
        lineItemId: object_id,
        propertyName: property_name,
        dealId: resolvedDealId,
      });

      // price/quantity/costo cambian el VALOR proyectado del auto-renew (regla 21-jul:
      // "campo dinámico, se actualiza al editar el LI") → recalcular. No bloquea el sync.
      if (resolvedDealId && ['price', 'quantity', 'costo_total_usd'].includes(property_name)) {
        try {
          await recalcValorTotal({ dealId: resolvedDealId });
        } catch (err) {
          logger.warn(
            { module: MODULE, fn: 'executeJob', jobId: job.id, dealId: resolvedDealId, err: err?.message },
            'recalcValorTotal post li_prop_sync falló (no bloquea)'
          );
        }
      }

      logger.info(
        { module: MODULE, fn: 'executeJob', jobId: job.id, lineItemId: object_id, propertyName: property_name, ...result },
        'li_prop_sync completado'
      );
      return result;
    }

    case 'deal_prop_sync': {
      // TANDA E (§5.bis): cambió el VENDEDOR (hubspot_owner_id) o la MONEDA
      // (deal_currency_code) DEL NEGOCIO → bajar sólo esa prop a los tickets del negocio
      // que el motor todavía manda (pipeline manual, no notificados). Gemelo del
      // li_prop_sync pero del lado del negocio: estas dos props NO salen del line item.
      // El guard de llave vive adentro de syncDealPropToTickets (devuelve flag_off).
      const result = await syncDealPropToTickets({
        dealId: object_id,
        propertyName: property_name,
      });
      logger.info(
        { module: MODULE, fn: 'executeJob', jobId: job.id, dealId: object_id, propertyName: property_name, ...result },
        'deal_prop_sync completado'
      );
      return result;
    }

    case 'valor_recalc': {
      // Dos orígenes (mismo efecto): frecuencia / nº de pagos del LI cambian la
      // clasificación auto-renew y el multiplicador anual del VALOR (regla 21-jul);
      // y ediciones de montos de TICKETS editables (monto_unitario_real / cantidad_real /
      // of_costo_usd / dolar — RUTA 5b) cambian el Σ subtotal_real del plan fijo.
      // Recalcula SOLO el VALOR del deal, sin re-correr las phases (no crea tickets
      // ni toca facturación).
      let resolvedDealId = deal_id;
      if (!resolvedDealId) {
        resolvedDealId = object_type === 'ticket'
          ? await getDealIdForTicket(object_id)
          : await getDealIdForLineItem(object_id);
        if (!resolvedDealId) {
          throw new Error(`No se encontró deal asociado al ${object_type} ${object_id}`);
        }
        await pool.query(`UPDATE webhook_queue SET deal_id = $2 WHERE id = $1`, [job.id, resolvedDealId]);
      }
      const result = await recalcValorTotal({ dealId: resolvedDealId });
      logger.info(
        { module: MODULE, fn: 'executeJob', jobId: job.id, dealId: resolvedDealId,
          lineItemId: object_id, propertyName: property_name,
          totalUsd: result.totalUsd, changed: result.changed },
        'valor_recalc completado'
      );
      return result;
    }

    case 'ticket_cancel_request': {
      // Casilla cancelar_ticket. Con CANCEL_REVERT_FLOW_ENABLED apagada (default)
      // el handler solo escribe props del TICKET (etapa/motivo/aviso/reset de
      // casilla) — no toca deal, factura ni cupo, así que corre SIN lock de deal
      // (exactamente como hoy). Con la llave PRENDIDA, el caso invoice_alive
      // puede cancelar la factura y propagar (deal/cupo) → se toma el mismo
      // candado de deal que deal_cancel para no pisarse con el cron/fases.
      if (!cancelRevertFlowEnabled()) {
        const result = await processCancelTicketRequest(object_id);
        logger.info(
          { module: MODULE, fn: 'executeJob', jobId: job.id, objectId: object_id, ...result },
          'ticket_cancel_request completado'
        );
        return result;
      }

      const dealId = deal_id || await getDealIdForTicket(object_id);
      let lockToken = null;
      if (dealId) {
        lockToken = await acquireDealLock(dealId, 'ticket_cancel_request');
        if (!lockToken) {
          return { reason: 'deal_locked' };
        }
      } else {
        // Sin of_deal_id no hay candado posible: el handler igual protege con
        // sus propios guards (pipeline, factura viva, gate Nodum).
        logger.warn(
          { module: MODULE, fn: 'executeJob', jobId: job.id, objectId: object_id },
          'ticket_cancel_request: ticket sin of_deal_id, se procesa sin lock de deal'
        );
      }

      try {
        const result = await processCancelTicketRequest(object_id);
        logger.info(
          { module: MODULE, fn: 'executeJob', jobId: job.id, objectId: object_id, dealId, ...result },
          'ticket_cancel_request completado'
        );
        return result;
      } finally {
        if (lockToken) await releaseDealLock(dealId, lockToken);
      }
    }

    case 'ticket_revert_request': {
      // Casilla revertir_factura (Bloque 3): puede cancelar la factura viva del
      // ticket y propagar (ticket/deal/cupo) → CON candado de deal (patrón
      // deal_cancel). Ocupado → deal_locked y processNext lo reencola.
      const dealId = deal_id || await getDealIdForTicket(object_id);
      let lockToken = null;
      if (dealId) {
        lockToken = await acquireDealLock(dealId, 'ticket_revert_request');
        if (!lockToken) {
          return { reason: 'deal_locked' };
        }
      } else {
        // Sin of_deal_id no hay candado posible: el handler igual protege con
        // sus propios guards (llave, pipeline, factura viva, gate Nodum).
        logger.warn(
          { module: MODULE, fn: 'executeJob', jobId: job.id, objectId: object_id },
          'ticket_revert_request: ticket sin of_deal_id, se procesa sin lock de deal'
        );
      }

      try {
        const result = await processRevertTicketRequest(object_id);
        logger.info(
          { module: MODULE, fn: 'executeJob', jobId: job.id, objectId: object_id, dealId, ...result },
          'ticket_revert_request completado'
        );
        return result;
      } finally {
        if (lockToken) await releaseDealLock(dealId, lockToken);
      }
    }

    case 'ticket_label_sync': {
      // Cambió una asociación negocio↔empresa (RUTA 8). Baja las etiquetas
      // "Empresa Factura"/"Partner" del negocio a sus tickets: agrega las que
      // faltan y quita las que sobran. Sólo toca ASOCIACIONES — no propiedades,
      // ni facturación, ni cupo → sin candado de deal (es idempotente y aditivo
      // respecto de lo que hace el cron).
      const resolvedDealId = deal_id || object_id;
      const result = await syncTicketCompanyLabels({ dealId: resolvedDealId });
      logger.info(
        { module: MODULE, fn: 'executeJob', jobId: job.id, dealId: resolvedDealId,
          associationType: property_name, ...result },
        'ticket_label_sync completado'
      );
      return result;
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

// ─── Helper: resolver dealId desde ticket (prop of_deal_id, como recalcValorTotal) ─

const PROP_TICKET_DEAL_ID = process.env.PROP_TICKET_DEAL_ID || 'of_deal_id';

async function getDealIdForTicket(ticketId) {
  const ticket = await hubspotClient.crm.tickets.basicApi.getById(String(ticketId), [
    PROP_TICKET_DEAL_ID,
  ]);
  return (ticket?.properties?.[PROP_TICKET_DEAL_ID] || '').trim() || null;
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

  // Eventos 'processing' viejos: el worker murió a mitad y el reaper todavía no
  // los levantó (o no está corriendo). Antes eran invisibles al health-check.
  const reapMinutes = Number(process.env.WEBHOOK_QUEUE_REAP_MINUTES ?? 15);
  const processingRes = await pool.query(
    `SELECT COUNT(*)::int AS count,
            MIN(started_at) AS oldest
       FROM webhook_queue
      WHERE status = 'processing'
        AND started_at < NOW() - ($1 || ' minutes')::interval`,
    [String(reapMinutes)]
  );

  const processingCount = processingRes.rows[0]?.count || 0;
  result.processingStale = { count: processingCount };
  if (processingCount > 0) {
    result.processingStale.oldest = processingRes.rows[0].oldest;
    result.status = 'warn';
  }

  return result;
}

// ─── Start / Stop ────────────────────────────────────────────────────────────

let workerInterval = null;
let reaperInterval = null;

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

  // Reaper periódico: el boot cubre el redeploy, esto cubre al worker que muere
  // sin que el proceso caiga. Nunca toca el job en vuelo (`currentJobId`).
  const reapEveryMin = Number(process.env.WEBHOOK_QUEUE_REAP_INTERVAL_MIN ?? 5);
  reaperInterval = setInterval(() => {
    reapStaleProcessingJobs().catch(err =>
      logger.error({ module: MODULE, fn: 'reaperInterval', err: err?.message }, 'Error en el reaper periódico')
    );
  }, reapEveryMin * 60 * 1000);
  logger.info({ module: MODULE, reapEveryMin }, 'Reaper de webhook_queue iniciado');
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
  if (reaperInterval) {
    clearInterval(reaperInterval);
    reaperInterval = null;
  }
}