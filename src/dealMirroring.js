// src/dealMirroring.js
//
// Este módulo implementa la lógica de “espejar” un negocio de Paraguay en
// Uruguay cuando el negocio original tiene líneas de producto marcadas para UY.
//
// La función principal mirrorDealToUruguay realiza:
//   1. Leer el negocio origen junto con sus líneas.
//   2. Filtrar las líneas cuyo destino operativo es UY (checkbox `uy`).
//   3. Crear un nuevo negocio “espejo” en Uruguay con propiedades básicas
//      copiadas del negocio origen, marcándolo como espejo y anotando el ID
//      del negocio de Paraguay.
//   4. Duplicar cada línea de negocio marcada para UY, copiando sus
//      propiedades (excepto el flag `uy`) y asociarlas al nuevo negocio.
//   5. Actualizar el negocio de Paraguay para reflejar que opera en más de un
//      país y guardar el ID del negocio espejo.
//   6. Actualizar las empresas y contactos asociados al negocio original y
//      asociarlos al nuevo negocio.
//   7. Asociar explícitamente la empresa dueña (Interfase PY) al negocio UY.
//      La empresa beneficiaria es el cliente del negocio origen (companies
//      ya asociadas al deal PY).

import { hubspotClient, getDealWithLineItems } from './hubspotClient.js';

// Nombre interno de la propiedad checkbox del line item que indica que es UY
const LINEA_PARA_UY_PROP = 'uy';

// ID de asociación por defecto entre line items y deals (HUBSPOT_DEFINED)
const LINE_ITEM_TO_DEAL_ASSOC_ID = 20;

// helper para obtener asociaciones v4
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

// Interpreta valores tipo booleano provenientes de HubSpot (checkbox)
function parseBoolFromHubspot(raw) {
  const v = (raw ?? '').toString().toLowerCase();
  return v === 'true' || v === '1' || v === 'sí' || v === 'si' || v === 'yes';
}

export function shouldMirrorDealToUruguay(deal, lineItems) {
  const props = deal?.properties || {};

  // Evitar bucles: si ya es espejo, no hacemos nada
  if (parseBoolFromHubspot(props.es_mirror_de_py)) {
    return { ok: false, reason: 'deal is already a mirror' };
  }

  // ¿Alguna línea con checkbox `uy = true`?
  const hasUy = lineItems.some(li =>
    parseBoolFromHubspot(li.properties?.[LINEA_PARA_UY_PROP])
  );

  return hasUy ? { ok: true } : { ok: false, reason: 'no UY line items' };
}

export async function mirrorDealToUruguay(sourceDealId, options = {}) {
  if (!sourceDealId) {
    throw new Error('mirrorDealToUruguay requiere un dealId');
  }

  // Empresa dueña fija: Interfase PY (por env o pasado en options)
  const interfaseCompanyId =
    options.interfaseCompanyId || process.env.INTERFASE_PY_COMPANY_ID;

  const { deal, lineItems } = await getDealWithLineItems(sourceDealId);

  const check = shouldMirrorDealToUruguay(deal, lineItems);
  if (!check.ok) {
    return { mirrored: false, sourceDealId, reason: check.reason };
  }

  // Filtrar las líneas que tengan `uy = true`
  const uyLineItems = lineItems.filter(li =>
    parseBoolFromHubspot(li.properties?.[LINEA_PARA_UY_PROP])
  );
  if (!uyLineItems.length) {
    return { mirrored: false, sourceDealId, reason: 'no UY line items' };
  }

  // Crear negocio espejo
  const srcProps = deal.properties || {};
  const newDealProps = {
    dealname: srcProps.dealname ? `${srcProps.dealname} - UY` : 'Negocio UY',
    ...(srcProps.pipeline ? { pipeline: srcProps.pipeline } : {}),
    ...(srcProps.dealstage ? { dealstage: srcProps.dealstage } : {}),
    pais_operativo: 'Uruguay',
    es_mirror_de_py: 'true',
    deal_py_origen_id: String(sourceDealId),
  };

  const createResp = await hubspotClient.crm.deals.basicApi.create({
    properties: newDealProps,
  });
  const targetDealId = createResp.id;

  // Duplicar líneas UY
  let createdLineItems = 0;
  for (const li of uyLineItems) {
    const props = {};
    for (const key of Object.keys(li.properties || {})) {
      // No copiamos el flag `uy` al negocio espejo
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

  // Actualizar negocio origen a Mixto y guardar ID del espejo
  await hubspotClient.crm.deals.basicApi.update(sourceDealId, {
    properties: {
      pais_operativo: 'Mixto',
      deal_uy_mirror_id: String(targetDealId),
    },
  });

  // Empresas asociadas: pasar a Mixto y asociarlas al nuevo negocio
  const companyIds = await getAssocIdsV4('deals', sourceDealId, 'companies');
  for (const companyId of companyIds) {
    const company = await hubspotClient.crm.companies.basicApi.getById(
      String(companyId),
      ['pais_operativo']
    );
    const cProps = company?.properties || {};
    if (cProps.pais_operativo === 'Paraguay') {
      await hubspotClient.crm.companies.basicApi.update(String(companyId), {
        properties: { pais_operativo: 'Mixto' },
      });
    }

    // Asociar también esa empresa (cliente beneficiario) al negocio UY
    await hubspotClient.crm.associations.v4.basicApi.createDefault(
      'companies',
      String(companyId),
      'deals',
      String(targetDealId)
    );
  }

  // Contactos asociados: pasar a Mixto y asociarlos al nuevo negocio
  const contactIds = await getAssocIdsV4('deals', sourceDealId, 'contacts');
  for (const contactId of contactIds) {
    const contact = await hubspotClient.crm.contacts.basicApi.getById(
      String(contactId),
      ['pais_operativo']
    );
    const ctProps = contact?.properties || {};
    if (ctProps.pais_operativo === 'Paraguay') {
      await hubspotClient.crm.contacts.basicApi.update(String(contactId), {
        properties: { pais_operativo: 'Mixto' },
      });
    }

    await hubspotClient.crm.associations.v4.basicApi.createDefault(
      'contacts',
      String(contactId),
      'deals',
      String(targetDealId)
    );
  }

  // Asegurar asociación explícita de Interfase PY al negocio espejo,
  // incluso si no estaba asociada al negocio origen
  if (interfaseCompanyId) {
    await hubspotClient.crm.associations.v4.basicApi.createDefault(
      'companies',
      String(interfaseCompanyId),
      'deals',
      String(targetDealId)
    );
  }

  return {
    mirrored: true,
    sourceDealId: String(sourceDealId),
    targetDealId: String(targetDealId),
    uyLineItemsCount: uyLineItems.length,
    createdLineItems,
  };
}
