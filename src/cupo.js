// src/cupo.js
//
// Este módulo centraliza la lógica relacionada con los cupos/bolsas de horas o monto.
// Reutiliza la lógica de bagEngine.js para inicializar el cupo en cada línea
// y bagProcessor.js para procesar los consumos desde tickets.
// También expone utilidades para calcular el estado del cupo a nivel negocio.

import { hubspotClient } from './hubspotClient.js';
import { updateBagFieldsForLineItem } from './bagEngine.js';
import { processBagTickets } from './bagProcessor.js';

/**
 * Inicializa o recalcula los campos de cupo de un line item.
 * Esta función encapsula updateBagFieldsForLineItem del bagEngine.
 * Devuelve el line item actualizado en memoria.
 *
 * @param {Object} lineItem - El objeto de line item (id y properties).
 * @returns {Promise<Object>}
 */
export async function initLineItemCupo(lineItem) {
  return updateBagFieldsForLineItem(lineItem);
}

/**
 * Procesa los tickets que consumen cupo (bolsa) en todo el portal.
 * Reutiliza processBagTickets del bagProcessor para actualizar
 * los campos de consumo en tickets y line items.
 *
 * @param {Object} [options] - Opciones como batchSize.
 * @returns {Promise<Object>} - { processed: number }
 */
export async function processCupoTickets(options = {}) {
  return processBagTickets(options);
}

/**
 * Determina el estado de un cupo en función del total, el restante y el umbral.
 *
 * @param {number} total - Total de horas o monto de la bolsa.
 * @param {number} restante - Cantidad restante (horas o monto).
 * @param {number} umbral - Valor entre 0 y 1 que define "Bajo Umbral".
 * @returns {"OK" | "Bajo Umbral" | "Agotado" | "Inconsistente"}
 */
export function computeCupoStatus(total, restante, umbral) {
  const t = Number(total);
  const r = Number(restante);
  const u = Number(umbral);

  if (!Number.isFinite(t) || t <= 0) {
    return 'Inconsistente';
  }
  if (!Number.isFinite(r)) {
    return 'Inconsistente';
  }
  if (r <= 0) {
    return 'Agotado';
  }
  const ratio = r / t;
  if (Number.isFinite(u) && u > 0 && ratio <= u) {
    return 'Bajo Umbral';
  }
  return 'OK';
}

/**
 * Agrega los totales de cupo a nivel negocio a partir de los line items.
 * Suma los totales, consumidos y restantes. Devuelve null si no aplica cupo.
 *
 * @param {Array<Object>} lineItems
 * @returns {Object|null} { tipo, total, consumido, restante, umbral, estado }
 */
export function aggregateDealCupo(lineItems) {
  let cupoActivo = false;
  let tipo = null; // 'Por horas' o 'Por Monto'
  let total = 0;
  let consumido = 0;
  let restante = 0;
  let umbral = null;

  for (const li of lineItems || []) {
    const p = li.properties || {};
    const aplica = (p.aplica_cupo || '').toString().trim().toLowerCase();
    if (!aplica) continue;

    cupoActivo = true;
    if (aplica === 'por_horas') {
      tipo = 'Por horas';
      total += Number(p.total_bolsa_horas) || 0;
      consumido += Number(p.bolsa_horas_consumidas) || 0;
      restante += Number(p.bolsa_horas_restantes) || 0;
    } else if (aplica === 'por_monto') {
      tipo = 'Por Monto';
      total += Number(p.total_bolsa_monto) || 0;
      consumido += Number(p.bolsa_monto_consumido) || 0;
      restante += Number(p.bolsa_monto_restante) || 0;
    }
    // Tomar el primer umbral encontrado (puede definirse a nivel línea)
    if (p.cupo_umbral !== undefined && p.cupo_umbral !== null && umbral === null) {
      const v = Number(p.cupo_umbral);
      if (Number.isFinite(v) && v > 0) umbral = v;
    }
  }

  if (!cupoActivo) {
    return null;
  }
  if (umbral === null) {
    // Umbral por defecto: 20%
    umbral = 0.2;
  }
  const estado = computeCupoStatus(total, restante, umbral);

  return { tipo, total, consumido, restante, umbral, estado };
}

/**
 * Actualiza las propiedades de cupo a nivel negocio en HubSpot.
 *
 * @param {string} dealId
 * @param {Array<Object>} lineItems - Line items ya actualizados con datos de cupo.
 * @returns {Promise<void>}
 */
export async function updateDealCupo(dealId, lineItems) {
  const aggregated = aggregateDealCupo(lineItems);
  const props = {};
  if (!aggregated) {
    // No hay cupo → limpiar propiedades en el negocio
    props.cupo_activo = 'false';
    props.tipo_de_cupo = null;
    props.cupo_total = null;
    props.cupo_umbral = null;
    props.cupo_consumido = null;
    props.cupo_restante = null;
    props.cupo_estado = null;
  } else {
    props.cupo_activo = 'true';
    props.tipo_de_cupo = aggregated.tipo || null;
    props.cupo_total = String(aggregated.total ?? '');
    props.cupo_umbral = String(aggregated.umbral ?? '');
    props.cupo_consumido = String(aggregated.consumido ?? '');
    props.cupo_restante = String(aggregated.restante ?? '');
    props.cupo_estado = aggregated.estado || null;
  }
  await hubspotClient.crm.deals.basicApi.update(String(dealId), { properties: props });
}
