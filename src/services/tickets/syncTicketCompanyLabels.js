// src/services/tickets/syncTicketCompanyLabels.js
//
// RE-SYNC de las asociaciones ticket→empresa contra las del NEGOCIO.
//
// El pedido (29-jul): el ticket tiene que llevar asociadas las MISMAS empresas del
// negocio y con las MISMAS etiquetas — "Empresa Factura" y "Partner" —, no sólo la
// principal.
//
// Eso ya se escribe al CREAR el ticket (ticketService.createTicketAssociations) y al
// GANAR el negocio (associateOnClosedWon), pero en el segundo caso sólo para los
// tickets que el hook RECIÉN vincula (`if (linkedNow …)`). Quedaban dos huecos:
//
//   1. Un ticket ya asociado de antes NUNCA recibía la etiqueta.
//   2. Si después del cierre cambian en el negocio qué empresa factura o quién es el
//      partner, el ticket se quedaba con la etiqueta vieja (el motor sólo agrega).
//
// Este módulo cierra los dos: compara y CORRIGE — agrega las etiquetas que faltan y
// QUITA las que sobran. Es la única pieza del motor que quita etiquetas, y lo hace de
// forma quirúrgica: `archiveLabels` borra el label del par, NO la asociación. La
// asociación sin etiqueta (la nativa ticket↔company) siempre sobrevive.
//
// ⚠️ NO desasocia empresas. Si una empresa dejó de estar en el negocio, el ticket la
// conserva asociada pero SIN etiqueta (se respeta la regla vigente "el motor no
// desasocia tickets", ver la limitación conocida de associateOnClosedWon.js).
//
// Gateado por TICKET_LABEL_SYNC_ENABLED (default OFF) y por tener al menos una etiqueta
// configurada (ASSOC_TICKET_LABEL_EMPRESA_FACTURA / _PARTNER; 0 = off). Con la llave
// apagada el comportamiento es exactamente el de hoy.
//
// Costo: 1 GET de asociaciones por ticket + los writes de lo que falte. Corre por
// NEGOCIO (pocos tickets por vez), no barre el portal.

import { hubspotClient } from '../../hubspotClient.js';
import { getDealCompanies, normalizeCompaniesInfo } from './ticketService.js';
import {
  ASSOC_TICKET_LABEL_EMPRESA_FACTURA,
  ASSOC_TICKET_LABEL_PARTNER,
} from '../../config/constants.js';
import { parseBool } from '../../utils/parsers.js';
import logger from '../../../lib/logger.js';

const MODULE = 'syncTicketCompanyLabels';

/** ¿Está prendido el re-sync? Env ausente/vacía ⇒ APAGADO (se prende explícito). */
export function ticketLabelSyncEnabled() {
  return parseBool(process.env.TICKET_LABEL_SYNC_ENABLED);
}

/**
 * Mapa companyId → Set(typeId) de las asociaciones actuales del ticket.
 * 404 (ticket inexistente) ⇒ mapa vacío.
 */
async function ticketCompanyTypes(client, ticketId) {
  try {
    const resp = await client.crm.associations.v4.basicApi.getPage(
      'tickets', String(ticketId), 'companies', undefined, 100
    );
    const mapa = new Map();
    for (const r of resp?.results || []) {
      const cid = String(r.toObjectId);
      const tipos = new Set((r.associationTypes || []).map(t => Number(t.typeId)));
      // Un mismo par puede venir repetido por tipo según la respuesta: se acumula.
      if (mapa.has(cid)) for (const t of tipos) mapa.get(cid).add(t);
      else mapa.set(cid, tipos);
    }
    return mapa;
  } catch (err) {
    const status = err?.response?.status ?? err?.statusCode;
    if (status === 404) return new Map();
    throw err;
  }
}

/** Tickets asociados al negocio (paginado). */
async function ticketsDelDeal(client, dealId) {
  const ids = [];
  let after;
  for (;;) {
    const resp = await client.crm.associations.v4.basicApi.getPage(
      'deals', String(dealId), 'tickets', after, 100
    );
    for (const r of resp?.results || []) ids.push(String(r.toObjectId));
    after = resp?.paging?.next?.after;
    if (!after) break;
  }
  return ids;
}

/**
 * Etiquetas que DEBERÍA tener cada empresa del negocio, según sus etiquetas allá.
 * Devuelve Map(companyId → Set(typeId)). Una misma empresa puede llevar las dos:
 * es el caso de los espejos, donde dealMirroring etiqueta a Interfase UY como
 * Empresa Factura Y Partner a la vez.
 */
function etiquetasDeseadas(info, labelEF, labelPartner) {
  const deseado = new Map();
  const agregar = (cid, typeId) => {
    if (!cid || !typeId) return;
    const k = String(cid);
    if (!deseado.has(k)) deseado.set(k, new Set());
    deseado.get(k).add(Number(typeId));
  };
  agregar(info.facturaId, labelEF);
  agregar(info.partnerId, labelPartner);
  return deseado;
}

/**
 * Re-sincroniza las asociaciones ticket→empresa de un negocio.
 *
 * @param {object}   params
 * @param {string}   params.dealId
 * @param {string[]} [params.ticketIds]   tickets a revisar; si falta, los asociados al deal
 * @param {boolean}  [params.dryRun]      calcula y loguea, no escribe
 * @param {object}   [params.client]              inyectable (tests)
 * @param {Function} [params.getDealCompaniesFn]  inyectable (tests)
 * @param {number}   [params.labelEmpresaFactura] inyectable (tests)
 * @param {number}   [params.labelPartner]        inyectable (tests)
 * @param {boolean}  [params.enabled]             override del flag (tests)
 * @returns {Promise<{applies:boolean, skipped?:boolean, reason?:string,
 *   ticketsRevisados:number, companiesAsociadas:number, labelsAgregados:number,
 *   labelsQuitados:number, errors:number}>}
 */
export async function syncTicketCompanyLabels({
  dealId,
  ticketIds = null,
  dryRun = false,
  // Inyectables solo para tests (defaults = producción).
  client = hubspotClient,
  getDealCompaniesFn = getDealCompanies,
  labelEmpresaFactura = ASSOC_TICKET_LABEL_EMPRESA_FACTURA,
  labelPartner = ASSOC_TICKET_LABEL_PARTNER,
  enabled = null,
} = {}) {
  const stats = {
    applies: false,
    ticketsRevisados: 0,
    companiesAsociadas: 0,
    labelsAgregados: 0,
    labelsQuitados: 0,
    errors: 0,
  };

  const on = enabled !== null ? enabled : ticketLabelSyncEnabled();
  if (!on) return { ...stats, skipped: true, reason: 'flag_off' };

  const labelEF = Number(labelEmpresaFactura) > 0 ? Number(labelEmpresaFactura) : 0;
  const labelPA = Number(labelPartner) > 0 ? Number(labelPartner) : 0;
  if (!labelEF && !labelPA) {
    return { ...stats, skipped: true, reason: 'labels_no_configurados' };
  }

  const gestionados = [labelEF, labelPA].filter(Boolean);

  let info;
  try {
    info = normalizeCompaniesInfo(await getDealCompaniesFn(dealId));
  } catch (err) {
    logger.warn({ module: MODULE, dealId, err }, 'No se pudieron leer las empresas del negocio');
    return { ...stats, skipped: true, reason: 'sin_empresas_del_deal', errors: 1 };
  }
  if (!info.ids?.length) {
    return { ...stats, skipped: true, reason: 'sin_empresas_del_deal' };
  }

  let ids = ticketIds;
  if (!ids) {
    try {
      ids = await ticketsDelDeal(client, dealId);
    } catch (err) {
      logger.warn({ module: MODULE, dealId, err }, 'No se pudieron listar los tickets del negocio');
      return { ...stats, skipped: true, reason: 'sin_tickets', errors: 1 };
    }
  }
  ids = [...new Set((ids || []).map(String))];
  if (!ids.length) return { ...stats, skipped: true, reason: 'sin_tickets' };

  stats.applies = true;
  const deseado = etiquetasDeseadas(info, labelEF, labelPA);

  for (const ticketId of ids) {
    try {
      const actual = await ticketCompanyTypes(client, ticketId);
      stats.ticketsRevisados++;

      // 1) Las empresas del negocio que el ticket todavía no tiene asociadas.
      //    (El pedido incluye esto: hoy muchos tickets tienen sólo la principal.)
      for (const cid of info.ids.map(String)) {
        if (actual.has(cid)) continue;
        if (!dryRun) {
          await client.crm.associations.v4.basicApi.create('tickets', ticketId, 'companies', cid, []);
        }
        actual.set(cid, new Set());
        stats.companiesAsociadas++;
      }

      // 2) Etiquetas faltantes. Se manda el set COMPLETO deseado del par en una
      //    sola llamada: el endpoint de labels define los USER_DEFINED del par,
      //    así mandar EF+Partner juntos (caso espejo) no se pisa a sí mismo.
      for (const [cid, tipos] of deseado.entries()) {
        const tieneTodos = [...tipos].every(t => actual.get(cid)?.has(t));
        if (tieneTodos) continue;
        const specs = [...tipos].map(t => ({
          associationCategory: 'USER_DEFINED',
          associationTypeId: t,
        }));
        if (!dryRun) {
          await client.crm.associations.v4.basicApi.create('tickets', ticketId, 'companies', cid, specs);
        }
        stats.labelsAgregados += [...tipos].filter(t => !actual.get(cid)?.has(t)).length;
      }

      // 3) Etiquetas sobrantes: el par tiene una etiqueta GESTIONADA que ya no le
      //    corresponde (cambió la empresa que factura / el partner, o la empresa
      //    salió del negocio). Se archiva SOLO el label; la asociación queda.
      for (const [cid, tipos] of actual.entries()) {
        const sobrantes = [...tipos].filter(
          t => gestionados.includes(t) && !deseado.get(cid)?.has(t)
        );
        if (!sobrantes.length) continue;
        if (!dryRun) {
          await client.crm.associations.v4.batchApi.archiveLabels('tickets', 'companies', {
            inputs: sobrantes.map(t => ({
              _from: { id: ticketId },
              to: { id: cid },
              types: [{ associationCategory: 'USER_DEFINED', associationTypeId: t }],
            })),
          });
        }
        stats.labelsQuitados += sobrantes.length;
        logger.info(
          { module: MODULE, dealId, ticketId, companyId: cid, sobrantes, dryRun },
          'Etiqueta de empresa retirada del ticket (ya no corresponde en el negocio)'
        );
      }
    } catch (err) {
      stats.errors++;
      logger.warn(
        { module: MODULE, dealId, ticketId, err },
        'Error re-sincronizando etiquetas de empresa del ticket (no bloquea el resto)'
      );
    }
  }

  logger.info(
    { module: MODULE, dealId, facturaId: info.facturaId, partnerId: info.partnerId, dryRun, ...stats },
    'Re-sync de etiquetas ticket→empresa completado'
  );
  return stats;
}
