// src/dealMirroring.js
//
// Módulo para “espejar” un negocio de Paraguay en Uruguay cuando el negocio
// original tiene líneas de pedido marcadas con el flag `uy = true`.  Este
// nuevo flujo evita duplicar negocios UY innecesariamente y actualiza el espejo
// existente cuando se modifican las líneas UY en el negocio paraguayo.
// También actualiza el país operativo de negocio, empresa y contactos a “Mixto”.

import { hubspotClient, getDealWithLineItems } from './hubspotClient.js';

// Propiedad del line item (checkbox) que marca la línea como operada en UY.
const LINEA_PARA_UY_PROP = 'uy';

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
  if (parseBoolFromHubspot(props.es_mirror_de_py)) {
    return { ok: false, reason: 'deal is already a mirror' };
  }
  const hasUy = lineItems.some((li) =>
    parseBoolFromHubspot(li.properties?.[LINEA_PARA_UY_PROP])
  );
  return hasUy ? { ok: true } : { ok: false, reason: 'no UY line items' };
}

/**
 * Crea o actualiza un negocio “espejo” en UY a partir de un negocio de PY.
 *
 * - Si el negocio ya tiene un espejo (`deal_uy_mirror_id`), se reutiliza ese
 *   negocio, se borran sus líneas de pedido y se vuelven a crear con las
 *   líneas UY actuales.
 * - Si no existe espejo, se crea uno nuevo con país operativo “Mixto”,
 *   marcándolo como espejo y vinculándolo al negocio PY.
 * - El negocio PY pasa a tener país operativo “Mixto” y guarda el ID del espejo.
 * - La empresa beneficiaria es la primera empresa asociada al negocio PY; su
 *   país operativo y el de sus contactos se actualizan a “Mixto”.
 * - La empresa dueña (Interfase PY) se asocia siempre al negocio UY.
 *
 * @param {string|number} sourceDealId ID del negocio paraguayo.
 * @param {Object} options Opcional: { interfaseCompanyId }
 * @returns {Promise<Object>} Resumen de la operación.
 */
export async function mirrorDealToUruguay(sourceDealId, options = {}) {
  if (!sourceDealId) {
    throw new Error('mirrorDealToUruguay requiere un dealId');
  }

  // ID de la empresa dueña (Interfase PY) — puede venir en options o en env.
  const interfaseCompanyId =
    options.interfaseCompanyId || process.env.INTERFASE_PY_COMPANY_ID;

  // 1) Obtener negocio PY y sus líneas
  const { deal, lineItems } = await getDealWithLineItems(sourceDealId);
  if (!deal) throw new Error(`No se encontró el negocio con ID ${sourceDealId}`);

  // 2) Verificar condiciones para espejar
  const check = shouldMirrorDealToUruguay(deal, lineItems);
  if (!check.ok) {
    return { mirrored: false, sourceDealId, reason: check.reason };
  }

  // Filtrar las líneas de negocio con flag UY = true
  const uyLineItems = lineItems.filter((li) =>
    parseBoolFromHubspot(li.properties?.[LINEA_PARA_UY_PROP])
  );
  if (!uyLineItems.length) {
    return { mirrored: false, sourceDealId, reason: 'no UY line items' };
  }

  // 3) Determinar si ya existe un espejo
  const existingMirrorId = deal.properties?.deal_uy_mirror_id;
  let targetDealId;
  let createdLineItems = 0;

  if (existingMirrorId) {
    // 3a) Usar el espejo existente y actualizarlo
    targetDealId = String(existingMirrorId);

    // Asegurar país operativo Mixto en el espejo
    await hubspotClient.crm.deals.basicApi.update(targetDealId, {
      properties: { pais_operativo: 'Mixto' },
    });

    // Eliminar todas las líneas de pedido actuales del espejo
    const mirrorLineItemIds = await getAssocIdsV4(
      'deals',
      targetDealId,
      'line_items'
    );
    for (const liId of mirrorLineItemIds) {
      try {
        await hubspotClient.crm.lineItems.basicApi.archive(String(liId));
      } catch {
        // Ignorar si no se puede archivar
      }
    }
  } else {
    // 3b) Crear un nuevo negocio espejo con país operativo Mixto
    const srcProps = deal.properties || {};
    const newDealProps = {
      dealname: srcProps.dealname ? `${srcProps.dealname} - UY` : 'Negocio UY',
      ...(srcProps.pipeline ? { pipeline: srcProps.pipeline } : {}),
      ...(srcProps.dealstage ? { dealstage: srcProps.dealstage } : {}),
      pais_operativo: 'Mixto',
      es_mirror_de_py: 'true',
      deal_py_origen_id: String(sourceDealId),
    };
    const createResp = await hubspotClient.crm.deals.basicApi.create({
      properties: newDealProps,
    });
    targetDealId = createResp.id;

    // Actualizar negocio PY: Mixto y guardar el ID del espejo
    await hubspotClient.crm.deals.basicApi.update(sourceDealId, {
      properties: {
        pais_operativo: 'Mixto',
        deal_uy_mirror_id: String(targetDealId),
      },
    });
  }

  // 4) Crear en el espejo las líneas UY del negocio PY
  for (const li of uyLineItems) {
    const props = {};
    for (const key of Object.keys(li.properties || {})) {
      // No copiar el flag `uy`
      if (key === LINEA_PARA_UY_PROP) continue;
      props[key] = li.properties[key];
    }
    await hubspotClient.crm.lineItems.basicApi.create({
      properties: props,
      associations: [
        {
          to: { id: targetDealId },
          types: [
            {
              associationCategory: 'HUBSPOT_DEFINED',
              associationTypeId: LINE_ITEM_TO_DEAL_ASSOC_ID,
            },
          ],
        },
      ],
    });
    createdLineItems++;
  }

  // 5) Determinar la empresa beneficiaria (primera empresa asociada al negocio PY)
  const companyIds = await getAssocIdsV4('deals', sourceDealId, 'companies');
  const beneficiaryCompanyId =
    companyIds && companyIds.length > 0 ? String(companyIds[0]) : null;

  // 6) Actualizar empresa beneficiaria y sus contactos a Mixto y asociarlos al espejo
  if (beneficiaryCompanyId) {
      // 6) Actualizar empresa beneficiaria y sus contactos a Mixto y asociarlos al espejo
if (beneficiaryCompanyId) {
  // 👇 NUEVO: guardar el cliente beneficiario en el negocio espejo
  try {
    await hubspotClient.crm.deals.basicApi.update(String(targetDealId), {
      properties: {
        cliente_beneficiario: beneficiaryCompanyId, 
      },
    });
  } catch {
    // Ignorar errores de actualización de la propiedad
  }

  // Cambiar país operativo de la empresa beneficiaria
  try {
    await hubspotClient.crm.companies.basicApi.update(beneficiaryCompanyId, {
      properties: { pais_operativo: 'Mixto' },
    });
  } catch {
    // Ignorar errores de actualización
  }

  // Asociar la empresa beneficiaria al negocio espejo (si no lo está)
  try {
    await hubspotClient.crm.associations.v4.basicApi.createDefault(
      'companies',
      beneficiaryCompanyId,
      'deals',
      String(targetDealId)
    );
  } catch {
    // Ignorar si ya estaba asociada
  }

  // Actualizar país operativo de los contactos de la empresa beneficiaria y asociarlos
  const beneficiaryContactIds = await getAssocIdsV4(
    'companies',
    beneficiaryCompanyId,
    'contacts'
  );

  for (const contactId of beneficiaryContactIds) {
    try {
      await hubspotClient.crm.contacts.basicApi.update(String(contactId), {
        properties: { pais_operativo: 'Mixto' },
      });
    } catch {
      // Ignorar errores
    }
    try {
      await hubspotClient.crm.associations.v4.basicApi.createDefault(
        'contacts',
        String(contactId),
        'deals',
        String(targetDealId)
      );
    } catch {
      // Ignorar si ya estaba asociado
    }
  }
}


  // 7) Asociar explícitamente Interfase PY al espejo
  if (interfaseCompanyId) {
    try {
      await hubspotClient.crm.associations.v4.basicApi.createDefault(
        'companies',
        String(interfaseCompanyId),
        'deals',
        String(targetDealId)
      );
    } catch {
      // Ignorar si ya estaba asociada
    }
  }

  // 8) Devolver resumen
  return {
    mirrored: true,
    sourceDealId: String(sourceDealId),
    targetDealId: String(targetDealId),
    uyLineItemsCount: uyLineItems.length,
    createdLineItems,
  };
}
}
