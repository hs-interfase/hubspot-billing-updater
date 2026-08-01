// src/services/notifications/mirrorTicketAlert.js
//
// TANDA D — EL AVISO AL TICKET DEL ESPEJO (§3.2 caso 2 del plan: "falta, es el
// pedido").
//
// Hoy, cuando el original cambia, el aviso se escribe en el `billing_error` del
// DEAL espejo + correo de mirror. **El ticket del espejo no se entera.** Este
// módulo cierra eso.
//
// ── LA REGLA ────────────────────────────────────────────────────────────────
//   Ticket original → ticket espejo: SE AVISA, NO SE COPIA.
// El aviso lleva el ANTES y el DESPUÉS ("en el original, tal propiedad pasó de
// X a Y"). Nunca se escribe una prop de negocio del ticket espejo: sólo
// `of_billing_error`, que es el canal de aviso.
//
// ── A QUÉ TICKET (decisión usuaria 1-ago, §3.2 caso 8) ──────────────────────
// Al de la MISMA FECHA, resuelto por clave de ticket:
//     of_ticket_key = <dealUY>::LIK:<line_item_key del LI UY>::<YMD>
// Si el espejo no tiene ticket de ese período, el aviso NO se pierde: cae al
// `billing_error` del DEAL espejo — que es exactamente lo que hace el motor hoy,
// así que el fallback es el comportamiento conocido, no uno nuevo.
//
// ── CASO 7 DEL PLAN: el ticket espejo que YA CRUZÓ LA FRONTERA ──────────────
// "avisar sí, tocar nunca". Se le escribe el of_billing_error igual (para eso
// es un aviso) y el texto dice explícitamente que el ticket ya fue notificado /
// emitido y que NO se modificó. No se toca su etapa, ni sus montos, ni se
// archiva. La frontera se consulta con hasTicketCrossedFrontier (fuente única
// de la tanda B) para no re-definirla acá.
//
// ── FORMA DEL AVISO (decisión usuaria 1-ago) ────────────────────────────────
// prop informativa + correo:
//   · `of_billing_error` del ticket espejo (writeTicketBillingError, con
//     timestamp) → desde ahí un workflow de HubSpot crea la tarea al owner, si
//     la usuaria decide engancharlo. El motor NO crea tareas.
//   · correo vía emailAvisoMirror → MIRROR_ALERT_TO_EMAIL (convención 25-jul:
//     todos los avisos a mirror van también por correo). Apagable con
//     DEAL_ALERTS_ENABLED, igual que el resto.
//
// Fire-and-forget: avisarTicketEspejo NUNCA lanza.

import { hubspotClient } from '../../hubspotClient.js';
import { writeTicketBillingError } from './dealAlerts.js';
import { emailAvisoMirror } from './mirrorAlert.js';
import { reportHubSpotError } from '../../utils/hubspotErrorCollector.js';
import { buildTicketKeyFromLineItemKey } from '../../utils/ticketKey.js';
import { isTicketPeriodoCerrado, stageOf } from '../../utils/ticketFrontera.js';
import { DERIVED_STAGES } from '../../config/constants.js';
import { withRetry } from '../../utils/withRetry.js';
import logger from '../../../lib/logger.js';

const MOD = 'mirrorTicketAlert';

/**
 * ¿Este ticket del ESPEJO ya fue notificado/emitido? (§3.2 caso 7)
 *
 * 🔴 A propósito NO usa `hasTicketCrossedFrontier`, y la diferencia importa:
 * ese predicado responde "¿manda el motor sobre este ticket?" y su respuesta
 * depende de ETAPA_UNICA_ENABLED — con esa llave apagada, «Próximos a facturar»
 * cae del lado "pasado". Pero el ticket del espejo VIVE en «Próximos a
 * facturar»: es ahí donde lo deja la promoción del motor (mirrorUtils.js:232-238)
 * para que administración lo revise. Describirlo como "ya notificado/emitido"
 * sería falso, y es justamente el ticket que el equipo operativo todavía puede
 * corregir.
 *
 * Acá la pregunta es otra y es estable: ¿pasó de «Listo para facturar» en
 * adelante (DERIVED_STAGES = notificado o posterior), o su período quedó
 * cerrado por una cancelación definitiva? Eso no cambia con ninguna llave.
 */
export function ticketEspejoYaNotificado(ticket) {
  const stage = stageOf(ticket);
  if (!stage) return false;
  if (DERIVED_STAGES.has(stage)) return true;
  return isTicketPeriodoCerrado(ticket);
}

/**
 * Busca el ticket del espejo del MISMO período (misma fecha) por of_ticket_key.
 *
 * @returns {Promise<Object|null>} el ticket (con properties) o null.
 */
export async function findTicketEspejoPorFecha(
  { mirrorDealId, mirrorLineItemKey, ymd },
  { client = hubspotClient, withRetryFn = withRetry } = {}
) {
  if (!mirrorDealId || !mirrorLineItemKey || !ymd) return null;

  let ticketKey;
  try {
    ticketKey = buildTicketKeyFromLineItemKey(mirrorDealId, mirrorLineItemKey, ymd);
  } catch (err) {
    // ymd inválido / campos vacíos: no es un error del flujo, es que no hay
    // período que resolver → el caller cae al aviso al deal.
    logger.debug({ module: MOD, mirrorDealId, ymd, err: err?.message }, 'No se pudo armar la clave del ticket espejo');
    return null;
  }

  try {
    const resp = await withRetryFn(
      () =>
        client.crm.tickets.searchApi.doSearch({
          filterGroups: [{ filters: [{ propertyName: 'of_ticket_key', operator: 'EQ', value: ticketKey }] }],
          properties: [
            'hs_pipeline',
            'hs_pipeline_stage',
            'of_ticket_key',
            'of_line_item_key',
            'of_invoice_id',
            'hubspot_owner_id',
            'subject',
            'fecha_resolucion_esperada',
          ],
          limit: 2,
        }),
      { module: MOD, fn: 'findTicketEspejoPorFecha', ticketKey }
    );
    return (resp?.results || [])[0] || null;
  } catch (err) {
    logger.warn({ module: MOD, ticketKey, err: err?.message }, 'Error buscando el ticket espejo por clave');
    return null;
  }
}

/**
 * Arma el texto del aviso con el ANTES y el DESPUÉS del ORIGINAL.
 * Pura y testeable: es el formato que ve el equipo operativo.
 *
 * @param {Object} params
 * @param {Array<{label:string, antes:*, despues:*}>} params.cambios
 * @param {boolean} [params.copiado]   ¿el LI espejo se actualizó?
 * @param {string}  [params.motivoNoCopiado] p.ej. 'espejo sellado'
 * @param {boolean} [params.cruzoFrontera] el ticket espejo ya fue notificado
 * @param {Object}  params.ref   { pyDealId, pyLineItemId, mirrorDealId, mirrorLineItemId, ymd }
 */
export function buildTextoAvisoEspejo({
  cambios = [],
  copiado = false,
  motivoNoCopiado = '',
  cruzoFrontera = false,
  ref = {},
}) {
  const detalle = cambios.length
    ? cambios
        .map((c) => `«${c.label}» pasó de ${formatValor(c.antes)} a ${formatValor(c.despues)}`)
        .join(' · ')
    : 'hubo un cambio sin detalle de valores';

  const cabecera = `En el negocio ORIGINAL (PY), ${detalle}.`;

  let queSeHizo;
  if (cruzoFrontera) {
    queSeHizo =
      'Este ticket del espejo YA fue notificado/emitido: NO se modificó nada en él. ' +
      'Si el cambio del original tiene que reflejarse, hay que hacerlo a mano por el camino que corresponda.';
  } else if (copiado) {
    queSeHizo =
      'El line item del espejo YA fue actualizado con ese cambio (sólo esa propiedad). ' +
      'El ticket del espejo NO se modificó — revisarlo antes de facturar.';
  } else {
    queSeHizo =
      `El espejo NO se actualizó${motivoNoCopiado ? ` (${motivoNoCopiado})` : ''}. ` +
      'Revisar y ajustar el espejo a mano si corresponde.';
  }

  const refs = [
    ref.pyDealId ? `Deal PY: ${ref.pyDealId}` : null,
    ref.pyLineItemId ? `LI PY: ${ref.pyLineItemId}` : null,
    ref.mirrorDealId ? `Deal UY: ${ref.mirrorDealId}` : null,
    ref.mirrorLineItemId ? `LI UY: ${ref.mirrorLineItemId}` : null,
    ref.ymd ? `Período: ${ref.ymd}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return `${cabecera} ${queSeHizo} ${refs}`.trim();
}

function formatValor(v) {
  const s = String(v ?? '').trim();
  return s === '' ? '(vacío)' : `"${s}"`;
}

/**
 * Escribe el aviso en el TICKET del espejo del mismo período (o, si no existe,
 * en el deal espejo). Nunca lanza.
 *
 * @param {Object} params
 * @param {string|number} params.mirrorDealId
 * @param {string|number} params.mirrorLineItemId
 * @param {string} [params.mirrorLineItemKey] line_item_key del LI UY (para la clave)
 * @param {string} [params.ymd]               período del ticket (YYYY-MM-DD)
 * @param {string} params.mensaje             texto ya armado (buildTextoAvisoEspejo)
 * @param {string} [params.title]             asunto del correo
 * @param {Object} [params.meta]              datos extra del correo
 * @param {Object} [deps] inyectables para tests
 * @returns {Promise<{avisado:boolean, via:'ticket'|'deal'|'ninguno', ticketId?:string,
 *                    cruzoFrontera?:boolean}>}
 */
export async function avisarTicketEspejo(
  { mirrorDealId, mirrorLineItemId, mirrorLineItemKey = '', ymd = '', mensaje, title = 'Cambio en el negocio original PY — revisar el espejo UY', meta = {} },
  deps = {}
) {
  const {
    findTicketFn = findTicketEspejoPorFecha,
    writeTicketErrorFn = writeTicketBillingError,
    reportFn = reportHubSpotError,
    emailFn = emailAvisoMirror,
  } = deps;

  try {
    const ticket = await findTicketFn({ mirrorDealId, mirrorLineItemKey, ymd }, deps);

    if (ticket) {
      const ticketId = String(ticket.id);
      const cruzoFrontera = ticketEspejoYaNotificado(ticket);

      // Caso 7: avisar sí, tocar nunca. of_billing_error es el canal de aviso;
      // no toca etapa, ni montos, ni archiva.
      await writeTicketErrorFn(ticketId, mensaje);

      await emailFn({
        mirrorDealId,
        title,
        message: mensaje,
        meta: {
          ...meta,
          ticket_espejo_uy: ticketId,
          periodo: ymd || '(sin período)',
          ...(cruzoFrontera ? { ticket_espejo_estado: 'ya notificado/emitido — no se tocó' } : {}),
        },
      });

      logger.info(
        { module: MOD, mirrorDealId, ticketId, ymd, cruzoFrontera },
        'Aviso escrito en el TICKET del espejo UY'
      );
      return { avisado: true, via: 'ticket', ticketId, cruzoFrontera };
    }

    // Sin ticket del período: el aviso no se pierde — cae al deal espejo, que es
    // lo que el motor hace hoy.
    reportFn({
      level: 'warn',
      objectType: 'deal',
      objectId: String(mirrorDealId),
      message: `${mensaje} (sin ticket del período en el espejo: el aviso queda en el negocio)`,
    });
    await emailFn({
      mirrorDealId,
      title,
      message: mensaje,
      meta: { ...meta, periodo: ymd || '(sin período)', ticket_espejo_uy: '(no existe para ese período)' },
    });

    logger.info({ module: MOD, mirrorDealId, mirrorLineItemId, ymd }, 'Sin ticket espejo del período — aviso al DEAL espejo');
    return { avisado: true, via: 'deal' };
  } catch (err) {
    logger.warn({ module: MOD, mirrorDealId, err: err?.message }, 'avisarTicketEspejo falló (no bloquea nada)');
    return { avisado: false, via: 'ninguno' };
  }
}
