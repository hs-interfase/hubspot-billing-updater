// src/services/cupo/consumeCupo.js

import { hubspotClient } from '../../hubspotClient.js';
import { parseNumber, safeString, parseBool } from '../../utils/parsers.js';
import { getTodayYMD } from '../../utils/dateUtils.js';
import logger from '../../../lib/logger.js';
import { reportHubSpotError } from '../../utils/hubspotErrorCollector.js';

/**
 * CÁLCULO PURO DEL CONSUMO DE CUPO (sin HubSpot, testeable).
 *
 * Detección de NOTA DE CRÉDITO por SIGNO: un consumo negativo DEVUELVE cupo
 * (resta), no depende de la marca `nc`. Solo 0 y NaN se consideran inválidos.
 *
 * @param {{tipoCupo:string, ticketProps?:object, dealProps?:object}} params
 * @returns {{ok:boolean, reason?:string, consumo?:number, cupoConsumidoActual?:number,
 *            cupoTotal?:number, cupoConsumidoNuevo?:number, cupoRestanteNuevo?:number,
 *            cupoDeactivated?:boolean}}
 */
export function calcularConsumoCupo({ tipoCupo, ticketProps = {}, dealProps = {} }) {
  const tp = ticketProps || {};
  const dp = dealProps || {};

  const cupoConsumidoActual = parseNumber(dp.cupo_consumido, 0);
  const cupoTotal = tipoCupo === 'Por Horas'
    ? parseNumber(dp.cupo_total, 0)
    : parseNumber(dp.cupo_total_monto ?? dp.cupo_total, 0);

  let consumo = 0;
  if (tipoCupo === 'Por Horas') {
    const horas = parseNumber(tp.total_de_horas_consumidas, 0);
    const cantidad = parseNumber(tp.cantidad_real, 0);
    // NC por horas: la cantidad negativa (edición manual) manda, así devolvemos
    // horas al cupo aunque total_de_horas_consumidas traiga un valor viejo/positivo.
    if (cantidad < 0) {
      consumo = cantidad;
    } else {
      consumo = horas !== 0 ? horas : cantidad;
    }
  } else if (tipoCupo === 'Por Monto') {
    consumo = parseNumber(tp.subtotal_real, 0);
  } else {
    return { ok: false, reason: `tipo_de_cupo desconocido: "${tipoCupo}"` };
  }

  // NC: un consumo NEGATIVO es válido y DEVUELVE cupo. Solo se rechazan 0 y NaN.
  if (consumo === 0 || isNaN(consumo)) {
    return { ok: false, reason: `consumo inválido: ${consumo} (NaN o cero)` };
  }

  const cupoConsumidoNuevo = cupoConsumidoActual + consumo;
  const cupoRestanteNuevo = cupoTotal - cupoConsumidoNuevo;
  const cupoDeactivated = cupoRestanteNuevo <= 0;

  // SOBRE-CRÉDITO: una NC que acredita más de lo consumido deja cupo_consumido
  // negativo. NO se pisa el valor (el dato fiel es la evidencia y reconcilia si se
  // corrige); solo se señaliza para que el caller lo avise como accionable — casi
  // siempre es un error de carga de la NC.
  const cupoSobreCredito = cupoConsumidoNuevo < 0;

  return {
    ok: true,
    consumo,
    cupoConsumidoActual,
    cupoTotal,
    cupoConsumidoNuevo,
    cupoRestanteNuevo,
    cupoDeactivated,
    cupoSobreCredito,
  };
}

/**
 * CONSUMO IDEMPOTENTE DE CUPO POST-FACTURACIÓN
 *
 * REGLAS
 * 1) Ticket es la fuente de verdad: ticket.cupo_consumo_invoice_id == invoiceId → ya consumió
 * 2) Solo consume si lineItem.parte_del_cupo == true
 * 3) Solo consume si deal.cupo_activo == true
 * 4) Un ticket consume cupo UNA SOLA VEZ por invoice (idempotencia por ticket+invoice)
 * TIPO DE CONSUMO:
 * - "Por Horas": ticket.cantidad_real / total_de_horas_consumidas
 * - "Por Monto": ticket.subtotal_real (neto sin IVA)
 *
 * NOTA DE CRÉDITO: si el consumo es NEGATIVO (monto/cantidad < 0, por edición
 * manual del ticket), se DEVUELVE cupo (resta). Se detecta por signo, no por flag.
 *
 *
 * ESCRITURAS:
 * - Deal: cupo_consumido, cupo_restante, cupo_ultima_actualizacion, cupo_activo (si agotado)
 * - Ticket: of_cupo_consumido, of_cupo_consumo_valor
 */
export async function consumeCupoAfterInvoice({ dealId, ticketId, lineItemId, invoiceId }) {
  logger.info(
    { module: 'consumeCupo', fn: 'consumeCupoAfterInvoice', dealId, ticketId, lineItemId: lineItemId || null, invoiceId },
    'Iniciando validación de consumo de cupo'
  );

  // ========== VALIDACIÓN 0: Invoice ID válido ==========
  if (!invoiceId || invoiceId === 'undefined' || invoiceId === 'null') {
    const reason = 'invoiceId inválido o vacío';
    logger.info({ module: 'consumeCupo', fn: 'consumeCupoAfterInvoice', invoiceId, reason }, 'SKIP consumo de cupo');
    return { consumed: false, reason };
  }

  // ========== RE-LEER DATOS NECESARIOS ==========
  let deal, ticket, lineItem;

  try {
    deal = await hubspotClient.crm.deals.basicApi.getById(dealId, [
      'cupo_activo',
      'tipo_de_cupo',
      'cupo_consumido',
      'cupo_restante',
      'cupo_total',
      'cupo_total_monto',
      'cupo_umbral',
      'cupo_estado',
    ]);

    ticket = await hubspotClient.crm.tickets.basicApi.getById(ticketId, [
      'total_de_horas_consumidas',
      'cantidad_real',
      'total_real_a_facturar',
      'subtotal_real',
      'cupo_consumo_invoice_id',
      'of_cupo_consumido',
      'of_invoice_id',
    ]);

    if (lineItemId && lineItemId !== 'undefined' && lineItemId !== 'null') {
      lineItem = await hubspotClient.crm.lineItems.basicApi.getById(lineItemId, ['parte_del_cupo']);
    }
  } catch (err) {
    logger.error(
      { module: 'consumeCupo', fn: 'consumeCupoAfterInvoice', dealId, ticketId, lineItemId, err },
      'Error re-leyendo datos de HubSpot'
    );
    return { consumed: false, reason: 'error al leer datos de HubSpot' };
  }

  const dp = deal?.properties || {};
  const tp = ticket?.properties || {};
  const lp = lineItem?.properties || {};

  // ========== VALIDACIÓN 1: Idempotencia por cupo ==========
  const cupoInvoiceIdEnTicket = safeString(tp.cupo_consumo_invoice_id || tp.of_cupo_consumo_invoice_id);

  if (cupoInvoiceIdEnTicket && cupoInvoiceIdEnTicket === String(invoiceId)) {
    const reason = 'ticket ya consumió cupo con esta invoice (idempotencia cupo_consumo_invoice_id)';
    logger.info({ module: 'consumeCupo', fn: 'consumeCupoAfterInvoice', ticketId, invoiceId, reason }, 'SKIP consumo de cupo');
    return { consumed: false, reason };
  }

  // ========== VALIDACIÓN 2: Line Item identificable ==========
  if (!lineItemId || lineItemId === 'undefined' || lineItemId === 'null') {
    const reason = 'lineItemId no identificable';
    logger.info({ module: 'consumeCupo', fn: 'consumeCupoAfterInvoice', reason }, 'SKIP consumo de cupo');
    return { consumed: false, reason };
  }

  // ========== VALIDACIÓN 3: parte_del_cupo ==========
  const parteDelCupo = parseBool(lp.parte_del_cupo);
  if (!parteDelCupo) {
    const reason = 'line item NO es parte_del_cupo';
    logger.info({ module: 'consumeCupo', fn: 'consumeCupoAfterInvoice', lineItemId, parteDelCupo: lp.parte_del_cupo, reason }, 'SKIP consumo de cupo');
    return { consumed: false, reason };
  }

  // ========== VALIDACIÓN 4: cupo_activo ==========
  const cupoActivo = parseBool(dp.cupo_activo);
  if (!cupoActivo) {
    const reason = 'deal.cupo_activo != true';
    logger.info({ module: 'consumeCupo', fn: 'consumeCupoAfterInvoice', dealId, cupoActivo: dp.cupo_activo, reason }, 'SKIP consumo de cupo');
    return { consumed: false, reason };
  }

  // ========== LEER ESTADO ACTUAL DEL CUPO ==========
  const tipoCupo = safeString(dp.tipo_de_cupo);

  if (!tipoCupo) {
    logger.warn(
      { module: 'consumeCupo', fn: 'consumeCupoAfterInvoice', dealId },
      'cupo_activo=true pero tipo_de_cupo vacío'
    );
    return { consumed: false, reason: 'tipo_de_cupo vacío' };
  }

  // ========== CALCULAR CONSUMO (helper puro, testeable) ==========
  // NC por signo: consumo negativo devuelve cupo. Detalle en calcularConsumoCupo.
  const calc = calcularConsumoCupo({ tipoCupo, ticketProps: tp, dealProps: dp });
  if (!calc.ok) {
    logger.info(
      { module: 'consumeCupo', fn: 'consumeCupoAfterInvoice', dealId, ticketId, tipoCupo, consumo: calc.consumo, cantidad_real: tp.cantidad_real, total_de_horas_consumidas: tp.total_de_horas_consumidas, total_real_a_facturar: tp.total_real_a_facturar, reason: calc.reason },
      'SKIP consumo de cupo'
    );
    return { consumed: false, reason: calc.reason };
  }

  const { consumo, cupoConsumidoActual, cupoTotal, cupoConsumidoNuevo, cupoRestanteNuevo, cupoSobreCredito } = calc;

  // NC que acredita más de lo consumido: el valor real (negativo) se escribe tal
  // cual — es la evidencia y reconcilia si se corrige. Solo se avisa al deal para
  // que el equipo revise (probable error de carga de la NC).
  if (cupoSobreCredito) {
    logger.warn(
      { module: 'consumeCupo', fn: 'consumeCupoAfterInvoice', dealId, ticketId, consumo, cupoConsumidoActual, cupoConsumidoNuevo },
      'Nota de crédito excede el cupo consumido: cupo_consumido queda negativo'
    );
    reportHubSpotError({
      level: 'warn',
      objectType: 'deal',
      objectId: String(dealId),
      message: `Nota de crédito acredita más cupo del consumido (crédito ${consumo}, consumido previo ${cupoConsumidoActual} → nuevo ${cupoConsumidoNuevo}). Revisar la NC (ticket ${ticketId}).`,
    });
  }

  logger.debug(
    { module: 'consumeCupo', fn: 'consumeCupoAfterInvoice', dealId, tipoCupo, cupoTotal, cupoConsumidoActual, cupoConsumidoNuevo, cupoRestanteNuevo, consumo },
    'Estado del cupo antes y después del consumo'
  );

  // ========== PREPARAR PROPIEDADES DEL DEAL ==========
  const dealUpdateProps = {
    cupo_consumido: String(cupoConsumidoNuevo),
    cupo_restante: String(cupoRestanteNuevo),
    cupo_ultima_actualizacion: getTodayYMD(),
  };

  // ========== DESACTIVAR SI SE AGOTA ==========
  let cupoDeactivated = false;
  if (cupoRestanteNuevo <= 0) {
    logger.info(
      { module: 'consumeCupo', fn: 'consumeCupoAfterInvoice', dealId, cupoRestanteNuevo },
      'Cupo agotado, desactivando'
    );
    dealUpdateProps.cupo_activo = 'false';
    cupoDeactivated = true;
  }

  /*// ✅ A) Actualizar cupo_estado según reglas
  const { calculateCupoEstado } = await import('../../utils/propertyHelpers.js');
  const newCupoEstado = calculateCupoEstado({
    cupo_activo: dealUpdateProps.cupo_activo ?? dp.cupo_activo,
    cupo_restante: dealUpdateProps.cupo_restante,
    cupo_umbral: dp.cupo_umbral,
  });
  
  if (newCupoEstado) {
    dealUpdateProps.cupo_estado = newCupoEstado;
    console.log(`[consumeCupo] 📊 cupo_estado → ${newCupoEstado}`);
  }

  // ========== ACTUALIZAR DEAL ==========
  try {
    await hubspotClient.crm.deals.basicApi.update(dealId, { properties: dealUpdateProps });
    console.log(`[consumeCupo] ✅ Deal ${dealId} actualizado`);
    console.log(`[consumeCupo] 📝 Props:`, dealUpdateProps);
  } catch (err) {
    console.error(`[consumeCupo] ❌ Error! actualizando deal ${dealId}:`, err?.message);
    throw err;
  }
*/

  // ✅ A) Actualizar cupo_estado según reglas
  const { calculateCupoEstado } = await import('../../utils/propertyHelpers.js');

  const merged = { ...dp, ...dealUpdateProps };

  const newCupoEstado = calculateCupoEstado({
    cupo_activo: merged.cupo_activo,
    tipo_de_cupo: merged.tipo_de_cupo,
    cupo_total: merged.cupo_total,
    cupo_total_monto: merged.cupo_total_monto,
    cupo_consumido: merged.cupo_consumido,
    cupo_restante: merged.cupo_restante,
    cupo_umbral: merged.cupo_umbral,
  });

  dealUpdateProps.cupo_estado = newCupoEstado;

  // ========== ACTUALIZAR DEAL ==========
  try {
    await hubspotClient.crm.deals.basicApi.update(dealId, { properties: dealUpdateProps });
    logger.info(
      { module: 'consumeCupo', fn: 'consumeCupoAfterInvoice', dealId, cupoEstado: newCupoEstado || '(vacío)', dealUpdateProps },
      'Deal actualizado con nuevo estado de cupo'
    );
  } catch (err) {
    logger.error(
      { module: 'consumeCupo', fn: 'consumeCupoAfterInvoice', dealId, err },
      'Error actualizando deal'
    );
    throw err;
  }

  // ========== ACTUALIZAR TICKET (IDEMPOTENCIA + TRAZABILIDAD + VALOR) ==========
  const ticketUpdateProps = {
    of_cupo_consumido: 'true',
    of_cupo_consumo_valor: String(consumo),
    cupo_consumo_invoice_id: String(invoiceId),
    of_cupo_consumido_fecha: getTodayYMD(),
  };

  try {
    const cleanProps = Object.fromEntries(
      Object.entries(ticketUpdateProps).filter(([_, v]) => v !== undefined)
    );

    if (Object.keys(cleanProps).length === 0) {
      logger.debug(
        { module: 'consumeCupo', fn: 'consumeCupoAfterInvoice', ticketId },
        'SKIP: sin props para actualizar ticket'
      );
    } else {
      await hubspotClient.crm.tickets.basicApi.update(ticketId, { properties: cleanProps });
      logger.info(
        { module: 'consumeCupo', fn: 'consumeCupoAfterInvoice', ticketId },
        'Ticket marcado con consumo de cupo'
      );
    }
  } catch (err) {
    // OJO: esta marca NO es solo trazabilidad — es la LLAVE DE IDEMPOTENCIA.
    // El cupo YA se descontó del deal (update de arriba). Si la marca no se escribe,
    // la próxima corrida no ve `cupo_consumo_invoice_id` y DESCUENTA DE NUEVO → doble
    // consumo → cupo_activo='false' espurio que bloquea facturación legítima.
    // El hubspotClient ya reintenta los transitorios (withRetry); si llegamos acá es
    // un fallo duro. NO re-lanzamos (no romper la facturación ya emitida), pero lo
    // escalamos como accionable para que un humano reconcilie el cupo.
    logger.error(
      { module: 'consumeCupo', fn: 'consumeCupoAfterInvoice', dealId, ticketId, invoiceId, consumo, err },
      'CRÍTICO: cupo descontado del deal pero NO se pudo marcar el ticket — riesgo de doble consumo'
    );
    reportHubSpotError({
      level: 'error',
      objectType: 'ticket',
      objectId: String(ticketId),
      message: `Cupo YA descontado del deal ${dealId} (valor ${consumo}, invoice ${invoiceId}) pero NO se pudo escribir la marca de idempotencia en el ticket. RIESGO DE DOBLE CONSUMO en la próxima corrida — reconciliar a mano: escribir cupo_consumo_invoice_id=${invoiceId} en este ticket o restar ${consumo} de cupo_consumido del deal.`,
    });
    // No re-lanzar: la factura ya se emitió; romper acá no revierte el consumo.
  }

  // ========== RESUMEN ==========
  logger.info(
    { module: 'consumeCupo', fn: 'consumeCupoAfterInvoice', dealId, ticketId, tipoCupo, consumo, cupoRestanteNuevo, cupoDeactivated },
    'Consumo de cupo completado'
  );

  return {
    consumed: true,
    consumo,
    cupoRestanteNuevo,
    cupoDeactivated,
  };
}

/*
 * CATCHES con reportHubSpotError agregados:
 *   - tickets.basicApi.update() en bloque de trazabilidad → objectType="ticket"
 *     (NO re-throw preservado: "trazabilidad no debe romper facturación")
 *
 * NO reportados:
 *   - deals.basicApi.update() → deals excluidos de reporte (Regla 4)
 *   - deals/tickets/lineItems.basicApi.getById → lecturas
 *
 * Confirmación: "No se reportan warns a HubSpot; solo errores 4xx (≠429)"
 */