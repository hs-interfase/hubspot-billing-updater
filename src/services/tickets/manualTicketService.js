// src/services/tickets/manualTicketService.js

import { hubspotClient } from '../../hubspotClient.js';
import { TICKET_PIPELINE, TICKET_STAGES } from '../../config/constants.js';
import { createTicketSnapshots } from '../snapshotService.js';
import { getTodayYMD, toHubSpotDate } from '../../utils/dateUtils.js';
import { parseBool } from '../../utils/parsers.js';
import { applyCupoPreventiveAlertFromTicket } from '../alerts/cupoAlert.js';
import logger from '../../../lib/logger.js';

import {
  ensureTicketCanonical,
  getTicketStage,
  getDealCompanies,
  getDealContacts,
  createTicketAssociations,
} from './ticketService.js';

/**
 * Limpia propiedades vacías del payload de tickets manuales.
 * Regla: eliminar si v === null || v === undefined || v === ''
 */
function cleanTicketProps(props) {
  const removed = [];

  for (const k of Object.keys(props)) {
    const v = props[k];
    if (v === null || v === undefined) {
      removed.push({ key: k, reason: 'nullish' });
      delete props[k];
    } else if (v === '') {
      removed.push({ key: k, reason: 'empty_string' });
      delete props[k];
    }
  }

  return removed;
}

/**
 * Valida que el payload de ticket incluya las propiedades mínimas requeridas.
 */
function assertTicketMinimum(props) {
  const required = ['of_ticket_key', 'of_deal_id', 'of_line_item_ids', 'of_producto_nombres'];
  const missing = required.filter(k => !(k in props));

  if (missing.length) {
    logger.warn(
      { module: 'manualTicketService', fn: 'assertTicketMinimum', missingProps: missing },
      'Ticket payload con props requeridas faltantes'
    );
  }

  return missing;
}

/**
 * Crea un ticket de orden de facturación manual.
 *
 * Reglas de fechas:
 * - expectedDate = billingDate (siempre)
 * - orderedDate = HOY solo si lineItem.facturar_ahora == true
 * - orderedDate = null en manual normal
 *
 * Con deduplicación: marca tickets clonados por UI como DUPLICADO_UI.
 */
export async function createManualBillingTicket(deal, lineItem, billingDate) {
  const dealId = String(deal?.id || deal?.properties?.hs_object_id);
  const lineItemId = String(lineItem?.id || lineItem?.properties?.hs_object_id);

  const dp = deal?.properties || {};
  const lp = lineItem?.properties || {};

  logger.debug(
    { module: 'manualTicketService', fn: 'createManualBillingTicket', dealId, lineItemId, billingDate },
    'Inicio createManualBillingTicket'
  );

  const lineItemKey = (lp.line_item_key || '').toString().trim();

  if (!lineItemKey) {
    throw new Error(`[ticketService][MANUAL] line_item_key vacío para lineItemId=${lineItemId} (Phase1 debería setearlo)`);
  }

  const result = await ensureTicketCanonical({
    dealId,
    lineItemKey,
    billDateYMD: billingDate,
    lineItemId,
    buildTicketPayload: async ({ dealId, lineItemKey, billDateYMD, expectedKey }) => {

      const expectedDate = billDateYMD;
      const lineProps = lineItem?.properties || {};
      const facturarAhora = parseBool(lineProps.facturar_ahora);
      const orderedDate = facturarAhora ? getTodayYMD() : null;

      logger.debug(
        { module: 'manualTicketService', fn: 'buildTicketPayload', dealId, lineItemId, expectedDate, orderedDate, facturarAhora },
        'Fechas del ticket manual'
      );

      const snapshots = createTicketSnapshots(deal, lineItem, expectedDate, orderedDate);

      const ivaValue = String(snapshots.of_iva ?? 'false') === 'true' ? 'true' : 'false';
      const ivaBoolean = ivaValue === 'true';

      const servicioRaw = lineProps.servicio || null;
      const servicioNormalized = servicioRaw ? String(servicioRaw).trim() : null;
      const ofRubroFinal = snapshots.of_rubro || null;

      const dealName = dp.dealname || 'Deal';
      const productName = lineProps.name || 'Producto';
      const rubro = snapshots.of_rubro || null;

      const stage = TICKET_STAGES.NEW;

      let avisosSistema = snapshots.of_billing_error || '';
      if (facturarAhora) {
        const notaUrgente = '⚠️ URGENTE: Vendedor solicitó facturar ahora.';
        avisosSistema = avisosSistema ? `${notaUrgente}\n\n${avisosSistema}` : notaUrgente;
      }

      const vendedorId = dp.hubspot_owner_id ? String(dp.hubspot_owner_id) : null;
      const responsable = lineProps.responsable_asignado ? String(lineProps.responsable_asignado) : null;

      const liName = lineProps.name || null;
      const liDescripcion = lineProps.description || null;
      const liNota = lineProps.nota || null;

      const montoUnitarioReal = lineProps.price ?? null;
      const cantidadReal = lineProps.quantity ?? null;
      const descuentoPctReal = lineProps.hs_discount_percentage ?? null;
      const descuentoUnitReal = lineProps.discount ?? null;

      const paisOperativo = dp.of_pais_operativo ?? dp.pais_operativo ?? null;
      const aplicaCupoRaw = dp.of_aplica_para_cupo ?? null;

      const CUPO_VALID_OPTIONS = ['Por Horas', 'Por Monto'];
      const aplicaCupoNormalized = aplicaCupoRaw ? String(aplicaCupoRaw).trim() : null;
      const aplicaCupo = aplicaCupoNormalized && CUPO_VALID_OPTIONS.includes(aplicaCupoNormalized)
        ? aplicaCupoNormalized
        : null;

      if (aplicaCupoRaw && !aplicaCupo) {
        logger.warn(
          { module: 'manualTicketService', fn: 'buildTicketPayload', dealId, lineItemId, aplicaCupoRaw },
          'Valor inválido para of_aplica_para_cupo, se omitirá'
        );
      }

      const rubroCandidate = servicioNormalized || snapshots.of_rubro || null;

      logger.debug(
        {
          module: 'manualTicketService',
          fn: 'buildTicketPayload',
          dealId,
          lineItemId,
          expectedKey,
          ivaValue,
          ivaBoolean,
          ofRubroFinal,
          servicioRaw,
          montoUnitarioReal,
          cantidadReal,
          facturarAhora,
          aplicaCupo: aplicaCupo ?? '(omitido)',
          total_real_a_facturar: snapshots.total_real_a_facturar,
          vendedorId,
          responsable,
        },
        'Valores fuente para payload de ticket manual'
      );

      const ticketProps = {
        subject: `${dealName} | ${productName} | ${rubro} | ${billDateYMD}`,
        hs_pipeline: TICKET_PIPELINE,
        hs_pipeline_stage: stage,
        of_deal_id: dealId,
        of_line_item_ids: lineItemId,
        of_ticket_key: expectedKey,
        of_line_item_key: lineItemKey,
        ...snapshots,
        fecha_resolucion_esperada: toHubSpotDate(billDateYMD),
        of_fecha_de_facturacion: toHubSpotDate(billDateYMD),
        of_producto_nombres: liName,
        of_descripcion_producto: liDescripcion || null,
        nota: liNota,
        of_pais_operativo: paisOperativo,
        of_aplica_para_cupo: aplicaCupo,
        monto_unitario_real: montoUnitarioReal,
        cantidad_real: cantidadReal,
        descuento_en_porcentaje: (typeof descuentoPctReal === 'number' && isFinite(descuentoPctReal))
          ? String(descuentoPctReal / 100)
          : (descuentoPctReal == null || descuentoPctReal === '')
            ? null
            : String(Number(descuentoPctReal) / 100),
        descuento_unit_real: descuentoUnitReal,
        of_iva: ivaValue,
        ...(vendedorId ? { of_propietario_secundario: vendedorId } : {}),
        ...(responsable ? { hubspot_owner_id: responsable } : {}),
      };

      if (rubroCandidate) {
        ticketProps.of_rubro = rubroCandidate;
      }

      const removed = cleanTicketProps(ticketProps);

      logger.debug(
        { module: 'manualTicketService', fn: 'buildTicketPayload', dealId, lineItemId, expectedKey, removedCount: removed.length, payloadKeys: Object.keys(ticketProps).sort() },
        'Payload de ticket manual listo'
      );

      const missing = assertTicketMinimum(ticketProps);
      if (process.env.STRICT_TICKET_CREATE === 'true' && missing.length > 0) {
        throw new Error(
          `Refusing to create manual ticket, missing required props: ${missing.join(', ')}`
        );
      }

      return { properties: ticketProps };
    },
  });

  const { ticketId, created, ticketKey, duplicatesMarked } = result;

  if (created && ticketId) {
    try {
      const [companyIds, contactIds] = await Promise.all([getDealCompanies(dealId), getDealContacts(dealId)]);
      await createTicketAssociations(ticketId, dealId, lineItemId, companyIds, contactIds);

      try {
        const createdTicket = await hubspotClient.crm.tickets.basicApi.getById(String(ticketId), [
          'of_monto_total',
          'total_real_a_facturar',
          'of_fecha_de_facturacion',
          'of_ticket_key',
          'of_deal_id',
          'of_line_item_ids',
        ]);
        await applyCupoPreventiveAlertFromTicket({ deal, ticket: createdTicket, lineItem });
      } catch (err) {
        logger.warn(
          { module: 'manualTicketService', fn: 'createManualBillingTicket', ticketId, err },
          'Error en alerta preventiva de cupo'
        );
      }

      const facturarAhoraPost = parseBool(lp.facturar_ahora);
      const stage = TICKET_STAGES.NEW;

      logger.info(
        {
          module: 'manualTicketService',
          fn: 'createManualBillingTicket',
          dealId,
          lineItemId,
          ticketId,
          ticketKey,
          duplicatesMarked,
          urgent: facturarAhoraPost,
          responsable: lp.responsable_asignado || null,
          vendedor: dp.hubspot_owner_id || null,
        },
        'Ticket manual creado'
      );
    } catch (err) {
      logger.error(
        { module: 'manualTicketService', fn: 'createManualBillingTicket', dealId, lineItemId, ticketId, err },
        'Error en post-creación de ticket manual'
      );
      throw err;
    }
  } else {
    logger.info(
      { module: 'manualTicketService', fn: 'createManualBillingTicket', dealId, lineItemId, ticketId, ticketKey, duplicatesMarked },
      'Ticket manual existente reutilizado'
    );
  }

  return { ticketId, created, duplicatesMarked };
}

/*
 * CATCHES con reportHubSpotError agregados: ninguno
 * NO reportados:
 *   - ensureTicketCanonical → delegado a ticketService.js que gestiona su propio reporte
 *   - tickets.basicApi.getById → lectura
 *   - applyCupoPreventiveAlertFromTicket → delegado, no es update ticket/line_item directo
 *   - getDealCompanies / getDealContacts → lecturas
 *   - createTicketAssociations → asociaciones excluidas (Regla 4)
 * Confirmación: "No se reportan warns a HubSpot; solo errores 4xx (≠429)"
 */