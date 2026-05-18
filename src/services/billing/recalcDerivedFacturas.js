// src/services/billing/recalcDerivedFacturas.js

/**
 * Recalcula `facturas_por_derivar` para un line item de plan fijo.
 *
 * facturas_por_derivar = total_payments - tickets en DERIVED_STAGES por LIK
 *
 * DERIVED_STAGES = READY + INVOICED_STAGES (excluye forecast y "Próximos a Facturar")
 *
 * Writer único de `facturas_por_derivar`.
 * Llamado desde: createInvoiceFromTicket (invoiceService.js)
 */

import { isAutoRenew } from './mode.js';
import logger from '../../../lib/logger.js';
import { reportIfActionable } from '../../utils/errorReporting.js';
import { DERIVED_STAGES } from '../../config/constants.js';
import { alertDerivacionCompleta } from '../notifications/dealAlerts.js';

const MOD = 'recalcDerivedFacturas';

export async function recalcDerivedFacturas({ hubspotClient, lineItemId, dealId }) {
  const id = String(lineItemId);

  const { properties } = await hubspotClient.crm.lineItems.basicApi.getById(
    id,
    [
      'renovacion_automatica',
      'recurringbillingfrequency',
      'hs_recurring_billing_frequency',
      'hs_recurring_billing_number_of_payments',
      'facturas_por_derivar',
      'line_item_key',
    ],
    undefined,
    undefined,
    false
  );

  logger.debug(
    {
      module: MOD,
      fn: 'recalcDerivedFacturas',
      lineItemId: id,
      renovacion_automatica: properties?.renovacion_automatica,
      hs_recurring_billing_number_of_payments: properties?.hs_recurring_billing_number_of_payments,
      facturas_por_derivar: properties?.facturas_por_derivar,
      line_item_key: properties?.line_item_key,
    },
    'Props de line item leídas'
  );

  // AUTO RENEW => no aplica facturas_por_derivar (limpia si existe)
  if (isAutoRenew({ properties })) {
    const current = String(properties?.facturas_por_derivar ?? '').trim();

    if (current !== '') {
      try {
        await hubspotClient.crm.lineItems.basicApi.update(id, {
          properties: { facturas_por_derivar: '' },
        });
        logger.info(
          { module: MOD, fn: 'recalcDerivedFacturas', lineItemId: id, mode: 'AUTO_RENEW', from: current },
          'AUTO_RENEW: facturas_por_derivar limpiado'
        );
      } catch (err) {
        reportIfActionable({ objectType: 'line_item', objectId: id, message: 'Error al limpiar facturas_por_derivar en AUTO_RENEW', err });
        throw err;
      }
    } else {
      logger.debug(
        { module: MOD, fn: 'recalcDerivedFacturas', lineItemId: id, mode: 'AUTO_RENEW' },
        'AUTO_RENEW: facturas_por_derivar ya vacío, noop'
      );
    }

    return { mode: 'AUTO_RENEW', facturas_por_derivar: null };
  }

  // PLAN FIJO => necesita total payments
  const totalRaw = properties?.hs_recurring_billing_number_of_payments;
  const cuotasTotales = Number.parseInt(String(totalRaw ?? ''), 10);

  if (!Number.isFinite(cuotasTotales) || cuotasTotales <= 0) {
    const current = String(properties?.facturas_por_derivar ?? '').trim();

    logger.info(
      { module: MOD, fn: 'recalcDerivedFacturas', lineItemId: id, reason: 'no_total_payments', totalRaw, cuotasTotales },
      'PLAN_FIJO: sin total payments, saltando'
    );

    if (current !== '') {
      try {
        await hubspotClient.crm.lineItems.basicApi.update(id, {
          properties: { facturas_por_derivar: '' },
        });
        logger.info(
          { module: MOD, fn: 'recalcDerivedFacturas', lineItemId: id, from: current },
          'PLAN_FIJO: facturas_por_derivar limpiado por no_total_payments'
        );
      } catch (err) {
        reportIfActionable({ objectType: 'line_item', objectId: id, message: 'Error al limpiar facturas_por_derivar por no_total_payments', err });
        throw err;
      }
    }

    return {
      mode: 'PLAN_FIJO',
      facturas_por_derivar: null,
      reason: 'no_total_payments',
    };
  }

  // PLAN FIJO => necesita LIK
  const lik = String(properties?.line_item_key ?? '').trim();
  if (!lik) {
    logger.info(
      { module: MOD, fn: 'recalcDerivedFacturas', lineItemId: id, reason: 'missing_line_item_key' },
      'PLAN_FIJO: line_item_key vacío, saltando'
    );

    return {
      mode: 'PLAN_FIJO',
      facturas_por_derivar: null,
      reason: 'missing_line_item_key',
    };
  }

  const countDerived = await countDerivedTicketsByLIK({ hubspotClient, lik });
  const porDerivar = Math.max(0, cuotasTotales - countDerived);
  const currentRaw = String(properties?.facturas_por_derivar ?? '').trim();
  const nextRaw = String(porDerivar);

  logger.debug(
    { module: MOD, fn: 'recalcDerivedFacturas', lineItemId: id, lik, cuotasTotales, countDerived, porDerivar, currentRaw, nextRaw },
    'Cómputo de facturas_por_derivar'
  );

  if (currentRaw !== nextRaw) {
    try {
      await hubspotClient.crm.lineItems.basicApi.update(id, {
        properties: { facturas_por_derivar: nextRaw },
      });

      logger.info(
        { module: MOD, fn: 'recalcDerivedFacturas', lineItemId: id, from: currentRaw, to: nextRaw },
        'facturas_por_derivar actualizado'
      );
    } catch (err) {
      reportIfActionable({ objectType: 'line_item', objectId: id, message: 'Error al actualizar facturas_por_derivar', err });
      throw err;
    }
  } else {
    logger.debug(
      { module: MOD, fn: 'recalcDerivedFacturas', lineItemId: id, facturas_por_derivar: currentRaw },
      'facturas_por_derivar sin cambio, noop'
    );

    // ── Alerta: facturas_por_derivar llegó a 0 ──
    if (porDerivar === 0) {
      alertDerivacionCompleta({ dealId, lineItemId: id, lineItemName: null, lik })
        .catch(err => logger.warn({ module: MOD, lineItemId: id, err: err?.message },
          'alertDerivacionCompleta falló (no bloquea)'));
    }

    // NOTA: fire-and-forget. Se evalúa porDerivar (ya calculado), no el valor de la prop.
    // Así cubre tanto el caso "cambió a 0" como "ya era 0 y se reconfirmó".

  }

  return {
    mode: 'PLAN_FIJO',
    facturas_por_derivar: porDerivar,
    countDerived,
    cuotasTotales,
    lik,
  };
}

/**
 * Cuenta tickets asociados a un LIK que están en DERIVED_STAGES.
 * (READY + INVOICED_STAGES, ambos pipelines)
 */
async function countDerivedTicketsByLIK({ hubspotClient, lik }) {
  const resp = await hubspotClient.crm.tickets.searchApi.doSearch({
    filterGroups: [{
      filters: [{ propertyName: 'of_line_item_key', operator: 'EQ', value: lik }],
    }],
    properties: ['hs_pipeline_stage'],
    limit: 100,
  });

  const tickets = resp?.results ?? [];
  const count = tickets.filter(t =>
    DERIVED_STAGES.has(String(t.properties?.hs_pipeline_stage))
  ).length;

  logger.debug(
    { module: MOD, fn: 'countDerivedTicketsByLIK', lik, total: tickets.length, matched: count },
    'Tickets en DERIVED_STAGES'
  );

  return count;
}