// src/services/tickets/ticketService.js

import { isAutoRenew } from '../billing/mode.js';
import { getEffectiveBillingConfig } from '../../billingEngine.js';
import { addInterval } from '../../utils/dateUtils.js';
import { createInvoiceFromTicket } from '../invoiceService.js';
import { syncBillingState } from '../billing/syncBillingState.js';
import { hubspotClient } from '../../hubspotClient.js';
import {
  TICKET_STAGES,
  AUTOMATED_TICKET_PIPELINE,
  AUTOMATED_TICKET_INITIAL_STAGE,
  isDryRun,
  isForecastTicketStage,
} from '../../config/constants.js';
import { createTicketSnapshots } from '../snapshotService.js';
import { getTodayYMD, getTomorrowYMD, toYMDInBillingTZ } from '../../utils/dateUtils.js';
import { parseBool, safeString } from '../../utils/parsers.js';
import { buildTicketKeyFromLineItemKey } from '../../utils/ticketKey.js';
import logger from '../../../lib/logger.js';
import { reportHubSpotError } from '../../utils/hubspotErrorCollector.js';

function reportIfActionable({ objectType, objectId, message, err }) {
  const status = err?.response?.status ?? err?.statusCode ?? null;
  if (status === null) { reportHubSpotError({ objectType, objectId, message }); return; }
  if (status === 429 || status >= 500) return;
  if (status >= 400 && status < 500) reportHubSpotError({ objectType, objectId, message });
}

/**
 * Garantiza que existan 24 tickets futuros para un line item en modo AUTO_RENEW.
 */
export async function ensure24FutureTickets({ hubspotClient, dealId, lineItemId, lineItem, lineItemKey, buildTicketPayload }) {
  let li = lineItem;
  if (!li) {
    if (!lineItemId) throw new Error('ensure24FutureTickets requiere lineItemId o lineItem');
    li = await hubspotClient.crm.lineItems.basicApi.getById(String(lineItemId), [
      'billing_next_date',
      'facturas_restantes',
      'renovacion_automatica',
      'recurringbillingfrequency',
      'hs_recurring_billing_frequency',
      'hs_recurring_billing_number_of_payments',
      'billing_anchor_date',
      'line_item_key',
      'name',
      'hs_object_id',
    ]);
  }
  const properties = li.properties || {};
  if (!isAutoRenew({ properties })) return;

  const cfg = getEffectiveBillingConfig({ properties });
  const { interval } = cfg;
  const anchorRaw = properties.billing_next_date;
  if (!interval || !anchorRaw) return;

  const maxCount = 24;
  const futureDates = [];
  let current = new Date(anchorRaw);
  for (let i = 0; i < maxCount && current && interval; i++) {
    futureDates.push(new Date(current));
    current = addInterval(current, interval);
  }

  const existingTickets = await getTicketsForDeal(dealId);
  const existingKeys = new Set(existingTickets.map(t => t.properties.of_ticket_key));

  for (const dateObj of futureDates) {
    const billDateYMD = dateObj.toISOString().slice(0, 10);
    const key = buildTicketKeyFromLineItemKey(dealId, lineItemKey || properties.line_item_key, billDateYMD);
    if (existingKeys.has(key)) continue;
    await ensureTicketCanonical({
      dealId,
      lineItemKey: lineItemKey || properties.line_item_key,
      billDateYMD,
      lineItemId: lineItemId || li.id,
      buildTicketPayload,
    });
  }
}

export async function countCanonicalTicketsForLineItemKey({ dealId, lineItemKey }) {
  const prefix = `${dealId}::LIK:${lineItemKey}::`;

  const res = await hubspotClient.crm.tickets.searchApi.doSearch({
    filterGroups: [
      {
        filters: [
          { propertyName: 'of_ticket_key', operator: 'CONTAINS_TOKEN', value: prefix },
        ],
      },
    ],
    properties: ['of_ticket_key', 'of_estado'],
    limit: 200,
  });

  const tickets = res?.results || [];

  const real = tickets.filter((t) => {
    const p = t.properties || {};
    const estado = (p.of_estado || '').toString().toUpperCase();
    if (estado === 'DUPLICADO_UI') return false;
    if (estado === 'DEPRECATED') return false;
    return true;
  });

  const uniq = new Set(real.map((t) => (t.properties?.of_ticket_key || '').toString()));
  return uniq.size;
}

// --- Helper para sincronizar line item tras ticket canónico ---
async function syncLineItemAfterCanonicalTicket({ dealId, lineItemId, ticketId, billDateYMD }) {
  let ticket;
  try {
    ticket = await hubspotClient.crm.tickets.basicApi.getById(String(ticketId), [
      'fecha_resolucion_esperada',
      'of_deal_id',
      'of_line_item_ids',
      'of_ticket_key',
      'hs_pipeline_stage',
    ]);
  } catch (err) {
    logger.warn(
      { module: 'ticketService', fn: 'syncLineItemAfterCanonicalTicket', ticketId, err },
      'No se pudo leer ticket'
    );
    return;
  }

  const tp = ticket?.properties || {};

  // Si el ticket sigue en FORECAST, no tocar fechas de line item
  if (isForecastTicketStage(tp.hs_pipeline_stage)) {
    return;
  }

  const ticketDateYMD = billDateYMD || toYMDInBillingTZ(tp.fecha_resolucion_esperada);
  if (!ticketDateYMD) return;

  // Anti-clon (soft)
  if (tp.of_deal_id && String(tp.of_deal_id) !== String(dealId)) return;
  if (tp.of_line_item_ids) {
    const ids = String(tp.of_line_item_ids).split(',').map(x => x.trim()).filter(Boolean);
    if (!ids.includes(String(lineItemId))) return;
  }
  if (!tp.of_ticket_key) return;

  let lineItem;
  try {
    lineItem = await hubspotClient.crm.lineItems.basicApi.getById(String(lineItemId), [
      'billing_next_date',
      'last_ticketed_date',
      'last_billing_period',
      'billing_anchor_date',
      'hs_recurring_billing_start_date',
      'recurringbillingfrequency',
      'hs_recurring_billing_frequency',
      'hs_recurring_billing_number_of_payments',
      'number_of_payments',
      'fecha_inicio_de_facturacion',
    ]);
  } catch (err) {
    logger.warn(
      { module: 'ticketService', fn: 'syncLineItemAfterCanonicalTicket', lineItemId, err },
      'No se pudo leer line item'
    );
    return;
  }

  const lp = lineItem?.properties || {};
  const currentLastTicketedYMD = (lp.last_ticketed_date || '').slice(0, 10);
  const currentNextYMD = (lp.billing_next_date || '').slice(0, 10);

  let newLastTicketedYMD = currentLastTicketedYMD;
  if (!currentLastTicketedYMD || ticketDateYMD > currentLastTicketedYMD) {
    newLastTicketedYMD = ticketDateYMD;
  }

  const totalPaymentsRaw =
    lp.hs_recurring_billing_number_of_payments ?? lp.number_of_payments;

  const totalPayments = totalPaymentsRaw ? Number(totalPaymentsRaw) : 0;

  if (totalPayments > 0) {
    const key = String(tp.of_ticket_key || '');
    const lineItemKey = extractLineItemKeyFromTicketKey(key);

    if (!lineItemKey) {
      logger.warn(
        { module: 'ticketService', fn: 'syncLineItemAfterCanonicalTicket', ticketKey: key },
        'ticketKey sin LIK'
      );
      return;
    }

    const issued = await countCanonicalTicketsForLineItemKey({ dealId, lineItemKey });

    if (issued >= totalPayments) {
      const updates = {};

      if (newLastTicketedYMD !== currentLastTicketedYMD) {
        updates.last_ticketed_date = newLastTicketedYMD;
      }

      if (currentNextYMD !== '') {
        updates.billing_next_date = '';
      }

      updates.fechas_completas = 'true';

      if (Object.keys(updates).length) {
        try {
          await hubspotClient.crm.lineItems.basicApi.update(
            String(lineItemId),
            { properties: updates }
          );
          logger.info(
            { module: 'ticketService', fn: 'syncLineItemAfterCanonicalTicket', lineItemId, issued, totalPayments, updates },
            'LineItem marcado como completado (pagos agotados)'
          );
        } catch (err) {
          reportIfActionable({ objectType: 'line_item', objectId: String(lineItemId), message: 'Error al marcar line item como completado', err });
          throw err;
        }
      }

      return;
    }
  }

  let newNextYMD = currentNextYMD;

  if (!currentNextYMD || currentNextYMD <= newLastTicketedYMD) {
    if (currentNextYMD && currentNextYMD > ticketDateYMD) {
      // no tocar
    } else {
      const { getNextBillingDateForLineItem } = await import('../../billingEngine.js');
      const { toYMDInBillingTZ, parseLocalDate } = await import('../../utils/dateUtils.js');

      const base = parseLocalDate(ticketDateYMD);
      const fakeLineItem = { properties: { ...lp } };
      const nextDateObj = getNextBillingDateForLineItem(fakeLineItem, base);
      newNextYMD = nextDateObj ? toYMDInBillingTZ(nextDateObj) : '';
    }
  }

  const updates = {};
  if (newLastTicketedYMD !== currentLastTicketedYMD) updates.last_ticketed_date = newLastTicketedYMD;
  if (newNextYMD !== currentNextYMD) updates.billing_next_date = newNextYMD;

  if (!Object.keys(updates).length) return;

  try {
    await hubspotClient.crm.lineItems.basicApi.update(String(lineItemId), { properties: updates });
    logger.info(
      { module: 'ticketService', fn: 'syncLineItemAfterCanonicalTicket', lineItemId, updates },
      'LineItem actualizado tras ticket canónico'
    );
  } catch (err) {
    reportIfActionable({ objectType: 'line_item', objectId: String(lineItemId), message: 'Error al actualizar billing dates en line item', err });
    logger.warn(
      { module: 'ticketService', fn: 'syncLineItemAfterCanonicalTicket', lineItemId, err },
      'No se pudo actualizar line item'
    );
  }
}

// Helper para resetear triggers en el Line Item (MVP anti-loops)
export async function resetTriggersFromLineItem(lineItemId) {
  const propsToReset = {
    facturar_ahora: 'false',
    actualizar: 'false',
  };

  try {
    await hubspotClient.crm.lineItems.basicApi.update(String(lineItemId), {
      properties: propsToReset,
    });
    logger.info(
      { module: 'ticketService', fn: 'resetTriggersFromLineItem', lineItemId },
      'Triggers reseteados en LineItem'
    );
  } catch (err) {
    reportIfActionable({ objectType: 'line_item', objectId: String(lineItemId), message: 'No se pudo resetear triggers en LineItem', err });

    const msg = `[TRIGGERS] NO se pudo resetear triggers en LineItem ${lineItemId}. ` +
      `Queda riesgo de loop. Error: ${err?.message || err}`;

    // Intento guardar el mensaje para que "se sepa qué falló"
    try {
      await hubspotClient.crm.lineItems.basicApi.update(String(lineItemId), {
        properties: { billing_error: msg },
      });
    } catch (_) {
      // si también falla, al menos queda en logs
    }

    throw new Error(msg);
  }
}

export function hasFrequency(lp) {
  const freq =
    (lp.recurringbillingfrequency ?? '') ||
    (lp.hs_recurring_billing_frequency ?? '');
  return freq.toString().trim() !== '';
}

export function isEmpty(v) {
  return v == null || (typeof v === 'string' && v.trim() === '');
}


export async function createAutoBillingTicket(deal, lineItem, billingDate) {
  const dealId = String(deal?.id || deal?.properties?.hs_object_id);
  const lineItemId = String(lineItem?.id || lineItem?.properties?.hs_object_id);
  const dp = deal?.properties || {};
  const lp = lineItem?.properties || {};

  const lineItemKey = lp.line_item_key || null;

  logger.debug(
    { module: 'ticketService', fn: 'createAutoBillingTicket', dealId, lineItemId, lineItemKey, billingDate },
    'Inicio createAutoBillingTicket'
  );

  let ticketId = null;
  let created = false;
  let duplicatesMarked = 0;

  try {
    const result = await ensureTicketCanonical({
      dealId,
      lineItemKey: lineItem?.properties?.line_item_key,
      billDateYMD: billingDate,
      lineItemId,

      buildTicketPayload: async ({ dealId, lineItemKey, billDateYMD, expectedKey }) => {
        const expectedDate = billDateYMD;
        const orderedDate = billDateYMD;
        const snapshots = await createTicketSnapshots(deal, lineItem, expectedDate, orderedDate);

        const dealName = deal?.properties?.dealname || 'Deal';
        const productName = lineItem?.properties?.name || 'Producto';
        const rubro = snapshots.of_rubro || null;

        const vendedorId = dp.hubspot_owner_id ? String(dp.hubspot_owner_id) : null;

        const ticketProps = {
          subject: `${dealName} | ${productName} | ${rubro} | ${billDateYMD}`,
          hs_pipeline: AUTOMATED_TICKET_PIPELINE,
          hs_pipeline_stage: AUTOMATED_TICKET_INITIAL_STAGE,
          of_deal_id: dealId,
          of_line_item_ids: lineItemId,
          of_line_item_key: lineItemKey,
          of_ticket_key: expectedKey,
          observaciones_ventas: lineItem?.properties?.mensaje_para_responsable || '',
          ...snapshots,
        };

        if (vendedorId) ticketProps.of_propietario_secundario = vendedorId;

        return { properties: ticketProps };
      },
    });

    ticketId = result.ticketId;
    created = result.created;
    duplicatesMarked = result.duplicatesMarked;

    if (!ticketId) {
      logger.warn(
        { module: 'ticketService', fn: 'createAutoBillingTicket', dealId, lineItemId },
        'No ticketId devuelto, omitiendo facturación'
      );
      return { ticketId, created, duplicatesMarked };
    }

    if (created) {
      const [companyIds, contactIds] = await Promise.all([
        getDealCompanies(dealId),
        getDealContacts(dealId),
      ]);
      await createTicketAssociations(ticketId, dealId, lineItemId, companyIds, contactIds);
      logger.info(
        { module: 'ticketService', fn: 'createAutoBillingTicket', dealId, lineItemId, ticketId, vendedorId: dp.hubspot_owner_id || null },
        'Ticket creado y asociado'
      );
    }

    let ticketObj = null;
    try {
      ticketObj = await hubspotClient.crm.tickets.basicApi.getById(String(ticketId), [
        'of_invoice_id',
        'of_invoice_key',
        'hs_pipeline',
        'of_ticket_key',
        'fecha_resolucion_esperada',
      ]);
    } catch (err) {
      logger.warn(
        { module: 'ticketService', fn: 'createAutoBillingTicket', ticketId, err },
        'No se pudo obtener ticket para chequeo de factura'
      );
    }

    const hasInvoice = ticketObj?.properties?.of_invoice_id;
    const isAutoPipeline = ticketObj?.properties?.hs_pipeline === AUTOMATED_TICKET_PIPELINE;

    if (created) {
      await createInvoiceFromTicket(ticketObj, 'AUTO_LINEITEM');
      logger.info(
        { module: 'ticketService', fn: 'createAutoBillingTicket', ticketId },
        'Factura emitida desde ticket nuevo'
      );
    } else if (isAutoPipeline && !hasInvoice) {
      await createInvoiceFromTicket(ticketObj, 'AUTO_LINEITEM');
      logger.info(
        { module: 'ticketService', fn: 'createAutoBillingTicket', ticketId },
        'Factura emitida desde ticket existente sin factura previa'
      );
    } else {
      logger.debug(
        { module: 'ticketService', fn: 'createAutoBillingTicket', ticketId, isAutoPipeline, hasInvoice: !!hasInvoice },
        'Ticket existente, no se emite factura'
      );
    }

    if (duplicatesMarked > 0) {
      logger.info(
        { module: 'ticketService', fn: 'createAutoBillingTicket', ticketId, duplicatesMarked },
        'Duplicados marcados'
      );
    }

    return { ticketId, created, duplicatesMarked };
  } catch (err) {
    logger.error(
      { module: 'ticketService', fn: 'createAutoBillingTicket', dealId, lineItemId, err },
      'Error en createAutoBillingTicket'
    );
    throw err;
  } finally {
    await resetTriggersFromLineItem(lineItemId);
  }
}

export async function buildTicketFullProps({
  deal,
  lineItem,
  dealId,
  lineItemId,
  lineItemKey,
  ticketKey,
  expectedYMD,
  orderedYMD = null
}) {
  const dp = deal?.properties || {};
  const lp = lineItem?.properties || {};

  const autorenew =
    hasFrequency(lp) &&
    isEmpty(lp.hs_recurring_billing_number_of_payments);

  let empresaId = '';
  let empresaNombre = '';

  try {
    const companyIds = await getDealCompanies(String(dealId));
    empresaId = companyIds?.[0] ? String(companyIds[0]) : '';

    if (empresaId) {
      const c = await hubspotClient.crm.companies.basicApi.getById(
        empresaId,
        ['name']
      );
      empresaNombre = c?.properties?.name || '';
    }
  } catch (_) {
    empresaId = '';
    empresaNombre = '';
  }

  const productoNombre = safeString(lp.name);
  const unidadDeNegocio = safeString(lp.unidad_de_negocio);
  const servicio = safeString(lp.servicio);
  const paisOperativo = safeString(dp.of_pais_operativo);

  const snapshots = createTicketSnapshots(
    deal,
    lineItem,
    expectedYMD,
    orderedYMD
  );

  const subject =
    `${empresaNombre || 'SIN_EMPRESA'} - ` +
    `${productoNombre || 'SIN_PRODUCTO'} - ` +
    `${expectedYMD}`;

  const properties = {
    of_deal_id: String(dealId),
    of_line_item_ids: String(lineItemId || ''),
    of_line_item_key: String(lineItemKey || ''),
    of_ticket_key: String(ticketKey || ''),
    empresa_id: empresaId,
    nombre_empresa: empresaNombre,
    of_pais_operativo: paisOperativo,
    unidad_de_negocio: unidadDeNegocio,
    of_rubro: servicio,
    subject,
    fecha_resolucion_esperada: String(expectedYMD),
    observaciones_ventas: safeString(lp.mensaje_para_responsable),
    ...snapshots,
  };

  properties.fecha_resolucion_esperada = String(expectedYMD);
  properties.renovacion_automatica = autorenew ? 'true' : 'false';

  logger.debug(
    { module: 'ticketService', fn: 'buildTicketFullProps', lineItemId, autorenew },
    'buildTicketFullProps completado'
  );

  return properties;
}


/**
 * Servicio para crear y gestionar tickets de "orden de facturación".
 * Implementa idempotencia mediante of_ticket_key.
 * Incluye deduplicación automática de tickets clonados por UI.
 *
 * DEDUPLICACIÓN DE TICKETS CLONADOS POR UI:
 * Problema: HubSpot permite clonar line items desde la UI; cuando un line item
 * tiene tickets asociados, también clona los tickets.
 * Solución: Identificar el ticket canónico (el que tiene ticketKey exacta)
 * y marcar los demás como DUPLICADO_UI.
 * Propiedades: of_ticket_key, of_estado, of_es_duplicado_clon.
 */

/**
 * Busca TODOS los tickets asociados a un Deal.
 */
async function getTicketsForDeal(hubspotClient, dealId) {
  try {
    const assoc = await hubspotClient.crm.associations.v4.basicApi.getPage(
      'deals',
      String(dealId),
      'tickets',
      100
    );

    const ticketIds = (assoc.results || []).map(r => String(r.toObjectId));
    if (!ticketIds.length) return [];

    const resp = await hubspotClient.crm.tickets.batchApi.read({
      inputs: ticketIds.map(id => ({ id })),
      properties: [
        'hs_object_id',
        'subject',
        'of_ticket_key',
        'of_fecha_de_facturacion',
        'of_line_item_ids',
        'of_estado',
        'of_es_duplicado_clon',
        'of_deal_id',
        'hs_pipeline_stage',
        'nota',
        'createdate',
        'hs_createdate',
      ],
    });

    return (resp.results || []).map(t => ({
      id: String(t.id),
      properties: t.properties || {},
      createdate: t.properties?.createdate || null,
    }));
  } catch (err) {
    logger.warn(
      { module: 'ticketService', fn: 'getTicketsForDeal', dealId, err },
      'Error obteniendo tickets del deal'
    );
    return [];
  }
}

export async function safeCreateTicket(hubspotClient, payload) {
  let current = structuredClone(payload);

  for (let i = 0; i < 5; i++) {
    try {
      return await hubspotClient.crm.tickets.basicApi.create(current);
    } catch (err) {
      const missing = getMissingPropertyNameFromHubSpotError(err);
      if (!missing) throw err;

      if (current?.properties?.[missing] === undefined) throw err;

      logger.warn(
        { module: 'ticketService', fn: 'safeCreateTicket', missingProperty: missing },
        'Propiedad faltante en HubSpot, reintentando sin ella'
      );
      delete current.properties[missing];
    }
  }
  throw new Error("safeCreateTicket: too many retries removing missing properties");
}

export async function safeUpdateTicket(hubspotClient, ticketId, payload) {
  let current = structuredClone(payload);

  for (let i = 0; i < 5; i++) {
    try {
      return await hubspotClient.crm.tickets.basicApi.update(ticketId, current);
    } catch (err) {
      const missing = getMissingPropertyNameFromHubSpotError(err);
      if (!missing) throw err;

      if (current?.properties?.[missing] === undefined) throw err;

      logger.warn(
        { module: 'ticketService', fn: 'safeUpdateTicket', ticketId, missingProperty: missing },
        'Propiedad faltante en HubSpot, reintentando update sin ella'
      );
      delete current.properties[missing];
    }
  }
  throw new Error("safeUpdateTicket: too many retries removing missing properties");
}

/**
 * Marca tickets duplicados "clonados por UI".
 */
async function markDuplicateTickets({ canonicalTicketId, duplicates, reason }) {
  if (!duplicates || duplicates.length === 0) return;

  logger.info(
    { module: 'ticketService', fn: 'markDuplicateTickets', canonicalTicketId, duplicatesCount: duplicates.length },
    'Marcando tickets como DUPLICADO_UI'
  );

  for (const t of duplicates) {
    const id = t.id;
    if (id === canonicalTicketId) continue;

    try {
      const currentNote = t.properties?.nota || '';
      const newNote = `${currentNote}\n[auto ${getTodayYMD()}] Marcado DUPLICADO_UI: ${reason}`.trim();

      const patch = {
        properties: {
          of_estado: 'DUPLICADO_UI',
          of_es_duplicado_clon: 'true',
          nota: newNote,
        },
      };

      await safeUpdateTicket(hubspotClient, String(id), patch);
      logger.debug(
        { module: 'ticketService', fn: 'markDuplicateTickets', ticketId: id },
        'Ticket marcado como DUPLICADO_UI'
      );
    } catch (err) {
      logger.warn(
        { module: 'ticketService', fn: 'markDuplicateTickets', ticketId: id, err },
        'No se pudo marcar ticket como duplicado'
      );
    }
  }
}

function extractLineItemKeyFromTicketKey(ticketKey) {
  if (!ticketKey) return null;
  const parts = String(ticketKey).split('::');
  if (parts.length !== 3) return null;

  const mid = parts[1];
  if (!mid.startsWith('LIK:')) return null;

  const lik = mid.slice(4);
  return lik || null;
}

async function findCanonicalAndDuplicates({
  dealId,
  expectedKey,
  billDateYMD,
  lineItemId,
  lineItemKey,
}) {
  const tickets = await getTicketsForDeal(dealId);

  const norm = (s) => (s == null ? '' : String(s)).trim();
  const tkey = (t) => norm(t?.properties?.of_ticket_key);

  const byExpectedKey = tickets.filter(t => tkey(t) === expectedKey);

  let canonical = null;
  let duplicates = [];

  if (byExpectedKey.length) {
    canonical = byExpectedKey
      .slice()
      .sort((a, b) => getTicketCreatedMs(a) - getTicketCreatedMs(b))[0];
    duplicates = byExpectedKey.filter(t => String(t.id) !== String(canonical.id));
  } else {
    canonical = null;
    duplicates = [];
  }

  return { canonical, duplicates };
}

function getTicketCreatedMs(t) {
  const p = t.properties || {};
  const raw = p.createdate || p.hs_createdate || p.hs_created_at;
  const ms = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(ms) ? ms : Number.MAX_SAFE_INTEGER;
}

export async function archiveClonedTicketsByKey({ expectedKey, dealId, dryRun = false }) {
  const tickets = await getTicketsForDeal(dealId);
  const byKey = tickets.filter(t => (t.properties?.of_ticket_key || '').trim() === expectedKey);

  if (byKey.length <= 1) return { kept: byKey[0]?.id || null, archived: [] };

  byKey.sort((a, b) => getTicketCreatedMs(a) - getTicketCreatedMs(b));

  const kept = String(byKey[0].id);
  const clones = byKey.slice(1).map(t => String(t.id));

  if (!dryRun) {
    for (const id of clones) {
      await hubspotClient.crm.tickets.basicApi.archive(id);
    }
  }
  return { kept, archived: clones };
}

/**
 * Asegura que existe un ticket canónico y marca los duplicados.
 */
export async function ensureTicketCanonical({
  dealId,
  lineItemKey,
  billDateYMD,
  lineItemId,
  buildTicketPayload,
  maxPayments,
}) {
  if (!lineItemId) {
    throw new Error('ensureTicketCanonical: lineItemId es requerido (asociaciones/updates)');
  }
  if (!lineItemKey) {
    throw new Error('ensureTicketCanonical: lineItemKey es requerido (identidad estable)');
  }

  const expectedKey = buildTicketKeyFromLineItemKey(dealId, lineItemKey, billDateYMD);

  logger.debug(
    { module: 'ticketService', fn: 'ensureTicketCanonical', dealId, lineItemKey, lineItemId, billDateYMD, expectedKey },
    'ensureTicketCanonical: buscando ticket canónico'
  );

  await archiveClonedTicketsByKey({ expectedKey, dealId, dryRun: isDryRun() });

  const { canonical, duplicates } = await findCanonicalAndDuplicates({
    dealId,
    expectedKey,
    billDateYMD,
    lineItemId,
    lineItemKey,
  });

  if (canonical) {
    logger.info(
      { module: 'ticketService', fn: 'ensureTicketCanonical', ticketId: canonical.id, expectedKey, duplicatesCount: duplicates.length },
      'Ticket canónico existente'
    );

    if (duplicates.length) {
      await markDuplicateTickets({
        canonicalTicketId: canonical.id,
        duplicates,
        reason: `Existe ticketKey canónica ${expectedKey}`,
      });
    }

    try {
      await syncLineItemAfterCanonicalTicket({
        dealId,
        lineItemId,
        ticketId: canonical.id,
        billDateYMD,
      });
      await syncBillingState({ hubspotClient, dealId, lineItemId, lineItemKey, dealIsCanceled: false });
      if (isAutoRenew({ properties: lineItem?.properties || lineItem })) {
        await ensure24FutureTickets({
          hubspotClient,
          dealId,
          lineItemId,
          lineItem,
          lineItemKey,
        });
      }
    } catch (err) {
      logger.warn(
        { module: 'ticketService', fn: 'ensureTicketCanonical', ticketId: canonical.id, err },
        'syncLineItemAfterCanonicalTicket (canonical) error'
      );
    }

    return {
      ticketId: canonical.id,
      created: false,
      ticketKey: expectedKey,
      duplicatesMarked: duplicates.length,
    };
  }

  // No existe: crear ticket canónico
  logger.info(
    { module: 'ticketService', fn: 'ensureTicketCanonical', dealId, lineItemId, expectedKey },
    'Creando ticket canónico'
  );

  if (isDryRun()) {
    logger.info(
      { module: 'ticketService', fn: 'ensureTicketCanonical', expectedKey },
      'DRY_RUN: ticket no creado'
    );
    return { ticketId: null, created: false, ticketKey: expectedKey, duplicatesMarked: 0 };
  }

  const payload = await buildTicketPayload({
    dealId,
    lineItemKey,
    billDateYMD,
    expectedKey,
  });

  const created = await safeCreateTicket(hubspotClient, payload);
  const newId = String(created.id || created.result?.id);

  logger.info(
    { module: 'ticketService', fn: 'ensureTicketCanonical', ticketId: newId, expectedKey },
    'Ticket canónico creado'
  );

  const post = await findCanonicalAndDuplicates({
    dealId,
    expectedKey,
    billDateYMD,
    lineItemId,
    lineItemKey,
  });

  if (post.duplicates.length) {
    await markDuplicateTickets({
      canonicalTicketId: newId,
      duplicates: post.duplicates,
      reason: `Se creó ticket canónico ${expectedKey}`,
    });
  }

  try {
    await syncLineItemAfterCanonicalTicket({
      dealId,
      lineItemId,
      ticketId: newId,
      billDateYMD,
    });
    await syncBillingState({ hubspotClient, dealId, lineItemId, lineItemKey, dealIsCanceled: false });
  } catch (err) {
    logger.warn(
      { module: 'ticketService', fn: 'ensureTicketCanonical', ticketId: newId, err },
      'syncLineItemAfterCanonicalTicket (created) error'
    );
  }

  return {
    ticketId: newId,
    created: true,
    ticketKey: expectedKey,
    duplicatesMarked: post.duplicates.length,
  };
}

export function getMissingPropertyNameFromHubSpotError(e) {
  const body = e?.body || e?.response?.body;
  const ctx = body?.errors?.[0]?.context?.propertyName?.[0];
  if (ctx) return ctx;

  const msg = body?.message || "";
  const m = msg.match(/Property \"(.+?)\" does not exist/);
  return m?.[1] || null;
}

/**
 * Busca un ticket existente por clave única (of_ticket_key).
 */
export async function findTicketByKey(ticketKey) {
  try {
    const searchResp = await hubspotClient.crm.tickets.searchApi.doSearch({
      filterGroups: [
        {
          filters: [
            {
              propertyName: 'of_ticket_key',
              operator: 'EQ',
              value: ticketKey,
            },
          ],
        },
      ],
      properties: ['of_ticket_id', 'of_invoice_id', 'hs_pipeline_stage'],
      limit: 1,
    });

    return searchResp.results?.[0] || null;
  } catch (err) {
    logger.warn(
      { module: 'ticketService', fn: 'findTicketByKey', ticketKey, err },
      'Error buscando ticket por key'
    );
    return null;
  }
}

/**
 * Determina el stage correcto del ticket según la fecha de facturación y flag "facturar ahora".
 */
export function getTicketStage(billingDate, lineItem) {
  const lp = lineItem?.properties || {};

  if (parseBool(lp.facturar_ahora)) {
    return TICKET_STAGES.READY;
  }

  const today = getTodayYMD();
  const tomorrowStr = getTomorrowYMD();

  if (billingDate === today || billingDate === tomorrowStr) {
    return TICKET_STAGES.READY;
  }

  return TICKET_STAGES.NEW;
}

/**
 * Obtiene los IDs de empresas asociadas al deal.
 */
export async function getDealCompanies(dealId) {
  try {
    const resp = await hubspotClient.crm.associations.v4.basicApi.getPage(
      'deals',
      String(dealId),
      'companies',
      100
    );
    return (resp.results || []).map(r => String(r.toObjectId));
  } catch (err) {
    logger.warn(
      { module: 'ticketService', fn: 'getDealCompanies', dealId, err },
      'Error obteniendo companies del deal'
    );
    return [];
  }
}

/**
 * Obtiene los IDs de contactos asociados al deal.
 */
export async function getDealContacts(dealId) {
  try {
    const resp = await hubspotClient.crm.associations.v4.basicApi.getPage(
      'deals',
      String(dealId),
      'contacts',
      100
    );
    return (resp.results || []).map(r => String(r.toObjectId));
  } catch (err) {
    logger.warn(
      { module: 'ticketService', fn: 'getDealContacts', dealId, err },
      'Error obteniendo contacts del deal'
    );
    return [];
  }
}

/**
 * Asocia el ticket a empresas, contactos y line item.
 */
export async function createTicketAssociations(ticketId, dealId, lineItemId, companyIds, contactIds) {
  const associations = [];

  associations.push(
    hubspotClient.crm.associations.v4.basicApi.create('tickets', ticketId, 'deals', dealId, [])
      .catch(err => logger.warn({ module: 'ticketService', fn: 'createTicketAssociations', ticketId, dealId, err }, 'Error asociando deal'))
  );

  associations.push(
    hubspotClient.crm.associations.v4.basicApi.create('tickets', ticketId, 'line_items', lineItemId, [])
      .catch(err => logger.warn({ module: 'ticketService', fn: 'createTicketAssociations', ticketId, lineItemId, err }, 'Error asociando line item'))
  );

  for (const companyId of companyIds) {
    associations.push(
      hubspotClient.crm.associations.v4.basicApi.create('tickets', ticketId, 'companies', companyId, [])
        .catch(err => logger.warn({ module: 'ticketService', fn: 'createTicketAssociations', ticketId, companyId, err }, 'Error asociando company'))
    );
  }

  for (const contactId of contactIds) {
    associations.push(
      hubspotClient.crm.associations.v4.basicApi.create('tickets', ticketId, 'contacts', contactId, [])
        .catch(err => logger.warn({ module: 'ticketService', fn: 'createTicketAssociations', ticketId, contactId, err }, 'Error asociando contact'))
    );
  }

  await Promise.all(associations);
}

/**
 * Actualiza un ticket existente con datos adicionales.
 */
export async function updateTicket(ticketId, properties) {
  if (!properties || Object.keys(properties).length === 0) {
    logger.debug(
      { module: 'ticketService', fn: 'updateTicket', ticketId },
      'SKIP_EMPTY_UPDATE: sin propiedades para actualizar'
    );
    return;
  }

  try {
    await safeUpdateTicket(hubspotClient, ticketId, { properties });
    logger.info(
      { module: 'ticketService', fn: 'updateTicket', ticketId },
      'Ticket actualizado'
    );
  } catch (err) {
    reportIfActionable({ objectType: 'ticket', objectId: String(ticketId), message: 'Error actualizando ticket', err });
    logger.error(
      { module: 'ticketService', fn: 'updateTicket', ticketId, err },
      'Error actualizando ticket'
    );
    throw err;
  }
}

/*
 * CATCHES con reportHubSpotError agregados:
 *   - syncLineItemAfterCanonicalTicket: lineItems.basicApi.update() rama "completado" → objectType="line_item"
 *   - syncLineItemAfterCanonicalTicket: lineItems.basicApi.update() rama "billing dates" → objectType="line_item"
 *     (este catch NO re-throws; warn + continúa, consistent con el original)
 *   - resetTriggersFromLineItem: lineItems.basicApi.update() → objectType="line_item", antes del throw
 *     (el segundo update interno —billing_error— es best-effort dentro del catch, no se reporta para evitar
 *     recursión y porque es solo un intento de diagnóstico)
 *   - updateTicket: safeUpdateTicket() → objectType="ticket", antes del re-throw
 *
 * NO reportados:
 *   - markDuplicateTickets: safeUpdateTicket() → es marcado de estado interno (DUPLICADO_UI),
 *     no accionable desde perspectiva del cliente; error absorbido con warn
 *   - safeCreateTicket / safeUpdateTicket internos (retry loop) → el error se re-throws
 *     al caller que sí reporta
 *   - getDealCompanies / getDealContacts / createTicketAssociations → lecturas y asociaciones excluidas
 *   - archiveClonedTicketsByKey → archivado, no update accionable
 *   - syncBillingState → delegado a otro servicio
 *   - createInvoiceFromTicket → no es ticket/line_item update directo
 *   - ensure24FutureTickets → delegado
 *   - findTicketByKey → lectura
 *   - getTicketsForDeal → lectura
 *
 * Confirmación: "No se reportan warns a HubSpot; solo errores 4xx (≠429)"
 *
 * ⚠️  BUGS PREEXISTENTES (no corregidos per Regla 5):
 *   1. getTicketsForDeal() tiene firma (hubspotClient, dealId) pero en los call sites
 *      internos (findCanonicalAndDuplicates, archiveClonedTicketsByKey, ensure24FutureTickets)
 *      se llama solo con (dealId), por lo que hubspotClient queda undefined dentro de la función
 *      y todas las calls a hubspotClient.crm.* fallarán en runtime.
 *   2. En ensureTicketCanonical, `lineItem` se referencia en el bloque
 *      `isAutoRenew({ properties: lineItem?.properties || lineItem })` pero no es
 *      un parámetro de la función (no está en la destructuración); siempre será undefined.
 */