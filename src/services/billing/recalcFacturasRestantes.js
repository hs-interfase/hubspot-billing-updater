// src/services/billing/recalcFacturasRestantes.js

import { isAutoRenew } from './mode.js';
import logger from '../../../lib/logger.js';
import { reportIfActionable } from '../../utils/errorReporting.js';

const INVOICE_LIK_PROP = 'line_item_key';

export async function recalcFacturasRestantes({ hubspotClient, lineItemId, dealId }) {
  const id = String(lineItemId);

  const { properties } = await hubspotClient.crm.lineItems.basicApi.getById(
    id,
    [
      'renovacion_automatica',
      'recurringbillingfrequency',
      'hs_recurring_billing_frequency',
      'hs_recurring_billing_number_of_payments',
      'facturas_restantes',
      'line_item_key',
    ],
    undefined,
    undefined,
    false
  );

  logger.debug(
    {
      module: 'recalcFacturasRestantes',
      fn: 'recalcFacturasRestantes',
      lineItemId: id,
      renovacion_automatica: properties?.renovacion_automatica,
      recurringbillingfrequency: properties?.recurringbillingfrequency,
      hs_recurring_billing_frequency: properties?.hs_recurring_billing_frequency,
      hs_recurring_billing_number_of_payments: properties?.hs_recurring_billing_number_of_payments,
      facturas_restantes: properties?.facturas_restantes,
      line_item_key: properties?.line_item_key,
    },
    'Props de line item leídas'
  );

  // AUTO RENEW => no aplica facturas_restantes (limpia si existe)
  if (isAutoRenew({ properties })) {
    const current = String(properties?.facturas_restantes ?? '').trim();

    if (current !== '') {
      try {
        await hubspotClient.crm.lineItems.basicApi.update(id, {
          properties: { facturas_restantes: '' },
        });
        logger.info(
          { module: 'recalcFacturasRestantes', fn: 'recalcFacturasRestantes', lineItemId: id, mode: 'AUTO_RENEW', from: current },
          'AUTO_RENEW: facturas_restantes limpiado'
        );
      } catch (err) {
        reportIfActionable({ objectType: 'line_item', objectId: id, message: 'Error al limpiar facturas_restantes en AUTO_RENEW', err });
        throw err;
      }
    } else {
      logger.debug(
        { module: 'recalcFacturasRestantes', fn: 'recalcFacturasRestantes', lineItemId: id, mode: 'AUTO_RENEW' },
        'AUTO_RENEW: facturas_restantes ya vacío, noop'
      );
    }

    return { mode: 'AUTO_RENEW', facturas_restantes: null };
  }

  // PLAN FIJO => necesita total payments
  const totalRaw = properties?.hs_recurring_billing_number_of_payments;
  const cuotasTotales = Number.parseInt(String(totalRaw ?? ''), 10);

  if (!Number.isFinite(cuotasTotales) || cuotasTotales <= 0) {
    const current = String(properties?.facturas_restantes ?? '').trim();

    logger.info(
      { module: 'recalcFacturasRestantes', fn: 'recalcFacturasRestantes', lineItemId: id, reason: 'no_total_payments', totalRaw, cuotasTotales },
      'PLAN_FIJO: sin total payments, saltando'
    );

    if (current !== '') {
      try {
        await hubspotClient.crm.lineItems.basicApi.update(id, {
          properties: { facturas_restantes: '' },
        });
        logger.info(
          { module: 'recalcFacturasRestantes', fn: 'recalcFacturasRestantes', lineItemId: id, from: current },
          'PLAN_FIJO: facturas_restantes limpiado por no_total_payments'
        );
      } catch (err) {
        reportIfActionable({ objectType: 'line_item', objectId: id, message: 'Error al limpiar facturas_restantes por no_total_payments', err });
        throw err;
      }
    }

    return {
      mode: 'PLAN_FIJO',
      facturas_restantes: null,
      reason: 'no_total_payments',
    };
  }

  // PLAN FIJO => necesita LIK
  const lik = String(properties?.line_item_key ?? '').trim();
  if (!lik) {
    logger.info(
      { module: 'recalcFacturasRestantes', fn: 'recalcFacturasRestantes', lineItemId: id, reason: 'missing_line_item_key' },
      'PLAN_FIJO: line_item_key vacío, saltando'
    );

    return {
      mode: 'PLAN_FIJO',
      facturas_restantes: null,
      reason: 'missing_line_item_key',
    };
  }

  const countTickets = await countTicketsByLIK({ hubspotClient, lik });

  const restantes = Math.max(0, cuotasTotales - countTickets);
  const currentRaw = String(properties?.facturas_restantes ?? '').trim();
  const nextRaw = String(restantes);

  logger.debug(
    { module: 'recalcFacturasRestantes', fn: 'recalcFacturasRestantes', lineItemId: id, lik, cuotasTotales, countTickets, restantes, currentRaw, nextRaw },
    'Cómputo de facturas_restantes'
  );

  if (currentRaw !== nextRaw) {
    try {
      await hubspotClient.crm.lineItems.basicApi.update(id, {
        properties: { facturas_restantes: nextRaw },
      });

      // Confirmación (releer)
      const liAfter = await hubspotClient.crm.lineItems.basicApi.getById(id, ['facturas_restantes']);
      logger.info(
        { module: 'recalcFacturasRestantes', fn: 'recalcFacturasRestantes', lineItemId: id, from: currentRaw, to: nextRaw, confirmed: liAfter?.properties?.facturas_restantes },
        'facturas_restantes actualizado'
      );
    } catch (err) {
      reportIfActionable({ objectType: 'line_item', objectId: id, message: 'Error al actualizar facturas_restantes', err });
      throw err;
    }
  } else {
    logger.debug(
      { module: 'recalcFacturasRestantes', fn: 'recalcFacturasRestantes', lineItemId: id, facturas_restantes: currentRaw },
      'facturas_restantes sin cambio, noop'
    );
  }

  return {
    mode: 'PLAN_FIJO',
    facturas_restantes: restantes,
    countTickets,
    cuotasTotales,
    lik,
  };
}

/**
 * Cuenta tickets asociados a un LIK que están en etapa de factura real emitida.
 * Cubre ambos pipelines (manual y automático).
 */
async function countTicketsByLIK({ hubspotClient, lik }) {
  const resp = await hubspotClient.crm.tickets.searchApi.doSearch({
    filterGroups: [{
      filters: [{ propertyName: 'of_line_item_key', operator: 'EQ', value: lik }],
    }],
    properties: ['hs_pipeline_stage'],
    limit: 100,
  });

  const tickets = resp?.results ?? [];
  const count = tickets.filter(t =>
    INVOICED_TICKET_STAGES.has(String(t.properties?.hs_pipeline_stage))
  ).length;

  logger.debug(
    { module: 'recalcFacturasRestantes', fn: 'countTicketsByLIK', lik, total: tickets.length, matched: count },
    'Tickets en etapa de factura real'
  );

  return count;
}

/*
 * CATCHES con reportHubSpotError agregados:
 *   - lineItems.basicApi.update() AUTO_RENEW clear → objectType="line_item", con re-throw
 *   - lineItems.basicApi.update() no_total_payments clear → objectType="line_item", con re-throw
 *   - lineItems.basicApi.update() write facturas_restantes → objectType="line_item", con re-throw
 *
 * NO reportados:
 *   - lineItems.basicApi.getById → lectura
 *   - tickets.searchApi.doSearch → lectura
 *
 * Confirmación: "No se reportan warns a HubSpot; solo errores 4xx (≠429)"
 */