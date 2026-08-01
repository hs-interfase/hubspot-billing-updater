// src/services/mirrorLineItemsUyUpsert.js

import { hubspotClient } from '../hubspotClient.js';
import logger from '../../lib/logger.js';
import { reportIfActionable } from '../utils/errorReporting.js';
import { getAllAssociatedIds } from '../utils/hubspotAssociations.js';
import { mirrorPuntualEnabled } from '../config/mirrorPuntualFlags.js';
import { pickChangedProps } from './mirror/mirrorLiPropMap.js';

const LINE_ITEM_TO_DEAL_ASSOC_ID = 20; // HUBSPOT_DEFINED

// Props que el batch read trae siempre (identificación del espejo).
const BASE_READ_PROPS = ['hs_object_id', 'of_line_item_py_origen_id', 'pais_operativo', 'uy', 'name'];

/**
 * Upsert de un line item UY en el deal espejo.
 * Usa of_line_item_py_origen_id como clave estable.
 *
 * ⚠️ EL UPDATE ES PUNTUAL DESDE LA TANDA D (flag MIRROR_PUNTUAL_ENABLED).
 *
 * Hasta ahora el UPDATE reescribía la HOJA ENTERA del line item espejo en cada
 * corrida: cualquier cosa que el camino reactivo (mirrorLiPuntualSync) o el
 * equipo operativo hubiera dejado en el espejo se perdía en la pasada
 * siguiente. Es la "corrección necesaria" del §3.1 del plan: sin ella, la copia
 * puntual no sobrevive al primer cron.
 *
 * Con la llave prendida se leen también las props que se van a escribir y se
 * mandan SÓLO las que difieren (pickChangedProps). Si no difiere ninguna, no se
 * llama a la API. Con la llave apagada el comportamiento es exactamente el de
 * hoy: update completo, siempre.
 *
 * 📌 Y es lo que hace convergente al motor: el colapso de la cola de webhooks
 * puede perder un evento de propiedad, pero esta comparación mira TODAS las
 * props deseadas, así que el cambio perdido se escribe igual en la corrida
 * siguiente.
 *
 * @param {string} mirrorDealId - ID del deal espejo UY
 * @param {Object} pyLineItem - Line item origen (PY) con uy=true
 * @param {Function} buildUyProps - Función (pyLineItem, pyId) => properties
 * @param {Object} [deps] - inyectables para tests (defaults = producción)
 * @param {Object} [deps.client] - default hubspotClient
 * @param {Function} [deps.getAssocIdsFn] - default getAllAssociatedIds
 * @returns {Object} { action: 'updated'|'created'|'unchanged', id: string }
 */
export async function upsertUyLineItem(mirrorDealId, pyLineItem, buildUyProps, deps = {}) {
  const { client = hubspotClient, getAssocIdsFn = getAllAssociatedIds } = deps;
  const pyId = String(pyLineItem.id || pyLineItem.properties?.hs_object_id);

  const log = logger.child({
    module: 'mirrorLineItemsUyUpsert',
    mirrorDealId: String(mirrorDealId),
    pyLineItemId: pyId,
  });

  // 1) Listar line items del deal espejo (con paginación completa)
  let uyLineItemIds;
  try {
    uyLineItemIds = await getAssocIdsFn(client, 'deals', String(mirrorDealId), 'line_items');
  } catch (err) {
    log.error({ err }, 'deal_line_items_assoc_list_failed');
    reportIfActionable({
      objectType: 'line_item',
      objectId: pyId,
      message: `deal_line_items_assoc_list_failed: ${err?.message || err}`,
      err,
    });
    throw err;
  }

  if (uyLineItemIds.length === 0) {
 // No hay line items asociados al deal espejo: es el primer sync.
    const props = buildUyProps(pyLineItem, pyId);

    try {
      const createResp = await client.crm.lineItems.basicApi.create({
        properties: props,
        associations: [
          {
            to: { id: mirrorDealId },
            types: [
              {
                associationCategory: 'HUBSPOT_DEFINED',
                associationTypeId: LINE_ITEM_TO_DEAL_ASSOC_ID,
              },
            ],
          },
        ],
      });

      const newId = String(createResp.id);
      log.info({ uyLineItemId: newId }, `[upsertUyLineItem] ✅ Creado line item UY ${newId} (PY origen: ${pyId})`);
      return { action: 'created', id: newId };
    } catch (err) {
      log.error({ err }, 'line_item_create_failed');
      reportIfActionable({
        objectType: 'line_item',
        objectId: pyId,
        message: `line_item_create_failed: ${err?.message || err}`,
        err,
      });
      throw err; // no cambiar flujo
    }
  }

  // 2) Buscar si existe uno con of_line_item_py_origen_id == pyId
  //
  // Con el update puntual hay que traer también las props que se van a escribir,
  // para poder comparar. `buildUyProps` es puro en todos sus call sites (en
  // dealMirroring es `() => props`, ya calculado), así que llamarlo acá para
  // saber qué leer no tiene efectos y no gasta una llamada extra a la API.
  const puntual = mirrorPuntualEnabled();
  let desiredProps = null;
  if (puntual) {
    try {
      desiredProps = buildUyProps(pyLineItem, pyId) || {};
    } catch (err) {
      log.warn({ err }, 'build_uy_props_failed_para_comparacion');
      desiredProps = null;
    }
  }
  const readProps = desiredProps
    ? [...new Set([...BASE_READ_PROPS, ...Object.keys(desiredProps)])]
    : BASE_READ_PROPS;

  let batchResp;
  try {
    batchResp = await client.crm.lineItems.batchApi.read({
      inputs: uyLineItemIds.map((id) => ({ id })),
      properties: readProps,
    });
  } catch (err) {
    log.error({ err }, 'line_items_batch_read_failed');
    reportIfActionable({
      objectType: 'line_item',
      objectId: pyId,
      message: `line_items_batch_read_failed: ${err?.message || err}`,
      err,
    });
    throw err; // no cambiar flujo
  }

  const existing = (batchResp.results || []).find((li) => {
    const origen = String(li.properties?.of_line_item_py_origen_id || '');
    return origen === pyId;
  });



  if (existing) {
    // 3a) Ya existe: UPDATE
    const existingId = String(existing.id);
    const props = desiredProps || buildUyProps(pyLineItem, pyId);

    // TANDA D: puntual = sólo lo que difiere. Sin la llave, la hoja entera.
    const propsAEscribir = puntual ? pickChangedProps(props, existing.properties || {}) : props;

    if (puntual && Object.keys(propsAEscribir).length === 0) {
      log.info(
        { uyLineItemId: existingId },
        `[upsertUyLineItem] ⏭️ Sin cambios en el line item UY ${existingId} (PY origen: ${pyId}) — no se escribe`
      );
      return { action: 'unchanged', id: existingId };
    }

    try {
      await client.crm.lineItems.basicApi.update(existingId, {
        properties: propsAEscribir,
      });

      log.info(
        { uyLineItemId: existingId, puntual, keys: puntual ? Object.keys(propsAEscribir) : undefined },
        `[upsertUyLineItem] ✅ Actualizado line item UY ${existingId} (PY origen: ${pyId})`
      );

      return { action: 'updated', id: existingId };
    } catch (err) {
      log.error({ err, uyLineItemId: existingId }, 'line_item_update_failed');
      reportIfActionable({
        objectType: 'line_item',
        objectId: existingId,
        message: `line_item_update_failed: ${err?.message || err}`,
        err,
      });
      throw err; // no cambiar flujo
    }
  } else {
    // 3b) No existe: CREATE y asociar (el alta siempre escribe la hoja completa)
    const props = desiredProps || buildUyProps(pyLineItem, pyId);
    let newId;
    try {
      const createResp = await client.crm.lineItems.basicApi.create({
        properties: props,
      });

      newId = String(createResp.id);
    } catch (err) {
      log.error({ err }, 'line_item_create_failed');
      reportIfActionable({
        objectType: 'line_item',
        objectId: pyId,
        message: `line_item_create_failed: ${err?.message || err}`,
        err,
      });
      throw err; // no cambiar flujo
    }

    // Asociar al deal espejo
    try {
      await client.crm.associations.v4.basicApi.create(
        'line_items',
        newId,
        'deals',
        String(mirrorDealId),
        [
          {
            associationCategory: 'HUBSPOT_DEFINED',
            associationTypeId: LINE_ITEM_TO_DEAL_ASSOC_ID,
          },
        ]
      );
    } catch (err) {
      log.error({ err, uyLineItemId: newId }, 'line_item_to_deal_assoc_create_failed');
      reportIfActionable({
        objectType: 'line_item',
        objectId: newId,
        message: `line_item_to_deal_assoc_create_failed: ${err?.message || err}`,
        err,
      });
      throw err; // no cambiar flujo
    }

    log.info({ uyLineItemId: newId }, `[upsertUyLineItem] ✅ Creado line item UY ${newId} (PY origen: ${pyId})`);

    return { action: 'created', id: newId };
  }
}
