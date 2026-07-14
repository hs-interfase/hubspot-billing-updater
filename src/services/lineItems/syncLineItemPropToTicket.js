// src/services/lineItems/syncLineItemPropToTicket.js
//
// Tarea C (reunión 13-jul) — SYNC QUIRÚRGICO por-propiedad Line Item → Ticket.
//
// Hoy la propagación LI→ticket es full-snapshot y SOLO forecast (phaseP re-snapshotea
// cuando el LI cambió). Al promover a NEW/READY el LI deja de pisar el ticket, para no
// aplastar lo que edita el responsable. Definición nueva: el cambio del vendedor SÍ debe
// llegar al ticket editable, pero **solo la propiedad que tocó** — no un re-snapshot del
// ticket entero (así no pisa el trabajo del responsable en otras props).
//
// Mecanismo: ante un `line_item.propertyChange` de una prop ESCUCHADA, se reusa
// `extractLineItemSnapshots` (FUENTE ÚNICA del mapeo LI→ticket) y se escriben SOLO las
// claves de ticket que esa prop influye, sobre los tickets NO emitidos del LI.
//
// TRANSFERIR (definición 13-jul): todas las props visibles del LI MENOS Frecuencia de
// Facturación, Término de facturación, Término, Número de Pagos y Momento de Facturación;
// de "Más Opciones" solo NC. La lista exacta de "visibles" queda abierta hasta limpiar
// las vistas → este módulo aplica las EXCLUSIONES nombradas y mapea el resto.
//
// Gateado por flag LI_PROP_SYNC_ENABLED (default OFF).

import { hubspotClient } from '../../hubspotClient.js';
import { extractLineItemSnapshots } from '../snapshotService.js';
import { updateTicket } from '../tickets/ticketService.js';
import { PENDING_STAGES } from '../../config/constants.js';
import { parseBool } from '../../utils/parsers.js';
import { reportIfActionable } from '../../utils/errorReporting.js';
import logger from '../../../lib/logger.js';

const MODULE = 'syncLineItemPropToTicket';

// ── Props del LI que NO se transfieren al ticket (definición 13-jul) ──────────
// Frecuencia de Facturación · Término de facturación · Término · Número de Pagos ·
// Momento de Facturación. (De "Más Opciones" solo se transfiere `nc`, que SÍ está mapeada.)
export const TRANSFER_EXCLUDED_LI_PROPS = new Set([
  'recurringbillingfrequency',            // Frecuencia de Facturación
  'hs_recurring_billing_frequency',       // idem (variante)
  'hs_recurring_billing_period',          // Término de facturación / Término
  'hs_recurring_billing_number_of_payments', // Número de Pagos
  'momento_de_facturacion',               // Momento de Facturación
]);

// ── Mapeo prop del LI → claves de snapshot del TICKET que influye ─────────────
// Derivado de extractLineItemSnapshots() (fuente de verdad). Una prop puede influir
// varias claves derivadas (ej. price → monto + costo/margen). Las props excluidas
// arriba NO figuran acá a propósito.
export const LI_PROP_TO_TICKET_KEYS = {
  // Texto / catálogo
  name: ['of_producto_nombres'],
  description: ['of_descripcion_producto'],
  servicio: ['of_rubro'],
  subrubro: ['of_subrubro'],
  area: ['area'],
  of_codigo_rubro: ['of_codigo_rubro'],
  mensaje_para_responsable: ['observaciones'],
  nota: ['nota'],
  pais_operativo: ['of_pais_operativo'],
  empresa_que_factura: ['entidad_facturadora'],
  // Numéricos / montos (derivadas: of_costo/of_margen dependen de varios)
  price: ['monto_unitario_real', 'of_costo', 'of_margen'],
  quantity: ['cantidad_real', 'of_costo', 'of_margen'],
  hs_discount_percentage: ['descuento_en_porcentaje'],
  discount: ['descuento_por_unidad_real'],
  hs_cost_of_goods_sold: ['of_costo', 'of_margen'],
  costo_total_usd: ['of_costo', 'of_costo_usd', 'of_margen'],
  dolar: ['dolar', 'of_costo'],
  // Impuestos
  hs_tax_rate_group_id: ['of_iva'],
  exonera_irae: ['exonera_irae'],
  // Booleanos / flags
  parte_del_cupo: ['of_aplica_para_cupo'],
  reventa: ['reventa'],
  opera_trading: ['opera_trading'],
  nc: ['nc'],
  facturacion_automatica: ['facturacion_automatica'],
  // Fechas
  hs_recurring_billing_start_date: ['fecha_inicio_de_facturacion'],
  fecha_inicio_de_facturacion: ['fecha_inicio_de_facturacion'],
};

// LI props que hay que leer para reconstruir el snapshot (fuente: extractLineItemSnapshots).
const LI_PROPS_TO_FETCH = [
  'line_item_key',
  'price', 'quantity', 'amount', 'hs_cost_of_goods_sold',
  'hs_discount_percentage', 'discount',
  'hs_tax_rate_group_id', 'exonera_irae',
  'costo_total_usd', 'dolar',
  'recurringbillingfrequency', 'hs_recurring_billing_frequency', 'irregular',
  'name', 'description', 'servicio', 'subrubro', 'area', 'of_codigo_rubro',
  'momento_de_facturacion', 'mensaje_para_responsable', 'nota', 'pais_operativo',
  'parte_del_cupo', 'reventa', 'opera_trading', 'nc', 'empresa_que_factura',
  'hs_recurring_billing_start_date', 'fecha_inicio_de_facturacion', 'facturacion_automatica',
  'hs_recurring_billing_number_of_payments',
];

const DEAL_PROPS_TO_FETCH = [
  'deal_currency_code', 'dolar', 'pais_operativo', 'es_mirror_de_py', 'tipo_de_cupo',
];

/** ¿La prop del LI se transfiere al ticket? (pura, testeable) */
export function isTransferableLiProp(propertyName) {
  if (!propertyName) return false;
  if (TRANSFER_EXCLUDED_LI_PROPS.has(propertyName)) return false;
  return Array.isArray(LI_PROP_TO_TICKET_KEYS[propertyName]);
}

/**
 * Dado el snapshot completo del LI y la prop que cambió, devuelve el subconjunto de
 * props del ticket a escribir (solo las claves que esa prop influye). (pura, testeable)
 */
export function pickAffectedTicketProps(snapshot, propertyName) {
  const keys = LI_PROP_TO_TICKET_KEYS[propertyName];
  if (!Array.isArray(keys)) return {};
  const out = {};
  for (const k of keys) {
    if (k in snapshot) out[k] = snapshot[k];
  }
  return out;
}

/**
 * Sincroniza al/los ticket(s) del line item SOLO la(s) prop(s) de ticket influida(s) por
 * `propertyName`. Toca únicamente tickets NO emitidos (stage ∈ PENDING_STAGES). No hace
 * re-snapshot completo → no pisa otras props que el responsable haya editado.
 *
 * @returns {Promise<{applies:boolean, reason?:string, ticketsScanned:number,
 *   ticketsUpdated:number, skippedEmitted:number, keys:string[], errors:number}>}
 */
export async function syncLineItemPropToTickets({
  lineItemId,
  propertyName,
  dealId = null,
  // Inyectables para tests (defaults = producción)
  client = hubspotClient,
  extractFn = extractLineItemSnapshots,
  updateTicketFn = updateTicket,
}) {
  const stats = { applies: false, ticketsScanned: 0, ticketsUpdated: 0, skippedEmitted: 0, keys: [], errors: 0 };

  if (!isTransferableLiProp(propertyName)) {
    return { ...stats, reason: TRANSFER_EXCLUDED_LI_PROPS.has(propertyName) ? 'excluded' : 'not_mapped' };
  }

  // Leer LI (props que necesita extractLineItemSnapshots)
  let lineItem;
  try {
    lineItem = await client.crm.lineItems.basicApi.getById(String(lineItemId), LI_PROPS_TO_FETCH);
  } catch (err) {
    logger.warn({ module: MODULE, lineItemId, err: err?.message }, 'No se pudo leer el line item');
    return { ...stats, reason: 'line_item_read_error', errors: 1 };
  }
  const lp = lineItem?.properties || {};
  const lineItemKey = lp.line_item_key;
  if (!lineItemKey) return { ...stats, reason: 'sin_line_item_key' };

  // Leer deal (extractLineItemSnapshots lo usa para moneda/dolar/país/cupo/intercompany)
  let deal = { properties: {} };
  if (dealId) {
    try {
      deal = await client.crm.deals.basicApi.getById(String(dealId), DEAL_PROPS_TO_FETCH);
    } catch (err) {
      logger.warn({ module: MODULE, dealId, err: err?.message }, 'No se pudo leer el deal (sigo con defaults)');
    }
  }

  // Snapshot completo → subconjunto afectado por la prop cambiada
  const snapshot = extractFn(lineItem, deal);
  const affected = pickAffectedTicketProps(snapshot, propertyName);
  const affectedKeys = Object.keys(affected);
  if (!affectedKeys.length) return { ...stats, reason: 'sin_claves_afectadas' };
  stats.applies = true;
  stats.keys = affectedKeys;

  // Buscar tickets del LI (por of_line_item_key) trayendo stage + las claves afectadas
  let tickets = [];
  try {
    const resp = await client.crm.tickets.searchApi.doSearch({
      filterGroups: [{ filters: [{ propertyName: 'of_line_item_key', operator: 'EQ', value: String(lineItemKey) }] }],
      properties: ['hs_pipeline_stage', 'of_ticket_key', ...affectedKeys],
      limit: 100,
    });
    tickets = resp?.results || [];
  } catch (err) {
    logger.error({ module: MODULE, lineItemId, lineItemKey, err }, 'Error buscando tickets del line item');
    return { ...stats, reason: 'ticket_search_error', errors: 1 };
  }

  for (const t of tickets) {
    stats.ticketsScanned++;
    const stage = String(t?.properties?.hs_pipeline_stage || '');
    // Solo tickets NO emitidos y no cancelados: stage ∈ PENDING_STAGES (forecast/NEW/READY).
    if (!PENDING_STAGES.has(stage)) { stats.skippedEmitted++; continue; }

    // Patch mínimo: solo las claves cuyo valor difiere.
    const patch = {};
    for (const k of affectedKeys) {
      const nv = affected[k];
      if (String(nv ?? '') !== String(t?.properties?.[k] ?? '')) patch[k] = nv;
    }
    if (!Object.keys(patch).length) continue;

    try {
      await updateTicketFn(String(t.id), patch);
      stats.ticketsUpdated++;
      logger.info(
        { module: MODULE, lineItemId, ticketId: t.id, propertyName, patchKeys: Object.keys(patch) },
        'Sync quirúrgico LI→ticket aplicado'
      );
    } catch (err) {
      stats.errors++;
      reportIfActionable({ objectType: 'ticket', objectId: String(t.id), message: `Sync LI→ticket falló (prop ${propertyName})`, err });
      logger.warn({ module: MODULE, lineItemId, ticketId: t.id, err }, 'Sync LI→ticket falló (no bloquea el resto)');
    }
  }

  logger.info({ module: MODULE, lineItemId, propertyName, ...stats }, 'syncLineItemPropToTickets completado');
  return stats;
}
