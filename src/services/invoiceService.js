// src/services/invoiceService.js
import { hubspotClient } from '../hubspotClient.js';
import { buildInvoiceKeyFromLIK } from '../utils/invoiceKey.js';
import { parseNumber, safeString, parseBool } from '../utils/parsers.js';
import { getTodayYMD, toYMDInBillingTZ, toHubSpotDateOnly } from '../utils/dateUtils.js';
import { isDryRun, DEFAULT_CURRENCY } from '../config/constants.js';
import { associateV4 } from '../associations.js';
import { consumeCupoAfterInvoice } from './cupo/consumeCupo.js';
import { recalcFacturasRestantes } from './billing/recalcFacturasRestantes.js';
import { syncBillingState } from './billing/syncBillingState.js';
import { isAutoRenew } from './billing/mode.js';
import { ensure24FutureTickets } from './tickets/ticketService.js';
import { buildValidatedUpdateProps } from '../utils/propertyHelpers.js';
import axios from 'axios';
import logger from '../../lib/logger.js';
import { reportHubSpotError } from '../utils/hubspotErrorCollector.js';

const HUBSPOT_API_BASE = 'https://api.hubapi.com';
const accessToken = process.env.HUBSPOT_PRIVATE_TOKEN;

/**
 * Helper anti-spam: reporta a HubSpot solo errores 4xx accionables (≠ 429).
 * 429 y 5xx son transitorios → solo logger.error, sin reporte.
 */
function reportIfActionable({ objectType, objectId, message, err }) {
  const status = err?.response?.status ?? err?.statusCode ?? null;
  if (status === null) {
    reportHubSpotError({ objectType, objectId, message });
    return;
  }
  if (status === 429 || status >= 500) return;
  if (status >= 400 && status < 500) {
    reportHubSpotError({ objectType, objectId, message });
  }
}

// Extrae la fecha YYYY-MM-DD del ticketKey (último segmento si matchea formato)
function extractBillDateFromTicketKey(ticketKey) {
  if (!ticketKey) return null;
  const parts = String(ticketKey).split('::');
  const last = parts[parts.length - 1];
  return /^\d{4}-\d{2}-\d{2}$/.test(last) ? last : null;
}

// Sincroniza last_billing_period en el line item a partir del ticket (fecha esperada)
async function syncBillingLastBilledDateFromTicket(ticketObj) {
  try {
    const tp = ticketObj?.properties || {};
    const ticketId = String(ticketObj?.id || tp?.hs_object_id || '');

    // SOLO fecha esperada (plan). NO usar of_fecha_de_facturacion.
    const expectedYMD =
      toYMDInBillingTZ(tp.fecha_resolucion_esperada) ||
      extractBillDateFromTicketKey(tp.of_ticket_key);

    if (!expectedYMD) {
      logger.debug({ module: 'invoiceService', fn: 'syncBillingLastBilledDateFromTicket', ticketId }, '[BLP] skip: no expectedYMD');
      return;
    }

    const lineItemId = String(tp.of_line_item_ids || '').split(',')[0].trim();
    if (!lineItemId) {
      logger.debug({ module: 'invoiceService', fn: 'syncBillingLastBilledDateFromTicket', ticketId, of_line_item_ids: tp.of_line_item_ids }, '[BLP] skip: no lineItemId');
      return;
    }

    const billingLastPeriod = String(toHubSpotDateOnly(expectedYMD));

    await hubspotClient.crm.lineItems.basicApi.update(String(lineItemId), {
      properties: { last_billing_period: billingLastPeriod },
    });

    // Confirmación inmediata
    const liAfter = await hubspotClient.crm.lineItems.basicApi.getById(String(lineItemId), ['last_billing_period']);

    logger.debug({
      module: 'invoiceService',
      fn: 'syncBillingLastBilledDateFromTicket',
      ticketId,
      lineItemId,
      expectedYMD,
      billingLastPeriod,
      confirmed: liAfter?.properties?.last_billing_period,
    }, '[BLP] last_billing_period sincronizado');

  } catch (err) {
    logger.warn({ module: 'invoiceService', fn: 'syncBillingLastBilledDateFromTicket', err }, '[BLP] error sincronizando last_billing_period');
  }
}

// Propiedades permitidas en el objeto Invoice de HubSpot
const ALLOWED_INVOICE_PROPS = [
  "cantidad","createdate","descripcion","descuento","descuento_por_unidad","etapa_de_la_factura",
  "exonera_irae","fecha_de_caneclacion","fecha_de_emision","fecha_de_envio","fecha_de_facturacion",
  "fecha_de_pago","frecuencia_de_facturacion","hs_amount_billed","hs_comments","hs_currency","hs_due_date",
  "hs_invoice_billable","hs_invoice_date","hs_tax_id","hs_title","hubspot_owner_id",
  "id_factura_nodum","impacto_facturado","impacto_forecast","impacto_historico","iva",
  "mensual","modo_de_generacion_de_factura","monto_a_facturar","motivo_de_pausa","nombre_empresa",
  "nombre_producto","of_invoice_key","of_monto_total_facturado","pais_operativo","pedido_por",
  "periodo_a_facturar","procede_de","responsable_asignado","reventa","servicio","ticket_id",
  "unidad_de_negocio","usuario_disparador_de_factura","vendedor_factura","line_item_key"
];

function pickAllowedProps(inputProps) {
  const result = {};
  for (const key of ALLOWED_INVOICE_PROPS) {
    if (inputProps[key] !== undefined && inputProps[key] !== null) {
      result[key] = inputProps[key];
    }
  }
  return result;
}

function toNumericOwnerOrNull(v) {
  const s = String(v).trim();
  return /^\d+$/.test(s) ? s : null;
}

async function createInvoiceDirect(properties) {
  const response = await axios.post(
    `${HUBSPOT_API_BASE}/crm/v3/objects/invoices`,
    { properties },
    { headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
  );
  return response.data;
}

async function updateInvoiceDirect(invoiceId, properties) {
  const response = await axios.patch(
    `${HUBSPOT_API_BASE}/crm/v3/objects/invoices/${invoiceId}`,
    { properties },
    { headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
  );
  return response.data;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ⚠️ REGLA NO NEGOCIABLE - FREEZE RULE ⚠️
// ═══════════════════════════════════════════════════════════════════════════════
// - Backend NO calcula montos: NO qty*price, NO descuentos, NO IVA.
// - Solo copia RAW + usa propiedades CALCULADAS por HubSpot en el Ticket.
// - IVA/descuento se copian solo como flags informativos.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Crea una factura desde un ticket de orden de facturación.
 *
 * @param {Object} ticket
 * @param {string} modoGeneracion - 'AUTO_LINEITEM' | 'MANUAL_TICKET' | 'MANUAL_LINEITEM'
 * @param {string|null} usuarioDisparador
 * @returns {Object} { invoiceId, created }
 */
export async function createInvoiceFromTicket(ticket, modoGeneracion = 'AUTO_LINEITEM', usuarioDisparador = null) {
  const ticketId = ticket.id || ticket.properties?.hs_object_id;

  logger.info({ module: 'invoiceService', fn: 'createInvoiceFromTicket', ticketId, modoGeneracion }, '[invoice] Iniciando creación de factura desde ticket');

  // Re-leer ticket con todas las propiedades relevantes
  let ticketFull = ticket;
  try {
    ticketFull = await hubspotClient.crm.tickets.basicApi.getById(ticketId, [
      'of_ticket_key', 'of_deal_id', 'of_line_item_ids', 'of_line_item_key',
      'of_invoice_id', 'of_invoice_key',
      'of_fecha_de_facturacion', 'fecha_real_de_facturacion', 'fecha_resolucion_esperada',
      'total_real_a_facturar', 'cantidad_real', 'monto_unitario_real',
      'subject', 'of_producto_nombres', 'of_descripcion_producto', 'of_rubro',
      'descuento_en_porcentaje', 'descuento_por_unidad_real', 'of_iva', 'of_exonera_irae',
      'of_aplica_para_cupo', 'of_cupo_alerta_preventiva_emitida', 'of_cupo_alerta_preventiva_fecha',
      'of_cupo_restante_proyectado', 'of_cupo_consumo_estimado',
      'of_cupo_consumido', 'of_cupo_consumido_fecha', 'of_cupo_consumo_valor', 'of_cupo_consumo_invoice_id',
      'of_moneda', 'of_pais_operativo', 'of_frecuencia_de_facturacion', 'of_propietario_secundario',
      'hubspot_owner_id', 'of_cliente', 'unidad_de_negocio',
      'descripcion', 'content', 'createdate', 'of_motivo_pausa', 'numero_de_factura', 'of_invoice_status',
      'facturar_ahora', 'repetitivo',
    ]);
  } catch (err) {
    logger.warn({ module: 'invoiceService', fn: 'createInvoiceFromTicket', ticketId, err }, '[invoice] No se pudo re-leer ticket completo, usando datos originales');
  }

  const tp = ticketFull.properties || {};

  // ⚡ RESOLVED VARIABLES — prueba de NO backend calculations
  const cantidadResolved      = parseNumber(tp.cantidad_real ?? null, 0);
  const montoUnitarioResolved = parseNumber(tp.monto_unitario_real ?? null, 0); // info only, NO multiply
  const descuentoPctResolved  = parseNumber(tp.descuento_en_porcentaje ?? null, 0);
  const descuentoUnitResolved = parseNumber(tp.descuento_por_unidad_real ?? null, 0);
  const totalFinalResolved    = parseNumber(tp.total_real_a_facturar ?? null, 0); // HubSpot-CALCULATED
  const hasIVAResolved        = parseBool(tp.of_iva);

  // Debug consolidado — reemplaza ~80 console.log individuales
  logger.debug({
    module: 'invoiceService',
    fn: 'createInvoiceFromTicket',
    ticketId,
    modoGeneracion,
    refs: {
      of_ticket_key: tp.of_ticket_key,
      of_deal_id: tp.of_deal_id,
      of_line_item_ids: tp.of_line_item_ids,
      of_line_item_key: tp.of_line_item_key,
      of_invoice_id: tp.of_invoice_id,
      of_invoice_key: tp.of_invoice_key,
    },
    fechas: {
      of_fecha_de_facturacion: tp.of_fecha_de_facturacion,
      fecha_real_de_facturacion: tp.fecha_real_de_facturacion,
      fecha_resolucion_esperada: tp.fecha_resolucion_esperada,
      date_from_key: extractBillDateFromTicketKey(tp.of_ticket_key),
    },
    // FREEZE RULE: valores RAW del ticket, NO cálculos de backend
    montos: {
      cantidad_real: tp.cantidad_real,
      monto_unitario_real: tp.monto_unitario_real,     // info only
      total_real_a_facturar: tp.total_real_a_facturar, // HubSpot-CALCULATED
      descuento_en_porcentaje: tp.descuento_en_porcentaje,
      descuento_por_unidad_real: tp.descuento_por_unidad_real,
      of_iva: tp.of_iva,
    },
    resolved: { cantidadResolved, montoUnitarioResolved, descuentoPctResolved, descuentoUnitResolved, totalFinalResolved, hasIVAResolved },
    cupo: Object.fromEntries(Object.entries(tp).filter(([k]) => k.toLowerCase().includes('cupo'))),
    contexto: {
      of_moneda: tp.of_moneda,
      of_pais_operativo: tp.of_pais_operativo,
      of_frecuencia_de_facturacion: tp.of_frecuencia_de_facturacion,
      hubspot_owner_id: tp.hubspot_owner_id,
      of_aplica_para_cupo: tp.of_aplica_para_cupo,
      facturar_ahora: tp.facturar_ahora,
      repetitivo: tp.repetitivo,
    },
  }, '[invoice] Ticket props resueltas');

  // 1) Calcular invoiceKey estricta
  const dealId = safeString(tp.of_deal_id);
  const lineItemKey = safeString(tp.of_line_item_key);
  const lik = lineItemKey;
  const rawLineItemIds = safeString(tp.of_line_item_ids);
  const lineItemId = rawLineItemIds?.includes(',')
    ? rawLineItemIds.split(',')[0].trim()
    : rawLineItemIds;

  const fechaPlan =
    extractBillDateFromTicketKey(tp.of_ticket_key) ||
    toYMDInBillingTZ(tp.fecha_resolucion_esperada) ||
    null;

  const invoiceKeyStrict =
    (dealId && lik && fechaPlan)
      ? buildInvoiceKeyFromLIK(dealId, lik, fechaPlan)
      : null;

  const invoiceKey = invoiceKeyStrict || safeString(tp.of_ticket_key) || `ticket::${ticketId}`;

  logger.info({ module: 'invoiceService', fn: 'createInvoiceFromTicket', ticketId, invoiceKey, lik, fechaPlan }, '[invoice] invoiceKey calculado');

  // 2) Verificar idempotencia
  if (tp.of_invoice_id) {
    const ticketKey = safeString(tp.of_invoice_key);
    const expected = invoiceKey;

    if (ticketKey && ticketKey === expected) {
      if (lineItemId && fechaPlan) {
        try {
          await hubspotClient.crm.lineItems.basicApi.update(lineItemId, {
            properties: { last_billing_period: toHubSpotDateOnly(fechaPlan) },
          });
        } catch (err) {
          logger.warn({ module: 'invoiceService', fn: 'createInvoiceFromTicket', lineItemId, err }, '[invoice] No se pudo actualizar last_billing_period (idempotencia)');
          reportIfActionable({ objectType: 'line_item', objectId: lineItemId, message: `line_item_update_failed (idempotencia last_billing_period): ${err?.message || err}`, err });
        }
      }
      await syncBillingLastBilledDateFromTicket(ticketFull);
      if (lineItemId && lik) {
        await syncBillingState({ hubspotClient, dealId, lineItemId, lineItemKey: lik, dealIsCanceled: false });
        if (isAutoRenew({ properties: lineItem?.properties || lineItem })) {
          await ensure24FutureTickets({ hubspotClient, dealId, lineItemId, lineItem, lineItemKey: lik });
        }
      }
      logger.info({ module: 'invoiceService', fn: 'createInvoiceFromTicket', ticketId, invoiceId: tp.of_invoice_id }, '[invoice] Ticket ya tiene factura válida, saliendo (idempotente)');
      return { invoiceId: tp.of_invoice_id, created: false };
    }

    logger.warn({ module: 'invoiceService', fn: 'createInvoiceFromTicket', ticketId, of_invoice_id: tp.of_invoice_id, invoiceKeyExpected: expected, invoiceKeyActual: ticketKey }, '[invoice] of_invoice_id existe pero invoice_key inválida, ignorando (posible clon sucio)');
  }

  // 3) DRY RUN
  if (isDryRun()) {
    logger.info({ module: 'invoiceService', fn: 'createInvoiceFromTicket', ticketId }, '[invoice] DRY_RUN: no se crea factura');
    return { invoiceId: null, created: false };
  }

  // 4) Responsable
  const responsableAsignadoRaw = process.env.USER_BILLING || '83169424';
  const responsableAsignado = toNumericOwnerOrNull(responsableAsignadoRaw);

  // 5) Fechas
  const invoiceDateYMD = getTodayYMD();
  const baseDate = new Date(invoiceDateYMD + 'T12:00:00Z');
  baseDate.setUTCDate(baseDate.getUTCDate() + 10);
  const dueDateYMD = baseDate.toISOString().slice(0, 10);
  const invoiceDateMs = toHubSpotDateOnly(invoiceDateYMD);
  const dueDateMs = toHubSpotDateOnly(dueDateYMD);

  // 5.5) Alias de resolved vars
  const cantidad      = cantidadResolved;
  const montoUnitario = montoUnitarioResolved; // info only, NO multiply
  const descuentoPct  = descuentoPctResolved;
  const descuentoUnit = descuentoUnitResolved;
  const totalFinal    = totalFinalResolved;    // source of truth
  const hasIVA        = hasIVAResolved;

  // Derivar frecuencia de facturación desde repetitivo
  // true → 'Frecuente' | false → 'Único' | null/undefined → null
  const frecuenciaDerivada = tp.repetitivo === 'true' || tp.repetitivo === true
    ? 'Frecuente'
    : tp.repetitivo === 'false' || tp.repetitivo === false
      ? 'Único'
      : null;

  // 6) Propiedades de la factura — mapeo Ticket → Invoice
  const invoicePropsRaw = {
    hs_currency: tp.of_moneda || DEFAULT_CURRENCY,
    hs_invoice_date: invoiceDateMs,
    hs_due_date: dueDateMs,
    hs_invoice_billable: false,
    of_invoice_key: invoiceKey,
    ticket_id: String(ticketId),
    line_item_key: lik,
    nombre_producto: tp.of_producto_nombres,
    descripcion: tp.of_descripcion_producto || tp.descripcion,
    servicio: tp.of_rubro,
    // FREEZE RULE: montos RAW del ticket, NO cálculo de backend
    cantidad,
    monto_a_facturar: totalFinal,
    hs_amount_billed: totalFinal,
    descuento: descuentoPct,
    descuento_por_unidad: descuentoUnit,
    iva: hasIVA ? 'true' : 'false',
    exonera_irae: tp.of_exonera_irae,
    responsable_asignado: toNumericOwnerOrNull(tp.hubspot_owner_id || tp.responsable_asignado),
    vendedor_factura: tp.of_propietario_secundario,
    frecuencia_de_facturacion: tp.of_frecuencia_de_facturacion || (tp.repetitivo ? 'Mensual' : undefined),
    nombre_empresa: tp.of_cliente,
    pais_operativo: tp.of_pais_operativo,
    unidad_de_negocio: tp.unidad_de_negocio,
    fecha_de_facturacion: tp.of_fecha_de_facturacion,
    periodo_a_facturar: tp.fecha_resolucion_esperada,
    mensual: frecuenciaDerivada,                            // 'Frecuente' | 'Único' | null
    hs_comments: tp.content,                                // era: tp.comments
    motivo_de_pausa: tp.of_motivo_pausa,                    // era: tp.motivo_pausa
    id_factura_nodum: tp.numero_de_factura,                 // era: tp.id_factura_nodum
    etapa_de_la_factura: tp.of_invoice_status || 'Pendiente', // era: tp.etapa_factura
    modo_de_generacion_de_factura: modoGeneracion,
  };

  if (usuarioDisparador) invoicePropsRaw.usuario_disparador_de_factura = usuarioDisparador;
  const invoiceOwner = toNumericOwnerOrNull(process.env.INVOICE_OWNER_ID);
  if (invoiceOwner) invoicePropsRaw.hubspot_owner_id = invoiceOwner;

  // Validar propiedades contra schema
  const validatedProps = await buildValidatedUpdateProps('invoices', invoicePropsRaw, {
    logPrefix: '[createInvoiceFromTicket]'
  });

  if (Object.keys(validatedProps).length === 0) {
    logger.error({ module: 'invoiceService', fn: 'createInvoiceFromTicket', ticketId }, '[invoice] SKIP_EMPTY_UPDATE: No hay propiedades válidas para crear invoice');
    return { invoiceId: null, created: false };
  }

  logger.debug({
    module: 'invoiceService',
    fn: 'createInvoiceFromTicket',
    ticketId,
    invoiceKey: validatedProps.of_invoice_key,
    validatedProps,
  }, '[invoice] Props validadas — listas para crear invoice');

  try {
    // 7) Crear factura
    const createResp = await createInvoiceDirect(validatedProps);
    const invoiceId = createResp.id;

    logger.info({ module: 'invoiceService', fn: 'createInvoiceFromTicket', ticketId, invoiceId, invoiceKey }, '[invoice] ✅ Factura creada');

    // Re-leer invoice para confirmar props (solo visible con LOG_LEVEL=debug)
    try {
      const invoiceFull = await hubspotClient.crm.objects.basicApi.getById('invoices', invoiceId, [
        'of_invoice_key','ticket_id','hs_invoice_date','hs_due_date',
        'monto_a_facturar','cantidad','descuento','descuento_por_unidad',
        'iva','exonera_irae','hs_title','nombre_producto','descripcion',
        'servicio','etapa_de_la_factura','id_factura_nodum','hs_currency',
        'pais_operativo','frecuencia_de_facturacion','vendedor_factura',
        'responsable_asignado','hubspot_owner_id',
      ]);
      logger.debug({ module: 'invoiceService', fn: 'createInvoiceFromTicket', invoiceId, invoiceProps: invoiceFull?.properties }, '[invoice] Props confirmadas post-create');
    } catch (err) {
      logger.warn({ module: 'invoiceService', fn: 'createInvoiceFromTicket', invoiceId, err }, '[invoice] No se pudo re-leer invoice post-create');
    }

    // 8) Asociaciones
    // ⚠️ NO asociamos Invoice → Line Item para evitar que HubSpot borre los line items
    const assocCalls = [];

    if (tp.of_deal_id) {
      assocCalls.push(
        associateV4('invoices', invoiceId, 'deals', tp.of_deal_id)
          .catch(err => logger.warn({ module: 'invoiceService', invoiceId, dealId: tp.of_deal_id, err }, '[invoice] Error asociación invoice→deal'))
      );
    }

    assocCalls.push(
      associateV4('invoices', invoiceId, 'tickets', ticketId)
        .catch(err => logger.warn({ module: 'invoiceService', invoiceId, ticketId, err }, '[invoice] Error asociación invoice→ticket'))
    );

    if (tp.of_deal_id) {
      try {
        const contacts = await hubspotClient.crm.associations.v4.basicApi.getPage('deals', tp.of_deal_id, 'contacts', 10);
        const contactId = contacts.results?.[0]?.toObjectId || null;
        if (contactId) {
          assocCalls.push(
            associateV4('invoices', invoiceId, 'contacts', contactId)
              .catch(err => logger.warn({ module: 'invoiceService', invoiceId, contactId, err }, '[invoice] Error asociación invoice→contact'))
          );
        }
      } catch (err) {
        logger.warn({ module: 'invoiceService', fn: 'createInvoiceFromTicket', dealId: tp.of_deal_id, err }, '[invoice] No se pudo obtener contacto del deal');
      }
    }

    await Promise.all(assocCalls);

    // 9) Actualizar ticket con fecha real y referencia a factura
    try {
      await hubspotClient.crm.tickets.basicApi.update(ticketId, {
        properties: {
          of_invoice_id: invoiceId,
          of_invoice_key: invoiceKey,
          fecha_real_de_facturacion: invoiceDateYMD,
        },
      });
    } catch (err) {
      logger.error({ module: 'invoiceService', fn: 'createInvoiceFromTicket', ticketId, invoiceId, err }, '[invoice] ticket_update_failed: set invoice refs');
      reportIfActionable({ objectType: 'ticket', objectId: ticketId, message: `ticket_update_failed (set invoice refs): ${err?.message || err}`, err });
    }

    // 10) Actualizar line item con referencia a factura
    if (lineItemId) {
      try {
        await hubspotClient.crm.lineItems.basicApi.update(String(lineItemId), {
          properties: {
            ...(fechaPlan ? { last_billing_period: toHubSpotDateOnly(fechaPlan) } : {}),
            ...(invoiceId ? { invoice_id: String(invoiceId) } : {}),
            ...(invoiceKey ? { invoice_key: String(invoiceKey) } : {}),
          },
        });

        const rr = await recalcFacturasRestantes({ hubspotClient, lineItemId: String(lineItemId), dealId: String(tp.of_deal_id) });

        const liAfter = await hubspotClient.crm.lineItems.basicApi.getById(String(lineItemId), [
          'facturas_restantes','hs_recurring_billing_number_of_payments',
          'line_item_key','renovacion_automatica','recurringbillingfrequency',
          'hs_recurring_billing_frequency',
        ]);

        logger.debug({
          module: 'invoiceService',
          fn: 'createInvoiceFromTicket',
          lineItemId,
          invoiceId,
          recalcResult: rr,
          liAfterProps: liAfter?.properties,
        }, '[invoice] Line item actualizado con invoice refs y recalc');

      } catch (err) {
        logger.warn({ module: 'invoiceService', fn: 'createInvoiceFromTicket', lineItemId, invoiceId, err }, '[invoice] No se pudo actualizar line item con invoice refs');
        reportIfActionable({ objectType: 'line_item', objectId: lineItemId, message: `line_item_update_failed (set invoice refs + recalc): ${err?.message || err}`, err });
      }
    }

    // 11) Consumo de cupo (idempotente, no rompe facturación)
    try {
      const cupoLineItemId = rawLineItemIds?.includes(',')
        ? rawLineItemIds.split(',')[0].trim()
        : rawLineItemIds?.trim();

      if (!dealId) {
        logger.debug({ module: 'invoiceService', fn: 'createInvoiceFromTicket', ticketId }, '[invoice] ⊘ No se consume cupo: falta of_deal_id');
      } else if (!invoiceId) {
        logger.warn({ module: 'invoiceService', fn: 'createInvoiceFromTicket', ticketId }, '[invoice] ⚠️ No se consume cupo: invoiceId undefined');
      } else {
        if (rawLineItemIds?.includes(',')) {
          logger.warn({ module: 'invoiceService', fn: 'createInvoiceFromTicket', of_line_item_ids: rawLineItemIds, using: cupoLineItemId }, '[invoice] Ticket tiene múltiples lineItems, usando primero para cupo');
        }
        await consumeCupoAfterInvoice({ dealId, ticketId, lineItemId: cupoLineItemId, invoiceId });
      }
    } catch (err) {
      logger.error({ module: 'invoiceService', fn: 'createInvoiceFromTicket', ticketId, err }, '[invoice] Error en consumo de cupo (no interrumpe facturación)');
    }

    await syncBillingLastBilledDateFromTicket(ticketFull);

    logger.info({
      module: 'invoiceService',
      fn: 'createInvoiceFromTicket',
      ticketId,
      invoiceId,
      invoiceKey,
      modoGeneracion,
      responsable: invoicePropsRaw.responsable_asignado || tp.hubspot_owner_id || 'no asignado',
    }, '[invoice] ✅ FACTURA CREADA EXITOSAMENTE');

    return { invoiceId, created: true };

  } catch (err) {
    logger.error({
      module: 'invoiceService',
      fn: 'createInvoiceFromTicket',
      ticketId,
      err,
      status: err?.response?.status,
      responseData: err?.response?.data,
      url: err?.config?.url,
    }, '[invoice] ❌ ERROR CREANDO FACTURA DESDE TICKET');
    throw err;
  }
}

/**
 * Crea una factura automática desde un Line Item (LEGACY).
 * ⚠️ Usar createInvoiceFromTicket en su lugar cuando sea posible.
 *
 * @param {Object} deal
 * @param {Object} lineItem
 * @param {string} billingPeriodDate - YYYY-MM-DD (para invoiceKey)
 * @param {string|null} invoiceDate - YYYY-MM-DD (para hs_invoice_date; default: billingPeriodDate)
 */
export async function createAutoInvoiceFromLineItem(deal, lineItem, billingPeriodDate, invoiceDate = null) {
  const dealId = String(deal.id || deal.properties?.hs_object_id);
  const lineItemId = String(lineItem.id || lineItem.properties?.hs_object_id);

  // Hook: Centraliza estado billing
  if (dealId && lineItemId && lineItem.line_item_key) {
    await syncBillingState({ hubspotClient, dealId, lineItemId, lineItemKey: lineItem.line_item_key, dealIsCanceled: false });
    if (isAutoRenew({ properties: lineItem?.properties || lineItem })) {
      await ensure24FutureTickets({ hubspotClient, dealId, lineItemId, lineItem, lineItemKey: lineItem.line_item_key });
    }
  }

  const lp = lineItem.properties || {};
  const dp = deal.properties || {};
  const actualInvoiceDate = invoiceDate || billingPeriodDate;

  const lik = lineItem.line_item_key;
  const invoiceKey = buildInvoiceKeyFromLIK(dealId, lik, billingPeriodDate);

  logger.info({
    module: 'invoiceService',
    fn: 'createAutoInvoiceFromLineItem',
    dealId,
    lineItemId,
    billingPeriodDate,
    actualInvoiceDate,
    invoiceKey,
  }, '[invoice] Iniciando factura automática desde line item');

  // 2) Idempotencia
  if (lp.invoice_id) {
    if (safeString(lp.invoice_key) === invoiceKey) {
      logger.info({ module: 'invoiceService', fn: 'createAutoInvoiceFromLineItem', lineItemId, invoiceId: lp.invoice_id }, '[invoice] Line item ya tiene factura válida');
      return { invoiceId: lp.invoice_id, created: false };
    }
    logger.warn({ module: 'invoiceService', fn: 'createAutoInvoiceFromLineItem', lineItemId, invoice_id: lp.invoice_id, invoiceKeyExpected: invoiceKey, invoiceKeyActual: lp.invoice_key }, '[invoice] invoice_key mismatch, ignorando (posible clon sucio)');
  }

  // 3) DRY RUN
  if (isDryRun()) {
    logger.info({ module: 'invoiceService', fn: 'createAutoInvoiceFromLineItem', lineItemId }, '[invoice] DRY_RUN: no se crea factura');
    return { invoiceId: null, created: false };
  }

  // 4) Nombre
  const dealName = dp.dealname || 'Deal';
  let liShort = lp.name || null;
  if (!liShort) {
    liShort = `Line Item ${lineItemId}`;
    logger.warn({ module: 'invoiceService', fn: 'createAutoInvoiceFromLineItem', lineItemId }, '[invoice] Line item sin nombre, usando fallback');
  }
  const invoiceTitle = `${dealName} - ${liShort} - ${billingPeriodDate}`;

  // 5) Fechas
  const billDate = new Date(billingPeriodDate);
  billDate.setDate(billDate.getDate() + 10);
  const dueDateYMD = billDate.toISOString().split('T')[0];

  // 6) Propiedades
  const invoiceProps = {
    hs_title: invoiceTitle,
    hs_currency: dp.deal_currency_code || DEFAULT_CURRENCY,
    hs_invoice_date: toHubSpotDateOnly(actualInvoiceDate),
    hs_due_date: toHubSpotDateOnly(dueDateYMD),
    hs_invoice_billable: false,
    hs_external_recipient: process.env.INVOICE_RECIPIENT_ID || '85894063',
    of_invoice_key: invoiceKey,
    etapa_de_la_factura: 'Pendiente',
    ...(lp.name ? { nombre_producto: lp.name } : {}),
    ...(lp.description ? { descripcion: lp.description } : {}),
    ...(lp.servicio ? { servicio: lp.servicio } : {}),
    ...(dp.dealname ? { nombre_empresa: dp.dealname } : {}),
    ...(lp.unidad_de_negocio ? { unidad_de_negocio: lp.unidad_de_negocio } : {}),
  };

  if (process.env.INVOICE_OWNER_ID) invoiceProps.hubspot_owner_id = process.env.INVOICE_OWNER_ID;

  const validatedProps = await buildValidatedUpdateProps('invoices', invoiceProps, {
    logPrefix: '[createAutoInvoice]'
  });

  if (Object.keys(validatedProps).length === 0) {
    logger.error({ module: 'invoiceService', fn: 'createAutoInvoiceFromLineItem', lineItemId }, '[invoice] SKIP_EMPTY_UPDATE: No hay propiedades válidas');
    return { invoiceId: null, created: false };
  }

  logger.debug({
    module: 'invoiceService',
    fn: 'createAutoInvoiceFromLineItem',
    dealId,
    lineItemId,
    invoiceKey: validatedProps.of_invoice_key,
    validatedProps,
  }, '[invoice] Props validadas — listas para crear invoice automática');

  try {
    const createResp = await createInvoiceDirect(validatedProps);
    const invoiceId = createResp.id;

    logger.info({ module: 'invoiceService', fn: 'createAutoInvoiceFromLineItem', dealId, lineItemId, invoiceId, invoiceKey }, '[invoice] ✅ Factura automática creada');

    // 7) Asociaciones
    const assocCalls = [];
    assocCalls.push(
      associateV4('invoices', invoiceId, 'deals', dealId)
        .catch(err => logger.warn({ module: 'invoiceService', invoiceId, dealId, err }, '[invoice] Error asociación invoice→deal'))
    );

    try {
      const contacts = await hubspotClient.crm.associations.v4.basicApi.getPage('deals', dealId, 'contacts', 10);
      const contactId = contacts.results?.[0]?.toObjectId || null;
      if (contactId) {
        assocCalls.push(
          associateV4('invoices', invoiceId, 'contacts', contactId)
            .catch(err => logger.warn({ module: 'invoiceService', invoiceId, contactId, err }, '[invoice] Error asociación invoice→contact'))
        );
      }
    } catch (err) {
      logger.warn({ module: 'invoiceService', fn: 'createAutoInvoiceFromLineItem', dealId, err }, '[invoice] No se pudo obtener contacto del deal');
    }

    await Promise.all(assocCalls);

    // 8) Actualizar line item
    try {
      await hubspotClient.crm.lineItems.basicApi.update(lineItemId, {
        properties: { invoice_id: String(invoiceId), invoice_key: String(invoiceKey) },
      });
      await recalcFacturasRestantes({ hubspotClient, lineItemId, dealId });
      logger.info({ module: 'invoiceService', fn: 'createAutoInvoiceFromLineItem', lineItemId, invoiceId }, '[invoice] Line item actualizado con invoice refs');
    } catch (err) {
      logger.warn({ module: 'invoiceService', fn: 'createAutoInvoiceFromLineItem', lineItemId, invoiceId, err }, '[invoice] No se pudo actualizar line item con invoice refs');
      reportIfActionable({ objectType: 'line_item', objectId: lineItemId, message: `line_item_update_failed (auto invoice refs): ${err?.message || err}`, err });
    }

    return { invoiceId, created: true };

  } catch (err) {
    logger.error({
      module: 'invoiceService',
      fn: 'createAutoInvoiceFromLineItem',
      dealId,
      lineItemId,
      err,
      responseBody: err?.response?.body,
    }, '[invoice] ❌ Error creando factura automática');
    throw err;
  }
}

/**
 * Obtiene una factura por ID.
 */
export async function getInvoice(invoiceId) {
  try {
    const invoice = await hubspotClient.crm.objects.basicApi.getById(
      'invoices',
      invoiceId,
      ['etapa_de_la_factura','of_invoice_key',
       'fecha_de_emision','fecha_de_envio','fecha_de_pago','fecha_de_caneclacion',
       'id_factura_nodum','hs_invoice_date','hs_currency']
    );
    return invoice;
  } catch (err) {
    logger.error({ module: 'invoiceService', fn: 'getInvoice', invoiceId, err }, '[invoice] Error obteniendo factura');
    throw err;
  }
}

/*
 * ─────────────────────────────────────────────────────────────
 * CATCHES con reportHubSpotError agregados:
 *
 * En createInvoiceFromTicket():
 * 1. Idempotencia — lineItems.update last_billing_period
 *    → objectType: "line_item", objectId: lineItemId
 * 2. tickets.update post-create (set invoice refs + fecha real)
 *    → objectType: "ticket", objectId: ticketId
 * 3. lineItems.update post-create (set invoice refs + recalc)
 *    → objectType: "line_item", objectId: lineItemId
 *
 * En createAutoInvoiceFromLineItem():
 * 4. lineItems.update (auto invoice refs)
 *    → objectType: "line_item", objectId: lineItemId
 *
 * NO reportados:
 * - Asociaciones (invoice→deal, →ticket, →contact) → no son ticket/line_item
 * - consumeCupoAfterInvoice → complementario, solo logger.error
 * - syncBillingLastBilledDateFromTicket → interna, solo logger.warn
 * - createInvoiceDirect catch principal → re-throw, no objeto accionable
 * - getInvoice → lectura, no update accionable
 *
 * Logs eliminados (~100 console.log):
 * - showProp() × 2 bloques completos (~50 líneas) → logger.debug objeto único
 * - [DEBUG][CUPO] Keys individuales × 10 → en logger.debug cupo object
 * - [DBG][INVOICE] RAW values × 15 líneas → en logger.debug montos/resolved
 * - Banners ASCII (╔═══╗, ====×80) → logger.info/debug estructurado
 * - Props validadas JSON.stringify → en logger.debug validatedProps
 * - Post-create invoice showProp() block → logger.debug invoiceProps
 * - console.log paso a paso asociaciones → errores en .catch()
 * - [FR][after-li-update], [FR][after-recalc], [FR][li-after]
 *   → colapsados en un único logger.debug con recalcResult + liAfterProps
 * - Cupo multi-línea → logger.debug/warn consolidado
 * - Éxito final multi-línea → logger.info con objeto
 * - DBG_TICKET_KEY / DBG_TICKET_FULL guards → logger.debug (LOG_LEVEL=debug)
 *
 * Confirmación: "No se reportan warns a HubSpot;
 *                solo errores 4xx (≠429)" — implementado en reportIfActionable().
 *
 * MAPEO CORREGIDO (ticket → factura):
 * - tp.content        → hs_comments          (era: tp.comments — no existe)
 * - tp.of_motivo_pausa → motivo_de_pausa     (era: tp.motivo_pausa — faltaba prefijo of_)
 * - tp.numero_de_factura → id_factura_nodum  (era: tp.id_factura_nodum — nombre incorrecto)
 * - tp.of_invoice_status → etapa_de_la_factura (era: tp.etapa_factura — no existe)
 * - frecuenciaDerivada → mensual             (era: tp.of_periodo_de_facturacion — no existe;
 *                                             derivado de tp.repetitivo: true→'Frecuente', false→'Único')
 * - periodo_a_facturar → undefined (TODO: pendiente definir formato con el equipo)
 * ─────────────────────────────────────────────────────────────
 */