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
 * ¿Se actualizan también las dos props de TEXTO del ticket? (REGLAS §4.18)
 * Env ausente/vacía ⇒ APAGADO. Llave propia porque esto ESCRIBE en el ticket, y el
 * re-sync de etiquetas ya está prendido en producción: sin llave, mergear cambiaría
 * el comportamiento de PROD en el mismo movimiento.
 */
export function ticketCompanyPropsSyncEnabled() {
  return parseBool(process.env.TICKET_COMPANY_PROPS_SYNC_ENABLED);
}

/**
 * Mapa companyId → Map(typeId → category) de las asociaciones actuales del ticket.
 * Se guarda la CATEGORÍA además del typeId porque hace falta para no destruir nada
 * al escribir (ver `specsPreservando`).
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
      // Un mismo par puede venir repetido por tipo según la respuesta: se acumula.
      if (!mapa.has(cid)) mapa.set(cid, new Map());
      const m = mapa.get(cid);
      for (const t of r.associationTypes || []) {
        m.set(Number(t.typeId), String(t.category || 'USER_DEFINED'));
      }
    }
    return mapa;
  } catch (err) {
    const status = err?.response?.status ?? err?.statusCode;
    if (status === 404) return new Map();
    throw err;
  }
}

/**
 * Specs para el PUT de etiquetas de UN par ticket↔empresa.
 *
 * ⚠️ EL PUT REEMPLAZA los tipos del par, no los suma (verificado en sandbox el
 * 29-jul: marcar la empresa como **Primary** y después aplicar "Empresa Factura"
 * dejaba el par SIN el Primary). Por eso los specs incluyen:
 *   - todo lo que el par ya tiene (con su categoría) — Primary, otras etiquetas
 *     puestas a mano, etc. — EXCEPTO las etiquetas gestionadas que ya no
 *     corresponden (esas se van, que es justo el objetivo del re-sync);
 *   - más las etiquetas gestionadas que sí corresponden.
 * El tipo "sin etiqueta" (HUBSPOT_DEFINED 339 en ticket→company) HubSpot lo
 * repone solo, pero se manda igual: es idempotente y evita depender de eso.
 *
 * @param {Map<number,string>} actualesDelPar typeId → category
 * @param {Set<number>}        deseadas       typeIds gestionados que corresponden
 * @param {number[]}           gestionados    typeIds que este módulo administra
 */
function specsPreservando(actualesDelPar, deseadas, gestionados) {
  const specs = [];
  for (const [typeId, category] of actualesDelPar || []) {
    const esGestionada = gestionados.includes(typeId) && category === 'USER_DEFINED';
    if (esGestionada && !deseadas.has(typeId)) continue;   // sobrante: no se re-manda
    specs.push({ associationCategory: category, associationTypeId: typeId });
  }
  for (const typeId of deseadas) {
    if (!specs.some(s => s.associationTypeId === typeId && s.associationCategory === 'USER_DEFINED')) {
      specs.push({ associationCategory: 'USER_DEFINED', associationTypeId: typeId });
    }
  }
  return specs;
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
  propsEnabled = null,
} = {}) {
  const stats = {
    applies: false,
    ticketsRevisados: 0,
    companiesAsociadas: 0,
    labelsAgregados: 0,
    labelsQuitados: 0,
    propsActualizadas: 0,
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

  // Las dos props de TEXTO del ticket — «Cliente que factura» (`empresa_que_factura`)
  // y «Cliente partner» (`cliente_partner`). REGLAS §4.18: el ticket es el documento
  // definitivo de la factura, así que estos datos viven EN el ticket y NO dependen de
  // que las empresas estén asociadas. `buildTicketFullProps` los escribe al CREAR;
  // acá se ACTUALIZAN cuando cambian las empresas o las etiquetas del negocio (el
  // único camino que existía —el re-snapshot de Phase P— está omitido bajo la etapa
  // única, así que sin esto el ticket se queda con el valor del día que nació).
  // Los nombres se leen UNA vez por negocio, no por ticket.
  const escribirProps = propsEnabled !== null ? propsEnabled : ticketCompanyPropsSyncEnabled();
  const propsDeseadas = { empresa_que_factura: '', cliente_partner: '' };
  if (escribirProps) {
    const nombres = new Map();
    for (const cid of [...new Set([info.facturaId, info.partnerId].filter(Boolean).map(String))]) {
      try {
        nombres.set(cid, (await client.crm.companies.basicApi.getById(cid, ['name']))?.properties?.name || '');
      } catch (err) {
        // Empresa borrada o sin permiso: se deja vacío y se sigue. Vaciar es
        // deliberado — si la empresa ya no está, el dato viejo del ticket miente.
        logger.warn({ module: MODULE, dealId, companyId: cid, err }, 'No se pudo leer el nombre de la empresa etiquetada');
        nombres.set(cid, '');
      }
    }
    propsDeseadas.empresa_que_factura = info.facturaId ? (nombres.get(String(info.facturaId)) || '') : '';
    propsDeseadas.cliente_partner = info.partnerId ? (nombres.get(String(info.partnerId)) || '') : '';
  }

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
        actual.set(cid, new Map());
        stats.companiesAsociadas++;
      }

      // 2) Etiquetas faltantes. Se manda el set COMPLETO del par en una sola
      //    llamada (ver specsPreservando: el PUT reemplaza, así que hay que
      //    re-mandar lo que ya estaba). Mandar EF+Partner juntos —el caso
      //    espejo— tampoco se pisa a sí mismo.
      for (const [cid, tipos] of deseado.entries()) {
        const tieneTodos = [...tipos].every(t => actual.get(cid)?.has(t));
        if (tieneTodos) continue;
        const faltantes = [...tipos].filter(t => !actual.get(cid)?.has(t));
        const specs = specsPreservando(actual.get(cid), tipos, gestionados);
        if (!dryRun) {
          await client.crm.associations.v4.basicApi.create('tickets', ticketId, 'companies', cid, specs);
        }
        // El PUT ya dejó el par en su estado final: se refleja en el mapa local
        // para que el paso 3 no intente archivar algo que este PUT ya quitó.
        const nuevo = new Map();
        for (const s of specs) nuevo.set(Number(s.associationTypeId), s.associationCategory);
        actual.set(cid, nuevo);
        stats.labelsAgregados += faltantes.length;
      }

      // 3) Etiquetas sobrantes: el par tiene una etiqueta GESTIONADA que ya no le
      //    corresponde (cambió la empresa que factura / el partner, o la empresa
      //    salió del negocio). Se archiva SOLO el label; la asociación queda.
      for (const [cid, tipos] of actual.entries()) {
        const sobrantes = [...tipos.entries()]
          .filter(([t, cat]) => cat === 'USER_DEFINED' && gestionados.includes(t) && !deseado.get(cid)?.has(t))
          .map(([t]) => t);
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

      // 4) Las dos props de TEXTO del ticket (REGLAS §4.18). Patch mínimo: sólo se
      //    escribe lo que difiere, así el re-sync sigue siendo idempotente y no
      //    ensucia `hs_lastmodifieddate` de tickets que ya estaban bien.
      if (escribirProps) {
        let actualesProps = {};
        try {
          actualesProps = (await client.crm.tickets.basicApi.getById(
            String(ticketId), ['empresa_que_factura', 'cliente_partner']
          ))?.properties || {};
        } catch (err) {
          logger.warn({ module: MODULE, dealId, ticketId, err }, 'No se pudieron leer las props de empresa del ticket');
          actualesProps = null;
        }
        if (actualesProps) {
          const patch = {};
          for (const [k, v] of Object.entries(propsDeseadas)) {
            if (String(actualesProps[k] ?? '') !== String(v ?? '')) patch[k] = v;
          }
          if (Object.keys(patch).length) {
            if (!dryRun) await client.crm.tickets.basicApi.update(String(ticketId), { properties: patch });
            stats.propsActualizadas++;
            logger.info(
              { module: MODULE, dealId, ticketId, patch, dryRun },
              'Props de empresa del ticket actualizadas desde el negocio'
            );
          }
        }
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
