// src/services/mirrorLineItemsUyUpsert.js

import { hubspotClient } from '../../hubspotClient.js';

const LINE_ITEM_TO_DEAL_ASSOC_ID = 20; // HUBSPOT_DEFINED

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
  
  // 1) Listar line items del deal espejo
  const assocResp = await hubspotClient.crm.associations.v4.basicApi.getPage(
    'deals',
    String(mirrorDealId),
    'line_items',
    100
  );
  
  const uyLineItemIds = (assocResp.results || []).map(r => String(r.toObjectId));
  
  if (uyLineItemIds.length === 0) {
    // No hay line items en el espejo, crear uno nuevo
    const props = buildUyProps(pyLineItem, pyId);
    
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
    console.log(`[upsertUyLineItem] ✅ Creado line item UY ${newId} (PY origen: ${pyId})`);
    
    return { action: 'created', id: newId };
  }
  
  // 2) Buscar si existe uno con of_line_item_py_origen_id == pyId
  const batchResp = await hubspotClient.crm.lineItems.batchApi.read({
    inputs: uyLineItemIds.map(id => ({ id })),
    properties: ['hs_object_id', 'of_line_item_py_origen_id', 'pais_operativo', 'uy', 'name'],
  });
  
  const existing = (batchResp.results || []).find(li => {
    const origen = String(li.properties?.of_line_item_py_origen_id || '');
    return origen === pyId;
  });
  
  if (existing) {
    // 3a) Ya existe: UPDATE
    const existingId = String(existing.id);
    const props = buildUyProps(pyLineItem, pyId);
    
    await hubspotClient.crm.lineItems.basicApi.update(existingId, {
      properties: props,
    });
    
    console.log(`[upsertUyLineItem] ✅ Actualizado line item UY ${existingId} (PY origen: ${pyId})`);
    
    return { action: 'updated', id: existingId };
  } else {
    // 3b) No existe: CREATE y asociar
    const props = buildUyProps(pyLineItem, pyId);
    
    const createResp = await hubspotClient.crm.lineItems.basicApi.create({
      properties: props,
    });
    
    const newId = String(createResp.id);
    
    // Asociar al deal espejo
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
    
    console.log(`[upsertUyLineItem] ✅ Creado line item UY ${newId} (PY origen: ${pyId})`);
    
    return { action: 'created', id: newId };
  }
}