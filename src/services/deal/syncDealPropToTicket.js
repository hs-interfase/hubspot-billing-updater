// src/services/deal/syncDealPropToTicket.js
//
// TANDA E (§5.bis del plan) — SYNC QUIRÚRGICO por-propiedad Negocio → Ticket.
//
// Gemelo de `services/lineItems/syncLineItemPropToTicket.js`, pero del otro lado:
// hay dos props del ticket cuyo origen NO es el line item sino el NEGOCIO, y por eso
// no pueden ir por LI_PROP_TO_TICKET_KEYS por más cómodo que resulte:
//
//   · VENDEDOR → `of_propietario_secundario` = `hubspot_owner_id` DEL NEGOCIO.
//   · MONEDA   → `of_moneda`                 = `deal_currency_code` DEL NEGOCIO.
//
// Las dos ya se escriben al crear el ticket (`extractDealSnapshots`, snapshotService),
// así que el ticket NACE bien. El agujero es después: si el negocio se reasigna a otro
// vendedor, o le cambian la moneda, los tickets ya creados se quedan con el valor viejo
// y nadie los actualiza. Consecuencia concreta: el workflow `1771473309` de PROD (que al
// pasar a «Notificado» avisa al owner del ticket Y a `of_propietario_secundario`) le
// termina avisando al vendedor ANTERIOR.
//
// Mecanismo: ante un `deal.propertyChange` de una de esas dos props, se escribe SOLO la
// clave de ticket que esa prop influye, sobre los tickets del negocio que el motor todavía
// manda (no notificados). No hay re-snapshot: igual que en el sync del line item, no se
// pisa nada que el responsable haya editado en otras props.
//
// ALCANCE (el mismo que el sync LI→ticket, a propósito): pipeline MANUAL y etapa no
// notificada. Los tickets que ya cruzaron la frontera están congelados — se editan desde
// el motor externo (§6 del plan), no desde acá; y los del pipeline automático los re-arma
// el cron. Además es donde importa: el workflow que lee `of_propietario_secundario`
// dispara en «Notificado», o sea justo al salir de este tramo.
//
// EL NEGOCIO GANA, SIEMPRE. Definición de la usuaria sobre la moneda: *"en el ticket
// podría sobreescribirse, pero POR AHORA NO"* → si el ticket tiene otra moneda, este
// sync la pisa con la del negocio. Lo mismo para el vendedor.
//
// 🔴 POR QUÉ SINCRONIZA LAS DOS PROPS Y NO SÓLO LA QUE DISPARÓ. La cola colapsa los
// pending del mismo `deal_id` + `action_type` (`webhookQueue.js:163-173`): si el vendedor
// y la moneda cambian seguidos, los dos eventos son `deal_prop_sync` del mismo negocio y
// el segundo marca al primero como `superseded`. Si cada job escribiera SÓLO su prop, ese
// cambio se perdería EN SILENCIO. Resolviendo las dos desde el estado actual del negocio,
// el colapso deja de importar: el job que sobrevive deja el ticket completo. `propertyName`
// queda como dato de la ruta y del log, no como filtro de lo que se escribe.
// (Sigue siendo puntual: sólo estas dos claves, sólo lo que difiere, nunca un re-snapshot.)
//
// Gateado por DEAL_PROP_SYNC_ENABLED (default OFF → el evento vuelve a caer en
// "Property not supported" y no se toca ningún ticket).

import { hubspotClient } from '../../hubspotClient.js';
import { updateTicket } from '../tickets/ticketService.js';
import { TICKET_PIPELINE, isEngineManagedStage } from '../../config/constants.js';
import { dealPropSyncEnabled } from '../../config/transferPropsFlags.js';
import { reportIfActionable } from '../../utils/errorReporting.js';
import logger from '../../../lib/logger.js';

const MODULE = 'syncDealPropToTicket';

// Prop del ticket que apunta a su negocio (la misma que usan el resto de los caminos).
const PROP_TICKET_DEAL_ID = process.env.PROP_TICKET_DEAL_ID || 'of_deal_id';

// ── Mapeo prop del NEGOCIO → clave del TICKET que influye ─────────────────────
// Derivado de extractDealSnapshots() (snapshotService.js), que es la fuente única del
// mapeo deal→ticket. SOLO estas dos: la regla del 29-jul dice que lo que el sistema
// escucha es lo que está puntualmente puesto a la escucha, y agregar props se pide
// explícitamente, una por una. Las otras cuatro claves de extractDealSnapshots
// (of_tipo_de_cupo · of_pais_operativo · mig_id_crm_origen · mig_id_cliente_nodum)
// NO están en la lista del cliente y por eso NO se escuchan.
export const DEAL_PROP_TO_TICKET_KEY = {
  hubspot_owner_id: 'of_propietario_secundario',  // VENDEDOR (owner del negocio)
  deal_currency_code: 'of_moneda',                // MONEDA del negocio
};

// Props del negocio que hay que leer para resolver el valor a bajar.
const DEAL_PROPS_TO_FETCH = Object.keys(DEAL_PROP_TO_TICKET_KEY);

/** ¿La prop del negocio se transfiere al ticket? (pura, testeable, independiente de la llave) */
export function isTransferableDealProp(propertyName) {
  if (!propertyName) return false;
  return Object.prototype.hasOwnProperty.call(DEAL_PROP_TO_TICKET_KEY, propertyName);
}

/**
 * Estado deseado del ticket según el negocio: `{ clave de ticket → valor }`, con el MISMO
 * criterio de normalización que `extractDealSnapshots` — si acá se normalizara distinto, un
 * ticket recién creado y uno sincronizado tendrían valores diferentes para el mismo negocio.
 * (pura, testeable)
 *
 * Una clave se OMITE (no se escribe) cuando:
 *  - el vendedor viene vacío: el negocio quedó sin owner (pasa al reasignar). Vaciar
 *    `of_propietario_secundario` dejaría al workflow `1771473309` sin a quién avisar, y el
 *    valor viejo es mejor dato que ninguno. Mismo criterio que `createAutoBillingTicket`,
 *    que sólo escribe la prop `if (vendedorId)`.
 *
 * La moneda NO tiene ese caso: `extractDealSnapshots` cae a 'USD' cuando viene vacía, así
 * que acá se cae al mismo default en vez de escribir ''.
 */
export function buildDesiredTicketPropsFromDeal(dealProps) {
  const dp = dealProps || {};
  const desired = {};

  const owner = String(dp.hubspot_owner_id ?? '').trim();
  if (owner) desired[DEAL_PROP_TO_TICKET_KEY.hubspot_owner_id] = owner;

  const moneda = String(dp.deal_currency_code ?? '').trim();
  desired[DEAL_PROP_TO_TICKET_KEY.deal_currency_code] = moneda || 'USD'; // mismo default que extractDealSnapshots

  return desired;
}

/**
 * Baja al/los ticket(s) del negocio las dos props de transferencia (vendedor y moneda),
 * desde el estado ACTUAL del negocio.
 *
 * Toca ÚNICAMENTE tickets del pipeline MANUAL en etapa NO notificada
 * (`isEngineManagedStage`, la misma frontera que usa el sync LI→ticket: con
 * ETAPA_UNICA_ENABLED apagada son los forecast; prendida, además «Próximos a facturar»).
 * Los que cruzaron la frontera están congelados y NO se tocan.
 *
 * @returns {Promise<{applies:boolean, reason?:string, desired?:Object, keys?:string[],
 *   ticketsScanned:number, ticketsUpdated:number, skipped:number, errors:number}>}
 */
export async function syncDealPropToTickets({
  dealId,
  propertyName,
  // Inyectables para tests (defaults = producción)
  client = hubspotClient,
  updateTicketFn = updateTicket,
}) {
  const stats = { applies: false, ticketsScanned: 0, ticketsUpdated: 0, skipped: 0, errors: 0 };

  if (!dealPropSyncEnabled()) return { ...stats, reason: 'flag_off' };
  if (!isTransferableDealProp(propertyName)) return { ...stats, reason: 'not_mapped' };

  // Leer el negocio: el valor del evento no se usa a propósito — entre el webhook y el
  // worker puede haber pasado otro cambio, y el estado actual del negocio es el que manda.
  let deal;
  try {
    deal = await client.crm.deals.basicApi.getById(String(dealId), DEAL_PROPS_TO_FETCH);
  } catch (err) {
    logger.warn({ module: MODULE, dealId, err: err?.message }, 'No se pudo leer el negocio');
    return { ...stats, reason: 'deal_read_error', errors: 1 };
  }

  const desired = buildDesiredTicketPropsFromDeal(deal?.properties || {});
  const keys = Object.keys(desired);
  if (!keys.length) return { ...stats, reason: 'sin_valor_a_escribir' };
  stats.applies = true;
  stats.desired = desired;
  stats.keys = keys;

  // Tickets del negocio, con lo justo para decidir el alcance y armar el patch mínimo.
  let tickets = [];
  try {
    const resp = await client.crm.tickets.searchApi.doSearch({
      filterGroups: [{ filters: [{ propertyName: PROP_TICKET_DEAL_ID, operator: 'EQ', value: String(dealId) }] }],
      properties: ['hs_pipeline', 'hs_pipeline_stage', 'of_ticket_key', ...keys],
      limit: 100,
    });
    tickets = resp?.results || [];
  } catch (err) {
    logger.error({ module: MODULE, dealId, propertyName, err }, 'Error buscando tickets del negocio');
    return { ...stats, reason: 'ticket_search_error', errors: 1 };
  }

  for (const t of tickets) {
    stats.ticketsScanned++;
    const stage = String(t?.properties?.hs_pipeline_stage || '');
    const pipeline = String(t?.properties?.hs_pipeline || '');

    if (!(pipeline === TICKET_PIPELINE && isEngineManagedStage(stage))) { stats.skipped++; continue; }

    // Patch mínimo: sólo las claves cuyo valor difiere (evita ruido y re-disparos).
    const patch = {};
    for (const k of keys) {
      if (String(t?.properties?.[k] ?? '') !== String(desired[k] ?? '')) patch[k] = desired[k];
    }
    if (!Object.keys(patch).length) continue;

    try {
      await updateTicketFn(String(t.id), patch);
      stats.ticketsUpdated++;
      logger.info(
        { module: MODULE, dealId, ticketId: t.id, propertyName, patchKeys: Object.keys(patch) },
        'Sync quirúrgico negocio→ticket aplicado'
      );
    } catch (err) {
      stats.errors++;
      reportIfActionable({
        objectType: 'ticket',
        objectId: String(t.id),
        message: `Sync negocio→ticket falló (disparado por ${propertyName})`,
        err,
      });
      logger.warn({ module: MODULE, dealId, ticketId: t.id, err }, 'Sync negocio→ticket falló (no bloquea el resto)');
    }
  }

  logger.info({ module: MODULE, dealId, propertyName, ...stats }, 'syncDealPropToTickets completado');
  return stats;
}
