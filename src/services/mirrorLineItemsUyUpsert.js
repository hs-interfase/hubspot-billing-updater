// src/services/mirrorLineItemsUyUpsert.js

import { hubspotClient } from '../hubspotClient.js';
import logger from '../../lib/logger.js';
import { reportHubSpotError } from '../utils/hubspotErrorCollector.js';

const LINE_ITEM_TO_DEAL_ASSOC_ID = 20; // HUBSPOT_DEFINED

function reportIfActionable({ objectType, objectId, message, err }) {
  const status = err?.response?.status ?? err?.statusCode ?? null;

  // Si no hay status, preferimos reportar (puede ser error lógico/no HTTP)
  if (status === null) {
    reportHubSpotError({ objectType, objectId, message });
    return;
  }

  // Evitar spam: rate limit / transitorios
  if (status === 429 || status >= 500) return;

  // Accionables: 4xx (excepto 429)
  if (status >= 400 && status < 500) {
    reportHubSpotError({ objectType, objectId, message });
  }
}

// Genera un LIK estable y determinístico para un line item UY mirror.
// No usa random: mismos inputs → mismo LIK siempre.
function buildMirrorLik(mirrorDealId, pyLineItemId) {
  return `mirror::${mirrorDealId}::py::${pyLineItemId}`;
}

/**
 * Upsert de un line item UY en el deal espejo.
 * Usa of_line_item_py_origen_id como clave estable.
 *
 * @param {string} mirrorDealId - ID del deal espejo UY
 * @param {Object} pyLineItem - Line item origen (PY) con uy=true
 * @param {Function} buildUyProps - Función (pyLineItem, pyId) => properties
 * @returns {Object} { action: 'updated'|'created', id: string }
 */
export async function upsertUyLineItem(mirrorDealId, pyLineItem, buildUyProps) {
  const pyId = String(pyLineItem.id || pyLineItem.properties?.hs_object_id);

  const log = logger.child({
    module: 'mirrorLineItemsUyUpsert',
    mirrorDealId: String(mirrorDealId),
    pyLineItemId: pyId,
  });

  // 1) Listar line items del deal espejo
  let assocResp;
  try {
    assocResp = await hubspotClient.crm.associations.v4.basicApi.getPage(
      'deals',
      String(mirrorDealId),
      'line_items',
      100
    );
  } catch (err) {
    log.error({ err }, 'deal_line_items_assoc_list_failed');
    reportIfActionable({
      objectType: 'line_item',
      objectId: pyId,
      message: `deal_line_items_assoc_list_failed: ${err?.message || err}`,
      err,
    });
    throw err; // no cambiar flujo: esto antes habría explotado igual
  }

  const uyLineItemIds = (assocResp.results || []).map((r) => String(r.toObjectId));

  if (uyLineItemIds.length === 0) {
 // No hay line items asociados al deal espejo: es el primer sync.
    const props = buildUyProps(pyLineItem, pyId);
if (!props.line_item_key) {
  props.line_item_key = buildMirrorLik(mirrorDealId, pyId);
}

    try {
      const createResp = await hubspotClient.crm.lineItems.basicApi.create({
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
  let batchResp;
  try {
    batchResp = await hubspotClient.crm.lineItems.batchApi.read({
      inputs: uyLineItemIds.map((id) => ({ id })),
      properties: ['hs_object_id', 'of_line_item_py_origen_id', 'pais_operativo', 'uy', 'name'],
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
    const props = buildUyProps(pyLineItem, pyId);

    try {
      await hubspotClient.crm.lineItems.basicApi.update(existingId, {
        properties: props,
      });

      log.info(
        { uyLineItemId: existingId },
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
    // 3b) No existe: CREATE y asociar
    const props = buildUyProps(pyLineItem, pyId);
    if (!props.line_item_key) {
      props.line_item_key = buildMirrorLik(mirrorDealId, pyId);
    }
    let newId;
    try {
      const createResp = await hubspotClient.crm.lineItems.basicApi.create({
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
      await hubspotClient.crm.associations.v4.basicApi.create(
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
