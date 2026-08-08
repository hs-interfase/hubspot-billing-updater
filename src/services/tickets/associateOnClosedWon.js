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
// DECISIÓN reunión 13-jul + AJUSTE usuaria 2026-07-19 + AJUSTE usuaria 2026-07-22
// (regla vigente):
//   - pipeline MANUAL            → SIEMPRE se asocia (pasado y futuro).
//   - pipeline AUTOMÁTICO PASADO → SE ASOCIA (ya ocurrió: es historia del negocio).
//   - pipeline AUTOMÁTICO FUTURO → se asocia SOLO el PRÓXIMO A FACTURAR (el de
//                                  fecha más cercana, por line item). El resto del
//                                  cronograma queda suelto hasta que le toque.
//
// AJUSTE usuaria 2026-08-07 — EL ESPEJO DE UN AUTOMÁTICO:
//   El espejo UY se fuerza a manual (dealMirroring.js), de modo que sus tickets
//   nacen en el pipeline manual y caían en "manual = asociar todo": al negocio
//   espejo se le colgaba el cronograma entero mientras su original mostraba sólo
//   el próximo. Con ASSOC_MIRROR_AS_AUTO=true, un ticket cuyo line item espejo
//   viene de un original AUTOMÁTICO (marca `of_origen_facturacion_automatica`)
//   sigue la regla del automático. El espejo de un MANUAL no cambia.
//   ⚠️ Sólo cambia QUÉ SE ASOCIA: el ticket NO se mueve de etapa — sigue en
//   «Próximos a facturar», que es donde administración lo quiere ver
//   (mirrorUtils.js:232-238 lo pone ahí a propósito).
// El corte pasado/futuro es por `fecha_resolucion_esperada` contra HOY.
// El flag ASSOC_CLOSEDWON_ONLY_MANUAL sigue gobernando el trato especial del
// automático; con el flag en false se asocia todo, como antes.
//
// CÓMO SE AUTO-MANTIENE el "próximo" (22-jul): este hook corre al FINAL de cada
// corrida completa de phases (webhook recalc y cron diario). El día de facturación,
// Phase 3 promueve el forecast a READY (y lo asocia por su propio camino); cuando
// este hook corre en esa misma corrida, ese ticket ya no es futuro y el que sigue
// pasa a ser "el próximo" → se asocia. No hace falta tocar Phase 3.
// Kill-switch: ASSOC_NEXT_AUTO_FORECAST=false vuelve a la regla del 19-jul
// (ningún automático futuro se asocia).
//
// ⚠️ LIMITACIÓN CONOCIDA — ASOCIACIONES RESIDUALES (verificado 2026-07-19, decisión
// usuaria: se ACEPTA, no se corrige por ahora).
//   Este módulo SOLO AGREGA asociaciones; el motor NO DESASOCIA tickets en ningún lado
//   (las únicas llamadas a associations.archive están en dealMirroring.js, y son de
//   line items del espejo). Consecuencia:
//     1. Phase 3 promueve un forecast automático a READY y LO ASOCIA (phase3.js,
//        promoteAutoForecastTicketToReady).
//     2. Una corrida posterior de Phase P lo devuelve a forecast ("Re-snapshot aplicado
//        a ticket forecast").
//     3. El stage vuelve atrás, pero LA ASOCIACIÓN QUEDA COLGADA.
//   → Un ticket automático FUTURO puede aparecer asociado al negocio aunque esta regla
//     diga que no debería. Es un residuo histórico, no un bug activo: se comprobó que
//     tras borrar la asociación a mano y correr el motor completo, NO se vuelve a crear.
//   → NO afecta el cálculo de VALOR/MARGEN (recalcValorTotal busca por of_deal_id, no
//     por asociaciones). Es puramente de VISTA.
//   Si algún día molesta: agregar acá el paso simétrico (desasociar el automático futuro).

import { hubspotClient } from '../../hubspotClient.js';
import { getDealCompanies, getDealContacts, normalizeCompaniesInfo } from './ticketService.js';
import {
  TICKET_PIPELINE,
  ASSOC_TICKET_LABEL_EMPRESA_FACTURA,
  ASSOC_TICKET_LABEL_PARTNER,
} from '../../config/constants.js';
import { reportIfActionable } from '../../utils/errorReporting.js';
import { parseBool } from '../../utils/parsers.js';
import { syncTicketCompanyLabels, ticketLabelSyncEnabled } from './syncTicketCompanyLabels.js';
import logger from '../../../lib/logger.js';

const MODULE = 'associateOnClosedWon';

/** Fecha de hoy en YYYY-MM-DD (UTC), para comparar contra fecha_resolucion_esperada. */
function hoyYMD() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * ¿El ticket es a FUTURO? (su facturación todavía no ocurrió)
 *
 * Regla usuaria 2026-07-19: los tickets automáticos del PASADO sí se asocian al negocio
 * (son historia real); los del FUTURO quedan sueltos hasta que les toque.
 *
 * Sin fecha ⇒ se considera PASADO (conservador: se asocia). Un ticket sin fecha no
 * debería quedar invisible desde el negocio.
 */
function esTicketFuturo(t, hoy) {
  const f = String(t?.properties?.fecha_resolucion_esperada || '').slice(0, 10);
  if (!f) return false;
  return f > hoy;
}

/**
 * ¿El ticket es de un line item ESPEJO cuyo ORIGEN factura automático?
 *
 * El espejo UY se fuerza siempre a manual (dealMirroring.js: `facturacion_automatica
 * = 'false'`), así que sus tickets nacen en el pipeline manual y hasta hoy caían en
 * la rama "manual = asociar todo". Resultado: al negocio espejo de un automático se
 * le colgaba el cronograma entero, mientras que a su original sólo el próximo.
 *
 * `of_origen_facturacion_automatica` sella cómo factura la línea PY de origen y viaja
 * LI PY → LI espejo → ticket (snapshotService). Vacía en todo lo que no es espejo.
 *
 * El espejo de un line item MANUAL no entra acá: ese comportamiento ya es el correcto.
 */
function esEspejoDeAutomatico(t) {
  return String(t?.properties?.of_origen_facturacion_automatica || '')
    .trim().toLowerCase() === 'true';
}

/**
 * ¿A este ticket le toca la regla del AUTOMÁTICO (pasado + sólo el próximo por line
 * item), en vez de la del manual (asociar todo)?
 *
 * Dos caminos: estar en el pipeline automático, o ser el espejo de un automático
 * (que vive en el manual por la fuerza, no por naturaleza).
 *
 * El segundo camino está detrás de ASSOC_MIRROR_AS_AUTO (default OFF): apagada, el
 * comportamiento es exactamente el de siempre.
 */
function usaReglaAutomatica(t, mirrorComoAuto) {
  const pipeline = String(t?.properties?.hs_pipeline || '');
  if (pipeline !== TICKET_PIPELINE) return true;
  return mirrorComoAuto && esEspejoDeAutomatico(t);
}

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
      properties: ['of_deal_id', 'of_ticket_key', 'of_line_item_key', 'hs_pipeline', 'hs_pipeline_stage', 'fecha_resolucion_esperada', 'of_origen_facturacion_automatica'],
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
 * @param {boolean} [params.associateNextAuto]  override de "asociar el próximo automático
 *                                              por facturar" (default: env
 *                                              ASSOC_NEXT_AUTO_FORECAST, prendido si falta)
 * @returns {Promise<{applies:boolean, ticketsFound:number, considered:number,
 *   dealLinked:number, companyLinked:number, contactLinked:number,
 *   alreadyLinked:number, skippedByPipeline:number, autoPastLinked:number,
 *   autoNextLinked:number, errors:number}>}
 */
export async function associateAllTicketsOnClosedWon({
  dealId,
  dealProps,
  onlyManualPipeline = null,
  associateNextAuto = null,
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
    skippedByPipeline: 0,   // automáticos FUTUROS: quedan sin asociar a propósito
    autoPastLinked: 0,      // automáticos PASADOS que sí se asocian (regla 19-jul)
    autoNextLinked: 0,      // el PRÓXIMO automático por facturar (regla 22-jul)
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

  const hoy = hoyYMD();
  const consideredIds = [];

  // Regla 22-jul: del cronograma automático FUTURO se asocia el PRÓXIMO a facturar
  // de cada line item (fecha_resolucion_esperada más chica; empate → id más bajo,
  // determinístico). Los tickets sin key de line item caen a un grupo único: mejor
  // asociar uno de más que dejar el próximo invisible.
  // Env ausente O VACÍO ⇒ prendido (una var creada sin valor en Railway no lo apaga
  // por accidente); apagar es explícito: ASSOC_NEXT_AUTO_FORECAST=false.
  const rawNextAuto = String(process.env.ASSOC_NEXT_AUTO_FORECAST ?? '').trim();
  const nextAuto = associateNextAuto !== null
    ? associateNextAuto
    : (rawNextAuto === '' ? true : parseBool(rawNextAuto));

  // ESPEJO DE UN AUTOMÁTICO (7-ago): el espejo UY se fuerza a manual, así que sus
  // tickets viven en el pipeline manual y hasta hoy se asociaban TODOS, al revés de
  // lo que hace su original. Con la llave prendida se les aplica la regla del
  // automático: pasado + sólo el próximo a facturar por line item. No se los mueve
  // de etapa — siguen en «Próximos a facturar», que es donde administración los
  // quiere ver. El espejo de un MANUAL no cambia.
  // Default OFF: apagada, el comportamiento es idéntico al de hoy.
  const mirrorComoAuto = parseBool(process.env.ASSOC_MIRROR_AS_AUTO);

  const nextAutoIds = new Set();
  if (onlyManual && nextAuto && TICKET_PIPELINE) {
    const proximoPorLi = new Map();
    for (const t of tickets) {
      if (!usaReglaAutomatica(t, mirrorComoAuto)) continue;  // manual puro: se asocia siempre
      if (!esTicketFuturo(t, hoy)) continue;                 // pasado: ya se asocia
      const grupo =
        String(t.properties?.of_line_item_key || '').trim() ||
        String(t.properties?.of_ticket_key || '').replace(/::\d{4}-\d{2}-\d{2}$/, '').trim() ||
        '(sin_key)';
      const fecha = String(t.properties?.fecha_resolucion_esperada || '').slice(0, 10);
      const prev = proximoPorLi.get(grupo);
      if (!prev || fecha < prev.fecha || (fecha === prev.fecha && Number(t.id) < Number(prev.id))) {
        proximoPorLi.set(grupo, { id: String(t.id), fecha });
      }
    }
    for (const v of proximoPorLi.values()) nextAutoIds.add(v.id);
  }

  for (const t of tickets) {
    const ticketId = String(t.id);

    // Regla del AUTOMÁTICO: se asocia si su facturación ya ocurrió (pasado) o si es
    // el próximo a facturar de su line item. El resto del cronograma futuro queda
    // sin asociar. La aplican los tickets del pipeline automático y los del espejo
    // de un automático (llave ASSOC_MIRROR_AS_AUTO). El manual puro pasa siempre.
    if (onlyManual && TICKET_PIPELINE && usaReglaAutomatica(t, mirrorComoAuto)) {
      if (esTicketFuturo(t, hoy)) {
        if (!nextAutoIds.has(ticketId)) {
          stats.skippedByPipeline++;
          continue;
        }
        stats.autoNextLinked++;
      } else {
        stats.autoPastLinked++;
      }
    }
    stats.considered++;
    consideredIds.push(ticketId);

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

  // RE-SYNC de etiquetas de empresa (29-jul). El bloque de arriba sólo etiqueta los
  // tickets que RECIÉN se vincularon (`linkedNow`); los que ya estaban asociados y los
  // cambios posteriores de etiqueta en el negocio los corrige este paso, que compara y
  // ajusta (agrega faltantes, quita sobrantes). Gateado por TICKET_LABEL_SYNC_ENABLED:
  // apagado ⇒ comportamiento idéntico al anterior. Reusa la lectura de companies ya
  // hecha (no gasta otro GET).
  if (consideredIds.length && ticketLabelSyncEnabled()) {
    try {
      stats.labelSync = await syncTicketCompanyLabels({
        dealId,
        ticketIds: consideredIds,
        client,
        getDealCompaniesFn: () => companiesInfo,
      });
    } catch (err) {
      stats.errors++;
      logger.warn({ module: MODULE, dealId, err }, 'Error en el re-sync de etiquetas de empresa (no bloquea)');
    }
  }

  // ❌ EL RESUMEN DE CRONOGRAMA AL CIERRE GANADO SALIÓ DEL MOTOR (30-jul).
  // La TANDA A lo había implementado acá (un email con todo el cronograma,
  // idempotente por `of_resumen_cronograma_enviado`). Decisión de la usuaria:
  // ese aviso lo arma ella con un WORKFLOW de HubSpot, así que el motor no
  // manda ninguno — dos fuentes del mismo aviso = dos correos por negocio.
  // La prop `of_resumen_cronograma_enviado` YA NO VA: no hay que crearla.
  //
  // 31-jul: el aviso individual de 1 mes siguió el MISMO camino — también lo
  // manda un workflow de HubSpot, así que se borró del motor
  // (`individualBillingReminderAlert.js` + los dos hooks de phase2.js) y la
  // prop `of_aviso_1mes_enviado` TAMPOCO va. El motor no manda NINGUNO de los
  // dos avisos al responsable: los dos son de HubSpot.

  logger.info({ module: MODULE, dealId, ...stats }, 'Asociación de tickets al closedwon completada');
  return stats;
}
