// src/billingEngine.js
import { hubspotClient } from './hubspotClient.js';



 //Convierte la frecuencia de facturación en meses.
//  Admite nombres con o sin tilde.

function getFrequencyMonths(freq) {
  if (!freq) return 0;
  const f = freq.toString().toLowerCase();
  switch (f) {
    case 'única':
    case 'unica':
    case 'pago único':
    case 'pago unico':
      return 0;
    case 'mensual':
      return 1;
    case 'bimestral':
      return 2;
    case 'trimestral':
      return 3;
    case 'semestral':
      return 6;
    case 'anual':
      return 12;
    case 'irregular':
      return 0;
    default:
      return 0;
  }
}



// Interpreta valores de período de HubSpot como cantidad de meses.
// Soportamos:
//   - "P5M"        -> 5 meses
//   - "P18M"       -> 18 meses
//   - "P1Y"        -> 12 meses
//   - "P2Y"        -> 24 meses
//   - "P1Y6M"      -> 18 meses
//   - "6"          -> 6 meses (simple numérico)
function parseMonthsFromHubspotTerm(value) {
  if (!value) return 0;
  const str = value.toString().trim().toUpperCase();

  // Caso ISO tipo "P1Y6M", "P2Y", "P18M"
  const isoMatch = str.match(/^P(?:(\d+)Y)?(?:(\d+)M)?$/);
  if (isoMatch) {
    const years = isoMatch[1] ? parseInt(isoMatch[1], 10) : 0;
    const months = isoMatch[2] ? parseInt(isoMatch[2], 10) : 0;
    const total = years * 12 + months;
    if (!Number.isNaN(total) && total > 0) {
      return total;
    }
  }

  // Caso simple numérico: "6", "18"
  const num = Number(str);
  if (!Number.isNaN(num) && num > 0) {
    return num;
  }

  return 0;
}


//
// Regla:
// - Si hs_recurring_billing_period tiene valor -> usar eso SIEMPRE (en meses).
// - Si NO tiene valor -> intentar derivar de contrato_a (1 año, 2 años, etc.).
// - Si nada sirve -> 0.
function parseDurationMonths(contratoA, recurringPeriod) {
  // 1) Primero intentamos con el término en meses (propiedad numérica o "P18M")
  const byTerm = parseMonthsFromHubspotTerm(recurringPeriod);
  if (byTerm > 0) {
    return byTerm;
  }

  // 2) Si no hay término válido, miramos contrato_a ("1 año", "2 años", etc.)
  const label = (contratoA || '').toString().toLowerCase().trim();
  const match = label.match(/(\d+)/);
  if (match) {
    const years = parseInt(match[1], 10);
    if (!Number.isNaN(years) && years > 0) {
      return years * 12;
    }
  }

  // 3) Nada de nada
  return 0;
}


 //Suma meses a una fecha, conservando el día cuando sea posible.

function addMonths(date, months) {
  const d = new Date(date.getTime());
  const day = d.getDate();
  d.setMonth(d.getMonth() + months);
  if (d.getDate() < day) {
    // Si el mes destino no tiene tantos días, ajusta al último día del mes
    d.setDate(0);
  }
  return d;
}

// Interpreta 'YYYY-MM-DD' como fecha local (sin saltos de huso horario)
function parseLocalDate(raw) {
  if (!raw) return null;

  const str = raw.toString().trim();

  // Caso típico de HubSpot: "2025-11-19"
  const m = str.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    const year = Number(m[1]);
    const month = Number(m[2]); // 1-12
    const day = Number(m[3]);   // 1-31
    // new Date(año, mesIndexado0, día) usa la zona local sin corrimientos raros
    return new Date(year, month - 1, day);
  }

  // Fallback por si viniera en otro formato
  const d = new Date(str);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}


// Genera un calendario de fechas de facturación.
// Incluye la fecha inicial como primer elemento.
// Si freqMonths = 0 (única/irregular), devuelve solo la fecha inicial.

function computeSchedule(startDate, freqMonths, durationMonths) {
const dates = [];
  if (!startDate) return dates;

  const start = parseLocalDate(startDate);
  if (!start) return dates;

  if (freqMonths === 0) {
    dates.push(start);
    return dates;
  }

  dates.push(start);
  const totalPayments = Math.floor(durationMonths / freqMonths);
  for (let i = 1; i < totalPayments; i++) {
    const next = addMonths(start, i * freqMonths);
    dates.push(next);
  }
  return dates;
}

// Construye el objeto de actualización para un line item.
// Escribe total_de_pagos, pagos_emitidos, pagos_restantes y fecha_2…fecha_N.
function buildLineItemUpdates(lineItem) {
  const p = lineItem.properties || {};
  const freq =
    p.frecuencia_de_facturacion || p.facturacion_frecuencia_de_facturacion;
  const start = p.fecha_inicio_de_facturacion;
  const contratoA = p.contrato_a;
  const recurringPeriod = p.hs_recurring_billing_period;

  const freqMonths = getFrequencyMonths(freq);
  const durationMonths = parseDurationMonths(contratoA, recurringPeriod);

  // 1) Calendario de pagos (incluye la fecha inicial en schedule[0])
  const schedule = computeSchedule(start, freqMonths, durationMonths);
  const total = schedule.length;

  // 2) Contadores de pagos
  let pagosEmitidos = Number(p.pagos_emitidos) || 0;
  if (pagosEmitidos > total) pagosEmitidos = total;

  const pagosRestantes = total > 0 ? Math.max(total - pagosEmitidos, 0) : 0;

  const updates = {
    total_de_pagos: total,
    pagos_emitidos: pagosEmitidos,
    pagos_restantes: pagosRestantes,
  };

  // 3) Rellenar fechas válidas (fecha_2, fecha_3, ...)
  //    schedule[0] es la fecha_inicio_de_facturacion, por eso empezamos en i = 1
  for (let i = 1; i < schedule.length; i++) {
    const date = schedule[i];
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    const iso = `${y}-${m}-${d}`;
    updates[`fecha_${i + 1}`] = iso;
  }

  // 4) Limpiar fechas que SOBRAN cuando el contrato se acorta
  //    (por ejemplo, de 12 pagos a 5 pagos).
  //    Usamos '' en vez de null porque HubSpot a veces ignora null y mantiene el valor viejo.
const firstExtraIndex = schedule.length + 1; // fecha_{total+1}
for (let i = firstExtraIndex; i <= 48; i++) {
  updates[`fecha_${i}`] = ''; // esto borra la propiedad en HubSpot
}

  return updates;
}



 // Actualiza el calendario y contadores de un line item en HubSpot.
 
export async function updateLineItemSchedule(lineItem) {
  const updates = buildLineItemUpdates(lineItem);
  if (!Object.keys(updates).length) return;

  const updateBody = { properties: updates };

  // 1) Actualizamos en HubSpot
  await hubspotClient.crm.lineItems.basicApi.update(lineItem.id, updateBody);

  // 2) Reflejamos los cambios en el objeto local
  lineItem.properties = {
    ...(lineItem.properties || {}),
    ...updates,
  };

  return updates;
}


// Devuelve la próxima fecha de facturación para un line item.
// - Para regulares: usa el calendario calculado y el contador de pagos emitidos.
// - Para irregulares: toma la fecha inicial y fecha_2…fecha_48 introducidas manualmente.
 
function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function collectAllBillingDatesFromLineItem(lineItem) {
  const p = lineItem.properties || {};
  const dates = [];

  const add = (raw) => {
    if (!raw) return;
    const d = parseLocalDate(raw);
    if (!d || Number.isNaN(d.getTime())) return;
    d.setHours(0, 0, 0, 0);
    dates.push(d);  
  };

  // fecha inicial
  add(p.fecha_inicio_de_facturacion);

  // fechas 2..48 (tanto para recurrentes como para irregulares)
  for (let i = 2; i <= 48; i++) {
    add(p[`fecha_${i}`]);
  }

  // ordenar cronológicamente
  dates.sort((a, b) => a - b);
  return dates;
}

export function getNextBillingDateForLineItem(lineItem, today = new Date()) {
  const p = lineItem.properties || {};

  // 1) Respetar contadores: si ya se hicieron todos los pagos, no hay próxima fecha
  const total = Number(p.total_de_pagos) || 0;
  const emitidos = Number(p.pagos_emitidos) || 0;

  if (total > 0 && emitidos >= total) {
    // contrato terminado para esta línea
    return null;
  }

  // 2) Lógica de fechas: elegir la primera fecha >= hoy
  const todayStart = startOfDay(today);
  const allDates = collectAllBillingDatesFromLineItem(lineItem);

  if (!allDates.length) return null;

  for (const d of allDates) {
    if (d.getTime() >= todayStart.getTime()) {
      return d;
    }
  }

  // Todas las fechas quedaron en el pasado -> ya no hay más pagos útiles
  return null;
}


export function computeNextBillingDateFromLineItems(lineItems, today = new Date()) {
  let minDate = null;

  for (const li of lineItems) {
    const next = getNextBillingDateForLineItem(li, today);
    if (!next) continue;

    if (!minDate || next < minDate) {
      minDate = next;
    }
  }

  return minDate; // puede ser null si no hay ninguna fecha futura
}

























// src/billingEngine.js (añadir después de los exports existentes)

/**
 * Convierte valores de HubSpot en booleano.
 * Se admiten variantes como 'true', '1', 'sí', 'si', etc.
 */
function parseBool(raw) {
  const v = (raw ?? '').toString().toLowerCase();
  return v === 'true' || v === '1' || v === 'sí' || v === 'si' || v === 'yes';
}
/**
 * Calcula y actualiza los campos de una bolsa de horas.
 *
 * - Determina si el line item es una bolsa mirando las propiedades:
 *   - bolsa_de_horas (casilla de verificación)
 *   - tipo_de_bolsa
 *
 * - Calcula:
 *   horas restantes, valor hora, monto consumido/restante, estado (activa/agotada)
 *   y umbrales de alerta.
 *
 * - Devuelve null si el line item NO es una bolsa.
 *
 * @param {object} lineItem - El line item de HubSpot con sus propiedades.
 * @param {Date} today - Fecha de referencia para vigencia (por ahora solo usado para futuros casos).
 * @returns {object|null} Un objeto con { bag, updates, thresholdAlert, estado, modality }
 */

export function computeBagLineItemState(lineItem, today = new Date()) {
  const p = lineItem.properties || {};

  // 1) Determinar si es bolsa
  const esBolsa =
    parseBool(p.bolsa_de_horas) ||
    (!!p.tipo_de_bolsa && p.tipo_de_bolsa !== '');

  if (!esBolsa) return null;

  const tipo = p.tipo_de_bolsa || 'por_horas'; // por_horas / por_monto (si es 'true', lo tratamos como por_horas)

  // 2) Valores base usando TUS nombres de propiedades
  const valorHoraInput = Number(p.bolsa_valor_hora) || 0;
  const horasInput = Number(p.cant__hs_bolsa) || 0; // horas de la bolsa
  const montoInput = Number(p.precio) || 0;         // precio total de la bolsa

  let totalHours = 0;
  let totalMonto = 0;

  // Regla:
  // - por_horas: el humano llena cant__hs_bolsa + bolsa_valor_hora
  // - por_monto: el humano llena precio + bolsa_valor_hora
  if (tipo === 'por_horas' || tipo === 'true') {
    totalHours = horasInput;
    if (montoInput) {
      totalMonto = montoInput;
    } else {
      totalMonto = totalHours * valorHoraInput;
    }
  } else if (tipo === 'por_monto') {
    totalMonto = montoInput;
    if (horasInput) {
      totalHours = horasInput;
    } else if (valorHoraInput) {
      totalHours = totalMonto / valorHoraInput;
    }
  } else {
    // Tipo desconocido: fallback simple
    totalHours = horasInput;
    totalMonto =
      montoInput || (valorHoraInput && totalHours ? totalHours * valorHoraInput : 0);
  }

  // 3) Horas consumidas y restantes
  const hoursConsumed = Number(p.bolsa_horas_consumidas) || 0;
  const hoursRemaining = totalHours - hoursConsumed;

  // 4) Valor/hora efectivo
  let valorHora = valorHoraInput;
  if (!valorHora && totalHours > 0 && totalMonto) {
    valorHora = totalMonto / totalHours;
  }
  if (!totalMonto && totalHours && valorHora) {
    totalMonto = totalHours * valorHora;
  }

  // 5) Monto consumido y restante
  const montoConsumido = hoursConsumed * valorHora;
  const montoRestante = totalMonto - montoConsumido;

  // 6) Estado de la bolsa (usando EXACTAMENTE las opciones válidas de HubSpot)
  // Opciones válidas: Activa, Agotada, Vencida, Pausada, Cerrada
  let estado = 'Activa';
  if (totalHours > 0 || hoursConsumed > 0) {
    if (hoursRemaining <= 0) {
      estado = 'Agotada';
    }
  }
  // (Más adelante podemos usar 'Vencida', 'Pausada', 'Cerrada' según lógica de negocio)

  // 7) ¿Debe avisar por umbral?
  const umbral = Number(p.bolsa_umbral_horas_alerta) || 0;
  const thresholdAlert = umbral > 0 && hoursRemaining <= umbral;

  // 8) Modalidad de facturación de la bolsa
  const modality = p.bolsa_modalidad_facturacion || null;

  return {
    bag: true,
    updates: {
      cant__hs_bolsa: totalHours,
      precio: totalMonto,

      bolsa_horas_consumidas: hoursConsumed,
      bolsa_horas_restantes: hoursRemaining,
      bolsa_valor_hora: valorHora,
      bolsa_monto_consumido: montoConsumido,
      bolsa_monto_restante: montoRestante,
      bolsa_estado: estado, // 👈 ahora manda "Activa" o "Agotada"
    },
    thresholdAlert,
    estado,
    modality,
  };
}

