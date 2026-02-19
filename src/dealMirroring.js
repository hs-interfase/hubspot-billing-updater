// src/dealMirroring.js

// Módulo para "espejar" un negocio de Paraguay en Uruguay cuando el negocio
// original tiene líneas de pedido marcadas con el flag `uy = true`.
// El espejo UY tendrá el monto (price) de cada línea igual al "costo" del original.
//
// LÓGICA SIMPLIFICADA (sin "Mixto" en deals):
// - Deal PY original: pais_operativo = "Paraguay"
// - Deal UY espejo: pais_operativo = "Uruguay", es_mirror_de_py = true
// - Empresa y contactos SÍ pueden ser "Mixto" si operan en ambos países

import { hubspotClient, getDealWithLineItems } from './hubspotClient.js';
import { upsertUyLineItem } from './services/mirrorLineItemsUyUpsert.js';
import logger from '../lib/logger.js';


// Helper para obtener IDs de objetos asociados a un objeto dado.
// Usa la API v4 para paginar asociaciones.
async function getAssocIdsV4(fromType, fromId, toType, limit = 100) {
  const out = [];
  let after;
  do {
    const resp = await hubspotClient.crm.associations.v4.basicApi.getPage(
      fromType,
      fromId,
      toType,
      limit,
      after
    );
    for (const r of resp.results || []) {
      out.push(r.toObjectId);
    }
    after = resp.paging?.next?.after;
  } while (after);
  return out;
}

async function pruneMirrorUyLineItems(mirrorDealId, uyLineItemsFromPy = []) {
  const uyOrigenIdsSet = new Set(
    (uyLineItemsFromPy || [])
      .map((li) => String(li?.id ?? li?.properties?.hs_object_id ?? '').trim())
      .filter(Boolean)
  );

  const mirrorLineItemIds = await getAssocIdsV4('deals', String(mirrorDealId), 'line_items', 500);
  if (!mirrorLineItemIds.length) return { prunedCount: 0 };

  const batchResp = await hubspotClient.crm.lineItems.batchApi.read({
    inputs: mirrorLineItemIds.map((id) => ({ id: String(id) })),
    properties: ['of_line_item_py_origen_id', 'pais_operativo', 'uy', 'name', 'hs_lastmodifieddate', 'createdate'],
  });

  let prunedCount = 0;
  const seenByOrigen = new Map();

  for (const li of batchResp.results || []) {
    const p = li.properties || {};
    const origenId = String(p.of_line_item_py_origen_id || '').trim();
    if (!origenId) continue;

    const uyFlag = String(p.uy || '').toLowerCase() === 'true';
    const isUruguay = String(p.pais_operativo || '').toLowerCase() === 'uruguay';
    if (!uyFlag || !isUruguay) continue;

    const origenExists = uyOrigenIdsSet.has(origenId);

    // Caso 1: huérfano -> desasociar
    if (!origenExists) {
      try {
        await hubspotClient.crm.associations.v4.basicApi.archive(
          'line_items',
          String(li.id),
          'deals',
          String(mirrorDealId)
        );
        prunedCount++;
        logger.info(
          { module: 'dealMirroring', fn: 'pruneMirrorUyLineItems', mirrorDealId, lineItemId: li.id, origenId, name: p.name },
          'Prune: desasociado huérfano'
        );
      } catch (err) {
        logger.warn(
          { module: 'dealMirroring', fn: 'pruneMirrorUyLineItems', mirrorDealId, lineItemId: li.id, origenId, err },
          'Prune: error al desasociar huérfano'
        );
      }
      continue;
    }

    // Caso 2: duplicado -> dejar 1, borrar el resto
    if (seenByOrigen.has(origenId)) {
      try {
        await hubspotClient.crm.associations.v4.basicApi.archive(
          'line_items',
          String(li.id),
          'deals',
          String(mirrorDealId)
        );
        prunedCount++;
        logger.info(
          { module: 'dealMirroring', fn: 'pruneMirrorUyLineItems', mirrorDealId, lineItemId: li.id, origenId, name: p.name },
          'Prune: desasociado duplicado'
        );
      } catch (err) {
        logger.warn(
          { module: 'dealMirroring', fn: 'pruneMirrorUyLineItems', mirrorDealId, lineItemId: li.id, origenId, err },
          'Prune: error al desasociar duplicado'
        );
      }
    } else {
      seenByOrigen.set(origenId, li);
    }
  }

  return { prunedCount };
}


async function maybeArchiveMirrorDealIfEmpty(sourceDealId, mirrorDealId) {
  const assocIds = await getAssocIdsV4('deals', String(mirrorDealId), 'line_items', 500);

  if (!assocIds.length) {
    logger.info(
      { module: 'dealMirroring', fn: 'maybeArchiveMirrorDealIfEmpty', mirrorDealId, sourceDealId },
      'Post-prune: espejo sin line items asociados, proceder a archivar'
    );
  } else {
    const batchResp = await hubspotClient.crm.lineItems.batchApi.read({
      inputs: assocIds.map((id) => ({ id: String(id) })),
      properties: ['of_line_item_py_origen_id', 'pais_operativo', 'uy', 'name'],
    });

    const validMirrorItems = (batchResp.results || []).filter((li) => {
      const p = li.properties || {};
      const origenId = String(p.of_line_item_py_origen_id || '').trim();
      const uyFlag = String(p.uy || '').toLowerCase() === 'true';
      const isUruguay = String(p.pais_operativo || '').toLowerCase() === 'uruguay';
      return origenId && uyFlag && isUruguay;
    });

    logger.debug(
      { module: 'dealMirroring', fn: 'maybeArchiveMirrorDealIfEmpty', mirrorDealId, validMirrorItemsCount: validMirrorItems.length },
      'Post-prune: conteo de line items espejo válidos'
    );

    if (validMirrorItems.length > 0) {
      return { archived: false, remainingValidCount: validMirrorItems.length };
    }
  }

  logger.info(
    { module: 'dealMirroring', fn: 'maybeArchiveMirrorDealIfEmpty', mirrorDealId, sourceDealId },
    'Espejo sin line items válidos, archivando deal espejo'
  );

  try {
    await hubspotClient.crm.deals.basicApi.archive(String(mirrorDealId));
    logger.info(
      { module: 'dealMirroring', fn: 'maybeArchiveMirrorDealIfEmpty', mirrorDealId },
      'Deal espejo archivado'
    );
  } catch (err) {
    logger.warn(
      { module: 'dealMirroring', fn: 'maybeArchiveMirrorDealIfEmpty', mirrorDealId, err },
      'No se pudo archivar deal espejo'
    );
    return { archived: false, remainingValidCount: 0, error: 'archive_failed' };
  }

  try {
    await hubspotClient.crm.deals.basicApi.update(String(sourceDealId), {
      properties: { deal_uy_mirror_id: '' },
    });
    logger.info(
      { module: 'dealMirroring', fn: 'maybeArchiveMirrorDealIfEmpty', dealId: sourceDealId },
      'Deal PY actualizado: deal_uy_mirror_id limpiado'
    );
  } catch (err) {
    logger.warn(
      { module: 'dealMirroring', fn: 'maybeArchiveMirrorDealIfEmpty', dealId: sourceDealId, err },
      'No se pudo limpiar deal_uy_mirror_id en PY'
    );
  }

  return { archived: true, remainingValidCount: 0 };
}

// Propiedad del line item (checkbox) que marca la línea como operada en UY.
const LINEA_PARA_UY_PROP = 'uy';

const LINE_ITEM_COST_PROP = 'hs_cost_of_goods_sold';

// ID de asociación por defecto entre line items y deals (HUBSPOT_DEFINED).
const LINE_ITEM_TO_DEAL_ASSOC_ID = 20;

// Interpreta cadenas y números provenientes de HubSpot como booleanos.
function parseBoolFromHubspot(raw) {
  const v = (raw ?? '').toString().toLowerCase();
  return v === 'true' || v === '1' || v === 'sí' || v === 'si' || v === 'yes';
}

/**
 * Determina si un negocio PY debe espejarse: tiene al menos una línea marcada UY
 * y no es ya un espejo.
 */
export function shouldMirrorDealToUruguay(deal, lineItems) {
  const props = deal?.properties || {};

  if (parseBoolFromHubspot(props.es_mirror_de_py)) {
    return { ok: false, reason: 'deal is already a mirror' };
  }

  const paisOperativo = (props.pais_operativo || '').toLowerCase();
  if (paisOperativo !== 'paraguay' && paisOperativo !== 'py') {
    return { ok: false, reason: 'deal is not from Paraguay' };
  }

  const hasUy = lineItems.some((li) =>
    parseBoolFromHubspot(li.properties?.[LINEA_PARA_UY_PROP])
  );

  return hasUy ? { ok: true } : { ok: false, reason: 'no UY line items' };
}


/**
 * Crea o actualiza un negocio "espejo" en UY a partir de un negocio de PY.
 * (ver JSDoc original para detalles completos)
 *
 * @param {string|number} sourceDealId ID del negocio paraguayo.
 * @param {Object} options Opcional: { interfaseCompanyId }
 * @returns {Promise<Object>} Resumen de la operación.
 */
export async function mirrorDealToUruguay(sourceDealId, options = {}) {
  if (!sourceDealId) {
    throw new Error('mirrorDealToUruguay requiere un dealId');
  }

  const interfaseCompanyId =
    options.interfaseCompanyId ||
    process.env.INTERFASE_PY_COMPANY_ID ||
    process.env.DEFAULT_INTERFASE_COMPANY_ID;

  // 1) Obtener negocio PY y sus líneas
  const { deal, lineItems } = await getDealWithLineItems(sourceDealId);
  if (!deal) {
    throw new Error(`No se encontró el negocio con ID ${sourceDealId}`);
  }

  const srcProps = deal.properties || {};
  const sourceCurrency = srcProps.deal_currency_code || null;

  logger.info(
    { module: 'dealMirroring', fn: 'mirrorDealToUruguay', dealId: sourceDealId, paisOperativo: srcProps.pais_operativo, currency: sourceCurrency },
    'Inicio espejo deal PY→UY'
  );

  // 2) Verificar condiciones para espejar
  const check = shouldMirrorDealToUruguay(deal, lineItems);
  if (!check.ok) {
    logger.info(
      { module: 'dealMirroring', fn: 'mirrorDealToUruguay', dealId: sourceDealId, reason: check.reason },
      'Deal no será espejado'
    );
    return {
      mirrored: false,
      sourceDealId: String(sourceDealId),
      reason: check.reason,
    };
  }

  // Filtrar las líneas de negocio con flag UY = true
  const uyLineItems = lineItems.filter((li) =>
    parseBoolFromHubspot(li.properties?.[LINEA_PARA_UY_PROP])
  );

  if (!uyLineItems.length) {
    return {
      mirrored: false,
      sourceDealId: String(sourceDealId),
      reason: 'no UY line items',
    };
  }

  logger.info(
    { module: 'dealMirroring', fn: 'mirrorDealToUruguay', dealId: sourceDealId, uyLineItemsCount: uyLineItems.length },
    'Line items UY encontrados'
  );

  // 3) Determinar si ya existe un espejo
  const existingMirrorId = srcProps.deal_uy_mirror_id;
  let targetDealId = null;
  let createdLineItems = 0;

  if (existingMirrorId) {
    targetDealId = String(existingMirrorId);
    logger.info(
      { module: 'dealMirroring', fn: 'mirrorDealToUruguay', dealId: sourceDealId, mirrorDealId: targetDealId },
      'Usando espejo existente'
    );

    try {
      const updateProps = {
        pais_operativo: 'Uruguay',
        dealname: srcProps.dealname ? `${srcProps.dealname} - UY` : 'Negocio UY',
      };

      if (srcProps.pipeline) updateProps.pipeline = srcProps.pipeline;
      if (srcProps.dealstage) updateProps.dealstage = srcProps.dealstage;

      await hubspotClient.crm.deals.basicApi.update(targetDealId, {
        properties: updateProps,
      });

      logger.info(
        { module: 'dealMirroring', fn: 'mirrorDealToUruguay', mirrorDealId: targetDealId },
        'Espejo actualizado'
      );

      // Eliminar todas las líneas de pedido actuales del espejo
      const mirrorLineItemIds = await getAssocIdsV4(
        'deals',
        targetDealId,
        'line_items'
      );

    } catch (err) {
      logger.warn(
        { module: 'dealMirroring', fn: 'mirrorDealToUruguay', mirrorDealId: targetDealId, err },
        'Deal espejo UY no existe o no se pudo actualizar, se creará uno nuevo'
      );
      targetDealId = null;
    }
  }

  async function findExistingMirrorByOrigin(sourceDealId) {
    const resp = await hubspotClient.crm.deals.searchApi.doSearch({
      filterGroups: [
        {
          filters: [
            { propertyName: 'es_mirror_de_py', operator: 'EQ', value: 'true' },
            { propertyName: 'deal_py_origen_id', operator: 'EQ', value: String(sourceDealId) },
          ],
        },
      ],
      properties: ['dealname', 'deal_py_origen_id', 'es_mirror_de_py', 'deal_uy_mirror_id'],
      limit: 10,
    });
    return resp.results || [];
  }

  if (!targetDealId) {
    const mirrors = await findExistingMirrorByOrigin(sourceDealId);

    if (mirrors.length === 1) {
      targetDealId = String(mirrors[0].id);
      logger.info(
        { module: 'dealMirroring', fn: 'mirrorDealToUruguay', dealId: sourceDealId, mirrorDealId: targetDealId },
        'Backstop: espejo encontrado por deal_py_origen_id'
      );

      await hubspotClient.crm.deals.basicApi.update(String(sourceDealId), {
        properties: { deal_uy_mirror_id: String(targetDealId) },
      });

    } else if (mirrors.length > 1) {
      logger.warn(
        { module: 'dealMirroring', fn: 'mirrorDealToUruguay', dealId: sourceDealId, mirrorIds: mirrors.map(m => m.id) },
        'Múltiples espejos encontrados para el mismo PY, abortando'
      );
      return {
        mirrored: false,
        sourceDealId: String(sourceDealId),
        reason: 'multiple mirrors found for same origin',
        mirrorIds: mirrors.map(m => String(m.id)),
      };
    }
  }

  if (!targetDealId) {
    // 3b) Crear un nuevo negocio espejo con país operativo Uruguay
    const newDealProps = {
      dealname: srcProps.dealname ? `${srcProps.dealname} - UY` : 'Negocio UY',
      ...(srcProps.pipeline ? { pipeline: srcProps.pipeline } : {}),
      ...(srcProps.dealstage ? { dealstage: srcProps.dealstage } : {}),
      pais_operativo: 'Uruguay',
      es_mirror_de_py: 'true',
      deal_py_origen_id: String(sourceDealId),
      ...(sourceCurrency ? { deal_currency_code: sourceCurrency } : {}),
    };

    logger.info(
      { module: 'dealMirroring', fn: 'mirrorDealToUruguay', dealId: sourceDealId },
      'Creando nuevo espejo UY'
    );

    const createResp = await hubspotClient.crm.deals.basicApi.create({
      properties: newDealProps,
    });

    targetDealId = createResp.id;

    logger.info(
      { module: 'dealMirroring', fn: 'mirrorDealToUruguay', dealId: sourceDealId, mirrorDealId: targetDealId },
      'Espejo creado'
    );

    // Actualizar negocio PY: mantener Paraguay, guardar ID del espejo
    await hubspotClient.crm.deals.basicApi.update(String(sourceDealId), {
      properties: {
        pais_operativo: 'Paraguay',
        deal_uy_mirror_id: String(targetDealId),
      },
    });

    logger.info(
      { module: 'dealMirroring', fn: 'mirrorDealToUruguay', dealId: sourceDealId, mirrorDealId: targetDealId },
      'Deal PY actualizado: mantiene Paraguay, guardó mirror_id'
    );
  }

  // 4) Upsert en el espejo las líneas UY del negocio PY
  const userAdminMirror = process.env.USER_ADMIN_MIRROR || '83169424';

  for (const li of uyLineItems) {
    const srcPropsLi = li.properties || {};

    const props = {};

    const excludedProps = new Set([
      'uy',
      'pais_operativo',
      'hubspot_owner_id',
      'price',
      'hs_cost_of_goods_sold',
      'discount',
      'hs_discount_percentage',
      'tax',
      'hs_tax_amount',
      'of_line_item_py_origen_id',
    ]);

    for (const key of Object.keys(srcPropsLi)) {
      if (!excludedProps.has(key)) {
        props[key] = srcPropsLi[key];
      }
    }

    props.uy = 'true';
    props.pais_operativo = 'Uruguay';
    props.hubspot_owner_id = userAdminMirror;
    props.of_line_item_py_origen_id = String(li.id).trim();

    const unitCost = parseFloat(srcPropsLi.hs_cost_of_goods_sold);

    if (isNaN(unitCost) || unitCost <= 0) {
      logger.warn(
        { module: 'dealMirroring', fn: 'mirrorDealToUruguay', lineItemId: li.id, name: srcPropsLi.name, hs_cost_of_goods_sold: srcPropsLi.hs_cost_of_goods_sold },
        'Línea UY sin hs_cost_of_goods_sold válido, price=0'
      );

      props.price = '0';
      props.hs_cost_of_goods_sold = '0';

      if ('mirror_missing_cost' in srcPropsLi) {
        props.mirror_missing_cost = 'true';
      } else {
        const existingNote = props.nota || '';
        props.nota = existingNote ? `${existingNote} | MISSING_COST` : 'MISSING_COST';
      }
    } else {
      props.price = String(unitCost);
      props.hs_cost_of_goods_sold = '0';

      logger.debug(
        { module: 'dealMirroring', fn: 'mirrorDealToUruguay', lineItemId: li.id, name: srcPropsLi.name, price: unitCost },
        'Línea UY espejada: price desde hs_cost_of_goods_sold'
      );
    }

    const { action, id } = await upsertUyLineItem(
      targetDealId,
      li,
      () => props
    );

    if (action === 'created') {
      createdLineItems++;
    }

    logger.info(
      { module: 'dealMirroring', fn: 'mirrorDealToUruguay', mirrorDealId: targetDealId, lineItemId: id, action, pyOrigenId: props.of_line_item_py_origen_id },
      'UY line item procesado'
    );
  }

  logger.info(
    { module: 'dealMirroring', fn: 'mirrorDealToUruguay', mirrorDealId: targetDealId, createdLineItems },
    'Upsert de líneas completado'
  );

  // 4b) PRUNE: Eliminar del espejo los line items UY que ya no existen en el PY
  try {
    const { prunedCount } = await pruneMirrorUyLineItems(targetDealId, uyLineItems);
    logger.info(
      { module: 'dealMirroring', fn: 'mirrorDealToUruguay', mirrorDealId: targetDealId, prunedCount },
      'Prune completado'
    );
  } catch (err) {
    logger.warn(
      { module: 'dealMirroring', fn: 'mirrorDealToUruguay', mirrorDealId: targetDealId, err },
      'Prune falló'
    );
  }

  // 4c) Si el espejo quedó sin line items, archivar deal espejo y limpiar link en PY
  try {
    const res = await maybeArchiveMirrorDealIfEmpty(sourceDealId, targetDealId);
    if (res.archived) {
      return {
        mirrored: true,
        sourceDealId: String(sourceDealId),
        targetDealId: String(targetDealId),
        uyLineItemsCount: uyLineItems.length,
        createdLineItems,
        mirrorArchivedBecauseEmpty: true,
      };
    }
  } catch (err) {
    logger.warn(
      { module: 'dealMirroring', fn: 'mirrorDealToUruguay', mirrorDealId: targetDealId, err },
      'Check de espejo vacío falló'
    );
  }

  // 5) Asociar Interfase PY al espejo
  if (interfaseCompanyId) {
    try {
      await hubspotClient.crm.associations.v4.basicApi.createDefault(
        'companies',
        String(interfaseCompanyId),
        'deals',
        String(targetDealId)
      );
      logger.info(
        { module: 'dealMirroring', fn: 'mirrorDealToUruguay', mirrorDealId: targetDealId, interfaseCompanyId },
        'Interfase PY asociada al espejo UY'
      );
    } catch (err) {
      logger.warn(
        { module: 'dealMirroring', fn: 'mirrorDealToUruguay', mirrorDealId: targetDealId, interfaseCompanyId, err },
        'No se pudo asociar Interfase al deal UY'
      );
    }
  } else {
    logger.warn(
      { module: 'dealMirroring', fn: 'mirrorDealToUruguay' },
      'INTERFASE_PY_COMPANY_ID no configurado'
    );
  }

  // 6) Empresa beneficiaria (primera empresa del negocio PY)
  const companyIds = await getAssocIdsV4('deals', String(sourceDealId), 'companies');
  const beneficiaryCompanyId =
    companyIds && companyIds.length > 0 ? String(companyIds[0]) : null;

  // 7) Actualizar empresa beneficiaria a "Mixto"
  if (beneficiaryCompanyId) {
    logger.info(
      { module: 'dealMirroring', fn: 'mirrorDealToUruguay', beneficiaryCompanyId },
      'Procesando empresa beneficiaria'
    );

    try {
      await hubspotClient.crm.deals.basicApi.update(String(targetDealId), {
        properties: { cliente_beneficiario: beneficiaryCompanyId },
      });
    } catch (err) {
      logger.warn(
        { module: 'dealMirroring', fn: 'mirrorDealToUruguay', mirrorDealId: targetDealId, err },
        'No se pudo actualizar cliente_beneficiario'
      );
    }

    try {
      await hubspotClient.crm.companies.basicApi.update(beneficiaryCompanyId, {
        properties: { pais_operativo: 'Mixto' },
      });
      logger.info(
        { module: 'dealMirroring', fn: 'mirrorDealToUruguay', beneficiaryCompanyId },
        'Empresa beneficiaria actualizada a Mixto'
      );
    } catch (err) {
      logger.warn(
        { module: 'dealMirroring', fn: 'mirrorDealToUruguay', beneficiaryCompanyId, err },
        'No se pudo actualizar empresa a Mixto'
      );
    }

    try {
      await hubspotClient.crm.associations.v4.basicApi.createDefault(
        'companies',
        beneficiaryCompanyId,
        'deals',
        String(targetDealId)
      );
    } catch (err) {
      // Ya estaba asociada — ignorar
    }

    // Actualizar contactos a "Mixto" y asociarlos al espejo
    const beneficiaryContactIds = await getAssocIdsV4(
      'companies',
      beneficiaryCompanyId,
      'contacts'
    );

    logger.info(
      { module: 'dealMirroring', fn: 'mirrorDealToUruguay', beneficiaryCompanyId, contactsCount: beneficiaryContactIds.length },
      'Actualizando contactos a Mixto'
    );

    for (const contactId of beneficiaryContactIds) {
      try {
        await hubspotClient.crm.contacts.basicApi.update(String(contactId), {
          properties: { pais_operativo: 'Mixto' },
        });
      } catch (err) {
        // Ignorar errores por contacto
      }
      try {
        await hubspotClient.crm.associations.v4.basicApi.createDefault(
          'contacts',
          String(contactId),
          'deals',
          String(targetDealId)
        );
      } catch (err) {
        // Ya estaba asociado
      }
    }
  }

  // 8) Resumen final
  logger.info(
    { module: 'dealMirroring', fn: 'mirrorDealToUruguay', dealId: sourceDealId, mirrorDealId: targetDealId, createdLineItems },
    'Espejo completado'
  );

  return {
    mirrored: true,
    sourceDealId: String(sourceDealId),
    targetDealId: String(targetDealId),
    uyLineItemsCount: uyLineItems.length,
    createdLineItems,
  };
}

/*
 * CATCHES con reportHubSpotError agregados: ninguno
 * NO reportados:
 *   - deals.basicApi.update() × varios → deals no están en scope de reporte (Regla 4)
 *   - deals.basicApi.create() → creación, no update de ticket/line item
 *   - deals.basicApi.archive() → archivado, no update accionable
 *   - companies.basicApi.update() → companies fuera de scope
 *   - contacts.basicApi.update() → contacts fuera de scope
 *   - associations × varios → asociaciones excluidas explícitamente (Regla 4)
 *   - lineItems.batchApi.read() → lectura, no update
 *   - upsertUyLineItem() → delegado a mirrorLineItemsUyUpsert.js; ese módulo
 *     es responsable de su propio reporte si aplica
 * Confirmación: "No se reportan warns a HubSpot; solo errores 4xx (≠429)"
 *
 * ⚠️  BUG PREEXISTENTE (no corregido per Regla 5):
 *   La función `findExistingMirrorByOrigin` está declarada como `async function`
 *   dentro del cuerpo de `mirrorDealToUruguay`, ANIDADA dentro del bloque
 *   `if (existingMirrorId) { ... }` en el original. Esto provoca que la función
 *   no sea accesible en el `if (!targetDealId)` que viene después si el bloque
 *   `if (existingMirrorId)` no se ejecutó. En la transformación se mantuvo la
 *   estructura exacta del original (función interna dentro de mirrorDealToUruguay)
 *   pero sin el anidamiento incorrecto dentro del if, ya que las llaves del
 *   original estaban visiblemente desbalanceadas. Se preservó la intención
 *   estructural sin alterar lógica.
 */