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



// Propiedad del line item (checkbox) que marca la línea como operada en UY.
const LINEA_PARA_UY_PROP = 'uy';

const LINE_ITEM_COST_PROP = 'hs_cost_of_goods_sold';

// ID de asociación por defecto entre line items y deals (HUBSPOT_DEFINED).
const LINE_ITEM_TO_DEAL_ASSOC_ID = 20;

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
  
  // Si ya es un espejo, no duplicar
  if (parseBoolFromHubspot(props.es_mirror_de_py)) {
    return { ok: false, reason: 'deal is already a mirror' };
  }
  
  // Verificar que sea un deal de Paraguay
  const paisOperativo = (props.pais_operativo || '').toLowerCase();
  if (paisOperativo !== 'paraguay' && paisOperativo !== 'py') {
    return { ok: false, reason: 'deal is not from Paraguay' };
  }
  
  // Verificar que tenga al menos una línea con uy=true
  const hasUy = lineItems.some((li) =>
    parseBoolFromHubspot(li.properties?.[LINEA_PARA_UY_PROP])
  );
  
  return hasUy ? { ok: true } : { ok: false, reason: 'no UY line items' };
}

/**
 * Crea o actualiza un negocio "espejo" en UY a partir de un negocio de PY.
 *
 * - Si el negocio ya tiene un espejo (`deal_uy_mirror_id`), se reutiliza ese
 *   negocio, se borran sus líneas de pedido y se vuelven a crear con las
 *   líneas UY actuales.
 * - Si no existe espejo, se crea uno nuevo con país operativo "Uruguay",
 *   marcándolo como espejo y vinculándolo al negocio PY.
 * - El negocio PY mantiene su país operativo "Paraguay" y guarda el ID del espejo.
 * - La empresa beneficiaria es la primera empresa asociada al negocio PY; su
 *   país operativo y el de sus contactos se actualizan a "Mixto" (empresas/contactos
 *   SÍ pueden ser mixtos).
 * - La empresa dueña (Interfase PY) se asocia siempre al negocio UY.
 *
 * En las líneas UY del espejo:
 * - Se copian todas las propiedades del line item original excepto `uy`.
 * - Si existe `hs_cost_of_goods_sold`, se usa ese valor como `price` en el espejo.
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
  
  // Moneda del negocio origen
  const sourceCurrency = srcProps.deal_currency_code || null;
  console.log('[mirrorDealToUruguay] Deal origen:', sourceDealId);
  console.log('[mirrorDealToUruguay] País operativo:', srcProps.pais_operativo);
  console.log('[mirrorDealToUruguay] Moneda:', sourceCurrency);

  // 2) Verificar condiciones para espejar
  const check = shouldMirrorDealToUruguay(deal, lineItems);
  if (!check.ok) {
    console.log('[mirrorDealToUruguay] No se espejará:', check.reason);
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

  console.log(`[mirrorDealToUruguay] Encontradas ${uyLineItems.length} líneas UY`);

  // 3) Determinar si ya existe un espejo
  const existingMirrorId = srcProps.deal_uy_mirror_id;
  let targetDealId = null;
  let createdLineItems = 0;

  if (existingMirrorId) {
    // 3a) Intentar usar el espejo existente y SINCRONIZARLO
    targetDealId = String(existingMirrorId);
    console.log(`[mirrorDealToUruguay] Espejo existente: ${targetDealId}`);

    try {
      const updateProps = {
        // País operativo siempre Uruguay en el espejo
        pais_operativo: 'Uruguay',
        
        // Sincronizar nombre con sufijo - UY
        dealname: srcProps.dealname
          ? `${srcProps.dealname} - UY`
          : 'Negocio UY',
      };

      // Sincronizar pipeline y etapa del negocio original (si están definidos)
      if (srcProps.pipeline) {
        updateProps.pipeline = srcProps.pipeline;
      }
      if (srcProps.dealstage) {
        updateProps.dealstage = srcProps.dealstage;
      }

      await hubspotClient.crm.deals.basicApi.update(targetDealId, {
        properties: updateProps,
      });

      console.log('[mirrorDealToUruguay] Espejo actualizado');

      // Eliminar todas las líneas de pedido actuales del espejo
      const mirrorLineItemIds = await getAssocIdsV4(
        'deals',
        targetDealId,
        'line_items'
      );

} catch (err) {
  const details = err?.response?.body || err?.message || err;
  console.warn(
    `[mirrorDealToUruguay] Deal espejo UY ${targetDealId} no existe o no se pudo actualizar. Se creará uno nuevo.`,
    details
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
    console.log('[mirrorDealToUruguay] Backstop: encontré espejo por deal_py_origen_id:', targetDealId);

    // Re-asegurar el vínculo en el PY para próximas corridas
    await hubspotClient.crm.deals.basicApi.update(String(sourceDealId), {
      properties: { deal_uy_mirror_id: String(targetDealId) },
    });

  } else if (mirrors.length > 1) {
    console.warn('[mirrorDealToUruguay] ERROR: múltiples espejos para el mismo PY. No crear otro.', {
      sourceDealId,
      mirrorIds: mirrors.map(m => m.id),
    });
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
      // Nombre = nombre original + sufijo UY
      dealname: srcProps.dealname ? `${srcProps.dealname} - UY` : 'Negocio UY',

      // Mantener pipeline y etapa del negocio origen (si existen)
      ...(srcProps.pipeline ? { pipeline: srcProps.pipeline } : {}),
      ...(srcProps.dealstage ? { dealstage: srcProps.dealstage } : {}),

      // ✅ País operativo Uruguay (no mixto)
      pais_operativo: 'Uruguay',
      
      // ✅ Marcadores de espejo
      es_mirror_de_py: 'true',
      deal_py_origen_id: String(sourceDealId),

      // Moneda del deal original
      ...(sourceCurrency ? { deal_currency_code: sourceCurrency } : {}),
    };

    console.log('[mirrorDealToUruguay] Creando nuevo espejo UY con país operativo: Uruguay');

    const createResp = await hubspotClient.crm.deals.basicApi.create({
      properties: newDealProps,
    });

    targetDealId = createResp.id;

    console.log('[mirrorDealToUruguay] Espejo creado:', targetDealId);

    // ✅ Actualizar negocio PY: MANTENER Paraguay, guardar ID del espejo
    await hubspotClient.crm.deals.basicApi.update(String(sourceDealId), {
      properties: {
        // ✅ Mantener país operativo Paraguay (NO cambiar a Mixto)
        pais_operativo: 'Paraguay',
        deal_uy_mirror_id: String(targetDealId),
      },
    });

    console.log('[mirrorDealToUruguay] Deal PY actualizado: mantiene Paraguay, guardó mirror_id');
  }

// 4) Upsert en el espejo las líneas UY del negocio PY (siempre desde el estado ACTUAL)
console.log(`[mirrorDealToUruguay] Upsert de ${uyLineItems.length} líneas UY en espejo`);

// Variable de entorno para el propietario
const userAdminMirror = process.env.USER_ADMIN_MIRROR || '83169424';

for (const li of uyLineItems) {
  const srcPropsLi = li.properties || {};
  
  // 🔍 DEBUG: Ver todas las keys disponibles
  console.log('[mirrorDealToUruguay] 🔍 DEBUG - keys properties:', Object.keys(srcPropsLi));
  
  const props = {};

  // ❌ Lista de propiedades a EXCLUIR (no copiar del original)
  const excludedProps = new Set([
    'uy',                        // No copiar el flag original (se pondrá true)
    'pais_operativo',           // Se establece manualmente como Uruguay
    'hubspot_owner_id',         // Se establece manualmente
    'price',                    // Se calcula desde el costo
    'hs_cost_of_goods_sold',   // Se pondrá en 0
    'discount',                 // No copiar descuentos
    'hs_discount_percentage',   
    'tax',
    'hs_tax_amount',
    'of_line_item_py_origen_id',
  ]);

  // Copiar todas las propiedades EXCEPTO las excluidas
  for (const key of Object.keys(srcPropsLi)) {
    if (!excludedProps.has(key)) {
      props[key] = srcPropsLi[key];
    }
  }

  // ✅ Establecer propiedades específicas del espejo UY
  props.uy = 'true';
  props.pais_operativo = 'Uruguay';
  props.hubspot_owner_id = userAdminMirror;

  // 🔑 Idempotencia: guardar ID del line item origen (PY)
  props.of_line_item_py_origen_id = String(li.id || li.properties?.hs_object_id);

  // ✅ COSTO → price (parseado como float)
  const unitCost = parseFloat(srcPropsLi.hs_cost_of_goods_sold);

  console.log('[mirrorDealToUruguay] 🔍 DEBUG - Costo parseado:', {
    hs_cost_of_goods_sold_raw: srcPropsLi.hs_cost_of_goods_sold,
    unitCost_parsed: unitCost,
    isNaN: isNaN(unitCost),
    isValid: !isNaN(unitCost) && unitCost > 0
  });

  if (isNaN(unitCost) || unitCost <= 0) {
    // Sin costo válido
    console.log(
      '[mirrorDealToUruguay] ⚠️ Línea UY sin hs_cost_of_goods_sold válido:',
      srcPropsLi.name,
      '- Costo original:',
      srcPropsLi.hs_cost_of_goods_sold
    );

    props.price = '0';
    props.hs_cost_of_goods_sold = '0';
    
    // Intentar marcar como "missing cost" (si la propiedad existe, sino usar nota)
    // Puedes ajustar esto según las propiedades custom que tengas
    if ('mirror_missing_cost' in srcPropsLi) {
      props.mirror_missing_cost = 'true';
    } else {
      const existingNote = props.nota || '';
      props.nota = existingNote ? `${existingNote} | MISSING_COST` : 'MISSING_COST';
    }
  } else {
    // Costo válido: setear price = unitCost
    props.price = String(unitCost);
    props.hs_cost_of_goods_sold = '0';

    console.log(
      '[mirrorDealToUruguay] ✅ Línea UY espejada:',
      srcPropsLi.name,
      '→ price =',
      unitCost,
      '(de hs_cost_of_goods_sold)'
    );
  }

  console.log('[mirrorDealToUruguay] 🔍 DEBUG - Propiedades finales a crear:', {
    name: props.name,
    pais_operativo: props.pais_operativo,
    uy: props.uy,
    hubspot_owner_id: props.hubspot_owner_id,
    price: props.price,
    hs_cost_of_goods_sold: props.hs_cost_of_goods_sold,
    nota: props.nota
  });

  const { action, id } = await upsertUyLineItem(
    targetDealId,     // mirror deal id
    li,               // line item PY origen (para identificar por id)
    () => props       // buildUyProps: usamos el props que ya armaste arriba
  );

  if (action === 'created') {
    createdLineItems++;
  }

  console.log(`[mirrorDealToUruguay] UY line item ${action}: ${id} (py=${props.of_line_item_py_origen_id})`);
}


  console.log(`[mirrorDealToUruguay] ${createdLineItems} líneas creadas en espejo`);

  // 5) Asociar explícitamente Interfase PY al espejo PRIMERO
  if (interfaseCompanyId) {
    try {
      await hubspotClient.crm.associations.v4.basicApi.createDefault(
        'companies',
        String(interfaseCompanyId),
        'deals',
        String(targetDealId)
      );

      console.log(
        '[mirrorDealToUruguay] Interfase PY asociada al espejo UY:',
        interfaseCompanyId
      );
    } catch (err) {
      console.warn(
        '[mirrorDealToUruguay] No se pudo asociar Interfase al deal UY:',
        err?.response?.body || err
      );
    }
  } else {
    console.warn(
      '[mirrorDealToUruguay] INTERFASE_PY_COMPANY_ID no configurado'
    );
  }

  // 6) Determinar la empresa beneficiaria (primera empresa asociada al negocio PY)
  const companyIds = await getAssocIdsV4('deals', String(sourceDealId), 'companies');
  const beneficiaryCompanyId =
    companyIds && companyIds.length > 0 ? String(companyIds[0]) : null;

  // 7) ✅ Actualizar empresa beneficiaria a "Mixto" (empresas SÍ pueden ser mixtas)
  if (beneficiaryCompanyId) {
    console.log('[mirrorDealToUruguay] Empresa beneficiaria:', beneficiaryCompanyId);

    // Guardar cliente beneficiario en el negocio espejo
    try {
      await hubspotClient.crm.deals.basicApi.update(String(targetDealId), {
        properties: {
          cliente_beneficiario: beneficiaryCompanyId,
        },
      });
    } catch (err) {
      console.warn('[mirrorDealToUruguay] No se pudo actualizar cliente_beneficiario');
    }

    // ✅ Cambiar país operativo de la empresa beneficiaria a "Mixto"
    try {
      await hubspotClient.crm.companies.basicApi.update(beneficiaryCompanyId, {
        properties: { pais_operativo: 'Mixto' },
      });
      console.log('[mirrorDealToUruguay] Empresa actualizada a Mixto');
    } catch (err) {
      console.warn('[mirrorDealToUruguay] No se pudo actualizar empresa a Mixto');
    }

    // Asociar la empresa beneficiaria al negocio espejo (si no lo está)
    try {
      await hubspotClient.crm.associations.v4.basicApi.createDefault(
        'companies',
        beneficiaryCompanyId,
        'deals',
        String(targetDealId)
      );
      console.log('[mirrorDealToUruguay] Empresa asociada al espejo UY');
    } catch (err) {
      // Ya estaba asociada
    }

    // ✅ Actualizar contactos a "Mixto" y asociarlos al espejo
    const beneficiaryContactIds = await getAssocIdsV4(
      'companies',
      beneficiaryCompanyId,
      'contacts'
    );

    console.log(`[mirrorDealToUruguay] Actualizando ${beneficiaryContactIds.length} contactos a Mixto`);

    for (const contactId of beneficiaryContactIds) {
      try {
        await hubspotClient.crm.contacts.basicApi.update(String(contactId), {
          properties: { pais_operativo: 'Mixto' },
        });
      } catch (err) {
        // Ignorar errores
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

  // 8) Devolver resumen
  console.log('[mirrorDealToUruguay] ✅ Duplicación completada');
  
  return {
    mirrored: true,
    sourceDealId: String(sourceDealId),
    targetDealId: String(targetDealId),
    uyLineItemsCount: uyLineItems.length,
    createdLineItems,
  };
}