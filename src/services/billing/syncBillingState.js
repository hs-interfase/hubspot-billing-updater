// src/services/billing/syncBillingState.js

import { isAutoRenew } from './mode.js';
import { recalcFacturasRestantes } from './recalcFacturasRestantes.js';
import { resolveNextBillingDate } from '../../utils/resolveNextBillingDate.js';
import { getEffectiveBillingConfig } from '../../billingEngine.js';
import { formatDateISO, addInterval } from '../../utils/dateUtils.js';
import logger from '../../../lib/logger.js';

// ─── Helper ──────────────────────────────────────────────────────────────────

/**
 * Genera la cadena de display de progreso de pagos.
 * Ejemplos:
 *   buildPagoDisplay(3, 12)  → "███░░░░░░░ 3 / 12"
 *   buildPagoDisplay(12, 12) → "██████████ 12 / 12"
 *   buildPagoDisplay(0, 0)   → ""   (auto-renew / sin total)
 *
 * @param {number} countInvoices  Facturas emitidas hasta ahora
 * @param {number} cuotasTotales  Total de pagos del plan
 * @returns {string}
 */
export function buildPagoDisplay(countInvoices, cuotasTotales) {
  if (!cuotasTotales || cuotasTotales <= 0) return '';

  const emitidas = Math.min(countInvoices ?? 0, cuotasTotales);
  const filled   = Math.round((emitidas / cuotasTotales) * 10);
  const empty    = 10 - filled;
  const bar      = '█'.repeat(filled) + '░'.repeat(empty);

  return `${bar} ${emitidas} / ${cuotasTotales}`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

/**
 * Centraliza la actualización de billing_next_date, facturas_restantes
 * y progreso_pagos (display informativo).
 *
 * @param {object}  opts
 * @param {object}  opts.hubspotClient
 * @param {string}  [opts.lineItemId]
 * @param {object}  [opts.lineItem]
 * @param {string}  [opts.dealId]
 * @param {boolean} [opts.dealIsCanceled]
 */
export async function syncBillingState({ hubspotClient, lineItemId, lineItem, dealId, dealIsCanceled }) {
  const log = logger.child({ module: 'syncBillingState', dealId, lineItemId });

  // 1. Obtener lineItemId y leer line item si no viene
  let li = lineItem;
  if (!li) {
    if (!lineItemId) throw new Error('syncBillingState requiere lineItemId o lineItem');
    const props = [
      'billing_next_date',
      'facturas_restantes',
      'progreso_pagos',                           // ← nuevo: leer para diff
      'renovacion_automatica',
      'recurringbillingfrequency',
      'hs_recurring_billing_frequency',
      'hs_recurring_billing_number_of_payments',
      'billing_anchor_date',
    ];
    li = await hubspotClient.crm.lineItems.basicApi.getById(String(lineItemId), props);
  }
  const properties = li.properties || {};
  const id         = li.id || lineItemId;

  // 2. Decidir modo
  const autoRenew = isAutoRenew({ properties });

  // 3. Cancelación: limpiar billing_next_date (y progreso_pagos) si corresponde
  if (dealIsCanceled === true) {
    const propsToClean = {};

    if (String(properties.billing_next_date ?? '').trim() !== '') {
      propsToClean.billing_next_date = '';
    }
    if (String(properties.progreso_pagos ?? '').trim() !== '') {
      propsToClean.progreso_pagos = '';
    }

    if (Object.keys(propsToClean).length > 0) {
      await hubspotClient.crm.lineItems.basicApi.update(String(id), {
        properties: propsToClean,
      });
    }
    return;
  }

  // 4. PLAN_FIJO: recalcular facturas_restantes
  let facturasRestantes = null;
  let recalcRes         = null;

  if (!autoRenew) {
    recalcRes         = await recalcFacturasRestantes({ hubspotClient, lineItemId: id, dealId });
    facturasRestantes = recalcRes?.facturas_restantes;
  }

  // 5. Calcular progreso_pagos (display informativo, no fuente de verdad)
  //    - AUTO_RENEW o sin cuotasTotales → vacío
  //    - PLAN_FIJO con datos → barra Unicode + fracción
  const nextProgreso = (!autoRenew && recalcRes?.cuotasTotales > 0)
    ? buildPagoDisplay(recalcRes.countInvoices, recalcRes.cuotasTotales)
    : '';

  log.debug(
    { id, autoRenew, countInvoices: recalcRes?.countInvoices, cuotasTotales: recalcRes?.cuotasTotales, nextProgreso },
    '[syncBillingState] progreso_pagos calculado'
  );

  // 6. Calcular próxima fecha
  const cfg = getEffectiveBillingConfig({ properties });
  const { interval, startDate } = cfg;

  let maxCount = 24; // DEFAULT: auto-renew / forecast

  if (!autoRenew) {
    if (typeof cfg.maxOccurrences === 'number') {
      maxCount = cfg.maxOccurrences;
    }
  }

  const nextYmd = resolveNextBillingDate({
    lineItemProps:  properties,
    facturasRestantes,
    dealIsCanceled: false,
    startRaw:       startDate ? formatDateISO(startDate) : null,
    interval,
    addInterval,
  });

// 7. Persistir solo los campos que cambiaron (batch PATCH)
const propsToUpdate = {};

// billing_next_date: solo AUTO_RENEW lo calcula aquí.
// PLAN_FIJO: lo gestiona recalcFromTickets/syncBillingNextDateFromTickets (fuente de verdad: tickets).
if (autoRenew) {
  const nextStr = nextYmd ? String(nextYmd) : '';
  const curStr  = String(properties.billing_next_date ?? '').trim();
  if (curStr !== nextStr) {
    propsToUpdate.billing_next_date = nextStr;
  }
}

const curProgreso = String(properties.progreso_pagos ?? '').trim();
if (curProgreso !== nextProgreso) {
  propsToUpdate.progreso_pagos = nextProgreso;
}

  if (Object.keys(propsToUpdate).length > 0) {
    await hubspotClient.crm.lineItems.basicApi.update(String(id), {
      properties: propsToUpdate,
    });

    log.info(
      { id, updated: propsToUpdate },
      '[syncBillingState] line item actualizado'
    );
  } else {
    log.debug({ id }, '[syncBillingState] sin cambios, noop');
  }
}