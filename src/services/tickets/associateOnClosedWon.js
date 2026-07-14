// src/services/tickets/associateOnClosedWon.js
//
// Fase 3 — Tickets asociados al negocio al cierre ganado.
//
// Los tickets forecast NACEN SIN asociación al deal (safeCreateTicket en
// phasep.js, sin associations) → antes del cierre NO se ven desde el negocio.
// La asociación se crea recién al promover/emitir cada ticket (uno a uno).
//
// Este hook cierra la brecha: cuando el negocio queda GANADO (facturacion_activa),
// asocia DE UNA VEZ todos los tickets del deal que aún no lo estén, para que el
// cronograma completo se vea desde el negocio sin esperar a que cada ticket se
// promueva. El descubrimiento es por Search (of_deal_id), no por asociación, así
// que este cambio es ADITIVO: no altera cómo el motor encuentra sus tickets.
//
// Idempotente (solo asocia lo que falta) y gateado por flag ASSOC_ALL_ON_CLOSEDWON.
// Patrón probado en scripts/fix/fixTicketAssociations.mjs, acá vía el hubspotClient
// del motor (rate-limit + retry del proxy).
//
// DECISIÓN reunión 13-jul (resuelve "todos vs solo manuales"): SOLO el pipeline
// MANUAL se asocia al ganar (ASSOC_CLOSEDWON_ONLY_MANUAL=true). Los tickets del
// pipeline AUTOMÁTICO NO se asocian; se muestran ordenados por fecha en la vista
// del negocio (facturados / listo-notificado / próximo-sin-notificar).

import { hubspotClient } from '../../hubspotClient.js';
import { getDealCompanies, getDealContacts, normalizeCompaniesInfo } from './ticketService.js';
import {
  TICKET_PIPELINE,
  ASSOC_TICKET_LABEL_EMPRESA_FACTURA,
  ASSOC_TICKET_LABEL_PARTNER,
} from '../../config/constants.js';
import { reportIfActionable } from '../../utils/errorReporting.js';
import { parseBool } from '../../utils/parsers.js';
import logger from '../../../lib/logger.js';

const MODULE = 'associateOnClosedWon';

/**
 * Busca por Search todos los tickets con of_deal_id === dealId.
 * Keyset pagination por hs_object_id (mismo patrón que fixTicketAssociations.mjs).
 */
async function fetchTicketsForDealBySearch(client, dealId) {
  const all = [];
  let lastId = '0';

  for (;;) {
    const body = {
      filterGroups: [{
        filters: [
          { propertyName: 'of_deal_id', operator: 'EQ', value: String(dealId) },
          { propertyName: 'hs_object_id', operator: 'GT', value: lastId },
        ],
      }],
      properties: ['of_deal_id', 'of_ticket_key', 'hs_pipeline', 'hs_pipeline_stage'],
      sorts: [{ propertyName: 'hs_object_id', direction: 'ASCENDING' }],
      limit: 100,
    };

    const resp = await client.crm.tickets.searchApi.doSearch(body);
    const results = resp?.results || [];
    if (!results.length) break;

    all.push(...results);
    lastId = results[results.length - 1].id;

    if (results.length < 100) break;
  }

  return all;
}

/** Set de IDs ya asociados ticket→<toType>. 404 (objeto inexistente) → set vacío. */
async function ticketAssocSet(client, ticketId, toType) {
  try {
    const resp = await client.crm.associations.v4.basicApi.getPage(
      'tickets', String(ticketId), toType, undefined, 100
    );
    return new Set((resp?.results || []).map(r => String(r.toObjectId)));
  } catch (err) {
    const status = err?.response?.status ?? err?.statusCode;
    if (status === 404) return new Set();
    throw err;
  }
}

/** Crea la asociación ticket→<toType> si no existe. Devuelve true si la creó. */
async function ensureAssoc(client, ticketId, toType, toId, existing) {
  if (existing.has(String(toId))) return false;
  await client.crm.associations.v4.basicApi.create('tickets', String(ticketId), toType, String(toId), []);
  return true;
}

/**
 * Asocia al negocio (y a sus companies/contacts) todos los tickets del deal que
 * aún no lo estén. Solo aplica si el negocio está en facturación activa (ganado).
 *
 * @param {Object}  params
 * @param {string}  params.dealId
 * @param {Object}  params.dealProps            props del deal (necesita facturacion_activa)
 * @param {boolean} [params.onlyManualPipeline] override del filtro por pipeline manual
 *                                              (default: env ASSOC_CLOSEDWON_ONLY_MANUAL)
 * @returns {Promise<{applies:boolean, ticketsFound:number, considered:number,
 *   dealLinked:number, companyLinked:number, contactLinked:number,
 *   alreadyLinked:number, skippedByPipeline:number, errors:number}>}
 */
export async function associateAllTicketsOnClosedWon({
  dealId,
  dealProps,
  onlyManualPipeline = null,
  // Inyectables solo para tests (defaults = producción).
  client = hubspotClient,
  getDealCompaniesFn = getDealCompanies,
  getDealContactsFn = getDealContacts,
}) {
  dealId = String(dealId);
  const stats = {
    applies: false,
    ticketsFound: 0,
    considered: 0,
    dealLinked: 0,
    companyLinked: 0,
    contactLinked: 0,
    alreadyLinked: 0,
    skippedByPipeline: 0,
    errors: 0,
  };

  // Solo al ganar el negocio (facturación activa). Antes del cierre los forecast
  // deben permanecer sin asociar (invisibles desde el negocio) — es el diseño.
  if (!parseBool(dealProps?.facturacion_activa)) {
    return stats;
  }
  stats.applies = true;

  const onlyManual = onlyManualPipeline !== null
    ? onlyManualPipeline
    : parseBool(process.env.ASSOC_CLOSEDWON_ONLY_MANUAL);

  let tickets;
  try {
    tickets = await fetchTicketsForDealBySearch(client, dealId);
  } catch (err) {
    stats.errors++;
    logger.error({ module: MODULE, dealId, err }, 'Error buscando tickets del deal para asociar en closedwon');
    return stats;
  }

  stats.ticketsFound = tickets.length;
  if (!tickets.length) return stats;

  // Companies/contacts del deal: una sola lectura, se reutiliza para todos.
  // getDealCompanies devuelve { ids, facturaId, partnerId }; los tests legacy
  // inyectan arrays de ids → normalizeCompaniesInfo acepta ambas formas.
  let companiesInfo = { ids: [], facturaId: null, partnerId: null };
  let contactIds = [];
  try { companiesInfo = normalizeCompaniesInfo(await getDealCompaniesFn(dealId)); } catch { /* getDealCompanies ya loguea */ }
  try { contactIds = await getDealContactsFn(dealId); } catch { /* getDealContacts ya loguea */ }
  const companyIds = companiesInfo.ids;

  // Specs de etiqueta ticket→company para Empresa Factura / Partner.
  const companyLabelSpecs = (companyId) => {
    const specs = [];
    if (ASSOC_TICKET_LABEL_EMPRESA_FACTURA > 0 && companyId === companiesInfo.facturaId) {
      specs.push({ associationCategory: 'USER_DEFINED', associationTypeId: ASSOC_TICKET_LABEL_EMPRESA_FACTURA });
    }
    if (ASSOC_TICKET_LABEL_PARTNER > 0 && companyId === companiesInfo.partnerId) {
      specs.push({ associationCategory: 'USER_DEFINED', associationTypeId: ASSOC_TICKET_LABEL_PARTNER });
    }
    return specs;
  };

  for (const t of tickets) {
    const ticketId = String(t.id);
    const pipeline = String(t.properties?.hs_pipeline || '');

    // Filtro opcional: asociar solo los tickets del pipeline manual.
    if (onlyManual && TICKET_PIPELINE && pipeline !== TICKET_PIPELINE) {
      stats.skippedByPipeline++;
      continue;
    }
    stats.considered++;

    try {
      const dealSet = await ticketAssocSet(client, ticketId, 'deals');
      const linkedNow = await ensureAssoc(client, ticketId, 'deals', dealId, dealSet);
      if (linkedNow) stats.dealLinked++;
      else stats.alreadyLinked++;

      // Companies/contacts: solo para los que recién vinculamos (los que ya
      // estaban asociados al deal fueron promovidos y ya recibieron el resto).
      if (linkedNow && (companyIds.length || contactIds.length)) {
        if (companyIds.length) {
          const compSet = await ticketAssocSet(client, ticketId, 'companies');
          for (const c of companyIds) {
            if (await ensureAssoc(client, ticketId, 'companies', c, compSet)) stats.companyLinked++;
            const specs = companyLabelSpecs(String(c));
            if (specs.length) {
              await client.crm.associations.v4.basicApi.create('tickets', ticketId, 'companies', String(c), specs);
            }
          }
        }
        if (contactIds.length) {
          const contSet = await ticketAssocSet(client, ticketId, 'contacts');
          for (const c of contactIds) {
            if (await ensureAssoc(client, ticketId, 'contacts', c, contSet)) stats.contactLinked++;
          }
        }
      }
    } catch (err) {
      stats.errors++;
      reportIfActionable({
        objectType: 'ticket',
        objectId: ticketId,
        message: `No se pudo asociar el ticket al negocio ${dealId} al cierre ganado`,
        err,
      });
      logger.warn({ module: MODULE, dealId, ticketId, err }, 'Error asociando ticket en closedwon (no bloquea el resto)');
    }
  }

  logger.info({ module: MODULE, dealId, ...stats }, 'Asociación de tickets al closedwon completada');
  return stats;
}
