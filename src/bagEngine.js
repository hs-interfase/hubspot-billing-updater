// src/bagEngine.js
//
// Módulo de soporte para bolsas de horas/monto en line items.
//
// Este archivo encapsula la lógica para inicializar y mantener
// las propiedades relacionadas con una bolsa (cupo) de horas o
// por monto dentro de un line item de HubSpot. Dado un line item
// marcado con `aplica_cupo`, calcula las horas y montos por período,
// las totales para el contrato y los saldos consumidos/restantes.
//
// Se espera que el vendedor defina en el line item:
// - aplica_cupo: "por_horas" o "por_monto" (si está vacío no se procesa)
// - bolsa_precio_hora: valor unitario de la hora en la bolsa
// - horas_bolsa o cant__hs_bolsa: horas del período (si aplica por horas)
// - precio_bolsa: monto del período (si aplica por monto)
//
// Con base en la configuración de facturación del line item, se calcula
// el número de períodos totales (usando computeBillingCountersForLineItem)
// y se derivan total_bolsa_horas y total_bolsa_monto. Los saldos
// consumidos/restantes se actualizan en función de las propiedades
// existente: bolsa_horas_consumidas y bolsa_monto_consumido.
//
// Nota: este módulo no crea tickets ni gestiona consumos; esas
// responsabilidades residen en bagProcessor.js y tickets.js. Aquí
// simplemente se normalizan y sincronizan las propiedades de bolsa.

import { hubspotClient } from './hubspotClient.js';
import { computeBillingCountersForLineItem } from './billingEngine.js';

/**
 * Convierte un valor en Number. Devuelve 0 si no es numérico.
 * @param {any} raw
 * @returns {number}
 */
function parseNumber(raw) {
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Actualiza las propiedades de bolsa para un line item.
 *
 * Detecta si el line item aplica a un cupo (aplica_cupo) y, en tal caso,
 * normaliza las propiedades de bolsa: horas_bolsa, precio_bolsa,
 * total_bolsa_horas, total_bolsa_monto, bolsa_horas_restantes y
 * bolsa_monto_restante. La determinación de horas o montos se hace
 * en función de aplica_cupo ("por_horas" o "por_monto") y del valor
 * unitario bolsa_precio_hora.
 *
 * El número total de períodos se toma del contador de avisos de
 * facturación (facturacion_total_avisos). Si no se puede calcular,
 * se asume al menos un período.
 *
 * @param {Object} lineItem - Objeto de line item con id y properties.
 * @returns {Promise<Object>} Devuelve el line item con properties actualizadas.
 */
export async function updateBagFieldsForLineItem(lineItem) {
  if (!lineItem || !lineItem.id) return lineItem;
  const p = lineItem.properties || {};
  // normalizamos la etiqueta de cupo
  const aplicaRaw = (p.aplica_cupo || '').toString().trim();
  if (!aplicaRaw) {
    // no aplica bolsa, no hacemos nada
    return lineItem;
  }
  const aplica = aplicaRaw.toLowerCase();

  // precio unitario de la hora
  const pricePerHour = parseNumber(p.bolsa_precio_hora);
  // horas y monto por período definidos por el vendedor
  let horasBolsa = parseNumber(p.horas_bolsa) || parseNumber(p.cant__hs_bolsa);
  let precioBolsa = parseNumber(p.precio_bolsa);

  // intentar inferir número de períodos usando la lógica de facturación
  let numberPeriods = 1;
  try {
    const counters = computeBillingCountersForLineItem(lineItem, new Date());
    if (
      counters &&
      Number.isFinite(counters.facturacion_total_avisos) &&
      counters.facturacion_total_avisos > 0
    ) {
      numberPeriods = counters.facturacion_total_avisos;
    }
  } catch (err) {
    console.warn(
      '[bagEngine] No se pudo calcular facturacion_total_avisos para el line item',
      lineItem.id,
      err?.message || err
    );
  }

  // Calcular horasBolsa y precioBolsa según aplica_cupo
  if (aplica === 'por_horas') {
    // Si las horas por período no existen, intentamos tomar cant__hs_bolsa
    if (!Number.isFinite(horasBolsa) || horasBolsa <= 0) {
      horasBolsa = parseNumber(p.cant__hs_bolsa);
    }
    // Derivar el precio del período a partir de horas * precio hora
    if (Number.isFinite(pricePerHour) && Number.isFinite(horasBolsa) && horasBolsa > 0) {
      precioBolsa = horasBolsa * pricePerHour;
    }
  } else if (aplica === 'por_monto') {
    // Si el monto por período no está definido, usamos precio_bolsa
    if (!Number.isFinite(precioBolsa) || precioBolsa <= 0) {
      precioBolsa = parseNumber(p.precio_bolsa);
    }
    // Derivar horas a partir del monto y el precio por hora
    if (
      Number.isFinite(pricePerHour) &&
      pricePerHour > 0 &&
      Number.isFinite(precioBolsa) &&
      precioBolsa > 0
    ) {
      horasBolsa = precioBolsa / pricePerHour;
    }
  }

  // Totales a nivel de contrato
  let totalHoras = parseNumber(p.total_bolsa_horas);
  let totalMonto = parseNumber(p.total_bolsa_monto);

  if (!Number.isFinite(totalHoras) || totalHoras <= 0) {
    if (Number.isFinite(horasBolsa) && horasBolsa > 0) {
      totalHoras = horasBolsa * numberPeriods;
    }
  }

  if (!Number.isFinite(totalMonto) || totalMonto <= 0) {
    if (Number.isFinite(precioBolsa) && precioBolsa > 0) {
      totalMonto = precioBolsa * numberPeriods;
    } else if (
      Number.isFinite(totalHoras) &&
      totalHoras > 0 &&
      Number.isFinite(pricePerHour) &&
      pricePerHour > 0
    ) {
      totalMonto = totalHoras * pricePerHour;
    }
  }

  // Contadores consumidos existentes
  let horasConsumidas = parseNumber(p.bolsa_horas_consumidas);
  let montoConsumido = parseNumber(p.bolsa_monto_consumido);
  if (!Number.isFinite(horasConsumidas)) horasConsumidas = 0;
  if (!Number.isFinite(montoConsumido)) montoConsumido = 0;

  // Saldos restantes
  let horasRestantes = 0;
  if (Number.isFinite(totalHoras) && totalHoras > 0) {
    horasRestantes = Math.max(totalHoras - horasConsumidas, 0);
  }
  let montoRestante = 0;
  if (Number.isFinite(totalMonto) && totalMonto > 0) {
    montoRestante = Math.max(totalMonto - montoConsumido, 0);
  }

  // Construir objeto de updates
  const updates = {};
  // Sólo actualizamos si los valores tienen sentido
  if (Number.isFinite(horasBolsa) && horasBolsa > 0) {
    updates.horas_bolsa = String(horasBolsa);
  }
  if (Number.isFinite(precioBolsa) && precioBolsa > 0) {
    updates.precio_bolsa = String(precioBolsa);
  }
  if (Number.isFinite(totalHoras) && totalHoras > 0) {
    updates.total_bolsa_horas = String(totalHoras);
  }
  if (Number.isFinite(totalMonto) && totalMonto > 0) {
    updates.total_bolsa_monto = String(totalMonto);
  }
  // Siempre actualizamos los saldos restantes
  updates.bolsa_horas_restantes = String(horasRestantes);
  updates.bolsa_monto_restante = String(montoRestante);
  // Aseguramos que existan campos de consumidos si no estaban definidos
  if (!Object.prototype.hasOwnProperty.call(p, 'bolsa_horas_consumidas')) {
    updates.bolsa_horas_consumidas = '0';
  }
  if (!Object.prototype.hasOwnProperty.call(p, 'bolsa_monto_consumido')) {
    updates.bolsa_monto_consumido = '0';
  }

  console.log('[bagEngine][DEBUG]', {
    lineItemId: String(lineItem.id),
    aplica_cupo: p.aplica_cupo,
    parte_del_cupo: p.parte_del_cupo,
    bolsa_precio_hora: p.bolsa_precio_hora,
    horas_bolsa_raw: p.horas_bolsa,
    cant__hs_bolsa_raw: p.cant__hs_bolsa,
    precio_bolsa_raw: p.precio_bolsa,
    total_bolsa_horas_raw: p.total_bolsa_horas,
    bolsa_horas_consumidas_raw: p.bolsa_horas_consumidas,
    // valores calculados
    pricePerHour,
    horasBolsa,
    precioBolsa,
    numberPeriods,
    totalHoras,
    horasConsumidas,
    horasRestantes,
    // lo que va a escribir
    updates,
  });


  // Si no hay nada que actualizar, retornamos
  if (Object.keys(updates).length === 0) {
    return lineItem;
  }

  // Aplicar actualización en HubSpot
  try {
    await hubspotClient.crm.lineItems.basicApi.update(String(lineItem.id), {
      properties: updates,
    });
    // Actualizar en memoria para que otros módulos vean los cambios
    lineItem.properties = { ...p, ...updates };
  } catch (err) {
    console.error(
      '[bagEngine] Error al actualizar line item',
      lineItem.id,
      err?.response?.data || err.message || err
    );
  }
  return lineItem;
}