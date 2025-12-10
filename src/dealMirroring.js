// src/dealMirroring.js
//
// Módulo para “espejar” un negocio de Paraguay en Uruguay cuando el negocio
// original tiene líneas de pedido marcadas con el flag `uy = true`.
// Además, en el espejo UY el monto (price) de cada línea será el "costo"
// definido en la línea original.
//
// También actualiza el país operativo de negocio, empresa y contactos a “Mixto”.

import { hubspotClient, getDealWithLineItems } from './hubspotClient.js';

// Propiedad del line item (checkbox) que marca la línea como operada en UY.
const LINEA_PARA_UY_PROP = 'uy';
// ID de fallback para la empresa Interfase (si no se define por options o .env)
const DEFAULT_INTERFASE_COMPANY_ID = '34885518646';

// 👇 Propiedad de COSTO en el line item (ajustá si tu internal name es otro)
const LINE_ITEM_COST_PROP = 'costo';

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
 * En las líneas UY del espejo:
 * - Se copian todas las propiedades del line item original excepto `uy`.
 * - Si existe la propiedad `costo`, se usa ese valor como `price` en el espejo.
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
  process.env.DEFAULT_INTERFASE_COMPANY_ID || process.env.INTERFASE_PY_COMPANY_ID;
  

  // 1) Obtener negocio PY y sus líneas
  const { deal, lineItems } = await getDealWithLineItems(sourceDealId);
  if (!deal) {
    throw new Error(`No se encontró el negocio con ID ${sourceDealId}`);
  }

  const srcProps = deal.properties || {};
  // Moneda del negocio origen (propiedad de deal)
const sourceCurrency = srcProps.deal_currency_code || null;
console.log('[mirrorDealToUruguay] Moneda deal origen:', sourceCurrency);


  // 2) Verificar condiciones para espejar
  const check = shouldMirrorDealToUruguay(deal, lineItems);
  if (!check.ok) {
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

  // 3) Determinar si ya existe un espejo
  const existingMirrorId = srcProps.deal_uy_mirror_id;
  let targetDealId = null;
  let createdLineItems = 0;

  if (existingMirrorId) {
    // 3a) Intentar usar el espejo existente y SINCRONIZARLO
    targetDealId = String(existingMirrorId);

    try {
      const updateProps = {
        // Siempre Mixto en el espejo
        pais_operativo: 'Mixto',
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

      // Eliminar todas las líneas de pedido actuales del espejo
      const mirrorLineItemIds = await getAssocIdsV4(
        'deals',
        targetDealId,
        'line_items'
      );

      for (const liId of mirrorLineItemIds) {
        try {
          await hubspotClient.crm.lineItems.basicApi.archive(String(liId));
        } catch (err) {
          console.warn(
            '[mirrorDealToUruguay] No se pudo archivar line item en espejo UY',
            liId,
            err?.message || err
          );
        }
      }
    } catch (err) {
      console.warn(
        `[mirrorDealToUruguay] Deal espejo UY ${targetDealId} no existe o no se pudo actualizar. Se creará uno nuevo.`,
        err?.message || err
      );
      targetDealId = null; // Forzamos a crear uno nuevo más abajo
    }
  }


if (!targetDealId) {
  // 3b) Crear un nuevo negocio espejo con país operativo Mixto
  const newDealProps = {
    // Nombre = nombre original + sufijo UY
    dealname: srcProps.dealname ? `${srcProps.dealname} - UY` : 'Negocio UY',

    // Mantener pipeline y etapa del negocio origen (si existen)
    ...(srcProps.pipeline ? { pipeline: srcProps.pipeline } : {}),
    ...(srcProps.dealstage ? { dealstage: srcProps.dealstage } : {}),

    // País operativo y marcadores de espejo
    pais_operativo: 'Mixto',
    es_mirror_de_py: 'true',
    deal_py_origen_id: String(sourceDealId),

    // 👇 Copiar moneda del negocio origen al espejo (a nivel deal)
    ...(sourceCurrency ? { deal_currency_code: sourceCurrency } : {}),
  };

  console.log(
    '[mirrorDealToUruguay] Creando negocio espejo UY con moneda:',
    sourceCurrency
  );

  const createResp = await hubspotClient.crm.deals.basicApi.create({
    properties: newDealProps,
  });

  targetDealId = createResp.id;

  // Actualizar negocio PY: Mixto y guardar el ID del espejo
  await hubspotClient.crm.deals.basicApi.update(String(sourceDealId), {
    properties: {
      pais_operativo: 'Mixto',
      deal_uy_mirror_id: String(targetDealId),
    },
  });
}

  // 4) Crear en el espejo las líneas UY del negocio PY (siempre desde el estado ACTUAL)
  for (const li of uyLineItems) {
    const srcPropsLi = li.properties || {};
    const props = {};

    // Copiar todas las props excepto el flag `uy`
    for (const key of Object.keys(srcPropsLi)) {
      if (key === LINEA_PARA_UY_PROP) continue;
      props[key] = srcPropsLi[key];
    }

    // === COSTO → price + hs_cost_of_goods_sold en el espejo ===
    // Prioridad:
    // 1) hs_cost_of_goods_sold del original (nativo HubSpot)
    // 2) costo (custom tuyo, si lo seguís usando)
    // 3) precio (por si acaso lo usaste como "costo" en algún caso viejo)
    const rawCost =
      srcPropsLi.hs_cost_of_goods_sold ??
      srcPropsLi.costo ??
      srcPropsLi.precio;

    if (rawCost !== undefined && rawCost !== null && rawCost !== '') {
      // Normalizamos a número por las dudas
      const costNum = Number(rawCost);
      const finalCost = Number.isFinite(costNum) ? costNum : rawCost;

      // En el espejo:
      // - price = costo (lo que Interfase va a pagar)
      // - hs_cost_of_goods_sold = costo (para contabilidad / margen)
      props.price = finalCost;
      props.hs_cost_of_goods_sold = finalCost;

      console.log(
        '[mirrorDealToUruguay] Línea UY espejada',
        srcPropsLi.name,
        '→ price =',
        finalCost,
        'hs_cost_of_goods_sold =',
        finalCost
      );
    } else {
      console.log(
        '[mirrorDealToUruguay] Línea UY sin costo definido para',
        srcPropsLi.name,
        '(no se sobreescribe price/hs_cost_of_goods_sold)'
      );
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
        '[mirrorDealToUruguay] Asocié Interfase',
        String(interfaseCompanyId),
        'al deal UY',
        String(targetDealId)
      );
    } catch (err) {
      console.warn(
        '[mirrorDealToUruguay] No se pudo asociar Interfase al deal UY:',
        err?.response?.body || err
      );
    }
  } else {
    console.warn(
      '[mirrorDealToUruguay] INTERFASE_PY_COMPANY_ID no está configurado. No se puede asociar Interfase como empresa principal.'
    );
  }


  // 6) Determinar la empresa beneficiaria (primera empresa asociada al negocio PY)
  const companyIds = await getAssocIdsV4('deals', String(sourceDealId), 'companies');
  const beneficiaryCompanyId =
    companyIds && companyIds.length > 0 ? String(companyIds[0]) : null;

  // 7) Actualizar empresa beneficiaria y sus contactos a Mixto y asociarlos al espejo
  if (beneficiaryCompanyId) {
    // Guardar el cliente beneficiario en el negocio espejo
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

  // 8) Devolver resumen
  return {
    mirrored: true,
    sourceDealId: String(sourceDealId),
    targetDealId: String(targetDealId),
    uyLineItemsCount: uyLineItems.length,
    createdLineItems,
  };
}
