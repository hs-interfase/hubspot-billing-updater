// src/jobs/cronMensajeFacturacion.js
//
// Construye el mensaje de facturación agrupando los tickets READY de cada deal
// y escribiendo `mensaje_de_facturacion` de una sola vez.
//
// 🔴 4-ago-2026: DEJÓ DE SER UN CRON. Ya no corre en tandas — el aviso se dispara
//    en el momento en que se pide «Facturar ahora» desde el ticket, vía
//    `refreshMensajeFacturacionParaDeal()` (usada por urgentBillingService.js).
//    Los servicios de Railway de 08:10/11:10/14:10/17:10 se eliminan y el bloque
//    de arranque directo (al final del archivo) quedó comentado.
//    El cooldown de 10 minutos también se eliminó: ver isDealHot().
//
// Lógica de `runCronMensajeFacturacion` (se mantiene, para correrla a mano):
//   1. Buscar tickets en stage READY (manual) donde
//      ticket_emitio_aviso_a_admin ≠ true
//   2. Agrupar por dealId (of_deal_id)
//   3. Construir HTML con buildMensajeFacturacion(tickets, dealName)
//   4. Escribir mensaje_de_facturacion en el deal
//   5. Marcar cada ticket con ticket_emitio_aviso_a_admin = true
//
// Ejecución manual:
//   node src/jobs/cronMensajeFacturacion.js
//   node src/jobs/cronMensajeFacturacion.js --deal 12345678
//   node src/jobs/cronMensajeFacturacion.js --dry

import 'dotenv/config';
import { hubspotClient } from "../hubspotClient.js";
import { buildMensajeFacturacion } from '../services/billing/buildMensajeFacturacion.js';
import {
  TICKET_PIPELINE,
  TICKET_STAGES,
  ASSOC_LABEL_EMPRESA_FACTURA,
} from '../config/constants.js';
import { parseBool } from '../utils/parsers.js';
import logger from '../../lib/logger.js';
import { pingHeartbeat } from '../../lib/alertService.js';
import { pathToFileURL } from 'url';
import { setCronState } from '../db.js';
import { getPortalId } from '../utils/hubspotPortal.js';


// ────────────────────────────────────────────────────────────
// Config
// ────────────────────────────────────────────────────────────

// COOLDOWN_MINUTES eliminado el 4-ago-2026 — ver isDealHot().
const DEAL_PROPERTY = 'mensaje_de_facturacion';

// Propiedades que necesitamos del ticket para construir el mensaje
const TICKET_PROPS = [
  'hs_object_id', 'hs_pipeline', 'hs_pipeline_stage', 'hs_lastmodifieddate',
  'of_deal_id', 'of_producto_nombres', 'of_descripcion_producto', 'of_rubro',
  'of_moneda', 'exonera_irae', 'of_iva', 'of_frecuencia_de_facturacion',
  'of_cantidad_de_pagos', 'producto_id',
  'monto_unitario_real', 'cantidad_real', 'subtotal_real',
  'descuento_en_porcentaje', 'descuento_por_unidad_real', 'total_real_a_facturar',
  'nombre_empresa', 'empresa_que_factura', 'persona_que_factura', 'facturacion_urgente',
  'unidad_de_negocio', 'observaciones',
  'fecha_resolucion_esperada', 'subject',
  'opera_trading', 'momento_de_facturacion',
  'ticket_emitio_aviso_a_admin',
  // Lista de Victoria (correo 1-jul): entidad facturadora + las tres fechas de contrato.
  'entidad_facturadora',
  'fecha_inicio_de_facturacion', 'of_inicio_del_contrato', 'of_fin_del_contrato',
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
 * 🔴 COOLDOWN ELIMINADO (4-ago-2026, decisión de la usuaria).
 *
 * Tenía sentido con el envío en tandas: el cron corría cuatro veces por día y el
 * cooldown evitaba mandar el aviso a mitad de una edición. Con el disparo en el
 * momento de «Facturar ahora» el aviso es la CONSECUENCIA de una acción explícita,
 * así que posponerlo 10 minutos sólo lograba que no saliera.
 *
 * Se deja la función devolviendo siempre false para no tocar los llamadores.
 */
function isDealHot(_tickets) {
  return false;
}

/**
 * Obtiene el nombre del deal.
 */
const ASSOC_LABEL_PERSONA_FACTURA  = 7;  // deals→contacts  "Persona Factura"

async function getDealInfo(dealId) {
  try {
    const [deal, compAssoc, contAssoc] = await Promise.all([
      hubspotClient.crm.deals.basicApi.getById(dealId, ['dealname']),
      hubspotClient.crm.associations.v4.basicApi.getPage('deals', String(dealId), 'companies', 100),
      hubspotClient.crm.associations.v4.basicApi.getPage('deals', String(dealId), 'contacts', 100),
    ]);

    // Empresa con label "Empresa Factura" (typeId=9)
    const empresaId = (compAssoc?.results || [])
      .find(r => r.associationTypes?.some(t => t.typeId === ASSOC_LABEL_EMPRESA_FACTURA))
      ?.toObjectId;

    // Contacto con label "Persona Factura" (typeId=7)
    const personaId = (contAssoc?.results || [])
      .find(r => r.associationTypes?.some(t => t.typeId === ASSOC_LABEL_PERSONA_FACTURA))
      ?.toObjectId;

    const [empresaName, personaName] = await Promise.all([
      empresaId
        ? hubspotClient.crm.companies.basicApi.getById(String(empresaId), ['name'])
            .then(r => r?.properties?.name || null).catch(() => null)
        : Promise.resolve(null),
      personaId
        ? hubspotClient.crm.contacts.basicApi.getById(String(personaId), ['firstname', 'lastname'])
            .then(r => {
              const p = r?.properties || {};
              return [p.firstname, p.lastname].filter(Boolean).join(' ') || null;
            }).catch(() => null)
        : Promise.resolve(null),
    ]);

    return {
      dealName:              deal?.properties?.dealname || `Deal ${dealId}`,
      empresa_que_factura:   empresaName,
      persona_que_factura:   personaName,
    };
  } catch (err) {
    logger.warn(
      { module: 'cronMensajeFacturacion', fn: 'getDealInfo', dealId, err },
      'No se pudo obtener info del deal'
    );
    return { dealName: `Deal ${dealId}`, empresa_que_factura: null, persona_que_factura: null };
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
 * Lee un ticket POR ID (sin Search API) y lo devuelve sólo si está en el stage
 * READY del pipeline manual. Devuelve null ante cualquier problema.
 *
 * 🔴 Por qué existe: el Search API de HubSpot tiene LATENCIA DE INDEXADO. Cuando
 * processUrgentTicket mueve el ticket a READY y a los ~170 ms llama acá, la
 * búsqueda todavía no ve el cambio de etapa y devuelve 0 resultados ⇒ no se
 * escribía `mensaje_de_facturacion` y el workflow que se inscribe por esa
 * propiedad nunca salía. (Diagnosticado el 4-ago-2026 sobre el deal 63433773463;
 * es la misma latencia que ya nos mordió en Phase 2 con los forecast.)
 *
 * La lectura por ID es inmediatamente consistente, así que el ticket que
 * disparó la acción SIEMPRE entra, aunque el índice esté atrasado.
 */
async function readTicketReadyById(ticketId, getTicketById) {
  try {
    const t = await getTicketById(String(ticketId), TICKET_PROPS);
    const tp = t?.properties || {};
    const enPipeline = String(tp.hs_pipeline) === String(TICKET_PIPELINE);
    const enStage    = String(tp.hs_pipeline_stage) === String(TICKET_STAGES.READY);
    if (!enPipeline || !enStage) return null;
    return t;
  } catch (err) {
    logger.warn(
      { module: 'cronMensajeFacturacion', fn: 'readTicketReadyById', ticketId, err },
      'No se pudo leer el ticket por ID — se sigue sólo con la búsqueda'
    );
    return null;
  }
}

/**
 * Construye y escribe el mensaje de facturación para un deal específico,
 * acumulando todos sus tickets READY que aún no emitieron aviso.
 * Sin cooldown. NO marca ticket_emitio_aviso_a_admin — eso lo hace el barrido.
 *
 * @param {string|number} dealId
 * @param {object}  [opts]
 * @param {string|number} [opts.ticketIdHint] - ticket que acaba de moverse a READY.
 *        Se lee POR ID y se suma al resultado de la búsqueda, para no depender
 *        del índice (ver readTicketReadyById).
 * @param {object} [opts.deps] - inyección para tests (mismo patrón que mirrorAlert.js).
 */
export async function refreshMensajeFacturacionParaDeal(dealId, { ticketIdHint = null, deps = {} } = {}) {
  const {
    doSearch      = (body)      => hubspotClient.crm.tickets.searchApi.doSearch(body),
    getTicketById = (id, props) => hubspotClient.crm.tickets.basicApi.getById(id, props),
    fetchDealInfo = getDealInfo,
    fetchPortalId = getPortalId,
    write         = writeMensaje,
  } = deps;

  try {
    const res = await doSearch({
      filterGroups: [{
        filters: [
          { propertyName: 'hs_pipeline',       operator: 'EQ', value: String(TICKET_PIPELINE) },
          { propertyName: 'hs_pipeline_stage',  operator: 'EQ', value: String(TICKET_STAGES.READY) },
          { propertyName: 'of_deal_id',         operator: 'EQ', value: String(dealId) },
        ],
      }],
      properties: TICKET_PROPS,
      limit: 50,
    });

    // Unión búsqueda + ticket leído por ID, deduplicando por id. El hint va
    // PRIMERO para que, si la búsqueda no lo trajo, igual encabece el mensaje.
    const encontrados = [...(res?.results || [])];
    if (ticketIdHint && !encontrados.some(t => String(t.id) === String(ticketIdHint))) {
      const directo = await readTicketReadyById(ticketIdHint, getTicketById);
      if (directo) {
        encontrados.unshift(directo);
        logger.info(
          { module: 'cronMensajeFacturacion', fn: 'refreshMensajeFacturacionParaDeal', dealId, ticketId: ticketIdHint },
          'Ticket recuperado por ID — la búsqueda todavía no lo indexaba'
        );
      }
    }

    const pendientes = filterPendientes(encontrados);

    if (pendientes.length === 0) {
      logger.info(
        { module: 'cronMensajeFacturacion', fn: 'refreshMensajeFacturacionParaDeal', dealId },
        'Sin tickets READY pendientes de aviso para el deal'
      );
      return;
    }

    const { dealName, empresa_que_factura, persona_que_factura } = await fetchDealInfo(String(dealId));
    const portalId = await fetchPortalId();
    const html = buildMensajeFacturacion(pendientes, dealName, { empresa_que_factura, persona_que_factura, portalId });
    if (!html) return;

    await write(String(dealId), html);

    logger.info(
      { module: 'cronMensajeFacturacion', fn: 'refreshMensajeFacturacionParaDeal', dealId, ticketCount: pendientes.length },
      '✅ mensaje_de_facturacion actualizado (acumulado)'
    );
  } catch (err) {
    logger.warn(
      { module: 'cronMensajeFacturacion', fn: 'refreshMensajeFacturacionParaDeal', dealId, err },
      'refreshMensajeFacturacionParaDeal falló — no bloquea flujo'
    );
  }
}

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
  const [manualTickets] = await Promise.all([
    searchReadyTickets(TICKET_PIPELINE, TICKET_STAGES.READY),
  ]);

  const allReady = [...manualTickets];
  logger.info(
    { module: 'cronMensajeFacturacion', manual: manualTickets.length, total: allReady.length },
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
      // Cooldown ELIMINADO (4-ago-2026): isDealHot() siempre devuelve false.
      if (!onlyDealId && isDealHot(tickets)) {
        logger.info(
          { module: 'cronMensajeFacturacion', dealId, ticketCount: tickets.length },
          '⏳ Deal caliente, pospuesto'
        );
        skippedHot++;
        continue;
      }

      const { dealName, empresa_que_factura, persona_que_factura } = await getDealInfo(dealId);
      const portalId = await getPortalId();
      const html = buildMensajeFacturacion(tickets, dealName, { empresa_que_factura, persona_que_factura, portalId });

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

    try {
    await setCronState('mensaje_facturacion_last_run', JSON.stringify(summary));
  } catch (err) {
    logger.warn({ module: 'cronMensajeFacturacion', err: err?.message }, 'No se pudo guardar cron state');
  }

  return summary;
}

// ────────────────────────────────────────────────────────────
// CLI
// ────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { deal: null, dry: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry') args.dry = true;
    else if (a === '--force') args.force = true;
    else if (a === '--deal') { args.deal = argv[i + 1] || null; i++; }
  }
  return args;
}

const argv1 = process.argv?.[1];
const isDirectRun =
  typeof argv1 === 'string' &&
  argv1.length > 0 &&
  import.meta.url === pathToFileURL(argv1).href;

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║ 🔴 LA CORRIDA AUTOMÁTICA ESTÁ DESACTIVADA — 4-ago-2026                   ║
// ║                                                                          ║
// ║ El aviso ya no sale en tandas: lo dispara `facturar_ahora = true` en el   ║
// ║ ticket, vía `refreshMensajeFacturacionParaDeal()` (arriba en este mismo   ║
// ║ archivo, llamada desde urgentBillingService.processUrgentTicket).         ║
// ║                                                                          ║
// ║ Los servicios de Railway invocaban esto SIN argumentos, así que una       ║
// ║ invocación pelada no hace nada: si alguno sobrevive a su borrado, o si    ║
// ║ alguien lo redeploya, no manda ningún aviso.                             ║
// ║                                                                          ║
// ║ 🛟 PERO SIGUE SIENDO CORRIBLE A MANO — es la salida de emergencia para    ║
// ║    un ticket que llegó a «Listo para facturar» sin pasar por             ║
// ║    `facturar_ahora` (p. ej. si alguien movió la etapa a mano):            ║
// ║                                                                          ║
// ║      node src/jobs/cronMensajeFacturacion.js --deal 63433773463          ║
// ║      node src/jobs/cronMensajeFacturacion.js --deal 63433773463 --dry    ║
// ║      node src/jobs/cronMensajeFacturacion.js --force        (barrido)    ║
// ║                                                                          ║
// ║ ⚠️ NO comentar el resto del archivo: `refreshMensajeFacturacionParaDeal`  ║
// ║ es el camino nuevo y lo importa urgentBillingService.js.                  ║
// ╚══════════════════════════════════════════════════════════════════════════╝

if (isDirectRun) {
  const { deal, dry, force } = parseArgs(process.argv.slice(2));

  if (!deal && !force) {
    // Invocación pelada = la del cron viejo. No hacer nada.
    logger.info(
      { module: 'cronMensajeFacturacion' },
      'Corrida automática desactivada (4-ago-2026). El aviso lo dispara facturar_ahora del ticket. ' +
      'Para correrlo a mano: --deal <id> (un negocio) o --force (barrido completo).'
    );
  } else {
    try {
      const result = await runCronMensajeFacturacion({ onlyDealId: deal, dry });
      console.log('\nResultado:', JSON.stringify(result, null, 2));
      // Heartbeat solo en el barrido completo (no en dry ni con --deal targeteado)
      if (!dry && !deal) await pingHeartbeat('msjFacturacion');
    } catch (e) {
      logger.error(
        { module: 'cronMensajeFacturacion', error: e?.message || String(e), stack: e?.stack },
        'cron_mensaje_failed'
      );
      process.exitCode = 1;
    }
  }
}