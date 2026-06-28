// src/services/billing/recalcContadores.js
//
// Motor de Phase R: recalcula los contadores derivados de un line item a partir
// del ESTADO REAL de sus tickets, en UNA sola búsqueda por line_item_key.
//
// Filosofía (ver docs/SISTEMA_CONTADORES_BILLING.md):
//   - Los 3 contadores de display son COSMÉTICOS: reflejan el estado real, nadie
//     decide nada leyéndolos.
//       · facturas_restantes   = total - tickets en INVOICED_STAGES
//       · facturas_por_derivar = total - tickets en DERIVED_STAGES
//       · progreso_pagos       = barra "███░░ 3 / 12"
//   - fechas_completas SÍ es funcional (gate que bloquea re-procesar la línea),
//     pero acá se reconcilia de forma SEGURA y BIDIRECCIONAL como espejo del
//     estado real: restantes===0 → true ; restantes>0 → false. Así se auto-sana
//     en ambas direcciones (sella un sello perdido, y des-sella una línea que
//     volvió a tener cuotas pendientes — el latch de una sola vía mataba líneas).
//   - Alertas SOLO en la transición (no en cada corrida) → sin spam.
//
// NO toca pagos_restantes (stateful) ni pagos_emitidos (sin writer).
// Los writers event-driven (recalcFacturasRestantes / recalcDerivedFacturas)
// quedan intactos; esta función es el reconciliador de fin de corrida.

import { isAutoRenew } from './mode.js';
import { buildPagoDisplay } from './syncBillingState.js';
import { INVOICED_STAGES, DERIVED_STAGES } from '../../config/constants.js';
import { alertFechasCompletas, alertDerivacionCompleta } from '../notifications/dealAlerts.js';
import { reportIfActionable } from '../../utils/errorReporting.js';
import logger from '../../../lib/logger.js';

const MOD = 'recalcContadores';
const norm = (v) => String(v ?? '').trim();

/**
 * PURE: calcula el estado deseado de los contadores a partir de las properties
 * del line item y los conteos de tickets. No hace IO. Misma lógica de cuotas
 * que recalcFacturasRestantes / recalcDerivedFacturas (auto-renew, pago único,
 * sin total).
 *
 * @param {object} props  properties del line item
 * @param {{invoiced:number, derived:number}} counts  conteos por LIK
 * @returns {{
 *   mode:'AUTO_RENEW'|'SIN_TOTAL'|'PLAN_FIJO',
 *   restantes:string, porDerivar:string, progreso:string,
 *   total?:number,
 *   sealFechasCompletas: boolean|null   // null = no tocar el flag (modo sin "completo")
 * }}
 */
export function computeContadores(props, counts) {
  // AUTO_RENEW: plan infinito → los 3 cosméticos vacíos; "completo" no aplica.
  if (isAutoRenew({ properties: props })) {
    return { mode: 'AUTO_RENEW', restantes: '', porDerivar: '', progreso: '', sealFechasCompletas: null };
  }

  let total = Number.parseInt(norm(props.hs_recurring_billing_number_of_payments), 10);
  const freq = norm(props.recurringbillingfrequency || props.hs_recurring_billing_frequency);

  // PAGO ÚNICO: sin frecuencia y sin total → plan de 1 cuota.
  if ((!Number.isFinite(total) || total <= 0) && !freq) total = 1;

  // Sin total utilizable → cosméticos vacíos; "completo" no aplica.
  if (!Number.isFinite(total) || total <= 0) {
    return { mode: 'SIN_TOTAL', restantes: '', porDerivar: '', progreso: '', sealFechasCompletas: null };
  }

  const restantes = Math.max(0, total - counts.invoiced);
  const porDerivar = Math.max(0, total - counts.derived);

  return {
    mode: 'PLAN_FIJO',
    total,
    restantes: String(restantes),
    porDerivar: String(porDerivar),
    progreso: buildPagoDisplay(counts.invoiced, total),
    sealFechasCompletas: restantes === 0, // espejo bidireccional del estado real
  };
}

/**
 * Trae todos los tickets del LIK y cuenta INVOICED y DERIVED en UNA búsqueda.
 * Mismo filtro/límite que los writers de producción (limit 100, sin paginar).
 */
async function countTicketsForLIK({ hubspotClient, lik }) {
  const resp = await hubspotClient.crm.tickets.searchApi.doSearch({
    filterGroups: [{ filters: [{ propertyName: 'of_line_item_key', operator: 'EQ', value: lik }] }],
    properties: ['hs_pipeline_stage'],
    limit: 100,
  });
  const tickets = resp?.results ?? [];
  let invoiced = 0;
  let derived = 0;
  for (const t of tickets) {
    const stage = String(t.properties?.hs_pipeline_stage || '');
    if (INVOICED_STAGES.has(stage)) invoiced++;
    if (DERIVED_STAGES.has(stage)) derived++;
  }
  return { total: tickets.length, invoiced, derived };
}

/**
 * IO: lee el line item, cuenta tickets (1 búsqueda), reconcilia los contadores
 * y persiste solo lo que cambió. Dispara alertas solo en la transición.
 *
 * Lanza si una escritura falla (runPhaseR lo cuenta como error y sigue).
 *
 * @param {object} opts
 * @param {object} opts.hubspotClient
 * @param {string} opts.lineItemId
 * @param {string} [opts.dealId]
 * @param {Function} [opts.alertFechasCompletasFn]   inyectable (tests)
 * @param {Function} [opts.alertDerivacionCompletaFn] inyectable (tests)
 * @param {Function} [opts.countTicketsFn]            inyectable (tests)
 * @returns {Promise<object>} resumen del recálculo
 */
export async function recalcContadores({
  hubspotClient,
  lineItemId,
  dealId,
  alertFechasCompletasFn = alertFechasCompletas,
  alertDerivacionCompletaFn = alertDerivacionCompleta,
  countTicketsFn = countTicketsForLIK,
}) {
  const id = String(lineItemId);

  const { properties: props } = await hubspotClient.crm.lineItems.basicApi.getById(
    id,
    [
      'renovacion_automatica',
      'recurringbillingfrequency',
      'hs_recurring_billing_frequency',
      'hs_recurring_billing_number_of_payments',
      'facturas_restantes',
      'facturas_por_derivar',
      'progreso_pagos',
      'fechas_completas',
      'line_item_key',
      'name',
    ],
    undefined,
    undefined,
    false
  );

  const lik = norm(props.line_item_key);
  if (!lik) {
    logger.debug({ module: MOD, lineItemId: id }, 'sin line_item_key, skip');
    return { mode: 'NO_LIK', skipped: true };
  }

  const counts = await countTicketsFn({ hubspotClient, lik });
  const want = computeContadores(props, counts);

  // ── Diff de contadores cosméticos ──
  const update = {};
  if (norm(props.facturas_restantes) !== want.restantes) update.facturas_restantes = want.restantes;
  if (norm(props.facturas_por_derivar) !== want.porDerivar) update.facturas_por_derivar = want.porDerivar;
  if (norm(props.progreso_pagos) !== want.progreso) update.progreso_pagos = want.progreso;

  // ── Reconciliación bidireccional de fechas_completas (solo si aplica) ──
  const curFlag = norm(props.fechas_completas).toLowerCase() === 'true';
  let sealedTransition = false; // false → true (para alerta)
  if (want.sealFechasCompletas !== null && want.sealFechasCompletas !== curFlag) {
    update.fechas_completas = want.sealFechasCompletas ? 'true' : 'false';
    sealedTransition = want.sealFechasCompletas === true;
  }

  // ── Transición de derivación a 0 (para alerta sin spam) ──
  const derivacionTransition =
    want.mode === 'PLAN_FIJO' && want.porDerivar === '0' && norm(props.facturas_por_derivar) !== '0';

  if (Object.keys(update).length > 0) {
    try {
      await hubspotClient.crm.lineItems.basicApi.update(id, { properties: update });
      logger.info(
        { module: MOD, lineItemId: id, lik, mode: want.mode, counts, update },
        'contadores recalculados'
      );
    } catch (err) {
      reportIfActionable({ objectType: 'line_item', objectId: id, message: 'Error al actualizar contadores (Phase R)', err });
      throw err;
    }
  } else {
    logger.debug({ module: MOD, lineItemId: id, lik, mode: want.mode }, 'sin cambios, noop');
  }

  // ── Alertas SOLO en transición (fire-and-forget) ──
  if (sealedTransition) {
    alertFechasCompletasFn({ dealId, lineItemId: id, lineItemName: props.name || null, lik })
      .catch((err) => logger.warn({ module: MOD, lineItemId: id, err: err?.message }, 'alertFechasCompletas falló (no bloquea)'));
  }
  if (derivacionTransition) {
    alertDerivacionCompletaFn({ dealId, lineItemId: id, lineItemName: props.name || null, lik })
      .catch((err) => logger.warn({ module: MOD, lineItemId: id, err: err?.message }, 'alertDerivacionCompleta falló (no bloquea)'));
  }

  return { mode: want.mode, counts, updated: Object.keys(update), sealedTransition, derivacionTransition };
}
