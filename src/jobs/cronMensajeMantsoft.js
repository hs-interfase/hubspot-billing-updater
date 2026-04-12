// src/jobs/cronMensajeMantsoft.js
//
// Cron que avisa sobre facturaciones automáticas pendientes de Mantsoft.
//
// Horario en Railway: 07:10 (America/Montevideo) — una hora antes que cronMensajeFacturacion
//
// Lógica:
//   1. Buscar line items con mansoft_pendiente = true y facturacion_automatica = true
//   2. Resolver dealId de cada line item via associations batch API
//   3. Agrupar por deal
//   4. Para cada deal: construir HTML con buildMensajeMantsoft(lineItems, dealName)
//   5. Escribir mensaje_de_facturacion en el deal
//   6. Resetear mantsoft_pendiente = false en cada line item procesado
//
// Ejecución manual:
//   node src/jobs/cronMensajeMantsoft.js
//   node src/jobs/cronMensajeMantsoft.js --deal 12345678
//   node src/jobs/cronMensajeMantsoft.js --dry

import 'dotenv/config';
import { hubspotClient } from "../hubspotClient.js";
import { buildMensajeMantsoft } from '../services/billing/buildMensajeMantsoft.js';
import { parseBool } from '../utils/parsers.js';
import logger from '../../lib/logger.js';
import { pathToFileURL } from 'url';

// ────────────────────────────────────────────────────────────
// Config
// ────────────────────────────────────────────────────────────

const DEAL_PROPERTY = 'mensaje_de_facturacion';

const LI_PROPS = [
  'hs_object_id', 'hs_lastmodifieddate',
  'name', 'description', 'of_rubro', 'rubro', 'unidad_de_negocio',
  'price', 'quantity', 'amount',
  'hs_discount_percentage', 'of_moneda', 'deal_currency_code',
  'of_iva', 'of_exonera_irae',
  'recurringbillingfrequency', 'hs_recurring_billing_frequency',
  'hs_recurring_billing_start_date', 'fecha_inicio_de_facturacion',
  'billing_next_date', 'fecha_vencimiento_contrato',
  'hs_recurring_billing_number_of_payments', 'pagos_restantes',
  'renovacion_automatica', 'hs_recurring_billing_terms',
  'nombre_empresa', 'empresa_que_factura', 'persona_que_factura',
  'observaciones_ventas', 'nota',
  'mansoft_pendiente', 'facturacion_automatica',
];

// ────────────────────────────────────────────────────────────
// Búsqueda de line items
// ────────────────────────────────────────────────────────────

async function searchLineItemsMantsoft() {
  const allItems = [];
  let after = undefined;
  const MAX_PAGES = 20;

  for (let page = 0; page < MAX_PAGES; page++) {
    const searchBody = {
      filterGroups: [{
        filters: [
          { propertyName: 'mansoft_pendiente', operator: 'EQ', value: 'true' },
          { propertyName: 'facturacion_automatica', operator: 'EQ', value: 'true' },
        ],
      }],
      properties: LI_PROPS,
      sorts: [{ propertyName: 'hs_lastmodifieddate', direction: 'ASCENDING' }],
      limit: 100,
    };

    if (after) searchBody.after = after;

    let res;
    try {
      res = await hubspotClient.crm.lineItems.searchApi.doSearch(searchBody);
    } catch (err) {
      logger.error(
        { module: 'cronMensajeMantsoft', fn: 'searchLineItemsMantsoft', err },
        'Error buscando line items mansoft_pendiente'
      );
      return allItems;
    }

    const results = res?.results || [];

    // Filtro in-memory — HAS_PROPERTY / EQ en booleans puede ser poco fiable
    for (const li of results) {
      if (parseBool(li?.properties?.mansoft_pendiente) &&
          parseBool(li?.properties?.facturacion_automatica)) {
        allItems.push(li);
      }
    }

    const nextAfter = res?.paging?.next?.after;
    if (!nextAfter || results.length < 100) break;
    after = nextAfter;
  }

  return allItems;
}

// ────────────────────────────────────────────────────────────
// Associations batch: line items → deals
// ────────────────────────────────────────────────────────────

/**
 * Dado un array de line items, resuelve el dealId de cada uno
 * usando la batch associations API (una sola llamada).
 * Retorna Map<lineItemId, dealId>
 */

async function resolveDealsForLineItems(lineItems) {
  const result = new Map();
  if (lineItems.length === 0) return result;

  const inputs = lineItems.map(li => ({ id: String(li.id) }));

  let resp;
  try {
    resp = await hubspotClient.crm.associations.v4.batchApi.read(
      'line_items',
      'deals',
      { inputs }
    );
  } catch (err) {
    logger.error(
      { module: 'cronMensajeMantsoft', fn: 'resolveDealsForLineItems', err },
      'Error en batch associations v4 line_items → deals'
    );
    return result;
  }

  for (const item of resp?.results || []) {
    const lineItemId = String(item?.from?.id || '');
    const dealId = String(item?.to?.[0]?.toObjectId || '');
    if (lineItemId && dealId) {
      result.set(lineItemId, dealId);
    }
  }

  return result;
}

// ────────────────────────────────────────────────────────────
// Agrupación por deal
// ────────────────────────────────────────────────────────────

/**
 * Agrupa line items por dealId usando el mapa de associations.
 * Retorna Map<dealId, lineItem[]>
 */
function groupByDeal(lineItems, liToDealMap) {
  const map = new Map();

  for (const li of lineItems) {
    const dealId = liToDealMap.get(String(li.id));
    if (!dealId) {
      logger.warn(
        { module: 'cronMensajeMantsoft', lineItemId: li.id },
        'Line item sin dealId en associations, saltando'
      );
      continue;
    }
    if (!map.has(dealId)) map.set(dealId, []);
    map.get(dealId).push(li);
  }

  return map;
}

// ────────────────────────────────────────────────────────────
// Helpers HubSpot
// ────────────────────────────────────────────────────────────

async function getDealName(dealId) {
  try {
    const deal = await hubspotClient.crm.deals.basicApi.getById(dealId, ['dealname']);
    return deal?.properties?.dealname || `Deal ${dealId}`;
  } catch (err) {
    logger.warn(
      { module: 'cronMensajeMantsoft', fn: 'getDealName', dealId, err },
      'No se pudo obtener nombre del deal'
    );
    return `Deal ${dealId}`;
  }
}

async function writeMensaje(dealId, html) {
  await hubspotClient.crm.deals.basicApi.update(String(dealId), {
    properties: { [DEAL_PROPERTY]: html },
  });
}

async function resetMantoftPendiente(lineItemId) {
  await hubspotClient.crm.lineItems.basicApi.update(String(lineItemId), {
    properties: { mansoft_pendiente: 'false' },
  });
}

// ────────────────────────────────────────────────────────────
// Main runner
// ────────────────────────────────────────────────────────────

export async function runCronMensajeMantsoft({ onlyDealId = null, dry = false } = {}) {
  const start = Date.now();
  logger.info(
    { module: 'cronMensajeMantsoft', onlyDealId, dry },
    '⚙️ Cron mensaje Mantsoft — inicio'
  );

  // 1. Buscar line items pendientes
  const lineItems = await searchLineItemsMantsoft();

  logger.info(
    { module: 'cronMensajeMantsoft', total: lineItems.length },
    'Line items mansoft_pendiente encontrados'
  );

  if (lineItems.length === 0) {
    logger.info({ module: 'cronMensajeMantsoft' }, 'Sin line items pendientes, saliendo');
    return { processed: 0, deals: 0, lineItemsReset: 0, errors: 0 };
  }

  // 2. Resolver dealId de todos los line items en una sola llamada batch
  const liToDealMap = await resolveDealsForLineItems(lineItems);

  logger.info(
    { module: 'cronMensajeMantsoft', resolved: liToDealMap.size, total: lineItems.length },
    'Associations resueltas'
  );

  // 3. Agrupar por deal
  let dealGroups = groupByDeal(lineItems, liToDealMap);

  // Si --deal, filtrar solo ese
  if (onlyDealId) {
    const targetId = String(onlyDealId);
    if (dealGroups.has(targetId)) {
      dealGroups = new Map([[targetId, dealGroups.get(targetId)]]);
    } else {
      logger.warn(
        { module: 'cronMensajeMantsoft', dealId: onlyDealId },
        'Deal especificado no tiene line items mantsoft pendientes'
      );
      return { processed: 0, deals: 0, lineItemsReset: 0, errors: 0 };
    }
  }

  logger.info(
    { module: 'cronMensajeMantsoft', deals: dealGroups.size },
    'Deals con line items Mantsoft pendientes'
  );

  // 4. Procesar cada deal
  let dealsProcessed = 0;
  let lineItemsReset = 0;
  let errors = 0;

  for (const [dealId, items] of dealGroups) {
    try {
      const dealName = await getDealName(dealId);
      const html = buildMensajeMantsoft(items, dealName);

      if (!html) {
        logger.warn(
          { module: 'cronMensajeMantsoft', dealId },
          'buildMensajeMantsoft retornó vacío, saltando'
        );
        continue;
      }

      if (dry) {
        logger.info(
          { module: 'cronMensajeMantsoft', dealId, dealName, lineItemCount: items.length, htmlLength: html.length },
          '🏜️ DRY RUN — no se escribe mensaje ni se resetean line items'
        );
        dealsProcessed++;
        lineItemsReset += items.length;
        continue;
      }

      // Escribir mensaje en el deal
      await writeMensaje(dealId, html);

      // Resetear flag en cada line item
      for (const li of items) {
        try {
          await resetMantoftPendiente(li.id);
          lineItemsReset++;
        } catch (err) {
          logger.error(
            { module: 'cronMensajeMantsoft', dealId, lineItemId: li.id, err },
            'Error reseteando mansoft_pendiente'
          );
          errors++;
        }
      }

      dealsProcessed++;
      logger.info(
        { module: 'cronMensajeMantsoft', dealId, dealName, lineItemCount: items.length },
        '✅ Mensaje Mantsoft escrito y line items reseteados'
      );

    } catch (err) {
      logger.error(
        { module: 'cronMensajeMantsoft', dealId, err },
        '❌ Error procesando deal'
      );
      errors++;
    }
  }

  const elapsed = Date.now() - start;
  const summary = {
    processed: dealsProcessed,
    deals: dealGroups.size,
    lineItemsReset,
    errors,
    elapsedMs: elapsed,
  };

  logger.info(
    { module: 'cronMensajeMantsoft', ...summary },
    '⚙️ Cron mensaje Mantsoft — fin'
  );

  return summary;
}

// ────────────────────────────────────────────────────────────
// CLI
// ────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { deal: null, dry: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry') args.dry = true;
    else if (a === '--deal') { args.deal = argv[i + 1] || null; i++; }
  }
  return args;
}

const argv1 = process.argv?.[1];
const isDirectRun =
  typeof argv1 === 'string' &&
  argv1.length > 0 &&
  import.meta.url === pathToFileURL(argv1).href;

if (isDirectRun) {
  const { deal, dry } = parseArgs(process.argv.slice(2));
  try {
    const result = await runCronMensajeMantsoft({ onlyDealId: deal, dry });
    console.log('\nResultado:', JSON.stringify(result, null, 2));
  } catch (e) {
    logger.error(
      { module: 'cronMensajeMantsoft', error: e?.message || String(e), stack: e?.stack },
      'cron_mensaje_mantsoft_failed'
    );
    process.exitCode = 1;
  }
}