// src/jobs/cronProductoReconcile.js
//
// Cron NOCTURNO — reconciliación producto ↔ nombre_producto de line items.
//
// Regla (definición usuaria 14-jul): `nombre_producto` es la fuente de verdad.
//   - nombre_producto NO vacío y no coincide → reasignar hs_product_id (nombre gana).
//   - nombre_producto vacío → rellenar desde hs_product_id.
// El cambio en tiempo real lo hace el webhook (reassignLineItemProduct); el relleno al
// crear lo hace phase1 (syncNombreProductoFromProductId, solo si vacío). Este cron cierra
// las divergencias que hayan quedado (webhook perdido, cambio nativo de producto, etc.).
//
// Standalone: se agenda en Railway (cron nocturno), como los demás jobs.
// Gateado por LI_PROP_PRODUCTO_RECONCILE_ENABLED (default OFF) para deployar sin correrlo.

import { pathToFileURL } from 'node:url';
import { hubspotClient } from '../hubspotClient.js';
import { reconcileLineItemsProducto } from '../services/billing/nombreProductoSelect.js';
import { parseBool } from '../utils/parsers.js';
import { flushHubSpotErrors } from '../utils/hubspotErrorCollector.js';
import logger from '../../lib/logger.js';

const MODULE = 'cronProductoReconcile';
const PAGE = Number(process.env.CRON_PRODUCTO_PAGE_LIMIT || 100);

/**
 * Trae line items que tengan hs_product_id O nombre_producto seteado (los únicos que
 * pueden reconciliarse), con paginación keyset por hs_object_id.
 */
async function* iterLineItemsToReconcile() {
  let lastId = '0';
  for (;;) {
    const body = {
      filterGroups: [
        { filters: [
          { propertyName: 'hs_object_id', operator: 'GT', value: lastId },
          { propertyName: 'hs_product_id', operator: 'HAS_PROPERTY' },
        ] },
        { filters: [
          { propertyName: 'hs_object_id', operator: 'GT', value: lastId },
          { propertyName: 'nombre_producto', operator: 'HAS_PROPERTY' },
        ] },
      ],
      properties: ['hs_product_id', 'nombre_producto'],
      sorts: [{ propertyName: 'hs_object_id', direction: 'ASCENDING' }],
      limit: PAGE,
    };
    const resp = await hubspotClient.crm.lineItems.searchApi.doSearch(body);
    const results = resp?.results || [];
    if (!results.length) break;
    yield results;
    lastId = results[results.length - 1].id;
    if (results.length < PAGE) break;
  }
}

export async function runProductoReconcile() {
  const totals = { scanned: 0, reassignedId: 0, filledNombre: 0, ok: 0, unmapped: 0, errors: 0 };
  for await (const batch of iterLineItemsToReconcile()) {
    totals.scanned += batch.length;
    const s = await reconcileLineItemsProducto(batch);
    totals.reassignedId += s.reassignedId;
    totals.filledNombre += s.filledNombre;
    totals.ok += s.ok;
    totals.unmapped += s.unmapped;
    totals.errors += s.errors;
  }
  logger.info({ module: MODULE, ...totals }, 'Reconciliación producto ↔ nombre_producto completada');
  return totals;
}

// Ejecución directa (Railway cron): node src/jobs/cronProductoReconcile.js
const argv1 = process.argv?.[1];
const isDirectRun = typeof argv1 === 'string' && argv1.length > 0 && import.meta.url === pathToFileURL(argv1).href;
if (isDirectRun) {
  (async () => {
    if (!parseBool(process.env.LI_PROP_PRODUCTO_RECONCILE_ENABLED)) {
      logger.warn({ module: MODULE }, 'LI_PROP_PRODUCTO_RECONCILE_ENABLED=false → cron no corre (salida limpia)');
      process.exit(0);
    }
    try {
      const totals = await runProductoReconcile();
      await flushHubSpotErrors();
      logger.info({ module: MODULE, ...totals }, 'cronProductoReconcile OK');
      process.exit(0);
    } catch (err) {
      logger.error({ module: MODULE, err }, 'cronProductoReconcile FALLÓ');
      try { await flushHubSpotErrors(); } catch {}
      process.exit(1);
    }
  })();
}
