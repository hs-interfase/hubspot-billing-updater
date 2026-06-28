// src/jobs/cronMensajeMantsoft.js
//
// Cron que avisa sobre facturaciones automáticas pendientes de Mantsoft.
//
// Horario en Railway: 07:10 (America/Montevideo) — una hora antes que cronMensajeFacturacion
//
// Lógica:
//   1. Buscar line items con mansoft_pendiente = true y facturacion_automatica = true
//   2. Resolver dealId de cada line item via associations batch API
//   3. Agrupar por deal
//   4. Para cada deal: construir HTML con buildMensajeMantsoft(lineItems, dealName)
//      Se mezclan altas y ediciones en el mismo mensaje.
//   5. Escribir `mensaje_mansoft` en el deal
//   6. Para cada LI procesado:
//      - guardar snapshot actualizado en `mansoft_ultimo_snapshot`
//      - resetear `mansoft_pendiente = false`
//      - limpiar `mansoft_tipo_aviso = ''`
//
// Ejecución manual:
//   node src/jobs/cronMensajeMantsoft.js
//   node src/jobs/cronMensajeMantsoft.js --deal 12345678
//   node src/jobs/cronMensajeMantsoft.js --dry

import 'dotenv/config';
import { hubspotClient } from "../hubspotClient.js";
import { buildMensajeMantsoft, classifyLineItem } from '../services/billing/buildMensajeMantsoft.js';
import {
  buildMansoftSnapshot,
  serializeMansoftSnapshot,
} from '../services/billing/mansoftSnapshot.js';
import { parseBool } from '../utils/parsers.js';
import logger from '../../lib/logger.js';
import { pathToFileURL } from 'url';
import { setCronState } from '../db.js';
import { BILLING_ACTIVE_DEAL_STAGES, ASSOC_LABEL_EMPRESA_FACTURA } from '../config/constants.js';
import { getPortalId } from '../utils/hubspotPortal.js';



// ────────────────────────────────────────────────────────────
// Config
// ────────────────────────────────────────────────────────────

const DEAL_PROPERTY = 'mensaje_mansoft';

const LI_PROPS = [
  'hs_object_id', 'hs_lastmodifieddate',
  'name', 'description', 'of_rubro', 'rubro', 'unidad_de_negocio',
  'price', 'quantity', 'amount',
  'hs_discount_percentage', 'of_moneda', 'deal_currency_code',
  'of_iva', 'exonera_irae', 'hs_tax_rate_group_id',
  'recurringbillingfrequency', 'hs_recurring_billing_frequency',
  'hs_recurring_billing_start_date', 'fecha_inicio_de_facturacion',
  'billing_next_date', 'fecha_vencimiento_contrato',
  'inicio_del_contrato', 'fin_del_contrato',
  'hs_recurring_billing_number_of_payments', 'pagos_restantes',
  'renovacion_automatica', 'hs_recurring_billing_terms',
  'hs_product_id', 'pagos_emitidos', 'billing_anchor_date',
  'nombre_empresa', 'empresa_que_factura', 'persona_que_factura',
  'observaciones', 'nota',
  'mansoft_pendiente', 'facturacion_automatica',
  // Nuevas props para el sistema alta/edición
    'fecha_de_baja', 'motivo_de_pausa', 'es_definitivo', 'pausa',
  'mansoft_tipo_aviso', 'mansoft_ultimo_snapshot',
  // Flag de migración: si está prendido y aún no hay snapshot → tipo 'migra' (no avisa alta)
  'mig_migracion_historica',
];

// ────────────────────────────────────────────────────────────
// Búsqueda de line items
// ────────────────────────────────────────────────────────────

async function searchLineItemsMantsoft() {
  const allItems = [];
  let after = undefined;
  const MAX_PAGES = 20;

  for (let page = 0; page < MAX_PAGES; page++) {
    const searchBody = {
      filterGroups: [{
        filters: [
          { propertyName: 'mansoft_pendiente', operator: 'EQ', value: 'true' },
          { propertyName: 'facturacion_automatica', operator: 'EQ', value: 'true' },
        ],
      }],
      properties: LI_PROPS,
      sorts: [{ propertyName: 'hs_lastmodifieddate', direction: 'ASCENDING' }],
      limit: 100,
    };

    if (after) searchBody.after = after;

    let res;
    try {
      res = await hubspotClient.crm.lineItems.searchApi.doSearch(searchBody);
    } catch (err) {
      logger.error(
        { module: 'cronMensajeMantsoft', fn: 'searchLineItemsMantsoft', err },
        'Error buscando line items mansoft_pendiente'
      );
      return { items: allItems, searchError: err?.message || String(err) };
    }

    const results = res?.results || [];

    // Filtro in-memory — HAS_PROPERTY / EQ en booleans puede ser poco fiable
    for (const li of results) {
      if (parseBool(li?.properties?.mansoft_pendiente) &&
          parseBool(li?.properties?.facturacion_automatica)) {
        allItems.push(li);
      }
    }

    const nextAfter = res?.paging?.next?.after;
    if (!nextAfter || results.length < 100) break;
    after = nextAfter;
  }

  return { items: allItems, searchError: null };
}

// ────────────────────────────────────────────────────────────
// Associations batch: line items → deals
// ────────────────────────────────────────────────────────────

async function resolveDealsForLineItems(lineItems) {
  const result = new Map();
  if (lineItems.length === 0) return result;

  const inputs = lineItems.map(li => ({ id: String(li.id) }));

  let resp;
  try {
    resp = await hubspotClient.crm.associations.v4.batchApi.getPage(
      'line_items',
      'deals',
      { inputs }
    );
  } catch (err) {
    logger.error(
      { module: 'cronMensajeMantsoft', fn: 'resolveDealsForLineItems', err },
      'Error en batch associations v4 line_items → deals'
    );
    return result;
  }

  for (const item of resp?.results || []) {
    const lineItemId = String(item?._from?.id || item?.from?.id || '');
    const dealId = String(item?.to?.[0]?.toObjectId || '');
    if (lineItemId && dealId) {
      result.set(lineItemId, dealId);
    }
  }

  return result;
}

// ────────────────────────────────────────────────────────────
// Agrupación por deal
// ────────────────────────────────────────────────────────────

function groupByDeal(lineItems, liToDealMap) {
  const map = new Map();

  for (const li of lineItems) {
    const dealId = liToDealMap.get(String(li.id));
    if (!dealId) {
      logger.warn(
        { module: 'cronMensajeMantsoft', lineItemId: li.id },
        'Line item sin dealId en associations, saltando'
      );
      continue;
    }
    if (!map.has(dealId)) map.set(dealId, []);
    map.get(dealId).push(li);
  }

  return map;
}

// ────────────────────────────────────────────────────────────
// Helpers HubSpot
// ────────────────────────────────────────────────────────────

const ASSOC_LABEL_PERSONA_FACTURA = 7;

async function getDealInfo(dealId) {
  try {
    const [deal, compAssoc, contAssoc] = await Promise.all([
      hubspotClient.crm.deals.basicApi.getById(dealId, ['dealname', 'dealstage']),
      hubspotClient.crm.associations.v4.basicApi.getPage('deals', String(dealId), 'companies', 100),
      hubspotClient.crm.associations.v4.basicApi.getPage('deals', String(dealId), 'contacts', 100),
    ]);

    const empresaId = (compAssoc?.results || [])
      .find(r => r.associationTypes?.some(t => t.typeId === ASSOC_LABEL_EMPRESA_FACTURA))
      ?.toObjectId;

    const personaId = (contAssoc?.results || [])
      .find(r => r.associationTypes?.some(t => t.typeId === ASSOC_LABEL_PERSONA_FACTURA))
      ?.toObjectId;

    const [empresaName, personaName] = await Promise.all([
      empresaId
        ? hubspotClient.crm.companies.basicApi.getById(String(empresaId), ['name'])
            .then(r => r?.properties?.name || null).catch(() => null)
        : Promise.resolve(null),
      personaId
        ? hubspotClient.crm.contacts.basicApi.getById(String(personaId), ['firstname', 'lastname'])
            .then(r => {
              const p = r?.properties || {};
              return [p.firstname, p.lastname].filter(Boolean).join(' ') || null;
            }).catch(() => null)
        : Promise.resolve(null),
    ]);

    return {
      dealName:            deal?.properties?.dealname || `Deal ${dealId}`,
      dealstage:           deal?.properties?.dealstage || '',
      empresa_que_factura: empresaName,
      persona_que_factura: personaName,
    };
  } catch (err) {
    logger.warn(
      { module: 'cronMensajeMantsoft', fn: 'getDealInfo', dealId, err },
      'No se pudo obtener info del deal'
    );
    return { dealName: `Deal ${dealId}`, dealstage: '', empresa_que_factura: null, persona_que_factura: null };
  }
}

async function writeMensaje(dealId, html) {
  await hubspotClient.crm.deals.basicApi.update(String(dealId), {
    properties: {
      [DEAL_PROPERTY]: html,
      mensaje_mansoft_actualizado: String(Date.now()),
    },
  });
}

/**
 * Al terminar de avisar sobre un LI:
 *  - guarda snapshot nuevo (refleja el estado ya notificado)
 *  - resetea mansoft_pendiente a false
 *  - limpia mansoft_tipo_aviso
 */
async function finalizeLineItemAfterNotify(li) {
  const snap = buildMansoftSnapshot(li);
  await hubspotClient.crm.lineItems.basicApi.update(String(li.id), {
    properties: {
      mansoft_pendiente: 'false',
      mansoft_tipo_aviso: '',
      mansoft_ultimo_snapshot: serializeMansoftSnapshot(snap),
    },
  });
}

// ────────────────────────────────────────────────────────────
// Main runner
// ────────────────────────────────────────────────────────────

export async function runCronMensajeMantsoft({ onlyDealId = null, dry = false } = {}) {
  const start = Date.now();
  logger.info(
    { module: 'cronMensajeMantsoft', onlyDealId, dry },
    '⚙️ Cron mensaje Mantsoft — inicio'
  );

  // 1. Buscar line items pendientes
 const { items: lineItems, searchError } = await searchLineItemsMantsoft();
  if (searchError) {
    logger.error({ module: 'cronMensajeMantsoft', searchError },
      '❌ Search API falló — el run NO es confiable');
    process.exitCode = 1;  // Railway marca el run como fallido
  }

  logger.info(
    { module: 'cronMensajeMantsoft', total: lineItems.length },
    'Line items mansoft_pendiente encontrados'
  );

  if (lineItems.length === 0) {
    logger.info({ module: 'cronMensajeMantsoft' }, 'Sin line items pendientes, saliendo');
    return { processed: 0, deals: 0, lineItemsReset: 0, errors: 0, searchError };
  }

  // 2. Resolver dealId via associations batch
  const liToDealMap = await resolveDealsForLineItems(lineItems);

  logger.info(
    { module: 'cronMensajeMantsoft', resolved: liToDealMap.size, total: lineItems.length },
    'Associations resueltas'
  );

  // 3. Agrupar por deal
  let dealGroups = groupByDeal(lineItems, liToDealMap);

  if (onlyDealId) {
    const targetId = String(onlyDealId);
    if (dealGroups.has(targetId)) {
      dealGroups = new Map([[targetId, dealGroups.get(targetId)]]);
    } else {
      logger.warn(
        { module: 'cronMensajeMantsoft', dealId: onlyDealId },
        'Deal especificado no tiene line items mantsoft pendientes'
      );
      return { processed: 0, deals: 0, lineItemsReset: 0, errors: 0 };
    }
  }

  logger.info(
    { module: 'cronMensajeMantsoft', deals: dealGroups.size },
    'Deals con line items Mantsoft pendientes'
  );

  // 4. Procesar cada deal
  let dealsProcessed = 0;
  let lineItemsReset = 0;
  let errors = 0;

  for (const [dealId, items] of dealGroups) {
    try {
const { dealName, dealstage, empresa_que_factura, persona_que_factura } = await getDealInfo(dealId);
      const portalId = await getPortalId();
      const dealMeta = { empresa_que_factura, persona_que_factura, dealId, portalId };

      // Altas solo se procesan si el deal está en stage ≥ 85%.
      // Si no califica, separamos las altas para no resetear su flag.
      const dealIsActive = BILLING_ACTIVE_DEAL_STAGES.has(dealstage);
      let itemsToProcess = items;

      if (!dealIsActive) {
        // Quitar LIs de alta — quedan con mansoft_pendiente=true para el próximo run
        const nonAltas = items.filter(li => classifyLineItem(li).tipo !== 'alta');
        if (nonAltas.length === 0) {
          logger.info(
            { module: 'cronMensajeMantsoft', dealId, dealstage },
            'Deal no está en stage activo — altas pospuestas'
          );
          continue;
        }
        itemsToProcess = nonAltas;
      }

      // Migrados (tipo 'migra'): NO van al mensaje del admin; se onboardean en SILENCIO
      // (finalizeLineItemAfterNotify estampa el snapshot + apaga mansoft_pendiente). Así no
      // se avisa alta de los migrados, pero quedan listos para que una edición futura sí avise.
      const migraItems = itemsToProcess.filter(li => classifyLineItem(li).tipo === 'migra');

      const html = buildMensajeMantsoft(itemsToProcess, dealName, dealMeta);

if (!html && migraItems.length === 0) {
        // Nada real que notificar (ej: ediciones cuyo diff quedó vacío).
        // Sin reset, estos LIs se reintentan todos los días para siempre.
        logger.warn(
          { module: 'cronMensajeMantsoft', dealId, lineItemCount: itemsToProcess.length },
          'Mensaje vacío sin migrados — se resetean flags para cortar reintentos'
        );
        if (!dry) {
          for (const li of itemsToProcess) {
            try {
              await finalizeLineItemAfterNotify(li);
              lineItemsReset++;
            } catch (err) {
              logger.error(
                { module: 'cronMensajeMantsoft', dealId, lineItemId: li.id, err },
                'Error reseteando LI con mensaje vacío'
              );
              errors++;
            }
          }
        }
        continue;
      }

      if (dry) {
        logger.info(
        { module: 'cronMensajeMantsoft', dealId, dealName, lineItemCount: itemsToProcess.length, migra: migraItems.length, htmlLength: html.length },
          '🏜️ DRY RUN — no se escribe mensaje ni se resetean line items'
        );
        dealsProcessed++;
        lineItemsReset += items.length;
        continue;
      }

      // Escribir mensaje en el deal (solo si hay algo que avisar; los migra no generan HTML)
      if (html) await writeMensaje(dealId, html);

      // Finalizar (snapshot + resetear flag + limpiar tipo): si hubo mensaje, TODOS los
      // itemsToProcess; si no, SOLO los migra (onboard silencioso). El flag mig_migracion_historica
      // NO se toca acá — lo apaga el último paso de la migración (sealHistoricTickets).
      const aFinalizar = html ? itemsToProcess : migraItems;
      for (const li of aFinalizar) {
        try {
          await finalizeLineItemAfterNotify(li);
          lineItemsReset++;
        } catch (err) {
          logger.error(
            { module: 'cronMensajeMantsoft', dealId, lineItemId: li.id, err },
            'Error finalizando line item (snapshot/flag/tipo)'
          );
          errors++;
        }
      }

      dealsProcessed++;
      logger.info(
        { module: 'cronMensajeMantsoft', dealId, dealName, lineItemCount: aFinalizar.length, migra: migraItems.length, avisado: !!html },
        '✅ Mensaje Mantsoft procesado (migrados onboardeados en silencio)'
      );

    } catch (err) {
      logger.error(
        { module: 'cronMensajeMantsoft', dealId, err },
        '❌ Error procesando deal'
      );
      errors++;
    }
  }

  const elapsed = Date.now() - start;
  const summary = {
    processed: dealsProcessed,
    deals: dealGroups.size,
    lineItemsReset,
    errors,
    elapsedMs: elapsed,
  };

  logger.info(
    { module: 'cronMensajeMantsoft', ...summary },
    '⚙️ Cron mensaje Mantsoft — fin'
  );
  try {
    await setCronState('mensaje_mantsoft_last_run', JSON.stringify(summary));
  } catch (err) {
    logger.warn({ module: 'cronMensajeMantsoft', err: err?.message }, 'No se pudo guardar cron state');
  }

  return summary;
}

// ────────────────────────────────────────────────────────────
// CLI
// ────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { deal: null, dry: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry') args.dry = true;
    else if (a === '--deal') { args.deal = argv[i + 1] || null; i++; }
  }
  return args;
}

const argv1 = process.argv?.[1];
const isDirectRun =
  typeof argv1 === 'string' &&
  argv1.length > 0 &&
  import.meta.url === pathToFileURL(argv1).href;

if (isDirectRun) {
  const { deal, dry } = parseArgs(process.argv.slice(2));
  try {
    const result = await runCronMensajeMantsoft({ onlyDealId: deal, dry });
    console.log('\nResultado:', JSON.stringify(result, null, 2));
  } catch (e) {
    logger.error(
      { module: 'cronMensajeMantsoft', error: e?.message || String(e), stack: e?.stack },
      'cron_mensaje_mantsoft_failed'
    );
    process.exitCode = 1;
  }
}