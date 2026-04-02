// src/jobs/cronMensajeFacturacion.js
//
// Cron que construye el mensaje de facturación agrupando todos los tickets
// READY de cada deal y escribiendo `mensaje_de_facturacion` de una sola vez.
//
// Horarios en Railway: 08:10, 11:10, 14:10, 17:10 (America/Montevideo)
//
// Lógica:
//   1. Buscar tickets en stage READY (manual + automático) donde
//      ticket_emitio_aviso_a_admin ≠ true
//   2. Agrupar por dealId (of_deal_id)
//   3. Para cada deal: si algún ticket fue modificado hace < 10 min → skip
//   4. Construir HTML con buildMensajeFacturacion(tickets, dealName)
//   5. Escribir mensaje_de_facturacion en el deal
//   6. Marcar cada ticket con ticket_emitio_aviso_a_admin = true
//
// Ejecución manual:
//   node src/jobs/cronMensajeFacturacion.js
//   node src/jobs/cronMensajeFacturacion.js --deal 12345678
//   node src/jobs/cronMensajeFacturacion.js --dry

import 'dotenv/config';
import { hubspotClient } from '../hubspotClient.js';
import { buildMensajeFacturacion } from '../services/billing/buildMensajeFacturacion.js';
import {
  TICKET_PIPELINE,
  TICKET_STAGES,
  AUTOMATED_TICKET_PIPELINE,
  BILLING_AUTOMATED_READY,
} from '../config/constants.js';
import { parseBool } from '../utils/parsers.js';
import logger from '../../lib/logger.js';
import { pathToFileURL } from 'url';

// ────────────────────────────────────────────────────────────
// Config
// ────────────────────────────────────────────────────────────

const COOLDOWN_MINUTES = 10;
const DEAL_PROPERTY = 'mensaje_de_facturacion';

// Propiedades que necesitamos del ticket para construir el mensaje
const TICKET_PROPS = [
  'hs_object_id', 'hs_pipeline', 'hs_pipeline_stage', 'hs_lastmodifieddate',
  'of_deal_id', 'of_producto_nombres', 'of_descripcion_producto', 'of_rubro',
  'of_moneda', 'of_exonera_irae', 'of_iva', 'of_frecuencia_de_facturacion',
  'of_cantidad_de_pagos',
  'monto_unitario_real', 'cantidad_real', 'subtotal_real',
  'descuento_en_porcentaje', 'descuento_por_unidad_real', 'total_real_a_facturar',
  'nombre_empresa', 'empresa_que_factura', 'persona_que_factura',
  'unidad_de_negocio', 'observaciones_ventas',
  'fecha_resolucion_esperada', 'subject',
  'ticket_emitio_aviso_a_admin',
];

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────

function nowMs() {
  return Date.now();
}

/**
 * Busca tickets en un pipeline+stage específico que NO tengan aviso emitido.
 * Retorna array de tickets con properties.
 */
async function searchReadyTickets(pipelineId, stageId) {
  if (!pipelineId || !stageId) return [];

  const allTickets = [];
  let after = undefined;
  const MAX_PAGES = 10;

  for (let page = 0; page < MAX_PAGES; page++) {
    const searchBody = {
      filterGroups: [
        {
          filters: [
            { propertyName: 'hs_pipeline', operator: 'EQ', value: String(pipelineId) },
            { propertyName: 'hs_pipeline_stage', operator: 'EQ', value: String(stageId) },
            // No podemos filtrar ticket_emitio_aviso_a_admin != true en Search API
            // (HAS_PROPERTY no detecta vacíos correctamente), así que filtramos in-memory
          ],
        },
      ],
      properties: TICKET_PROPS,
      sorts: [{ propertyName: 'hs_lastmodifieddate', direction: 'ASCENDING' }],
      limit: 100,
    };

    if (after) searchBody.after = after;

    let res;
    try {
      res = await hubspotClient.crm.tickets.searchApi.doSearch(searchBody);
    } catch (err) {
      logger.error(
        { module: 'cronMensajeFacturacion', fn: 'searchReadyTickets', pipelineId, stageId, err },
        'Error buscando tickets READY'
      );
      return allTickets;
    }

    const results = res?.results || [];
    allTickets.push(...results);

    const nextAfter = res?.paging?.next?.after;
    if (!nextAfter || results.length < 100) break;
    after = nextAfter;
  }

  return allTickets;
}

/**
 * Filtra tickets que ya fueron notificados (ticket_emitio_aviso_a_admin = true).
 */
function filterPendientes(tickets) {
  return tickets.filter(t => {
    const v = t?.properties?.ticket_emitio_aviso_a_admin;
    return !parseBool(v);
  });
}

/**
 * Agrupa tickets por dealId.
 * Retorna Map<dealId, ticket[]>
 */
function groupByDeal(tickets) {
  const map = new Map();
  for (const t of tickets) {
    const dealId = String(t?.properties?.of_deal_id || '').trim();
    if (!dealId) {
      logger.warn(
        { module: 'cronMensajeFacturacion', ticketId: t.id },
        'Ticket sin of_deal_id, saltando'
      );
      continue;
    }
    if (!map.has(dealId)) map.set(dealId, []);
    map.get(dealId).push(t);
  }
  return map;
}

/**
 * Verifica si algún ticket del grupo fue modificado hace menos de COOLDOWN_MINUTES.
 * Retorna true si el deal está "caliente" (hay que esperar).
 */
function isDealHot(tickets) {
  const cutoff = nowMs() - (COOLDOWN_MINUTES * 60 * 1000);
  for (const t of tickets) {
    const lastMod = t?.properties?.hs_lastmodifieddate;
    if (!lastMod) continue;
    const ms = new Date(lastMod).getTime();
    if (ms > cutoff) return true;
  }
  return false;
}

/**
 * Obtiene el nombre del deal.
 */
async function getDealName(dealId) {
  try {
    const deal = await hubspotClient.crm.deals.basicApi.getById(dealId, ['dealname']);
    return deal?.properties?.dealname || `Deal ${dealId}`;
  } catch (err) {
    logger.warn(
      { module: 'cronMensajeFacturacion', fn: 'getDealName', dealId, err },
      'No se pudo obtener nombre del deal'
    );
    return `Deal ${dealId}`;
  }
}

/**
 * Escribe mensaje_de_facturacion en el deal.
 */
async function writeMensaje(dealId, html) {
  await hubspotClient.crm.deals.basicApi.update(dealId, {
    properties: { [DEAL_PROPERTY]: html },
  });
}

/**
 * Marca un ticket como notificado.
 */
async function markTicketNotified(ticketId) {
  await hubspotClient.crm.tickets.basicApi.update(String(ticketId), {
    properties: { ticket_emitio_aviso_a_admin: 'true' },
  });
}

// ────────────────────────────────────────────────────────────
// Main runner
// ────────────────────────────────────────────────────────────

export async function runCronMensajeFacturacion({ onlyDealId = null, dry = false } = {}) {
  const start = Date.now();
  logger.info(
    { module: 'cronMensajeFacturacion', onlyDealId, dry },
    '🔔 Cron mensaje facturación — inicio'
  );

  // 1. Buscar tickets READY en ambos pipelines
  const [manualTickets, autoTickets] = await Promise.all([
    searchReadyTickets(TICKET_PIPELINE, TICKET_STAGES.READY),
    searchReadyTickets(AUTOMATED_TICKET_PIPELINE, BILLING_AUTOMATED_READY),
  ]);

  const allReady = [...manualTickets, ...autoTickets];
  logger.info(
    { module: 'cronMensajeFacturacion', manual: manualTickets.length, auto: autoTickets.length, total: allReady.length },
    'Tickets READY encontrados'
  );

  // 2. Filtrar los que ya tienen aviso
  const pendientes = filterPendientes(allReady);
  logger.info(
    { module: 'cronMensajeFacturacion', pendientes: pendientes.length, yaNotificados: allReady.length - pendientes.length },
    'Tickets pendientes de aviso'
  );

  if (pendientes.length === 0) {
    logger.info({ module: 'cronMensajeFacturacion' }, 'Sin tickets pendientes, saliendo');
    return { processed: 0, skippedHot: 0, deals: 0, ticketsNotified: 0 };
  }

  // 3. Agrupar por deal
  let dealGroups = groupByDeal(pendientes);

  // Si --deal, filtrar solo ese
  if (onlyDealId) {
    const targetId = String(onlyDealId);
    if (dealGroups.has(targetId)) {
      const tickets = dealGroups.get(targetId);
      dealGroups = new Map([[targetId, tickets]]);
    } else {
      logger.warn(
        { module: 'cronMensajeFacturacion', dealId: onlyDealId },
        'Deal especificado no tiene tickets pendientes de aviso'
      );
      return { processed: 0, skippedHot: 0, deals: 0, ticketsNotified: 0 };
    }
  }

  logger.info(
    { module: 'cronMensajeFacturacion', deals: dealGroups.size },
    'Deals con tickets pendientes'
  );

  // 4. Procesar cada deal
  let dealsProcessed = 0;
  let skippedHot = 0;
  let ticketsNotified = 0;
  let errors = 0;

  for (const [dealId, tickets] of dealGroups) {
    try {
      // Cooldown check (skip si --deal forzado)
      if (!onlyDealId && isDealHot(tickets)) {
        logger.info(
          { module: 'cronMensajeFacturacion', dealId, ticketCount: tickets.length },
          `⏳ Deal caliente (ticket modificado < ${COOLDOWN_MINUTES} min), pospuesto`
        );
        skippedHot++;
        continue;
      }

      // Obtener nombre del deal
      const dealName = await getDealName(dealId);

      // Construir HTML
      const html = buildMensajeFacturacion(tickets, dealName);

      if (!html) {
        logger.warn(
          { module: 'cronMensajeFacturacion', dealId },
          'buildMensajeFacturacion retornó vacío, saltando'
        );
        continue;
      }

      if (dry) {
        logger.info(
          { module: 'cronMensajeFacturacion', dealId, dealName, ticketCount: tickets.length, htmlLength: html.length },
          '🏜️ DRY RUN — no se escribe mensaje ni se marcan tickets'
        );
        dealsProcessed++;
        ticketsNotified += tickets.length;
        continue;
      }

      // Escribir propiedad en el deal
      await writeMensaje(dealId, html);

      // Marcar tickets como notificados
      for (const t of tickets) {
        try {
          await markTicketNotified(t.id);
          ticketsNotified++;
        } catch (err) {
          logger.error(
            { module: 'cronMensajeFacturacion', dealId, ticketId: t.id, err },
            'Error marcando ticket como notificado'
          );
          errors++;
        }
      }

      dealsProcessed++;
      logger.info(
        { module: 'cronMensajeFacturacion', dealId, dealName, ticketCount: tickets.length },
        '✅ Mensaje de facturación escrito y tickets marcados'
      );

    } catch (err) {
      logger.error(
        { module: 'cronMensajeFacturacion', dealId, err },
        '❌ Error procesando deal'
      );
      errors++;
    }
  }

  const elapsed = Date.now() - start;
  const summary = {
    processed: dealsProcessed,
    skippedHot,
    deals: dealGroups.size,
    ticketsNotified,
    errors,
    elapsedMs: elapsed,
  };

  logger.info(
    { module: 'cronMensajeFacturacion', ...summary },
    '🔔 Cron mensaje facturación — fin'
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
    const result = await runCronMensajeFacturacion({ onlyDealId: deal, dry });
    console.log('\nResultado:', JSON.stringify(result, null, 2));
  } catch (e) {
    logger.error(
      { module: 'cronMensajeFacturacion', error: e?.message || String(e), stack: e?.stack },
      'cron_mensaje_failed'
    );
    process.exitCode = 1;
  }
}