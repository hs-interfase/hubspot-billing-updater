// src/services/billing/recalcFacturasRestantes.js

import { isAutoRenew } from './mode.js';
import logger from '../../../lib/logger.js';
import { reportHubSpotError } from '../../utils/hubspotErrorCollector.js';

const INVOICE_LIK_PROP = 'line_item_key';

function reportIfActionable({ objectType, objectId, message, err }) {
  const status = err?.response?.status ?? err?.statusCode ?? null;
  if (status === null) { reportHubSpotError({ objectType, objectId, message }); return; }
  if (status === 429 || status >= 500) return;
  if (status >= 400 && status < 500) reportHubSpotError({ objectType, objectId, message });
}

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

  const countInvoices = await countInvoicesByLIK({ hubspotClient, lik, dealId });

  const restantes = Math.max(0, cuotasTotales - countInvoices);
  const currentRaw = String(properties?.facturas_restantes ?? '').trim();
  const nextRaw = String(restantes);

  logger.debug(
    { module: 'recalcFacturasRestantes', fn: 'recalcFacturasRestantes', lineItemId: id, lik, cuotasTotales, countInvoices, restantes, currentRaw, nextRaw },
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
    countInvoices,
    cuotasTotales,
    lik,
    invoiceLikProp: INVOICE_LIK_PROP,
  };
}

async function countInvoicesByLIK({ hubspotClient, lik, dealId }) {
  const v4 = hubspotClient?.crm?.associations?.v4?.basicApi;

  if (!v4?.getPage) {
    throw new Error('countInvoicesByLIK: Associations v4 API no disponible');
  }

  if (!dealId) {
    throw new Error('countInvoicesByLIK requiere dealId');
  }

  let after = undefined;
  let invoiceIds = [];
  let page = 0;

  // 1) Traer todas las invoices asociadas al DEAL
  while (true) {
    page += 1;

    const res = await v4.getPage(
      'deals',
      String(dealId),
      'invoices',
      100,
      after
    );

    const results = res?.results ?? [];
    invoiceIds.push(...results.map(r => r.toObjectId));

    const nextAfter = res?.paging?.next?.after;
    if (!nextAfter) break;
    after = nextAfter;
  }

  if (invoiceIds.length === 0) {
    logger.debug(
      { module: 'recalcFacturasRestantes', fn: 'countInvoicesByLIK', dealId, total: 0 },
      'Sin invoices asociadas al deal'
    );
    return 0;
  }

  // 2) Leer invoices y filtrar por LIK
  let count = 0;

  for (const invoiceId of invoiceIds) {
    const inv = await hubspotClient.crm.objects.basicApi.getById(
      'invoices',
      invoiceId,
      ['of_invoice_key', 'etapa_de_la_factura']
    );

    const invoiceKey = inv?.properties?.of_invoice_key || '';

    if (invoiceKey.includes(lik)) {
      count++;
    }
  }

  logger.debug(
    { module: 'recalcFacturasRestantes', fn: 'countInvoicesByLIK', dealId, lik, matched: count, totalInvoicesOnDeal: invoiceIds.length },
    'Invoices filtradas por LIK'
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
 *   - objects.basicApi.getById (invoices) → lectura
 *   - associations.v4.basicApi.getPage → lectura/asociaciones excluidas
 *
 * Confirmación: "No se reportan warns a HubSpot; solo errores 4xx (≠429)"
 */