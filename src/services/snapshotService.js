// src/services/snapshotService.js

import { parseNumber, safeString, parseBool } from '../utils/parsers.js';
import { toHubSpotDateOnly } from '../utils/dateUtils.js';
import logger from '../../lib/logger.js';
import { reportIfActionable } from '../utils/errorReporting.js';
import { reportHubSpotError } from '../utils/hubspotErrorCollector.js';
import {
  IVA_UY_TAX_GROUP_ID,
  IVA_PY_TAX_GROUP_ID,
  EXENTO_TAX_GROUP_ID,
} from '../config/constants.js';

/**
 * Determina la frecuencia del ticket según las reglas del negocio.
 *
 * FUENTE DE VERDAD: Line Item properties
 *
 * Valores internos esperados en la propiedad del ticket:
 * - Único
 * - Irregular
 * - Frecuente
 * - Mensual
 * - Bimestral
 * - Trimestral
 * - Semestral
 * - Anual
 *
 * Prioridad:
 * 1. Irregular: si irregular = true
 * 2. Único: si no hay frecuencia o si la frecuencia indica pago único
 * 3. Frecuencias conocidas de HubSpot
 * 4. Frecuente: cualquier otra frecuencia no reconocida
 *
 * ⚠️ Esta es la ÚNICA función que debe usarse para calcular frecuencia de facturación.
 */
export function determineTicketFrequency(lineItem) {
  const lp = lineItem?.properties || {};

  const isIrregular = parseBool(lp.irregular);
  if (isIrregular) return 'Irregular';

  const freq = (
    lp.recurringbillingfrequency ||
    lp.hs_recurring_billing_frequency ||
    ''
  )
    .toString()
    .trim()
    .toLowerCase();

  if (
    !freq ||
    freq === 'unico' ||
    freq === 'único' ||
    freq === 'one_time' ||
    freq === 'one-time' ||
    freq === 'pago_unico' ||
    freq === 'pago único'
  ) {
    return 'Único';
  }

  const frequencyMap = {
    monthly: 'Mensual',
    quarterly: 'Trimestral',
    per_six_months: 'Semestral',
    annually: 'Anual',

    // Por si HubSpot o tu sistema llega a usar estas variantes
    bimonthly: 'Bimestral',
    bi_monthly: 'Bimestral',
    every_two_months: 'Bimestral',
  };

  return frequencyMap[freq] || 'Frecuente';
}

/**
 * Detecta taxes del line item según hs_tax_rate_group_id y exonera_irae.
 *
 * IVA:
 * - IVA UY => 'true'
 * - IVA PY => 'true'
 * - IVA UY + IRAE => 'true'
 * - Exento IVA => 'false'
 * - IRAE puro => 'false'
 * - Cualquier otro valor => ''
 *
 * IRAE:
 * - exonera_irae = false / no => 'true'
 * - exonera_irae = true / sí => 'false'
 * - fallback por tax group IRAE / IVA UY + IRAE => 'true'
 * - Cualquier otro valor => ''
 */


function parseYesNoBool(value) {
  if (value === null || value === undefined || value === '') return null;

  const raw = String(value).trim().toLowerCase();

  if (['true', '1', 'si', 'sí', 'yes', 'y'].includes(raw)) return true;
  if (['false', '0', 'no', 'n'].includes(raw)) return false;

  return null;
}

export function detectIVA(lineItem) {
  const raw = String(lineItem?.properties?.hs_tax_rate_group_id ?? '').trim();

  let result;

  if (
    raw &&
    (
      (IVA_UY_TAX_GROUP_ID && raw === IVA_UY_TAX_GROUP_ID) ||
      (IVA_PY_TAX_GROUP_ID && raw === IVA_PY_TAX_GROUP_ID)
    )
  ) {
    result = 'true';
  } else if (
    raw &&
    (EXENTO_TAX_GROUP_ID && raw === EXENTO_TAX_GROUP_ID)
  ) {
    result = 'false';
  } else {
    result = '';
  }

  logger.info({
    module: 'snapshotService',
    fn: 'detectIVA',
    raw,
    result,
    IVA_UY_TAX_GROUP_ID,
    IVA_PY_TAX_GROUP_ID,
    EXENTO_TAX_GROUP_ID,
  }, '[SNAPSHOT][IVA][A] detectIVA()');

  // AVISO (auditoría 2026-07-18, D3·Q4): si no se pudo determinar el IVA, of_iva queda ''
  // y la factura saldría con el neto SIN IVA sin ningún error visible. Se MANTIENE el
  // comportamiento (no bloquea), pero se avisa SIEMPRE para que un humano lo vea antes de
  // que un automático emita 22%/10% abajo. El caso peligroso es un tax group presente pero
  // NO reconocido (ID nuevo, o env IVA_*_TAX_GROUP_ID faltante/cambiada por swap de portal).
  if (result === '') {
    const taxGroupPresente = raw !== '';
    logger.warn({
      module: 'snapshotService', fn: 'detectIVA',
      lineItemId: lineItem?.id, raw, taxGroupPresente,
      IVA_UY_TAX_GROUP_ID, IVA_PY_TAX_GROUP_ID, EXENTO_TAX_GROUP_ID,
    }, taxGroupPresente
      ? '[SNAPSHOT][IVA][AVISO] tax group NO reconocido → of_iva="" (factura sin IVA)'
      : '[SNAPSHOT][IVA][AVISO] sin tax group asignado → of_iva=""');
    reportHubSpotError({
      level: taxGroupPresente ? 'error' : 'warn',
      objectType: 'line_item',
      objectId: String(lineItem?.id ?? ''),
      message: taxGroupPresente
        ? `IVA indeterminado: el tax group "${raw}" NO coincide con ninguno configurado (IVA_UY_TAX_GROUP_ID / IVA_PY_TAX_GROUP_ID / IVA_EXENTO_TAX_GROUP_ID). of_iva queda "" → la factura saldría con el NETO SIN IVA. Revisar que la env var del portal apunte a este tax group, o corregir el tax group del line item ANTES de emitir.`
        : `IVA indeterminado: el line item no tiene tax group asignado (hs_tax_rate_group_id vacío). of_iva queda "" → la factura saldría sin IVA. Asignar el tax group correcto antes de emitir.`,
    });
  }

  return result;
}

function detectIRAE(lineItem) {
  const lp = lineItem?.properties || {};
  const rawTaxGroupId = String(lp.hs_tax_rate_group_id ?? '').trim();
  const exoneraIraeRaw = lp.exonera_irae;
  const exoneraIrae = parseYesNoBool(exoneraIraeRaw);

  let result;

  // Fuente principal: propiedad explícita del Line Item.
  // exonera_irae = no / false => aplica IRAE.
  // exonera_irae = sí / true => no aplica IRAE.
  if (exoneraIrae === false) {
    result = 'true';
  } else if (exoneraIrae === true) {
    result = 'false';
  } else {
    result = '';
  }

  logger.info({
    module: 'snapshotService',
    fn: 'detectIRAE',
    rawTaxGroupId,
    exonera_irae: exoneraIraeRaw,
    exoneraIrae,
    result,
  }, '[SNAPSHOT][IRAE][A] detectIRAE()');

  return result;
}

export function extractLineItemSnapshots(lineItem, deal) {
  const lp = lineItem?.properties || {};

  // Valores base
  const precioUnitario = parseNumber(lp.price, 0); // = valor hora para cupos
  const cantidad = parseNumber(lp.quantity, 0); // = horas para cupos
  const costoUnitario = parseNumber(lp.hs_cost_of_goods_sold, 0);

  // TAX & DISCOUNT desde Line Item
  const descuentoPorcentaje = parseNumber(lp.hs_discount_percentage, 0) / 100; // ✅ Convertir basis points a %
  const descuentoMonto = parseNumber(lp.discount, 0); // descuento por unidad en moneda del deal
  const ivaValue = detectIVA(lineItem);
  const iraeValue = detectIRAE(lineItem);

  // 🐛 DEBUG: Log valores fuente y destino
  logger.info({ module: 'snapshotService', fn: 'extractLineItemSnapshots', lineItemId: lineItem?.id }, `[DBG][SNAPSHOT] Line Item ID: ${lineItem?.id}`);
  logger.info({
    module: 'snapshotService',
    fn: 'extractLineItemSnapshots',
    lineItemId: lineItem?.id,
    hs_discount_percentage: lp.hs_discount_percentage,
    discount: lp.discount,
    hs_tax_rate_group_id: lp.hs_tax_rate_group_id,
    exonera_irae: lp.exonera_irae,
  }, '[DBG][SNAPSHOT] Tax/Discount SOURCE');

  logger.info({
    module: 'snapshotService',
    fn: 'extractLineItemSnapshots',
    lineItemId: lineItem?.id,
    descuento_en_porcentaje: descuentoPorcentaje,
    descuento_por_unidad_real: descuentoMonto,
    of_iva: ivaValue,
    exonera_irae: iraeValue === 'true' ? 'false' : iraeValue === 'false' ? 'true' : '',
  }, '[DBG][SNAPSHOT] Tax/Discount TARGET (ticket)');

  // Definición 2026-07-07 (+ copia-directa 2026-07-10): costo_total_usd (LI) = FUENTE DE VERDAD del costo (total, USD).
  //   of_costo (moneda del negocio) = costo_total_usd × dolar(LI); fallback legacy cogs × cantidad.
  //   of_costo_usd                  = COPIA DIRECTA de costo_total_usd (null si no está; NO se deriva del cogs).
  // Al leer costo_total_usd directo, el ticket ya no nace con costo 0 cuando el cogs se
  // deriva en la misma corrida (hallazgo escenario F).
  const tieneCostoUsd = lp.costo_total_usd != null && lp.costo_total_usd !== '';
  const costoTotalUsdLi = parseNumber(lp.costo_total_usd, 0);
  const dolarLi = parseNumber(lp.dolar, 0);
  const dealCurrency = String(deal?.properties?.deal_currency_code || '').toUpperCase();

  let costoTotal; // en moneda del negocio → of_costo
  if (tieneCostoUsd) {
    costoTotal = dolarLi > 0 ? costoTotalUsdLi * dolarLi
      : (dealCurrency === 'USD' || !dealCurrency ? costoTotalUsdLi : costoUnitario * cantidad);
  } else {
    costoTotal = costoUnitario * cantidad;
  }

  // TC sellado del ticket: el dólar de la LÍNEA (por línea; en migrados = el Dolar de su OF)
  // con fallback al dólar del negocio. Alimenta las props calculadas of_costo_usd/of_margen_usd
  // (of_costo ÷ dolar). Al facturar, propagateInvoiceStateToTicket lo pisa con el dólar de la
  // factura de Nodum (dólar real del momento de facturación).
  const liDolar = parseNumber(lp.dolar, 0);
  const dealDolar = parseNumber(deal?.properties?.dolar, 0);
  const dolarTicket = liDolar > 0 ? liDolar : (dealDolar > 0 ? dealDolar : null);

  // Calcular monto total (price × quantity, ya viene calculado en amount)
  const montoTotal = parseNumber(lp.amount, precioUnitario * cantidad);

  // Frecuencia simplificada (fuente: Line Item)
  const frecuencia = determineTicketFrequency(lineItem);

  // "repetitivo" (legacy): depende de si el Line Item tiene billing frequency (no vacío y no "unico")
  const rawFreq = (lp.recurringbillingfrequency || lp.hs_recurring_billing_frequency || '')
    .toString()
    .trim()
    .toLowerCase();

const repetitivo = !!rawFreq && ![
  'unico',
  'único',
  'one_time',
  'one-time',
  'pago_unico',
  'pago único',
].includes(rawFreq);


  // ⚠️  of_rubro: validar antes de incluir (async validation se hará en createTicketSnapshots)
  const baseSnapshots = {
    of_cantidad_de_pagos: parseNumber(lp.hs_recurring_billing_number_of_payments, null),
    of_producto_nombres: safeString(lp.name),
    of_descripcion_producto: safeString(lp.description),
    of_rubro: safeString(lp.servicio),
    of_subrubro: safeString(lp.subrubro),
    area: safeString(lp.area), // select del line item → select homónimo del ticket (mismas opciones)
    of_codigo_rubro: safeString(lp.of_codigo_rubro),
    momento_de_facturacion: safeString(lp.momento_de_facturacion),
    observaciones: safeString(lp.mensaje_para_responsable),
    nota: safeString(lp.nota),
    of_pais_operativo: safeString(deal?.properties?.pais_operativo || lp.pais_operativo),
    monto_unitario_real: precioUnitario,
    cantidad_real: cantidad,
    descuento_en_porcentaje: descuentoPorcentaje,
    descuento_por_unidad_real: descuentoMonto,
    of_aplica_para_cupo: getCupoType(lineItem, deal), // "Por Horas", "Por Monto" o null
    of_costo: costoTotal, // ✅ costo total en moneda del negocio (fuente: costo_total_usd × dolar; fallback cogs × cantidad)
    of_margen: montoTotal - costoTotal, // ✅ margen bruto = subtotal pre-IVA (lp.amount) − costo total. Antes leía lp.hs_margin (no se fetchea → siempre 0).
    // Costo en USD del ticket: COPIA DIRECTA de costo_total_usd del LI (fuente de verdad, ya en USD,
    // presente al crear el ticket). Directo = sin la carrera de timing que tenía la versión derivada
    // de cogs/dólar. Es un número EDITABLE en el ticket (alguien puede corregirlo a mano); of_margen_usd
    // (calc) lo referencia, así una corrección manual del costo reajusta el margen sola.
    of_costo_usd: parseNumber(lp.costo_total_usd, null),
    dolar: dolarTicket, // TC sellado del ticket (LI.dolar → deal.dolar); alimenta la conversión USD de facturación/margen

    of_iva: ivaValue,
    exonera_irae: iraeValue === 'true' ? 'false' : iraeValue === 'false' ? 'true' : '',
    reventa: parseBool(lp.reventa),
    opera_trading: parseBool(lp.opera_trading),
    of_frecuencia_de_facturacion: frecuencia, // ✅ Irregular / Único / Frecuente
    nc: parseBool(lp.nc), // NC: se setea a mano en el LI y se propaga al ticket (solo registro)
    repetitivo,
    // Entidad del grupo que emite: select del line item → select homónimo del ticket (mismas opciones: Interfase UY / ISA UY / ISA PY / Interfase PY)
    entidad_facturadora: safeString(lp.empresa_que_factura),
    // Fecha de inicio de facturación del line item (distinta de fecha_resolucion_esperada, que es la próxima)
    fecha_inicio_de_facturacion: toHubSpotDateOnly(lp.hs_recurring_billing_start_date || lp.fecha_inicio_de_facturacion),
    // Facturación automática: espejo del checkbox del line item (enum booleancheckbox: "true"/"false")
    facturacion_automatica: parseBool(lp.facturacion_automatica) ? 'true' : 'false',
    // Intercompany (regla informes 2026-07-07): el deal UY espejo factura al grupo (su monto
    // = costo del PY), así que su facturación NO cuenta para informes (FACT 0 vía calc prop
    // of_facturacion_usd); su MARGEN sí (monto UY − costo real UY). Fuente: es_mirror_de_py.
    of_intercompany: parseBool(deal?.properties?.es_mirror_de_py) ? 'true' : 'false',

    // Contrato / progreso de pagos (para la vista de Victoria): se copian del LI al
    // ticket. of_cantidad_de_pagos (arriba) = total; of_pagos_restantes = progreso.
    of_inicio_del_contrato: toHubSpotDateOnly(lp.inicio_del_contrato),
    of_fin_del_contrato: toHubSpotDateOnly(lp.fin_del_contrato),
    of_pagos_restantes: parseNumber(lp.pagos_restantes, null),

    // Paramétrica: copia del ajuste aplicado en el LI, para el card de Victoria.
    // tipo_de_parametrica va como texto (evita depender de opciones del select).
    of_tipo_de_parametrica: safeString(lp.tipo_de_parametrica),
    of_monto_unitario_original: parseNumber(lp.monto_unitario_original, null),
    of_porcentaje_ultimo_ajuste: parseNumber(lp.porcentaje_ultimo_ajuste, null),
    of_fecha_ultimo_ajuste: toHubSpotDateOnly(lp.fecha_ultimo_ajuste),
  };

  logger.info({
    module: 'snapshotService',
    fn: 'extractLineItemSnapshots',
    lineItemId: lineItem?.id,
    monto_unitario_real: precioUnitario,
    cantidad_real: cantidad,
    descuento_en_porcentaje: descuentoPorcentaje,
    descuento_por_unidad_real: descuentoMonto,
    of_iva: ivaValue,
    exonera_irae: baseSnapshots.exonera_irae,
  }, '[SNAPSHOT][CRITICOS][AUTO]');

  logger.info({
    module: 'snapshotService',
    fn: 'extractLineItemSnapshots',
    lineItemId: lineItem?.id,
    of_iva: baseSnapshots.of_iva,
    exonera_irae: baseSnapshots.exonera_irae,
  }, '[SNAPSHOT][IVA][B] extractLineItemSnapshots() before return');

  return baseSnapshots;
}

/**
 * Convierte el tipo de cupo del line item a formato HubSpot.
 * Si parte_del_cupo es false, devuelve null (no aplica cupo).
 * Si es true, devuelve "Por Horas" o "Por Monto" según tipo_de_cupo del deal.
 */
function getCupoType(lineItem, deal) {
  const lp = lineItem?.properties || {};
  const dp = deal?.properties || {};

  const aplicaCupo = parseBool(lp.parte_del_cupo);
  if (!aplicaCupo) return null; // No aplica cupo

  const tipoCupo = safeString(dp.tipo_de_cupo);
  // Normalizar el valor
  if (tipoCupo.toLowerCase().includes('hora')) return 'Por Horas';
  if (tipoCupo.toLowerCase().includes('monto')) return 'Por Monto';

  return null; // Valor desconocido
}

/**
 * Extrae datos del Deal que se copian al Ticket.
 * Nota: hubspot_owner_id NO se extrae aquí (viene del Line Item).
 */
export function extractDealSnapshots(deal) {
  const dp = deal?.properties || {};

  return {
    of_moneda: safeString(dp.deal_currency_code || 'USD'),
    of_tipo_de_cupo: safeString(dp.tipo_de_cupo),
    of_pais_operativo: safeString(dp.pais_operativo),
    of_propietario_secundario: safeString(dp.hubspot_owner_id),
    mig_id_crm_origen: safeString(dp.id_crm_origen),
    mig_id_cliente_nodum: safeString(dp.id_cliente_nodum),
  };
}

/**
 * Deriva el producto del ticket desde deal.producto (checkbox múltiple, valores
 * separados por ";"). Con un solo valor lo usa directo; con varios intenta
 * matchear contra el nombre del line item y si no matchea toma el primero.
 * Los valores del catálogo coinciden con las opciones de ticket.of_producto
 * (alineadas en ambos portales el 2026-07-07).
 */
export function deriveProductoTicket(dealProducto, liName) {
  const values = safeString(dealProducto).split(';').map(v => v.trim()).filter(Boolean);
  if (!values.length) return '';
  if (values.length === 1) return values[0];
  const name = safeString(liName).toLowerCase();
  const hit = values.find(v => name.includes(v.toLowerCase()));
  return hit || values[0];
}

/**
 * Combina snapshots de Deal y Line Item en un objeto listo para el Ticket.
 *
 * NUEVO MODELO DE FECHAS (sin período):
 * - expectedDate (planificada/esperada desde Line Item) → fecha_resolucion_esperada
 * - orderedDate (cuando se manda a facturar) → of_fecha_de_facturacion
 *
 * Regla: En MANUAL normal, orderedDate debe ser null (NO se setea).
 * En AUTO, orderedDate == expectedDate.
 * En FACTURAR AHORA, orderedDate = HOY y expectedDate sigue siendo la planificada del Line Item.
 *
 * @param {Object} deal
 * @param {Object} lineItem
 * @param {string} expectedDate (YYYY-MM-DD)
 * @param {string|null} orderedDate (YYYY-MM-DD) o null
 * @returns {Object}
 */
export function createTicketSnapshots(deal, lineItem, expectedDate, orderedDate = null) {
  const dealData = extractDealSnapshots(deal);
  const lineItemData = extractLineItemSnapshots(lineItem, deal); // Pasar deal para cupo
  const lp = lineItem?.properties || {};
  const dp = deal?.properties || {};

  // Producto del ticket (select of_producto, mismo catálogo que deal.producto)
  const ofProducto = deriveProductoTicket(dp.producto, lp.name);

  // Motivo cancelación: primero motivo_pausa del line item, luego closed_lost_reason del deal
  const motivoCancelacion = safeString(lp.motivo_pausa) || safeString(dp.closed_lost_reason);

  // ✅ C) Construir título del invoice
  const liShort = safeString(lp.name) || `Flota`;
  const invoiceTitle = `${safeString(dp.dealname) || 'Deal'} - ${liShort} - ${expectedDate}`;

  const out = {
    ...dealData,
    ...lineItemData,

    // ✅ B) FECHA ESPERADA/PLANIFICADA (siempre desde billDateYMD usado en key)
    // Convertir YYYY-MM-DD a timestamp ms (midnight UTC)
    fecha_resolucion_esperada: expectedDate ? toHubSpotDateOnly(expectedDate) : null,

    // 📅 FECHA REAL (solo desde Invoice cuando Nodum = EMITIDA)
    // of_fecha_facturacion_real: (se setea después)

    motivo_cancelacion_del_ticket: motivoCancelacion,

    // Producto (select con catálogo, para vistas por producto)
    of_producto: ofProducto,

    // ✅ C) Título del invoice para usar después
    subject: invoiceTitle,
  };

  logger.info({
    module: 'snapshotService',
    fn: 'createTicketSnapshots',
    of_iva: out.of_iva,
  }, '[SNAPSHOT][IVA][C] createTicketSnapshots() after merge');

  // ✅ Garantizar que of_iva siempre sea 'true' o 'false', nunca '' o null
  const ivaRaw = out.of_iva;
  out.of_iva = ivaRaw === 'true' ? 'true' : ivaRaw === 'false' ? 'false' : '';
  logger.info({
    module: 'snapshotService',
    fn: 'createTicketSnapshots',
    before: ivaRaw,
    after: out.of_iva,
  }, '[SNAPSHOT][IVA][FIX] of_iva normalizado');

  // ✅ Garantizar que exonera_irae siempre sea 'true' o 'false', nunca null
  const iraeRaw = out.exonera_irae;
  out.exonera_irae = iraeRaw === 'true' ? 'true' : iraeRaw === 'false' ? 'false' : '';
  
  logger.info({
    module: 'snapshotService',
    fn: 'createTicketSnapshots',
    before: iraeRaw,
    after: out.exonera_irae,
  }, '[SNAPSHOT][IRAE][FIX] exonera_irae normalizado');

  // ✅ B) FECHA ORDENADA A FACTURAR (solo si aplica, ej: urgente)
  // Convertir YYYY-MM-DD a timestamp ms
  if (orderedDate) {
    out.of_fecha_de_facturacion = toHubSpotDateOnly(orderedDate);
  }

  return out;
}

/*
 * ─────────────────────────────────────────────────────────────
 * CATCHES con reportHubSpotError agregados: NINGUNO
 *
 * Este archivo no contiene bloques try/catch con ticketId ni
 * lineItemId en contexto de error accionable de HubSpot API.
 * Es un módulo puro de transformación de datos (sin llamadas a
 * hubspotClient), por lo que reportIfActionable está disponible
 * pero no se invoca en esta versión.
 *
 * Confirmación: "No se reportan warns a HubSpot;
 *                solo errores 4xx (≠429)" — regla implementada
 *                en reportIfActionable(), lista para uso si se
 *                agregan llamadas API en el futuro.
 * ─────────────────────────────────────────────────────────────
 */
