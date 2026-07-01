// src/services/lineItems/lineItemWriteBuffer.js
//
// Buffer/colector de escrituras de LINE ITEMS con soporte de batch.
//
// MOTIVACIÓN (rate limit): el token bucket (src/db.js) cobra 1 ficha por
// REQUEST HTTP, no por objeto. Un batchApi.update de 100 line items cuesta
// 1 ficha; 100 basicApi.update cuestan 100. Colapsar los updates por-LI de
// las fases en lotes reduce 2.5-4× las requests por deal.
//
// SEMÁNTICA (feature flag LI_BATCH_WRITES_ENABLED, default OFF):
//   - Flag OFF: queueUpdate ejecuta basicApi.update INMEDIATO, byte a byte
//     igual al código previo, y el error SE PROPAGA al caller (los try/catch
//     existentes en cada call site siguen funcionando idéntico). flush() = noop.
//     El buffer es el único camino: el modo inmediato ES el camino viejo.
//   - Flag ON: queueUpdate acumula en memoria (merge por LI, último gana por
//     prop) y NO lanza. flush() trocea en chunks ≤batchLimit y llama
//     crm.lineItems.batchApi.update. El Proxy de hubspotClient.js ya envuelve
//     batchApi.* con acquireToken + withRetry → 1 ficha por chunk, sin tocar
//     hubspotClient.js.
//   - Fallback 400 (aislamiento por-LI): batchApi.update es todo-o-nada ante
//     error de validación (400 no se reintenta, withRetry lo propaga). Para no
//     perder los LIs válidos del lote, flush degrada ese chunk a basicApi.update
//     individual por LI; el LI que falla individualmente se loguea + report y
//     NO bloquea a los demás (peor caso = mismo nº de requests que hoy).
//     flush() NUNCA lanza: mismo espíritu best-effort de los call sites.
//
// Los call sites siguen siendo dueños de la mutación en memoria de
// li.properties (hoy ya es optimista/incondicional post-catch en billingEngine).
//
// hubspotClient es inyectable (patrón de recalcContadores.test.mjs) para
// testear sin red.

import { parseBool } from '../../utils/parsers.js';
import logger from '../../../lib/logger.js';

const MOD = 'lineItemWriteBuffer';

// Imports LAZY: hubspotClient.js y errorReporting.js arrastran db.js, que exige
// DATABASE_URL al cargar. Se resuelven recién si nadie inyectó un cliente
// (producción); en tests con DI nunca se cargan.
let _defaultClientPromise = null;
function getDefaultHubspotClient() {
  if (!_defaultClientPromise) {
    _defaultClientPromise = import('../../hubspotClient.js').then(m => m.hubspotClient);
  }
  return _defaultClientPromise;
}

let _reportPromise = null;
function getReportIfActionable() {
  if (!_reportPromise) {
    _reportPromise = import('../../utils/errorReporting.js')
      .then(m => m.reportIfActionable)
      .catch(() => () => {}); // sin entorno completo, degradar a noop (solo tests)
  }
  return _reportPromise;
}

export function createLineItemWriteBuffer({
  hubspotClient = null,
  enabled = parseBool(process.env.LI_BATCH_WRITES_ENABLED),
  batchLimit = 100,
  context = {},
} = {}) {
  // id → { properties, labels[] } (merge: último gana por prop)
  const pending = new Map();

  const stats = {
    queued: 0,          // updates recibidos por queueUpdate
    updatesSent: 0,     // updates efectivamente enviados (batch o individual)
    batchCalls: 0,      // requests batchApi.update
    individualCalls: 0, // requests basicApi.update
    failed: 0,          // LIs cuyo update terminó fallando (tras fallback)
    flushes: 0,
  };

  async function getClient() {
    return hubspotClient ?? (hubspotClient = await getDefaultHubspotClient());
  }

  async function queueUpdate(lineItemId, properties, { label = '' } = {}) {
    const id = String(lineItemId || '').trim();
    if (!id) return;
    if (!properties || typeof properties !== 'object' || Object.keys(properties).length === 0) return;

    stats.queued++;

    if (!enabled) {
      // Camino inmediato = comportamiento previo, error propagado al caller.
      stats.individualCalls++;
      stats.updatesSent++;
      const client = await getClient();
      await client.crm.lineItems.basicApi.update(id, { properties });
      return;
    }

    const entry = pending.get(id) || { properties: {}, labels: [] };
    entry.properties = { ...entry.properties, ...properties };
    if (label) entry.labels.push(label);
    pending.set(id, entry);
  }

  async function flushChunkWithFallback(chunk) {
    // chunk: Array<[id, { properties, labels }]>
    const client = await getClient();
    try {
      await client.crm.lineItems.batchApi.update({
        inputs: chunk.map(([id, e]) => ({ id, properties: e.properties })),
      });
      stats.batchCalls++;
      stats.updatesSent += chunk.length;
      return;
    } catch (batchErr) {
      logger.warn(
        { module: MOD, fn: 'flush', ...context, chunkSize: chunk.length, err: batchErr },
        'batchApi.update falló para el chunk → fallback a updates individuales (aislamiento por-LI)'
      );
    }

    for (const [id, entry] of chunk) {
      try {
        stats.individualCalls++;
        await client.crm.lineItems.basicApi.update(id, { properties: entry.properties });
        stats.updatesSent++;
      } catch (err) {
        stats.failed++;
        const labels = entry.labels.join(',') || '(sin label)';
        logger.error(
          { module: MOD, fn: 'flush', ...context, lineItemId: id, labels, err },
          'line_item_update_failed (fallback individual del batch)'
        );
        const reportIfActionable = await getReportIfActionable();
        reportIfActionable({
          objectType: 'line_item',
          objectId: id,
          message: `line_item_update_failed (batch fallback: ${labels}): ${err?.message || err}`,
          err,
        });
      }
    }
  }

  async function flush() {
    if (!enabled || pending.size === 0) {
      return { updated: 0, failed: 0, batchCalls: 0, individualCalls: 0 };
    }

    stats.flushes++;
    const before = { updatesSent: stats.updatesSent, failed: stats.failed, batchCalls: stats.batchCalls, individualCalls: stats.individualCalls };

    const entries = Array.from(pending.entries());
    pending.clear();

    for (let i = 0; i < entries.length; i += batchLimit) {
      await flushChunkWithFallback(entries.slice(i, i + batchLimit));
    }

    const result = {
      updated: stats.updatesSent - before.updatesSent,
      failed: stats.failed - before.failed,
      batchCalls: stats.batchCalls - before.batchCalls,
      individualCalls: stats.individualCalls - before.individualCalls,
    };

    logger.info(
      { module: MOD, fn: 'flush', ...context, ...result, totals: { ...stats } },
      `[writeBuffer] flush: ${result.updated} updates en ${result.batchCalls} batch + ${result.individualCalls} individuales (failed=${result.failed})`
    );

    return result;
  }

  return {
    queueUpdate,
    flush,
    pendingCount: () => pending.size,
    stats: () => ({ ...stats }),
    enabled,
  };
}
