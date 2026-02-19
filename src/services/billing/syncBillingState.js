import { isAutoRenew } from './mode.js';
import { recalcFacturasRestantes } from './recalcFacturasRestantes.js';
import { resolveNextBillingDate } from '../../utils/resolveNextBillingDate.js';
import { getEffectiveBillingConfig } from '../../billingEngine.js';
import { formatDateISO, addInterval } from '../../utils/dateUtils.js';
import logger from '../../../lib/logger.js';

/**
 * Centraliza la actualización de billing_next_date y facturas_restantes.
 * @param {object} opts
 * @param {object} opts.hubspotClient
 * @param {string} [opts.lineItemId]
 * @param {object} [opts.lineItem]
 * @param {string} [opts.dealId]
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
      'renovacion_automatica',
      'recurringbillingfrequency',
      'hs_recurring_billing_frequency',
      'hs_recurring_billing_number_of_payments',
      'billing_anchor_date',
    ];
    li = await hubspotClient.crm.lineItems.basicApi.getById(String(lineItemId), props);
  }
  const properties = li.properties || {};
  const id = li.id || lineItemId;

  // 2. Decidir modo
  const autoRenew = isAutoRenew({ properties });

  // 3. Cancelación: limpiar billing_next_date si corresponde
  if (dealIsCanceled === true) {
    if (String(properties.billing_next_date ?? '').trim() !== '') {
      await hubspotClient.crm.lineItems.basicApi.update(String(id), {
        properties: { billing_next_date: '' },
      });
    }
    return;
  }

  // 4. PLAN_FIJO: recalcular facturas_restantes
  let facturasRestantes = null;
  if (!autoRenew) {
    const res = await recalcFacturasRestantes({ hubspotClient, lineItemId: id, dealId });
    facturasRestantes = res?.facturas_restantes;
  }

  // 5. Calcular próxima fecha
  const cfg = getEffectiveBillingConfig({ properties });
  const { interval, startDate } = cfg;

  // DEFAULT: 24 (auto-renew / forecast)
  let maxCount = 24;

  // PLAN_FIJO (temporal): NO gobernar billing_next_date por facturasRestantes.
  if (!autoRenew) {
    if (typeof cfg.maxOccurrences === 'number') {
      maxCount = cfg.maxOccurrences;
    }
  }

  // 6. Calcular nextYmd
  const nextYmd = resolveNextBillingDate({
    lineItemProps: properties,
    facturasRestantes,
    dealIsCanceled: false,
    upcomingDates, // ⚠️ OJO: esto está undefined en tu snippet (ver nota abajo)
    startRaw: startDate ? formatDateISO(startDate) : null,
    interval,
    addInterval,
  });

  // 7. Persistir solo si cambia
  const nextStr = nextYmd ? String(nextYmd) : '';
  const curStr = String(properties.billing_next_date ?? '').trim();
  if (curStr !== nextStr) {
    await hubspotClient.crm.lineItems.basicApi.update(String(id), {
      properties: { billing_next_date: nextStr },
    });
  }

  // Debug opcional (Pino)
  // log.debug({ id, autoRenew, nextYmd }, '[syncBillingState]');
}
