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
import { PROMOTED_STAGES, ASSOC_LABEL_EMPRESA_FACTURA, ASSOC_LABEL_EMPRESA_PARTNER } from './config/constants.js';
import { reportHubSpotError } from './utils/hubspotErrorCollector.js';


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
    properties: ['of_line_item_py_origen_id', 'pais_operativo', 'uy', 'name', 'line_item_key', 'hs_lastmodifieddate', 'createdate'],
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

// Caso 1: huérfano -> guard de tickets promovidos antes de eliminar
    if (!origenExists) {
      // Verificar si el LI mirror tiene tickets en stages promovidos/emitidos
 let hasPromoted = false;
      try {
        const lik = String(p.line_item_key || '').trim();
        if (lik) {
          const searchResp = await hubspotClient.crm.tickets.searchApi.doSearch({
            filterGroups: [{
              filters: [
                { propertyName: 'of_line_item_key', operator: 'EQ', value: lik },
              ],
            }],
            properties: ['hs_pipeline_stage'],
            limit: 100,
          });
          hasPromoted = (searchResp.results || []).some((t) =>
            PROMOTED_STAGES.has(String(t.properties?.hs_pipeline_stage || ''))
          );
        }
      } catch (err) {
        logger.warn(
          { module: 'dealMirroring', fn: 'pruneMirrorUyLineItems', mirrorDealId, lineItemId: li.id, origenId, err },
          'Prune: error al verificar tickets promovidos, tratando como protegido'
        );
        hasPromoted = true; // fail-safe: no borrar si no pudimos verificar
      }

      if (hasPromoted) {
        // Pausar en lugar de eliminar
        try {
          await hubspotClient.crm.lineItems.basicApi.update(String(li.id), {
            properties: {
              pausa: 'true',
              of_billing_error: 'LI pausado: el original PY perdió vínculo UY. Tiene tickets promovidos/emitidos.',
            },
          });
          reportHubSpotError({
            level: 'warn',
            objectType: 'deal',
            objectId: mirrorDealId,
            message: `LI espejo pausado: "${p.name || li.id}" fue desvinculado de Uruguay en el deal PY. Tickets promovidos/emitidos se mantienen. Futuros pagos NO se generarán para este producto en UY.`,
          });

          logger.info(
            { module: 'dealMirroring', fn: 'pruneMirrorUyLineItems', mirrorDealId, lineItemId: li.id, origenId, name: p.name },
            'Prune: huérfano con tickets promovidos — pausado en lugar de eliminado'
          );
        } catch (err) {
          logger.warn(
            { module: 'dealMirroring', fn: 'pruneMirrorUyLineItems', mirrorDealId, lineItemId: li.id, origenId, err },
            'Prune: error al pausar huérfano protegido'
          );
        }
        continue;
      }

      // Sin tickets promovidos: REGLA USUARIA (2026-07-18) — al borrarse el LI original
      // en PY, el espejo UY NO se borra: se pausa y se AVISA para revisión humana (antes
      // se desasociaba + archivaba en silencio). Nunca perdemos el espejo automáticamente.
      try {
        await hubspotClient.crm.lineItems.basicApi.update(String(li.id), {
          properties: {
            pausa: 'true',
            of_billing_error: 'LI espejo pausado: el LI original en PY fue borrado/desvinculado. NO se elimina el espejo — revisar y decidir a mano.',
          },
        });
        reportHubSpotError({
          level: 'warn',
          objectType: 'deal',
          objectId: mirrorDealId,
          message: `LI espejo pausado: "${p.name || li.id}" — su original en Paraguay fue borrado o desvinculado de Uruguay. No tenía facturación aún. El espejo NO se elimina automáticamente: futuros pagos quedan pausados. Revisar y decidir si corresponde eliminarlo o reactivarlo.`,
        });
        logger.info(
          { module: 'dealMirroring', fn: 'pruneMirrorUyLineItems', mirrorDealId, lineItemId: li.id, origenId, name: p.name },
          'Prune: huérfano sin facturación — pausado y avisado (no se elimina, regla usuaria)'
        );
      } catch (err) {
        logger.warn(
          { module: 'dealMirroring', fn: 'pruneMirrorUyLineItems', mirrorDealId, lineItemId: li.id, origenId, err },
          'Prune: error al pausar/avisar huérfano sin facturación'
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

// ¿El LI espejo (por su line_item_key) tiene tickets en stages promovidos/emitidos?
// fail-safe: ante error de lectura devuelve true (tratar como facturado → no tocar).
async function lineItemHasPromotedTickets(lik) {
  const key = String(lik || '').trim();
  if (!key) return false;
  try {
    const searchResp = await hubspotClient.crm.tickets.searchApi.doSearch({
      filterGroups: [{ filters: [{ propertyName: 'of_line_item_key', operator: 'EQ', value: key }] }],
      properties: ['hs_pipeline_stage'],
      limit: 100,
    });
    return (searchResp.results || []).some((t) =>
      PROMOTED_STAGES.has(String(t.properties?.hs_pipeline_stage || ''))
    );
  } catch (err) {
    logger.warn(
      { module: 'dealMirroring', fn: 'lineItemHasPromotedTickets', lik: key, err },
      'Dedup sellado: error verificando tickets promovidos — se trata como facturado (no se toca)'
    );
    return true;
  }
}

/**
 * DEDUP para mirrors SELLADOS (auditoría 2026-07-18, D1·Q4 / #10b).
 *
 * En mirrors sellados el prune completo se omite por diseño (el stock migrado de agosto
 * es independiente del PY, así que no se puede borrar un "huérfano"). Pero eso también deja
 * pasar un duplicado PERMANENTE: dos LIs espejo con el MISMO of_line_item_py_origen_id
 * (creados por la carrera histórica LI↔cron) = doble línea de costo para siempre.
 *
 * Este pase deduplica SOLO por of_line_item_py_origen_id exacto, sin tocar huérfanos.
 * Es CONSERVADOR: conserva el LI que tiene facturación real (tickets promovidos/emitidos);
 * si el elegido a descartar tiene facturación, NO lo desasocia — avisa para revisión humana.
 * Idempotente: en un mirror sin duplicados no hace nada.
 */
async function dedupeSealedMirrorLineItems(mirrorDealId) {
  const ids = await getAssocIdsV4('deals', String(mirrorDealId), 'line_items', 500);
  if (ids.length < 2) return { dedupedCount: 0 };

  const batchResp = await hubspotClient.crm.lineItems.batchApi.read({
    inputs: ids.map((id) => ({ id: String(id) })),
    properties: ['of_line_item_py_origen_id', 'pais_operativo', 'uy', 'name', 'line_item_key', 'createdate'],
  });

  const groups = new Map();
  for (const li of batchResp.results || []) {
    const p = li.properties || {};
    const origenId = String(p.of_line_item_py_origen_id || '').trim();
    if (!origenId) continue;
    const uyFlag = String(p.uy || '').toLowerCase() === 'true';
    const isUruguay = String(p.pais_operativo || '').toLowerCase() === 'uruguay';
    if (!uyFlag || !isUruguay) continue;
    if (!groups.has(origenId)) groups.set(origenId, []);
    groups.get(origenId).push(li);
  }

  let dedupedCount = 0;
  for (const [origenId, lis] of groups) {
    if (lis.length < 2) continue;

    // Anotar cada LI con si tiene facturación real y su antigüedad.
    const anotados = [];
    for (const li of lis) {
      const promoted = await lineItemHasPromotedTickets(li.properties?.line_item_key);
      anotados.push({ li, promoted, createdate: String(li.properties?.createdate || '') });
    }

    // Keeper: si EXACTAMENTE uno tiene facturación → ese; si no, el más viejo (createdate asc).
    const conFactura = anotados.filter((x) => x.promoted);
    const keeper = conFactura.length === 1
      ? conFactura[0]
      : anotados.slice().sort((a, b) => a.createdate.localeCompare(b.createdate))[0];

    for (const x of anotados) {
      if (String(x.li.id) === String(keeper.li.id)) continue;

      if (x.promoted) {
        // El duplicado a descartar tiene facturación → NO desasociar automáticamente.
        reportHubSpotError({
          level: 'warn',
          objectType: 'deal',
          objectId: String(mirrorDealId),
          message: `LI espejo DUPLICADO con facturación en deal sellado (origen PY ${origenId}, "${x.li.properties?.name || x.li.id}"). Hay 2+ líneas espejo del mismo LI PY y más de una tiene tickets promovidos/emitidos. NO se desasoció automáticamente — revisar a mano cuál conservar.`,
        });
        logger.warn(
          { module: 'dealMirroring', fn: 'dedupeSealedMirrorLineItems', mirrorDealId, lineItemId: x.li.id, origenId },
          'Dedup sellado: duplicado con facturación — no se toca, se avisa para revisión humana'
        );
        continue;
      }

      // Duplicado sin facturación → desasociar (no se archiva el LI, solo se saca del deal).
      try {
        await hubspotClient.crm.associations.v4.basicApi.archive(
          'line_items', String(x.li.id), 'deals', String(mirrorDealId)
        );
        dedupedCount++;
        logger.info(
          { module: 'dealMirroring', fn: 'dedupeSealedMirrorLineItems', mirrorDealId, lineItemId: x.li.id, origenId, keeper: keeper.li.id, name: x.li.properties?.name },
          'Dedup sellado: duplicado sin facturación desasociado'
        );
      } catch (err) {
        logger.warn(
          { module: 'dealMirroring', fn: 'dedupeSealedMirrorLineItems', mirrorDealId, lineItemId: x.li.id, origenId, err },
          'Dedup sellado: error al desasociar duplicado'
        );
      }
    }
  }

  return { dedupedCount };
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
      properties: ['of_line_item_py_origen_id', 'pais_operativo', 'uy', 'name', 'pausa'],
    });

    const validMirrorItems = (batchResp.results || []).filter((li) => {
      const p = li.properties || {};
      const origenId = String(p.of_line_item_py_origen_id || '').trim();
      const uyFlag = String(p.uy || '').toLowerCase() === 'true';
      const isUruguay = String(p.pais_operativo || '').toLowerCase() === 'uruguay';
      return origenId && uyFlag && isUruguay;
    });

    // Proteger deal si hay LIs pausados con tickets promovidos (desvinculados de PY)
    const pausedProtectedItems = (batchResp.results || []).filter((li) => {
      const p = li.properties || {};
      return String(p.pausa || '').toLowerCase() === 'true'
        && String(p.of_line_item_py_origen_id || '').trim();
    });

    if (pausedProtectedItems.length > 0) {
      logger.info(
        { module: 'dealMirroring', fn: 'maybeArchiveMirrorDealIfEmpty', mirrorDealId, pausedCount: pausedProtectedItems.length },
        'Post-prune: deal mirror tiene LIs pausados con promovidos, NO se archiva'
      );
      return { archived: false, remainingValidCount: validMirrorItems.length, pausedProtectedCount: pausedProtectedItems.length };
    }

    logger.debug(
      { module: 'dealMirroring', fn: 'maybeArchiveMirrorDealIfEmpty', mirrorDealId, validMirrorItemsCount: validMirrorItems.length },
      'Post-prune: conteo de line items espejo válidos'
    );

    if (validMirrorItems.length > 0) {
      return { archived: false, remainingValidCount: validMirrorItems.length };
    }
  }

  // REGLA USUARIA (2026-07-18): el deal espejo NO se archiva automáticamente aunque quede
  // sin line items válidos. Antes se archivaba y se limpiaba el vínculo deal_uy_mirror_id
  // en PY (borrado silencioso del mirror). Ahora solo se AVISA y se mantiene el vínculo,
  // para que un humano decida si corresponde archivarlo.
  logger.warn(
    { module: 'dealMirroring', fn: 'maybeArchiveMirrorDealIfEmpty', mirrorDealId, sourceDealId },
    'Espejo sin line items válidos — NO se archiva (regla usuaria); se avisa para revisión'
  );
  reportHubSpotError({
    level: 'warn',
    objectType: 'deal',
    objectId: String(mirrorDealId),
    message: `Deal espejo UY quedó sin productos válidos (su original PY ${sourceDealId} ya no tiene líneas espejadas). NO se archivó automáticamente — revisar a mano si corresponde archivarlo o si falta algo.`,
  });

  return { archived: false, remainingValidCount: 0, flaggedEmpty: true };
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

// Prop (deal mirror) que setea la MIGRACIÓN: las LIs del mirror son históricas
// y el motor no debe sincronizarlas desde el PY — solo avisar si el PY cambia.
const MIRROR_SEAL_PROP = 'mig_espejo_independiente';
// Prop (deal mirror) con el último snapshot conocido de costo/cantidad del PY,
// para avisar UNA vez por cambio en lugar de en cada pasada del cron.
const MIRROR_PY_SNAPSHOT_PROP = 'mig_py_li_snapshot';

// Snapshot estable (orden por LI id) de costo/cantidad de las líneas UY del PY.
// Definición 2026-07-07: el costo se compara por costo_total_usd (fuente de verdad,
// siempre USD) y NO por hs_cost_of_goods_sold (derivada en moneda del deal: un
// refresh del dólar la cambia sin que el costo real haya cambiado → falsa alarma).
// Fallback legacy a cogs para LIs viejos sin costo_total_usd. Nota: los mirrors ya
// sellados con snapshot cogs-based avisan UNA vez al re-comparar y se re-guardan.
function pyLiSnapshotValue(li) {
  const p = li.properties || {};
  const costo = (p.costo_total_usd ?? '') !== '' ? p.costo_total_usd : (p[LINE_ITEM_COST_PROP] ?? '');
  return `${costo}x${p.quantity ?? ''}`;
}

function buildPyLiSnapshot(uyLineItems) {
  return uyLineItems
    .map((li) => `${li.id}:${pyLiSnapshotValue(li)}`)
    .sort()
    .join('|');
}

function parsePyLiSnapshot(snapshot) {
  const map = new Map();
  for (const entry of String(snapshot || '').split('|')) {
    if (!entry) continue;
    const i = entry.indexOf(':');
    if (i > 0) map.set(entry.slice(0, i), entry.slice(i + 1));
  }
  return map;
}

/**
 * Cuando el deal PY fue eliminado/archivado, busca su mirror UY
 * y pausa los LIs que tengan tickets promovidos, dejando aviso.
 * No archiva el deal mirror ni los tickets promovidos/emitidos.
 */
async function handleOrphanedMirrorDeal(sourceDealId) {
  const log = logger.child({
    module: 'dealMirroring',
    fn: 'handleOrphanedMirrorDeal',
    sourceDealId: String(sourceDealId),
  });

  // 1) Buscar mirror por deal_py_origen_id
  let mirrors;
  try {
    const resp = await hubspotClient.crm.deals.searchApi.doSearch({
      filterGroups: [{
        filters: [
          { propertyName: 'es_mirror_de_py', operator: 'EQ', value: 'true' },
          { propertyName: 'deal_py_origen_id', operator: 'EQ', value: String(sourceDealId) },
        ],
      }],
      properties: ['dealname', 'deal_py_origen_id', 'mig_espejo_independiente'],
      limit: 5,
    });
    mirrors = resp.results || [];
  } catch (err) {
    log.error({ err }, 'Error buscando mirror UY para deal PY eliminado');
    return;
  }

  if (!mirrors.length) {
    log.info('Sin mirror UY encontrado para deal PY eliminado');
    return;
  }

  for (const mirror of mirrors) {
    const mirrorDealId = String(mirror.id);
    const mirrorName = mirror.properties?.dealname || mirrorDealId;

    // Mirror migrado independiente: sus LIs históricas no se pausan ni archivan,
    // solo se avisa que el PY origen desapareció.
    if (parseBoolFromHubspot(mirror.properties?.mig_espejo_independiente)) {
      reportHubSpotError({
        level: 'warn',
        objectType: 'deal',
        objectId: mirrorDealId,
        message: `Deal PY origen (${sourceDealId}) fue eliminado/archivado. Mirror migrado independiente: sus líneas quedaron intactas — revisar manualmente.`,
      });
      log.info({ mirrorDealId, mirrorName }, 'Mirror sellado huérfano: LIs intactas, solo aviso');
      continue;
    }

    // 2) Leer LIs del mirror
    let mirrorLiIds;
    try {
      mirrorLiIds = await getAssocIdsV4('deals', mirrorDealId, 'line_items', 500);
    } catch (err) {
      log.warn({ err, mirrorDealId }, 'Error obteniendo LIs del mirror');
      continue;
    }

    if (!mirrorLiIds.length) {
      log.info({ mirrorDealId }, 'Mirror sin LIs, nada que proteger');
      continue;
    }

    let batchResp;
    try {
      batchResp = await hubspotClient.crm.lineItems.batchApi.read({
        inputs: mirrorLiIds.map(id => ({ id: String(id) })),
        properties: ['name', 'line_item_key', 'of_line_item_py_origen_id', 'pausa'],
      });
    } catch (err) {
      log.warn({ err, mirrorDealId }, 'Error leyendo LIs del mirror');
      continue;
    }

    let pausedCount = 0;

    for (const li of batchResp.results || []) {
      const p = li.properties || {};
      const lik = String(p.line_item_key || '').trim();

      // Verificar si tiene tickets promovidos/emitidos
      let hasPromoted = false;
      if (lik) {
        try {
          const searchResp = await hubspotClient.crm.tickets.searchApi.doSearch({
            filterGroups: [{
              filters: [
                { propertyName: 'of_line_item_key', operator: 'EQ', value: lik },
              ],
            }],
            properties: ['hs_pipeline_stage'],
            limit: 100,
          });
          hasPromoted = (searchResp.results || []).some(t =>
            PROMOTED_STAGES.has(String(t.properties?.hs_pipeline_stage || ''))
          );
        } catch (err) {
          log.warn({ err, mirrorDealId, lineItemId: li.id }, 'Error verificando tickets, tratando como protegido');
          hasPromoted = true; // fail-safe
        }
      }

      if (hasPromoted) {
        try {
          await hubspotClient.crm.lineItems.basicApi.update(String(li.id), {
            properties: {
              pausa: 'true',
              of_billing_error: `LI pausado: deal PY origen (${sourceDealId}) fue eliminado/archivado. Tickets promovidos se mantienen. No se generarán futuros pagos UY.`,
            },
          });
          pausedCount++;
        } catch (err) {
          log.warn({ err, lineItemId: li.id }, 'Error pausando LI huérfano');
        }
      } else {
        // Sin promovidos: desasociar + archivar
        try {
          await hubspotClient.crm.associations.v4.basicApi.archive(
            'line_items', String(li.id), 'deals', mirrorDealId
          );
          await hubspotClient.crm.lineItems.basicApi.archive(String(li.id));
          log.info({ lineItemId: li.id, name: p.name }, 'LI mirror sin promovidos archivado');
        } catch (err) {
          log.warn({ err, lineItemId: li.id }, 'Error archivando LI mirror');
        }
      }
    }

    // 3) Aviso en deal mirror
    reportHubSpotError({
      level: 'warn',
      objectType: 'deal',
      objectId: mirrorDealId,
      message: `Deal PY origen (${sourceDealId}) fue eliminado/archivado. ${pausedCount} LI(s) pausado(s) con tickets promovidos. Futuros pagos UY no se generarán.`,
    });

    log.info({ mirrorDealId, mirrorName, pausedCount }, 'Mirror UY protegido tras eliminación de deal PY');
  }
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
 let deal, lineItems;
  try {
    ({ deal, lineItems } = await getDealWithLineItems(sourceDealId));
  } catch (err) {
    // Deal PY eliminado/archivado — verificar si hay mirror con promovidos
    const isNotFound = err?.response?.status === 404
      || err?.code === 404
      || /not found|archived/i.test(err?.message);

    if (!isNotFound) throw err; // error real, relanzar

    logger.warn(
      { module: 'dealMirroring', fn: 'mirrorDealToUruguay', dealId: sourceDealId, err },
      'Deal PY no encontrado (posiblemente eliminado/archivado), protegiendo mirror UY'
    );

    await handleOrphanedMirrorDeal(sourceDealId);
    return {
      mirrored: false,
      sourceDealId: String(sourceDealId),
      reason: 'source_deal_not_found_mirror_protected',
    };
  }

  if (!deal) {
    logger.warn(
      { module: 'dealMirroring', fn: 'mirrorDealToUruguay', dealId: sourceDealId },
      'Deal PY retornó null, protegiendo mirror UY'
    );
    await handleOrphanedMirrorDeal(sourceDealId);
    return {
      mirrored: false,
      sourceDealId: String(sourceDealId),
      reason: 'source_deal_null_mirror_protected',
    };
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
  let mirrorCreatedNow = false;

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

      // Stage: copiar del PY solo hasta 85%. Si el mirror ya avanzó a 95%/100%
      // de forma independiente (por sus propios tickets), no pisar.
      if (srcProps.dealstage) {
        const MIRROR_INDEPENDENT_STAGES = new Set([
          process.env.DEAL_STAGE_95 || '1327905636',
          process.env.DEAL_STAGE_100 || '1296491150',
        ]);

        let currentMirrorStage = null;
        try {
          const mirrorDeal = await hubspotClient.crm.deals.basicApi.getById(targetDealId, ['dealstage']);
          currentMirrorStage = String(mirrorDeal?.properties?.dealstage || '');
        } catch (err) {
          logger.warn({ module: 'dealMirroring', fn: 'mirrorDealToUruguay', mirrorDealId: targetDealId, err },
            'No se pudo leer stage actual del mirror, se copiará del PY');
        }

        if (!MIRROR_INDEPENDENT_STAGES.has(currentMirrorStage)) {
          // Mirror no está en 95%/100% → copiar stage del PY (hasta 85% máx)
          if (!MIRROR_INDEPENDENT_STAGES.has(srcProps.dealstage)) {
            updateProps.dealstage = srcProps.dealstage;
          }
          // Si PY está en 95%/100% pero mirror no, no copiar — el mirror
          // avanzará cuando tenga su propia factura emitida
        }
        // Si mirror ya está en 95%/100% → no tocar
      }

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
      // Distinguir 404 (el mirror ya no existe → recrear) de un fallo TRANSITORIO (429/5xx/timeout
      // sobre un mirror VÁLIDO). Si anuláramos targetDealId ante un transitorio, caeríamos al
      // backstop `search`, que por lag de indexado podría no ver el mirror y CREAR UN DUPLICADO.
      const status = err?.statusCode || err?.code || err?.response?.status;
      const isNotFound = status === 404 || /not found|no longer exists|archived/i.test(err?.message || '');
      if (!isNotFound) {
        logger.error(
          { module: 'dealMirroring', fn: 'mirrorDealToUruguay', mirrorDealId: targetDealId, status, err },
          'Fallo transitorio actualizando el mirror existente — se relanza para reintentar (NO se recrea, evita duplicado)'
        );
        throw err;
      }
      logger.warn(
        { module: 'dealMirroring', fn: 'mirrorDealToUruguay', mirrorDealId: targetDealId, err },
        'Deal espejo UY no existe (404), se creará uno nuevo'
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
const MIRROR_INDEPENDENT_STAGES_CREATE = new Set([
      process.env.DEAL_STAGE_95 || '1327905636',
      process.env.DEAL_STAGE_100 || '1296491150',
    ]);

    const newDealProps = {
      dealname: srcProps.dealname ? `${srcProps.dealname} - UY` : 'Negocio UY',
      ...(srcProps.pipeline ? { pipeline: srcProps.pipeline } : {}),
      // Stage: copiar solo hasta 85%. Si PY ya está en 95%/100%, el mirror
      // arranca en 85% y avanzará por sus propios tickets.
      ...(srcProps.dealstage && !MIRROR_INDEPENDENT_STAGES_CREATE.has(srcProps.dealstage)
        ? { dealstage: srcProps.dealstage }
        : { dealstage: 'closedwon' }),
        
      pais_operativo: 'Uruguay',
      es_mirror_de_py: 'true',
      deal_py_origen_id: String(sourceDealId),
      // R1 (2026-07-05): el mirror UY se creaba SIN fecha de cierre. Es la misma oportunidad
      // que el PY → copiamos su closedate. (El `amount`/valor lo fija Paso B' desde los prices
      // reales del twin, porque al crear el mirror sus line items todavía no existen.)
      ...(srcProps.closedate ? { closedate: srcProps.closedate } : {}),
      // Los prices del mirror son costos intercompany, siempre en USD:
      // no hereda la moneda del deal PY (decisión 2026-07-02).
      deal_currency_code: 'USD',
    };

    logger.info(
      { module: 'dealMirroring', fn: 'mirrorDealToUruguay', dealId: sourceDealId },
      'Creando nuevo espejo UY'
    );

    const createResp = await hubspotClient.crm.deals.basicApi.create({
      properties: newDealProps,
    });

    targetDealId = createResp.id;
    mirrorCreatedNow = true;

    logger.info(
      { module: 'dealMirroring', fn: 'mirrorDealToUruguay', dealId: sourceDealId, mirrorDealId: targetDealId },
      'Espejo creado'
    );

    // Actualizar negocio PY: mantener Paraguay, guardar ID del espejo.
    // Si esta escritura falla, el PY queda SIN deal_uy_mirror_id → en la próxima pasada el backstop
    // podría no ver este mirror recién creado (lag del Search API) y DUPLICARLO. Por eso el fallo
    // se avisa FUERTE (no se traga en silencio) para resolverlo antes de re-procesar.
    try {
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
    } catch (err) {
      logger.error(
        { module: 'dealMirroring', fn: 'mirrorDealToUruguay', dealId: sourceDealId, mirrorDealId: targetDealId, err },
        'Mirror CREADO pero NO se pudo guardar deal_uy_mirror_id en el PY — riesgo de duplicado al re-procesar; revisar manualmente'
      );
      reportHubSpotError({
        level: 'warn',
        objectType: 'deal',
        objectId: sourceDealId,
        message: `Mirror ${targetDealId} creado pero no se guardó deal_uy_mirror_id en el PY (${sourceDealId}). Riesgo de mirror duplicado al re-procesar — asociar el id a mano antes de la próxima pasada.`,
      });
    }
  }

  // 3c) Mirror migrado independiente: sus LIs YA espejadas (históricas) NO se
  // sincronizan desde el PY — si el PY cambia costo/cantidad o quita líneas, se
  // emite un aviso en el mirror en lugar de tocarlas. Las líneas UY NUEVAS del
  // PY (sin espejo todavía) SÍ se crean con el comportamiento normal del motor
  // (decisión 2026-07-02/03).
  let sealedMirror = false;
  let sealedNuevasLIs = [];
  if (!mirrorCreatedNow) {
    let mirrorSealProps = null;
    try {
      const mirrorDeal = await hubspotClient.crm.deals.basicApi.getById(
        String(targetDealId),
        [MIRROR_SEAL_PROP, MIRROR_PY_SNAPSHOT_PROP]
      );
      mirrorSealProps = mirrorDeal?.properties || null;
    } catch (err) {
      logger.warn(
        { module: 'dealMirroring', fn: 'mirrorDealToUruguay', mirrorDealId: targetDealId, err },
        'No se pudo leer el seal del mirror, se asume NO sellado'
      );
    }

    if (mirrorSealProps && parseBoolFromHubspot(mirrorSealProps[MIRROR_SEAL_PROP])) {
      sealedMirror = true;

      // Qué líneas PY ya tienen espejo (of_line_item_py_origen_id en LIs del mirror).
      // Si no se puede leer, no se crea nada (evita duplicados).
      const mirroredPyIds = new Set();
      let mirrorLisLeidas = false;
      try {
        const mirrorLiIds = await getAssocIdsV4('deals', String(targetDealId), 'line_items', 500);
        if (mirrorLiIds.length) {
          const br = await hubspotClient.crm.lineItems.batchApi.read({
            inputs: mirrorLiIds.map((id) => ({ id: String(id) })),
            properties: ['of_line_item_py_origen_id'],
          });
          for (const li of br.results || []) {
            const origen = String(li.properties?.of_line_item_py_origen_id || '').trim();
            if (origen) mirroredPyIds.add(origen);
          }
        }
        mirrorLisLeidas = true;
      } catch (err) {
        logger.warn(
          { module: 'dealMirroring', fn: 'mirrorDealToUruguay', mirrorDealId: targetDealId, err },
          'Mirror sellado: no se pudieron leer sus LIs — no se crearán líneas nuevas en esta pasada'
        );
      }

      const existentes = uyLineItems.filter((li) => mirroredPyIds.has(String(li.id)));
      sealedNuevasLIs = mirrorLisLeidas
        ? uyLineItems.filter((li) => !mirroredPyIds.has(String(li.id)))
        : [];

      // Aviso por cambios sobre lo histórico: costo/cantidad de líneas ya espejadas,
      // o líneas que estaban en el snapshot y desaparecieron (borradas o uy=false).
      const snapshotGuardado = mirrorSealProps[MIRROR_PY_SNAPSHOT_PROP] || '';
      const prev = parsePyLiSnapshot(snapshotGuardado);
      const cambiadas = existentes.filter(
        (li) => prev.has(String(li.id)) && prev.get(String(li.id)) !== pyLiSnapshotValue(li)
      );
      const idsActuales = new Set(uyLineItems.map((li) => String(li.id)));
      const eliminadas = [...prev.keys()].filter((id) => !idsActuales.has(id));

      if (snapshotGuardado && (cambiadas.length || eliminadas.length)) {
        reportHubSpotError({
          level: 'warn',
          objectType: 'deal',
          objectId: targetDealId,
          message: `Mirror migrado independiente: el deal PY origen (${sourceDealId}) modificó sus líneas UY (${cambiadas.length} con cambio de costo/cantidad, ${eliminadas.length} quitada(s)/desmarcada(s)). Las líneas históricas del mirror NO se actualizaron — revisar manualmente.`,
        });
      }

      // Snapshot nuevo = estado PY completo (incluye las nuevas que se crean abajo).
      // Sin snapshot previo (primera pasada) se fija la línea base en silencio.
      const snapshotActual = buildPyLiSnapshot(uyLineItems);
      if (snapshotActual !== snapshotGuardado) {
        try {
          await hubspotClient.crm.deals.basicApi.update(String(targetDealId), {
            properties: { [MIRROR_PY_SNAPSHOT_PROP]: snapshotActual },
          });
        } catch (err) {
          logger.warn(
            { module: 'dealMirroring', fn: 'mirrorDealToUruguay', mirrorDealId: targetDealId, err },
            'No se pudo guardar el snapshot PY en el mirror sellado'
          );
        }
      }

      logger.info(
        { module: 'dealMirroring', fn: 'mirrorDealToUruguay', dealId: sourceDealId, mirrorDealId: targetDealId, cambiadas: cambiadas.length, eliminadas: eliminadas.length, nuevas: sealedNuevasLIs.length },
        'Mirror sellado: LIs históricas intactas'
      );

      if (!sealedNuevasLIs.length) {
        return {
          mirrored: true,
          sourceDealId: String(sourceDealId),
          targetDealId: String(targetDealId),
          uyLineItemsCount: uyLineItems.length,
          createdLineItems: 0,
          sealedMirrorLineItemsSkipped: true,
        };
      }
      // Hay líneas PY nuevas: se dejan pasar al paso 4 (solo ellas) para crearlas
      // con el comportamiento normal; prune/archive/asociaciones siguen omitidos.
    }
  }

  // 4) Upsert en el espejo las líneas UY del negocio PY
  // (mirror sellado: solo las líneas PY nuevas, las históricas no se tocan)
  const userAdminMirror = process.env.USER_ADMIN_MIRROR || '89701984';
  const lisParaSync = sealedMirror ? sealedNuevasLIs : uyLineItems;

  for (const li of lisParaSync) {
     try {
    const srcPropsLi = li.properties || {};

    const props = {};

const allowedProps = new Set([
  'name',
  'description',
  'quantity',
  'recurringbillingfrequency',
  'hs_recurring_billing_frequency',
  'hs_recurring_billing_start_date',
  'hs_recurring_billing_number_of_payments',
  'hs_recurring_billing_period',
  'billing_anchor_date',
  'servicio',
  'subrubro',
  'unidad_de_negocio',
  'renovacion_automatica',
  'facturacion_activa',
  'pausa',
  'motivo_de_pausa',
  'hs_product_id',
  'hs_sku',
]);

    for (const key of allowedProps) {
      if (key in srcPropsLi) {
        props[key] = srcPropsLi[key];
      }
    }

    props.uy = 'true';
    props.pais_operativo = 'Uruguay';
    props.hubspot_owner_id = userAdminMirror;
    props.of_line_item_py_origen_id = String(li.id).trim();
    props.facturacion_automatica = 'false'; // mirrors UY siempre manuales

    // PY3 (María 7-jul) + definición 2026-07-07: costo_total_usd es la FUENTE DE VERDAD
    // del costo (total de la línea, siempre USD). El price del mirror va SIEMPRE en USD
    // (el mirror se crea con deal_currency_code='USD'), así que sale de ahí:
    //   price = costo_total_usd ÷ quantity.
    // hs_cost_of_goods_sold es DERIVADA (costo_total_usd × dolar ÷ qty, en moneda del
    // deal PY) — usarla directo inflaba el mirror ×TC en deals en guaraníes.
    // Fallbacks legacy: cogs ÷ dolar del LI; cogs directo SOLO si el deal PY es USD.
    // Deal en moneda ≠ USD sin dato USD confiable → NO se adivina: MISSING_COST.
    const qtyLi = parseFloat(srcPropsLi.quantity) || 1;
    const costoTotalUsd = parseFloat(srcPropsLi.costo_total_usd);
    const cogsMonedaDeal = parseFloat(srcPropsLi.hs_cost_of_goods_sold);
    const dolarLi = parseFloat(srcPropsLi.dolar);

    let unitCost = NaN;
    let costSource = null;
    if (costoTotalUsd > 0) {
      unitCost = costoTotalUsd / qtyLi;
      costSource = 'costo_total_usd/qty';
    } else if (cogsMonedaDeal > 0 && dolarLi > 0) {
      unitCost = cogsMonedaDeal / dolarLi;
      costSource = 'cogs/dolar';
    } else if (cogsMonedaDeal > 0 && String(sourceCurrency || 'USD').toUpperCase() === 'USD') {
      unitCost = cogsMonedaDeal; // deal ya en USD: cogs es USD (comportamiento histórico)
      costSource = 'cogs';
    }

    if (isNaN(unitCost) || unitCost <= 0) {
      logger.warn(
        { module: 'dealMirroring', fn: 'mirrorDealToUruguay', lineItemId: li.id, name: srcPropsLi.name, costo_total_usd: srcPropsLi.costo_total_usd, hs_cost_of_goods_sold: srcPropsLi.hs_cost_of_goods_sold, dolar: srcPropsLi.dolar, currency: sourceCurrency },
        'Línea UY sin costo USD válido (costo_total_usd/cogs), price=0'
      );

      props.price = '0';

      if ('mirror_missing_cost' in srcPropsLi) {
        props.mirror_missing_cost = 'true';
      } else {
        const existingNote = props.nota || '';
        props.nota = existingNote ? `${existingNote} | MISSING_COST` : 'MISSING_COST';
      }
    } else {
      props.price = String(unitCost);

      logger.debug(
        { module: 'dealMirroring', fn: 'mirrorDealToUruguay', lineItemId: li.id, name: srcPropsLi.name, unitCost, costSource },
        `Línea UY espejada: price USD (${costSource})`
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
      } catch (err) {
     logger.error({ module: 'dealMirroring', fn: 'mirrorDealToUruguay', dealId: sourceDealId, lineItemId: li?.id, err }, 'unit_failed');
   }
  }

  logger.info(
    { module: 'dealMirroring', fn: 'mirrorDealToUruguay', mirrorDealId: targetDealId, createdLineItems },
    'Upsert de líneas completado'
  );

  // Mirror sellado: ya se crearon las líneas nuevas; prune/archive/asociaciones no corren.
  if (sealedMirror) {
    // #10b (auditoría 2026-07-18): el prune completo se omite (no se borran "huérfanos"
    // porque el stock sellado es independiente del PY), pero SÍ deduplicamos LIs espejo
    // con el mismo of_line_item_py_origen_id (doble línea de costo permanente). Conservador
    // e idempotente: no toca duplicados con facturación real, los avisa.
    let dedupedCount = 0;
    try {
      ({ dedupedCount } = await dedupeSealedMirrorLineItems(targetDealId));
      if (dedupedCount) {
        logger.info(
          { module: 'dealMirroring', fn: 'mirrorDealToUruguay', mirrorDealId: targetDealId, dedupedCount },
          'Dedup de mirror sellado completado'
        );
      }
    } catch (err) {
      logger.warn(
        { module: 'dealMirroring', fn: 'mirrorDealToUruguay', mirrorDealId: targetDealId, err },
        'Dedup de mirror sellado falló'
      );
    }
    return {
      mirrored: true,
      sourceDealId: String(sourceDealId),
      targetDealId: String(targetDealId),
      uyLineItemsCount: uyLineItems.length,
      createdLineItems,
      sealedMirrorLineItemsSkipped: true,
      sealedNewLineItems: sealedNuevasLIs.length,
      sealedDedupedLineItems: dedupedCount,
    };
  }

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
  // IDs de labels de asociación deals → companies
  const ASSOC_LABEL_PRIMARY          = 5; // HUBSPOT_DEFINED
  

  // 5) Determinar empresa beneficiaria: la asociada con label "Primary" (typeId 5).
  // El orden de las asociaciones NO está garantizado: si el deal PY tiene además
  // empresas con etiquetas (Partner / Empresa Factura), la primera puede ser cualquiera.
  // Fallback: primera asociada (comportamiento previo).
  let beneficiaryCompanyId = null;
  try {
    const companyAssocs = await hubspotClient.crm.associations.v4.basicApi.getPage(
      'deals', String(sourceDealId), 'companies', 100
    );
    const assocResults = companyAssocs?.results || [];
    const primaryAssoc = assocResults.find((r) =>
      r.associationTypes?.some((t) => t.category === 'HUBSPOT_DEFINED' && t.typeId === ASSOC_LABEL_PRIMARY)
    );
    const pick = primaryAssoc || assocResults[0];
    beneficiaryCompanyId = pick?.toObjectId ? String(pick.toObjectId) : null;
  } catch (err) {
    logger.warn(
      { module: 'dealMirroring', fn: 'mirrorDealToUruguay', dealId: sourceDealId, err },
      'No se pudieron leer las empresas del deal PY — mirror sin beneficiaria'
    );
  }

  // 6) Asociar empresa beneficiaria como PRIMARY del mirror UY
  if (beneficiaryCompanyId) {
    logger.info(
      { module: 'dealMirroring', fn: 'mirrorDealToUruguay', mirrorDealId: targetDealId, beneficiaryCompanyId },
      'Asociando empresa beneficiaria como Primary del mirror UY'
    );

    try {
      await hubspotClient.crm.associations.v4.basicApi.create(
        'deals',
        String(targetDealId),
        'companies',
        String(beneficiaryCompanyId),
        [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: ASSOC_LABEL_PRIMARY }]
      );
    } catch (err) {
      logger.warn(
        { module: 'dealMirroring', fn: 'mirrorDealToUruguay', mirrorDealId: targetDealId, beneficiaryCompanyId, err },
        'No se pudo asociar beneficiaria como Primary'
      );
    }

    // Setear cliente_beneficiario apuntando a la empresa principal (mantener por ahora, deprecar luego)
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

    // Actualizar empresa beneficiaria a Mixto (operativa en ambos países)
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

    // Actualizar contactos a Mixto y asociarlos al mirror
    const beneficiaryContactIds = await getAssocIdsV4('companies', beneficiaryCompanyId, 'contacts');

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
        // ignorar errores por contacto
      }
      try {
        await hubspotClient.crm.associations.v4.basicApi.createDefault(
          'contacts',
          String(contactId),
          'deals',
          String(targetDealId)
        );
      } catch (err) {
        // ya estaba asociado
      }
    }
  } else {
    logger.warn(
      { module: 'dealMirroring', fn: 'mirrorDealToUruguay', dealId: sourceDealId },
      'Deal PY sin empresa asociada — mirror UY quedará sin Primary'
    );
  }

  // 7) Asociar Interfase PY como EMPRESA FACTURA del mirror UY
  if (interfaseCompanyId) {
    try {
      await hubspotClient.crm.associations.v4.basicApi.create(
        'deals',
        String(targetDealId),
        'companies',
        String(interfaseCompanyId),
        [
          { associationCategory: 'USER_DEFINED', associationTypeId: ASSOC_LABEL_EMPRESA_FACTURA },
          ...(ASSOC_LABEL_EMPRESA_PARTNER
            ? [{ associationCategory: 'USER_DEFINED', associationTypeId: ASSOC_LABEL_EMPRESA_PARTNER }]
            : []),
        ]
      );
      logger.info(
        { module: 'dealMirroring', fn: 'mirrorDealToUruguay', mirrorDealId: targetDealId, interfaseCompanyId, conPartner: Boolean(ASSOC_LABEL_EMPRESA_PARTNER) },
        'Interfase PY asociada como Empresa Factura (y Partner si está configurada) del mirror UY'
      );
    } catch (err) {
      logger.warn(
        { module: 'dealMirroring', fn: 'mirrorDealToUruguay', mirrorDealId: targetDealId, interfaseCompanyId, err },
        'No se pudo asociar Interfase como Empresa Factura'
      );
    }
  } else {
    logger.warn(
      { module: 'dealMirroring', fn: 'mirrorDealToUruguay' },
      'INTERFASE_PY_COMPANY_ID no configurado'
    );
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