import { hubspotClient, getDealWithLineItems } from './hubspotClient.js';
import {
  updateLineItemSchedule,
  computeNextBillingDateFromLineItems,
  computeBagLineItemState,
} from './billingEngine.js';

// Helpers chiquitos para no repetir lógica de textos


// Utilidades de presentación y construcción de mensajes.

function formatMoney(value, currency) {
  const num = Number(value);
  if (Number.isNaN(num)) return `no definido ${currency || ''}`.trim();
  return `${num.toFixed(2)} ${currency || ''}`.trim();
}


function buildLineItemBlock(li, idx, moneda, notaNegocio) {
  const p = li.properties || {};
  const nombreProducto = p.name || `Línea ${idx + 1}`;
  const servicio = p.servicio || '(servicio no definido)';
  const frecuencia =
    p.frecuencia_de_facturacion ||
    p.facturacion_frecuencia_de_facturacion ||
    'no definida';

  // Fecha de inicio de facturación
  let inicioLineaTexto = 'no definida';
  if (p.fecha_inicio_de_facturacion) {
    const str = p.fecha_inicio_de_facturacion.toString().trim();
    const m = str.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) {
      const [_, y, mm, dd] = m;
      inicioLineaTexto = `${dd}/${mm}/${y}`;
    } else {
      const d = new Date(str);
      if (!Number.isNaN(d.getTime())) {
        const y = d.getFullYear();
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        inicioLineaTexto = `${dd}/${mm}/${y}`;
      }
    }
  }

  // Contrato / término (como antes)
  const contratoA = p.contrato_a || '(sin definir)';
  const terminoA = p.termino_a || '(sin definir)';
  let duracion = 'no definida';
  if (contratoA !== '(sin definir)' && terminoA !== '(sin definir)') {
    duracion = `${contratoA} / ${terminoA}`;
  } else if (contratoA !== '(sin definir)') {
    duracion = `${contratoA}`;
  } else if (terminoA !== '(sin definir)') {
    duracion = `${terminoA}`;
  }

  const tercerosRaw = (p.terceros || '').toString().toLowerCase();
  const esTerceros =
    tercerosRaw === 'true' ||
    tercerosRaw === '1' ||
    tercerosRaw === 'sí' ||
    tercerosRaw === 'si' ||
    tercerosRaw === 'yes';
  const tercerosTexto = esTerceros ? 'Sí, facturación a terceros.' : 'No.';

  const notaLinea = p.nota;
  const notaLineaTexto = notaLinea ? `- Nota de la línea: ${notaLinea}` : null;

  const qty = Number(p.quantity || 1);
  const unitPrice = Number(p.price || 0);
  const total = qty * unitPrice;

  // 🔍 Datos de pagos / término para debug
  const recurringTerm = p.hs_recurring_billing_period; // "5", "12", etc.
  const totalPagos = Number(p.total_de_pagos ?? 0);
  const pagosEmitidos = Number(p.pagos_emitidos ?? 0);
  const pagosRestantes = Number(p.pagos_restantes ?? 0);

  const parts = [
    `Servicio`,
    `- Producto: ${nombreProducto}`,
    `- Servicio: ${servicio}`,
    `- Frecuencia de facturación: ${frecuencia}`,
  ];

  if (inicioLineaTexto !== 'no definida') {
    parts.push(`- Fecha de inicio de facturación: ${inicioLineaTexto}`);
  }
  if (duracion !== 'no definida') {
    parts.push(`- Duración del contrato: ${duracion}`);
  }

  // 🔍 Bloque explícito de debug (lo que pediste)
  parts.push(
    `- DEBUG contrato_a: ${contratoA}`,
    `- DEBUG termino_a: ${terminoA}`,
    `- DEBUG hs_recurring_billing_period: ${recurringTerm ?? '(sin definir)'}`,
    `- Pagos: ${pagosEmitidos} / ${totalPagos}`,
    `- Pagos restantes: ${pagosRestantes}`
  );

  parts.push(
    `- Facturación a terceros: ${tercerosTexto}`,
    `- Cantidad: ${qty}`,
    `- Precio unitario: ${formatMoney(unitPrice, moneda)}`,
    `- Importe total: ${formatMoney(total, moneda)}`
  );

  if (notaLineaTexto) parts.push(notaLineaTexto);

  /////////////////////////
  /////////////////////////

  // ¿Es una bolsa?
  const esBolsa =
    parseBoolFromHubspot(p.bolsa_de_horas) ||
    parseBoolFromHubspot(p['Bolsa de Horas']) ||
    (!!p.tipo_de_bolsa && p.tipo_de_bolsa !== '');

  if (esBolsa) {
    const totalH = Number(p.horas_bolsa) || 0;
    const consumidas = Number(p.bolsa_horas_consumidas) || 0;
    const restantes =
      typeof p.bolsa_horas_restantes !== 'undefined'
        ? Number(p.bolsa_horas_restantes)
        : totalH - consumidas;
    const valorHora = Number(p.bolsa_valor_hora) || 0;
    const montoConsumido = Number(p.bolsa_monto_consumido) || 0;
    const montoRestante = Number(p.bolsa_monto_restante) || 0;
    const estadoBolsa = p.bolsa_estado || 'activa';
    const umbral = Number(p.bolsa_umbral_horas_alerta) || 0;

    parts.push(
      `- Bolsa de horas: ${restantes}h restantes de ${totalH}h (consumidas: ${consumidas}h)`
    );
    parts.push(
      `- Monto consumido/restante: ${formatMoney(
        montoConsumido,
        moneda
      )} / ${formatMoney(montoRestante, moneda)}`
    );
    parts.push(`- Valor por hora: ${formatMoney(valorHora, moneda)}`);
    parts.push(`- Estado de la bolsa: ${estadoBolsa}`);
    if (umbral > 0 && restantes <= umbral) {
      parts.push(
        `- Aviso: quedan ${restantes}h (≤ ${umbral}h), revisar renovación de bolsa.`
      );
    }
  }
 //////////////////////
 /////////////////////

  return parts.join('\n');
}


function getLineItemStartDateIso(li) {
  const p = li.properties || {};
  const raw = p.fecha_inicio_de_facturacion;
  if (!raw) return null;

  // Si ya viene en formato YYYY-MM-DD, lo devolvemos tal cual
  const str = raw.toString().trim();
  const m = str.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    return str;
  }

  // Fallback genérico
  const d = new Date(str);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${mm}-${dd}`;
}


function buildNextBillingMessage({ deal, nextDate, lineItems }) {
  const props = deal.properties || {};
  const moneda = props.deal_currency_code || '(sin definir)';
  const notaNegocio = props.nota || null;

  const yyyy = nextDate.getFullYear();
  const mm = String(nextDate.getMonth() + 1).padStart(2, '0');
  const dd = String(nextDate.getDate()).padStart(2, '0');
  const nextDateIso = `${yyyy}-${mm}-${dd}`;

  const withDates = lineItems
    .map((li) => ({ li, iso: getLineItemStartDateIso(li) }))
    .filter((x) => x.iso);

  let relevantLineItems;
  if (withDates.length > 0) {
    relevantLineItems = withDates
      .filter((x) => x.iso === nextDateIso)
      .map((x) => x.li);
    if (!relevantLineItems.length) {
      relevantLineItems = withDates.map((x) => x.li);
    }
  } else {
    relevantLineItems = lineItems;
  }

  const lineBlocks = relevantLineItems.map((li, idx) =>
    [
      `------------------------------`,
      buildLineItemBlock(li, idx + 1, moneda, notaNegocio),
    ].join('\n')
  );
  return lineBlocks.join('\n\n');
}


function normalizeFreq(raw) {
  return (raw ?? '').toString().trim().toLowerCase();
}

function isIrregular(freqRaw) {
  return normalizeFreq(freqRaw) === 'irregular';
}

function isOneTime(freqRaw) {
  const f = normalizeFreq(freqRaw);
  return (
    f === 'única' ||
    f === 'unica' ||
    f === 'pago único' ||
    f === 'pago unico'
  );
}

function isRecurrent(freqRaw) {
  const f = normalizeFreq(freqRaw);
  return ['mensual', 'bimestral', 'trimestral', 'semestral', 'anual'].includes(f);
}

function parseBoolFromHubspot(raw) {
  const v = (raw ?? '').toString().toLowerCase();
  return v === 'true' || v === '1' || v === 'sí' || v === 'si' || v === 'yes';
}

export async function processDeal(dealId) {
  if (!dealId) {
    throw new Error('processDeal requiere un dealId');
  }

  const { deal, lineItems } = await getDealWithLineItems(dealId);
  const dealProps = deal.properties || {};

  // 1) Si la facturación NO está activa, no tocamos nada
  if (!parseBoolFromHubspot(dealProps.facturacion_activa)) {
    return {
      dealId,
      dealName: dealProps.dealname,
      skipped: true,
      reason: 'facturacion_activa es false',
    };
  }

  if (!lineItems.length) {
    // Sin líneas, no hay nada que programar
    return {
      dealId,
      dealName: dealProps.dealname,
      skipped: true,
      reason: 'sin line items',
    };
  }

  /**
   * Recorremos las líneas una sola vez:
   *   - Si es una bolsa, actualizamos sus propiedades (horas restantes, estado, montos…),
   *     y sólo actualizamos calendario si la modalidad no es renovacion_por_agotamiento.
   *   - Si no es bolsa, actualizamos calendario si es recurrente.
   * Además, guardamos la fecha más temprana en que una bolsa requiere atención (bagNextDate).
   */
  let bagNextDate = null;

for (const li of lineItems) {
  // DEBUG 1: ver propiedades crudas del line item
  console.log('DEBUG lineItem props', li.id, li.properties);

  const bagState = computeBagLineItemState(li);

  // DEBUG 2: ver qué devuelve computeBagLineItemState
  console.log('DEBUG bagState', li.id, bagState);

  if (bagState) {
    const { updates, thresholdAlert, estado, modality } = bagState;

    // DEBUG 3: ver qué se va a escribir en HubSpot
    console.log('DEBUG bag updates', li.id, updates);

    // 2) Actualiza campos de bolsa en la línea
    if (updates && Object.keys(updates).length > 0) {
      await hubspotClient.crm.lineItems.basicApi.update(li.id, { properties: updates });
      li.properties = { ...(li.properties || {}), ...updates };
    }

    // 3) Actualiza calendario sólo en prepago/postpago (recurrentes)
    const freq = li.properties?.frecuencia_de_facturacion;
    if (modality !== 'renovacion_por_agotamiento' && isRecurrent(freq)) {
      await updateLineItemSchedule(li);
    }

    // 4) Si está agotada o bajo umbral, la próxima acción debe ser hoy
    if (estado === 'agotada' || thresholdAlert) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      if (!bagNextDate || bagNextDate > today) {
        bagNextDate = today;
      }
    }
  } else {
    // Línea normal: actualiza calendario si es recurrente
    const freq = li.properties?.frecuencia_de_facturacion;
    if (isRecurrent(freq)) {
      await updateLineItemSchedule(li);
    }
  }
}

  // 5) Calcula la próxima fecha a partir de calendarios de todas las líneas
  let nextBillingDate = computeNextBillingDateFromLineItems(lineItems);

  // Si hay una alerta de bolsa anterior, priorizarla
  if (bagNextDate && (!nextBillingDate || bagNextDate < nextBillingDate)) {
    nextBillingDate = bagNextDate;
  }

  if (!nextBillingDate) {
    // No hay fechas futuras en ninguna línea
    return {
      dealId,
      dealName: dealProps.dealname,
      skipped: true,
      reason: 'sin fechas futuras (contrato completado o mal configurado)',
    };
  }

  // 6) Construye el mensaje en base a la próxima fecha y las líneas
  const message = buildNextBillingMessage({
    deal,
    nextDate: nextBillingDate,
    lineItems,
  });

  // 7) Pasa la fecha a ISO (YYYY-MM-DD) para guardarla en el negocio
  const yyyy = nextBillingDate.getFullYear();
  const mm = String(nextBillingDate.getMonth() + 1).padStart(2, '0');
  const dd = String(nextBillingDate.getDate()).padStart(2, '0');
  const nextDateStr = `${yyyy}-${mm}-${dd}`;

  // 8) Deriva facturacion_frecuencia_de_facturacion a nivel negocio
  let dealBillingFrequency = dealProps.facturacion_frecuencia_de_facturacion;
  const hasRecurrent = lineItems.some((li) =>
    isRecurrent(li.properties?.frecuencia_de_facturacion)
  );
  const hasIrregular = lineItems.some((li) =>
    isIrregular(li.properties?.frecuencia_de_facturacion)
  );
  const hasOneTime = lineItems.some((li) =>
    isOneTime(li.properties?.frecuencia_de_facturacion)
  );

  if (hasRecurrent) {
    dealBillingFrequency = 'Recurrente';
  } else if (hasIrregular) {
    dealBillingFrequency = 'Irregular';
  } else if (hasOneTime) {
    dealBillingFrequency = 'Pago Único';
  }

  // 9) Actualiza el negocio con la próxima fecha, el mensaje y la frecuencia
  const updateBody = {
    properties: {
      facturacion_proxima_fecha: nextDateStr,
      facturacion_mensaje_proximo_aviso: message,
      facturacion_frecuencia_de_facturacion: dealBillingFrequency,
    },
  };

  await hubspotClient.crm.deals.basicApi.update(dealId, updateBody);

  // 10) Devuelve información resumida
  return {
    dealId,
    dealName: dealProps.dealname,
    nextBillingDate: nextDateStr,
    lineItemsCount: lineItems.length,
    facturacion_frecuencia_de_facturacion: dealBillingFrequency,
  };
}

