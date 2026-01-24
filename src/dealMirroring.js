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
import { upsertUyLineItem } from './services/mirror/mirrorLineItemsUyUpsert.js';
import { propagateAndExecuteMirror } from './services/mirror/mirrorFlagPropagation.js';


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

const LINE_ITEM_MIRROR_ALLOWLIST = new Set([
  // texto / producto
  'name',
  'of_producto_nombres',
  'of_descripcion_producto',
  'nota',
  'observaciones_ventas',
  'of_rubro',
  'of_subrubro',
  'reventa',
  'renovacion_automatica',

  // facturación
  'facturacion_activa',
  'facturacion_automatica',
  'facturar_ahora',
  'actualizar',
  'irregular',
  'pausa',
  'motivo_de_pausa',

  // recurring / schedule
  'hs_recurring_billing_frequency',
  'recurringbillingfrequency',
  'hs_recurring_billing_start_date',
  'hs_billing_start_delay_type',
  'hs_billing_start_delay_days',
  'hs_billing_start_delay_months',
  'hs_recurring_billing_number_of_payments',

  // cupo (si aplica por LI)
  'parte_del_cupo',
  'cantidad_real',
  'of_fecha_de_facturacion',
]);

async function pruneMirrorUyLineItems(mirrorDealId, uyLineItemsFromPy = []) {
  console.log('[mirrorDealToUruguay] Prune de line items espejo UY');

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

  // ⬇️ track duplicados por origen
  const seenByOrigen = new Map(); // origenId -> li (el que nos quedamos)

  for (const li of batchResp.results || []) {
    const p = li.properties || {};
    const origenId = String(p.of_line_item_py_origen_id || '').trim();
    if (!origenId) continue;

    const uyFlag = String(p.uy || '').toLowerCase() === 'true';
    const isUruguay = String(p.pais_operativo || '').toLowerCase() === 'uruguay';
    if (!uyFlag || !isUruguay) continue;

    const origenExists = uyOrigenIdsSet.has(origenId);

    // ✅ Caso 1: huérfano -> borrar
    if (!origenExists) {
      try {
        await hubspotClient.crm.associations.v4.basicApi.archive(
          'line_items',
          String(li.id),
          'deals',
          String(mirrorDealId)
        );
        prunedCount++;
        console.log(`[mirrorDealToUruguay] Prune: desasociado huérfano ${li.id} (${p.name || ''}) (origen=${origenId})`);
      } catch (err) {
        console.warn(`[mirrorDealToUruguay] Prune: error huérfano ${li.id} (origen=${origenId})`, err?.response?.body || err);
      }
      continue;
    }

    // ✅ Caso 2: duplicado -> dejar 1, borrar el resto
    if (seenByOrigen.has(origenId)) {
      try {
        await hubspotClient.crm.associations.v4.basicApi.archive(
          'line_items',
          String(li.id),
          'deals',
          String(mirrorDealId)
        );
        prunedCount++;
        console.log(`[mirrorDealToUruguay] Prune: desasociado DUPLICADO ${li.id} (${p.name || ''}) (origen=${origenId})`);
      } catch (err) {
        console.warn(`[mirrorDealToUruguay] Prune: error duplicado ${li.id} (origen=${origenId})`, err?.response?.body || err);
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
    console.log('[mirrorDealToUruguay] Post-prune: espejo sin asociaciones de line items -> archivar');
  } else {
    const batchResp = await hubspotClient.crm.lineItems.batchApi.read({
      inputs: assocIds.map((id) => ({ id: String(id) })),
      properties: ['of_line_item_py_origen_id', 'pais_operativo', 'uy', 'name'],
    });

    // ✅ Solo consideramos “line items espejo válidos” (no legacy)
    const validMirrorItems = (batchResp.results || []).filter((li) => {
      const p = li.properties || {};
      const origenId = String(p.of_line_item_py_origen_id || '').trim();
      const uyFlag = String(p.uy || '').toLowerCase() === 'true';
      const isUruguay = String(p.pais_operativo || '').toLowerCase() === 'uruguay';
      return origenId && uyFlag && isUruguay;
    });

    console.log('[mirrorDealToUruguay] Post-prune: validMirrorItems=', validMirrorItems.length);

    if (validMirrorItems.length > 0) {
      return { archived: false, remainingValidCount: validMirrorItems.length };
    }
  }

  console.log('[mirrorDealToUruguay] Espejo quedó sin line items válidos -> archivando deal espejo', {
    mirrorDealId,
    sourceDealId,
  });

  try {
    await hubspotClient.crm.deals.basicApi.archive(String(mirrorDealId));
    console.log('[mirrorDealToUruguay] ✅ Deal espejo archivado:', mirrorDealId);
  } catch (err) {
    console.warn(
      '[mirrorDealToUruguay] ⚠️ No se pudo archivar deal espejo',
      mirrorDealId,
      err?.response?.body || err
    );
    return { archived: false, remainingValidCount: 0, error: 'archive_failed' };
  }

  try {
    await hubspotClient.crm.deals.basicApi.update(String(sourceDealId), {
      properties: { deal_uy_mirror_id: '' },
    });
    console.log('[mirrorDealToUruguay] ✅ Deal PY actualizado: deal_uy_mirror_id limpiado');
  } catch (err) {
    console.warn(
      '[mirrorDealToUruguay] ⚠️ No se pudo limpiar deal_uy_mirror_id en PY',
      sourceDealId,
      err?.response?.body || err
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

  if (options?.mode && parseBoolFromHubspot(srcProps.es_mirror_de_py)) {
  console.log('[mirrorDealToUruguay] skip mode propagation: source deal is a mirror', {
    dealId: String(sourceDealId),
    mode: options.mode,
  });
  options = { ...options, mode: null };
}
  
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
        // Sincronizar facturacion_activa si existe
        ...(srcProps.facturacion_activa ? { facturacion_activa: srcProps.facturacion_activa } : {}),
        // Sincronizar moneda si existe
        ...(sourceCurrency ? { deal_currency_code: sourceCurrency } : {}),
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
      // Sincronizar facturacion_activa si existe
      ...(srcProps.facturacion_activa ? { facturacion_activa: srcProps.facturacion_activa } : {}),
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

let lastMirrorLineItemId = null;

for (const li of uyLineItems) {
  const srcPropsLi = li.properties || {};
  const props = {};

  // copiar SOLO allowlist
  for (const key of Object.keys(srcPropsLi)) {
    if (LINE_ITEM_MIRROR_ALLOWLIST.has(key)) {
      props[key] = srcPropsLi[key];
    }
  }

  // obligatorias mirror
  props.uy = 'true';
  props.pais_operativo = 'Uruguay';
  props.hubspot_owner_id = userAdminMirror;
  props.of_line_item_py_origen_id = String(li.id).trim();

  // costo -> price
  const unitCost = parseFloat(srcPropsLi.hs_cost_of_goods_sold);
  if (isNaN(unitCost) || unitCost <= 0) {
    props.price = '0';
    props.hs_cost_of_goods_sold = '0';

    // opcional
    if ('mirror_missing_cost' in srcPropsLi) {
      props.mirror_missing_cost = 'true';
    } else {
      const existingNote = props.nota || '';
      props.nota = existingNote ? `${existingNote} | MISSING_COST` : 'MISSING_COST';
    }
  } else {
    props.price = String(unitCost);
    props.hs_cost_of_goods_sold = '0';
  }

  const { action, id } = await upsertUyLineItem(targetDealId, li, () => props);

  lastMirrorLineItemId = id;
  if (action === 'created') createdLineItems++;

  console.log(
    `[mirrorDealToUruguay] UY line item ${action}: ${id} (py=${props.of_line_item_py_origen_id})`
  );
}



console.log(`[mirrorDealToUruguay] ${createdLineItems} líneas creadas en espejo`);

// 4b) PRUNE: Eliminar del espejo los line items UY que ya no existen en el PY
console.log('[mirrorDealToUruguay] Prune de line items espejo UY');
try {
  const { prunedCount } = await pruneMirrorUyLineItems(targetDealId, uyLineItems);
  console.log(`[mirrorDealToUruguay] Prune completado: pruned=${prunedCount}`);
} catch (err) {
  console.warn('[mirrorDealToUruguay] ⚠️ Prune falló', err?.response?.body || err);
}
// 4c) Si el espejo quedó sin line items asociados, archivar deal espejo y limpiar link en PY
try {
  const res = await maybeArchiveMirrorDealIfEmpty(sourceDealId, targetDealId);
  if (res.archived) {
    // Si archivamos, no tiene sentido seguir asociando compañías/contactos/etc.
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
  console.warn('[mirrorDealToUruguay] ⚠️ Check de espejo vacío falló', err?.response?.body || err);
}


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

  // Propagación de intención SOLO para line items
  if (options.mode && typeof options.mode === 'string' && options.mode.startsWith('line_item.')) {
    if (lastMirrorLineItemId) {
      try {
        await propagateAndExecuteMirror({
          mode: options.mode,
          mirrorDealId: targetDealId,
          mirrorLineItemId: lastMirrorLineItemId,
          logLabel: 'mirrorDealToUruguay'
        });
      } catch (err) {
        console.warn('[mirrorDealToUruguay] propagateAndExecuteMirror error:', err?.message || err);
      }
    } else {
      console.log('[mirrorDealToUruguay] skip propagateAndExecuteMirror: no mirrorLineItemId');
    }
  } else {
    if (options.mode) {
      console.log('[mirrorDealToUruguay] skip propagateAndExecuteMirror: mode no es line_item.*');
    } else {
      console.log('[mirrorDealToUruguay] skip propagateAndExecuteMirror: no mode');
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