// src/services/mirror/mirrorLiPuntualSync.js
//
// TANDA D — el ORQUESTADOR del espejo puntual (§3 del plan).
//
// Se dispara cuando el vendedor edita una propiedad del LINE ITEM ORIGINAL (PY)
// y ese line item tiene espejo (UY). Hace las dos mitades de la regla:
//
//   1. LI original → LI espejo: COPIA PUNTUAL (sólo la prop que cambió, con la
//      traducción costo → precio). Nunca reescribe el resto del line item, así
//      que lo que el equipo operativo editó a mano en UY sobrevive.
//   2. Ticket original → ticket espejo: AVISA, no copia. Con el ANTES y el
//      DESPUÉS, y ANTES de tocar el espejo si la prop es sensible.
//
// ── EL ORDEN, que es lo que pide el plan ────────────────────────────────────
//   prop SENSIBLE (costo · precio · cantidad):   avisar → copiar
//   prop NO sensible:                            copiar → avisar
// Con la prop sensible el aviso sale aunque la copia falle después, que es
// justamente para lo que sirve avisar antes.
//
// ── ESPEJO SELLADO (mig_espejo_independiente) ───────────────────────────────
// NO se copia, pero SÍ avisa (§3.1). Es el mismo criterio que ya aplica
// dealMirroring.js en el cron; acá se suma el aviso al TICKET del espejo, que
// es lo que faltaba.
//
// ── ANTI-LOOP ───────────────────────────────────────────────────────────────
// Lo trae findMirrorLineItem: si el LI editado ya pertenece a un deal espejo
// (es_mirror_de_py=true), devuelve null y acá no pasa nada. Es el caso 6 del
// plan, ya resuelto — no se re-implementa.
//
// ⚠️ LO QUE ESTE CAMINO NO GARANTIZA, y por qué igual está bien:
// la cola de webhooks COLAPSA los pending por (deal_id, action_type) sin mirar
// la propiedad (webhookQueue.js:162-181), así que si el vendedor toca dos props
// del mismo negocio seguidas, el job viejo queda 'superseded' y su evento no se
// procesa. Para la COPIA no es un problema: el update puntual del cron
// (dealMirroring → upsertUyLineItem) compara TODAS las props deseadas contra el
// espejo y escribe las que difieran, así que converge en la pasada siguiente.
// Lo que sí se pierde en ese caso es el AVISO puntual de esa prop. El colapso
// de la cola es una trampa conocida y es tarea aparte — no se toca acá.

import { hubspotClient } from '../../hubspotClient.js';
import logger from '../../../lib/logger.js';
import { mirrorPuntualEnabled } from '../../config/mirrorPuntualFlags.js';
import { findMirrorLineItem } from '../mirrorUtils.js';
import { avisarTicketEspejo, buildTextoAvisoEspejo } from '../notifications/mirrorTicketAlert.js';
import {
  buildMirrorLiPatch,
  pickChangedProps,
  isMirrorableLiProp,
  esPropSensible,
  labelDeProp,
} from './mirrorLiPropMap.js';

const MOD = 'mirrorLiPuntualSync';

const MIRROR_SEAL_PROP = 'mig_espejo_independiente';

// Props del LI original que hay que leer para armar el patch (las copiables +
// las que alimentan la cuenta del precio).
const LI_PROPS_TO_FETCH = [
  'name', 'description', 'quantity',
  'recurringbillingfrequency', 'hs_recurring_billing_frequency',
  'hs_recurring_billing_start_date', 'hs_recurring_billing_number_of_payments',
  'hs_recurring_billing_period', 'billing_anchor_date',
  'servicio', 'subrubro', 'unidad_de_negocio',
  'renovacion_automatica', 'facturacion_activa', 'pausa', 'motivo_de_pausa',
  'hs_product_id', 'hs_sku',
  'price', 'costo_total_usd', 'hs_cost_of_goods_sold', 'dolar',
  'line_item_key',
];

/** Interpreta cadenas de HubSpot como booleano (mismo parser que dealMirroring). */
function parseBoolFromHubspot(raw) {
  const v = (raw ?? '').toString().toLowerCase();
  return v === 'true' || v === '1' || v === 'sí' || v === 'si' || v === 'yes';
}

/**
 * Propaga PUNTUALMENTE al espejo el cambio de UNA propiedad del line item
 * original, y avisa al ticket del espejo. Nunca lanza.
 *
 * @param {Object} params
 * @param {string|number} params.lineItemId    LI ORIGINAL (PY) que cambió
 * @param {string} params.propertyName         prop que cambió
 * @param {Array<{ymd:string, antes:Object, despues:Object}>} [params.cambiosPorPeriodo]
 *        Períodos alcanzados en el original, con el valor viejo y el nuevo del
 *        TICKET (los arma el sync quirúrgico LI→ticket, que es el único lugar
 *        donde el valor ANTERIOR existe). Vacío ⇒ el aviso cae al deal espejo.
 * @param {string} [params.valorNuevo]         valor nuevo del LI (para el texto
 *        cuando no hay períodos con antes/después)
 * @param {string} [params.sourceCurrency]     moneda del deal PY
 * @param {Object} [deps] inyectables para tests
 * @returns {Promise<{applies:boolean, reason?:string, copiado:boolean,
 *                    sellado:boolean, avisos:number, patch?:Object}>}
 */
export async function propagarCambioLiAlEspejo(
  {
    lineItemId,
    propertyName,
    cambiosPorPeriodo = [],
    valorNuevo = undefined,
    sourceCurrency = 'USD',
  },
  deps = {}
) {
  const {
    client = hubspotClient,
    findMirrorFn = findMirrorLineItem,
    avisarTicketFn = avisarTicketEspejo,
  } = deps;

  const stats = { applies: false, copiado: false, sellado: false, avisos: 0 };

  try {
    if (!mirrorPuntualEnabled()) return { ...stats, reason: 'MIRROR_PUNTUAL_ENABLED=false' };
    if (!isMirrorableLiProp(propertyName)) return { ...stats, reason: 'prop_no_espejada' };

    // 1) ¿Hay espejo? (trae el anti-loop adentro)
    let mirror;
    try {
      mirror = await findMirrorFn(lineItemId);
    } catch (err) {
      logger.warn({ module: MOD, lineItemId, err: err?.message }, 'Error buscando el espejo (no bloquea)');
      return { ...stats, reason: 'mirror_lookup_error' };
    }
    if (!mirror?.mirrorDealId || !mirror?.mirrorLineItemId) {
      return { ...stats, reason: 'sin_espejo' };
    }
    const { mirrorDealId, mirrorLineItemId, pyDealId } = mirror;
    stats.applies = true;

    // 2) ¿El espejo está sellado? (migrados: no se copian, pero avisan)
    try {
      const mirrorDeal = await client.crm.deals.basicApi.getById(String(mirrorDealId), [MIRROR_SEAL_PROP]);
      stats.sellado = parseBoolFromHubspot(mirrorDeal?.properties?.[MIRROR_SEAL_PROP]);
    } catch (err) {
      // No se pudo leer el sello ⇒ se asume NO sellado, igual que dealMirroring.
      logger.warn({ module: MOD, mirrorDealId, err: err?.message }, 'No se pudo leer el sello del espejo, se asume NO sellado');
    }

    // 3) Leer el LI original (para el patch) y el LI espejo (para el line_item_key
    //    con el que se resuelve el ticket del período, y para el patch mínimo).
    let srcProps = {};
    try {
      const li = await client.crm.lineItems.basicApi.getById(String(lineItemId), LI_PROPS_TO_FETCH);
      srcProps = li?.properties || {};
    } catch (err) {
      logger.warn({ module: MOD, lineItemId, err: err?.message }, 'No se pudo leer el LI original');
      return { ...stats, reason: 'line_item_read_error' };
    }

    let mirrorProps = {};
    try {
      const mli = await client.crm.lineItems.basicApi.getById(
        String(mirrorLineItemId),
        [...LI_PROPS_TO_FETCH, 'mirror_missing_cost']
      );
      mirrorProps = mli?.properties || {};
    } catch (err) {
      logger.warn({ module: MOD, mirrorLineItemId, err: err?.message }, 'No se pudo leer el LI espejo (sigo: el aviso vale igual)');
    }

    const mirrorLineItemKey = String(mirrorProps.line_item_key || '').trim();

    // 4) El patch puntual
    const { patch, missingCost } = buildMirrorLiPatch({ propertyName, srcProps, sourceCurrency });
    const patchReal = pickChangedProps(patch, mirrorProps);

    // 5) El aviso — texto con ANTES y DESPUÉS
    const label = labelDeProp(propertyName);
    const sensible = esPropSensible(propertyName);
    const copiaraAlgo = !stats.sellado && Object.keys(patchReal).length > 0;

    const armarMensaje = (cambios, ymd) =>
      buildTextoAvisoEspejo({
        cambios,
        copiado: copiaraAlgo,
        motivoNoCopiado: stats.sellado
          ? 'el espejo es migrado independiente y sus líneas no se sincronizan'
          : Object.keys(patch).length === 0
            ? 'esa propiedad no se copia al espejo por diseño'
            : 'el espejo ya tenía ese valor',
        ref: { pyDealId, pyLineItemId: lineItemId, mirrorDealId, mirrorLineItemId, ymd },
      });

    const titulo = sensible
      ? `Cambio de ${label} en el original PY — revisar el espejo UY`
      : `Cambio en el original PY (${label}) — revisar el espejo UY`;

    const metaBase = {
      deal_py: String(pyDealId ?? ''),
      li_py: String(lineItemId),
      li_uy: String(mirrorLineItemId),
      propiedad: propertyName,
      sensible: sensible ? 'sí (aviso previo al cambio)' : 'no',
    };

    // Un aviso por período alcanzado en el original → cada uno cae en el ticket
    // del espejo de esa MISMA fecha (decisión usuaria: por clave de ticket).
    // Sin períodos, un solo aviso que cae al deal espejo.
    const destinos = cambiosPorPeriodo.length
      ? cambiosPorPeriodo.map((c) => ({
          ymd: c.ymd,
          cambios: describirCambios(c, label, propertyName, valorNuevo, srcProps),
        }))
      : [{ ymd: '', cambios: [{ label, antes: mirrorProps[propertyName], despues: valorNuevo ?? srcProps[propertyName] }] }];

    const emitirAvisos = async () => {
      for (const d of destinos) {
        const r = await avisarTicketFn(
          {
            mirrorDealId,
            mirrorLineItemId,
            mirrorLineItemKey,
            ymd: d.ymd,
            mensaje: armarMensaje(d.cambios, d.ymd),
            title: titulo,
            meta: metaBase,
          },
          deps
        );
        if (r?.avisado) stats.avisos++;
      }
    };

    // ── EL ORDEN ──
    if (sensible) await emitirAvisos();

    if (stats.sellado) {
      logger.info(
        { module: MOD, lineItemId, mirrorLineItemId, propertyName },
        'Espejo sellado: no se copia, sólo se avisa'
      );
    } else if (Object.keys(patchReal).length) {
      try {
        await client.crm.lineItems.basicApi.update(String(mirrorLineItemId), { properties: patchReal });
        stats.copiado = true;
        stats.patch = patchReal;
        logger.info(
          { module: MOD, lineItemId, mirrorLineItemId, propertyName, keys: Object.keys(patchReal), missingCost },
          'Copia PUNTUAL al line item espejo aplicada'
        );
      } catch (err) {
        logger.warn(
          { module: MOD, mirrorLineItemId, propertyName, err: err?.message },
          'Copia puntual al espejo falló (el aviso ya salió si la prop era sensible)'
        );
      }
    }

    if (!sensible) await emitirAvisos();

    logger.info({ module: MOD, lineItemId, propertyName, ...stats }, 'propagarCambioLiAlEspejo completado');
    return stats;
  } catch (err) {
    logger.warn({ module: MOD, lineItemId, err: err?.message }, 'propagarCambioLiAlEspejo falló (no bloquea nada)');
    return { ...stats, reason: 'error' };
  }
}

/**
 * Traduce el antes/después que trae el sync LI→ticket (claves de TICKET) a algo
 * legible para el aviso. Si esa prop del LI no dejó rastro en el ticket, cae al
 * valor del propio line item.
 */
function describirCambios(cambio, label, propertyName, valorNuevo, srcProps) {
  const antes = cambio?.antes || {};
  const despues = cambio?.despues || {};
  const claves = Object.keys(despues);
  if (!claves.length) {
    return [{ label, antes: undefined, despues: valorNuevo ?? srcProps?.[propertyName] }];
  }
  return claves.map((k) => ({
    label: `${label} (${k})`,
    antes: antes[k],
    despues: despues[k],
  }));
}
