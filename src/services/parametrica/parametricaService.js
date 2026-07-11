// src/services/parametrica/parametricaService.js
//
// Lógica del ajuste de precio por paramétrica — caso masivo iJServ (Petróleo).
// Lee/escribe line items en HubSpot; el estado de cada corrida vive en
// parametrica_batches / parametrica_items (api/parametrica/Db.js).
//
// Exclusiones del ajuste (se listan aparte en la pantalla, no se tocan):
//   - Espejos UY (of_line_item_py_origen_id presente): el cron de mirroring
//     deriva su price del costo del LI PY y pisaría el cambio.
//   - LIs de deals fuera de BILLING_ACTIVE_DEAL_STAGES (cerrados/perdidos/etc.).

import { hubspotClient } from '../../hubspotClient.js';
import {
  BILLING_ACTIVE_DEAL_STAGES,
  PROXIMOS_A_FACTURAR_STAGE,
  TICKET_STAGE_LISTO_MANUAL,
  BILLING_AUTOMATED_READY,
  isDryRun,
} from '../../config/constants.js';
import logger from '../../../lib/logger.js';

const MOD = 'parametricaService';

// Fecha YYYY-MM-DD en hora Montevideo (evita correrse de día por UTC)
const fmtFechaMvd = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'America/Montevideo', year: 'numeric', month: '2-digit', day: '2-digit',
});
const hoyMvd = () => fmtFechaMvd.format(new Date());

export const IJSERV_PRODUCT_ID = (process.env.IJSERV_PRODUCT_ID || '').trim();

const LI_PROPS = [
  'hs_object_id', 'hs_lastmodifieddate',
  'name', 'price', 'quantity', 'amount', 'hs_product_id',
  'area', 'servicio', 'unidad_de_negocio', 'nombre_empresa',
  'of_moneda', 'deal_currency_code',
  'uy', 'pais_operativo', 'of_line_item_py_origen_id', 'pausa',
  'monto_unitario_original', 'monto_unitario_actual',
  'ajuste_factura_aparte', 'tipo_de_parametrica',
  'fecha_ultimo_ajuste', 'porcentaje_ultimo_ajuste',
];

// ────────────────────────────────────────────────────────────
// Lectura
// ────────────────────────────────────────────────────────────

/**
 * Busca todos los line items del producto iJServ (paginado).
 */
export async function searchIjservLineItems() {
  if (!IJSERV_PRODUCT_ID) {
    throw new Error('IJSERV_PRODUCT_ID no configurado');
  }
  const all = [];
  let after;
  const MAX_PAGES = 30;

  for (let page = 0; page < MAX_PAGES; page++) {
    const searchBody = {
      filterGroups: [{
        filters: [
          { propertyName: 'hs_product_id', operator: 'EQ', value: IJSERV_PRODUCT_ID },
        ],
      }],
      properties: LI_PROPS,
      sorts: [{ propertyName: 'hs_object_id', direction: 'ASCENDING' }],
      limit: 100,
    };
    if (after) searchBody.after = after;

    const res = await hubspotClient.crm.lineItems.searchApi.doSearch(searchBody);
    const results = res?.results || [];
    all.push(...results);

    const nextAfter = res?.paging?.next?.after;
    if (!nextAfter || results.length < 100) break;
    after = nextAfter;
  }
  return all;
}

/**
 * Resuelve el deal asociado de cada line item (batch associations v4, chunks de 100)
 * y lee dealname + dealstage de cada deal (batch read).
 * @returns Map(lineItemId -> {dealId, dealName, dealStage})
 */
export async function resolveDealsForLineItems(lineItems) {
  const liToDeal = new Map();
  if (!lineItems.length) return liToDeal;

  for (let i = 0; i < lineItems.length; i += 100) {
    const inputs = lineItems.slice(i, i + 100).map(li => ({ id: String(li.id) }));
    const resp = await hubspotClient.crm.associations.v4.batchApi.getPage(
      'line_items', 'deals', { inputs }
    );
    for (const item of resp?.results || []) {
      const lineItemId = String(item?._from?.id || item?.from?.id || '');
      const dealId = String(item?.to?.[0]?.toObjectId || '');
      if (lineItemId && dealId) liToDeal.set(lineItemId, dealId);
    }
  }

  const dealIds = [...new Set(liToDeal.values())];
  const deals = new Map();
  for (let i = 0; i < dealIds.length; i += 100) {
    const inputs = dealIds.slice(i, i + 100).map(id => ({ id }));
    const resp = await hubspotClient.crm.deals.batchApi.read(
      { inputs, properties: ['dealname', 'dealstage'] }, false
    );
    for (const d of resp?.results || []) {
      deals.set(String(d.id), {
        dealName: d.properties?.dealname || '',
        dealStage: d.properties?.dealstage || '',
      });
    }
  }

  const out = new Map();
  for (const [liId, dealId] of liToDeal) {
    const deal = deals.get(dealId) || { dealName: '', dealStage: '' };
    out.set(liId, { dealId, ...deal });
  }
  return out;
}

/**
 * Arma la vista completa: elegibles para el ajuste + excluidos con motivo.
 */
export async function listarLineItemsIjserv() {
  const lis = await searchIjservLineItems();
  const dealsByLi = await resolveDealsForLineItems(lis);

  const elegibles = [];
  const excluidos = [];

  for (const li of lis) {
    const p = li.properties || {};
    const deal = dealsByLi.get(String(li.id)) || {};
    const row = {
      lineItemId: String(li.id),
      dealId: deal.dealId || null,
      dealName: deal.dealName || '',
      dealStage: deal.dealStage || '',
      empresa: p.nombre_empresa || '',
      area: p.area || '',
      producto: 'iJServ',
      servicio: p.name || '',
      price: p.price != null && p.price !== '' ? Number(p.price) : null,
      moneda: p.of_moneda || p.deal_currency_code || '',
      fechaUltimoAjuste: p.fecha_ultimo_ajuste || null,
      porcentajeUltimoAjuste: p.porcentaje_ultimo_ajuste || null,
      montoUnitarioOriginal: p.monto_unitario_original || null,
      pausa: p.pausa === 'true',
    };

    if (p.of_line_item_py_origen_id) {
      excluidos.push({ ...row, motivo: 'espejo_intercompany' });
    } else if (!deal.dealId) {
      excluidos.push({ ...row, motivo: 'sin_deal' });
    } else if (!BILLING_ACTIVE_DEAL_STAGES.has(String(deal.dealStage))) {
      excluidos.push({ ...row, motivo: 'deal_no_activo' });
    } else if (row.price == null || Number.isNaN(row.price)) {
      excluidos.push({ ...row, motivo: 'sin_precio' });
    } else {
      elegibles.push(row);
    }
  }
  return { productoId: IJSERV_PRODUCT_ID, elegibles, excluidos };
}

/**
 * Cuenta, por line item, los tickets ya promovidos con fecha futura que
 * conservarán el precio viejo (Phase P no re-snapshotea los protegidos).
 * @returns Map(lineItemId -> {count, stages: [..]})
 */
export async function contarTicketsProtegidosFuturos(lineItemIds) {
  const out = new Map();
  const hoy = hoyMvd();
  const stagesProtegidos = [
    PROXIMOS_A_FACTURAR_STAGE,
    TICKET_STAGE_LISTO_MANUAL,
    BILLING_AUTOMATED_READY,
  ].filter(Boolean);

  for (const liId of lineItemIds) {
    try {
      const resp = await hubspotClient.crm.tickets.searchApi.doSearch({
        filterGroups: stagesProtegidos.map(stage => ({
          filters: [
            { propertyName: 'of_line_item_ids', operator: 'CONTAINS_TOKEN', value: String(liId) },
            { propertyName: 'hs_pipeline_stage', operator: 'EQ', value: stage },
            { propertyName: 'fecha_resolucion_esperada', operator: 'GTE', value: hoy },
          ],
        })),
        properties: ['hs_pipeline_stage'],
        limit: 100,
      });
      const results = resp?.results || [];
      if (results.length) {
        out.set(String(liId), {
          count: results.length,
          stages: [...new Set(results.map(t => t.properties?.hs_pipeline_stage))],
        });
      }
    } catch (err) {
      logger.warn({ module: MOD, fn: 'contarTicketsProtegidosFuturos', liId, err: err?.message },
        'No se pudo contar tickets protegidos — se omite advertencia para este LI');
    }
  }
  return out;
}

// ────────────────────────────────────────────────────────────
// Escritura
// ────────────────────────────────────────────────────────────

/**
 * Lee el price actual de un LI (para verificar que no cambió desde el preview).
 */
export async function leerPriceActual(lineItemId) {
  const li = await hubspotClient.crm.lineItems.basicApi.getById(
    String(lineItemId), ['price', 'monto_unitario_original']
  );
  const p = li?.properties || {};
  return {
    price: p.price != null && p.price !== '' ? Number(p.price) : null,
    montoUnitarioOriginal: p.monto_unitario_original || null,
  };
}

/**
 * Aplica el ajuste a UN line item: price nuevo + props de rastreo.
 * monto_unitario_original solo se setea si estaba vacío (primer ajuste).
 */
export async function aplicarAjusteLineItem({ lineItemId, priceViejo, priceNuevo, pct, montoUnitarioOriginal }) {
  const properties = {
    price: String(priceNuevo),
    fecha_ultimo_ajuste: hoyMvd(),
    porcentaje_ultimo_ajuste: String(pct),
  };
  if (montoUnitarioOriginal == null || montoUnitarioOriginal === '') {
    properties.monto_unitario_original = String(priceViejo);
  }
  if (isDryRun()) {
    logger.info({ module: MOD, fn: 'aplicarAjusteLineItem', lineItemId, properties }, '[DRY_RUN] update omitido');
    return;
  }
  await hubspotClient.crm.lineItems.basicApi.update(String(lineItemId), { properties });
}

/**
 * Revierte UN line item al price_viejo guardado en DB.
 */
export async function revertirLineItem({ lineItemId, priceViejo }) {
  const properties = {
    price: String(priceViejo),
    fecha_ultimo_ajuste: hoyMvd(),
  };
  if (isDryRun()) {
    logger.info({ module: MOD, fn: 'revertirLineItem', lineItemId, properties }, '[DRY_RUN] update omitido');
    return;
  }
  await hubspotClient.crm.lineItems.basicApi.update(String(lineItemId), { properties });
}
