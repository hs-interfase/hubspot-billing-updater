// src/services/cupo/consumeCupo.js

import { hubspotClient } from '../../hubspotClient.js';
import { parseNumber, safeString, parseBool } from '../../utils/parsers.js';
import { getTodayYMD } from '../../utils/dateUtils.js';
import logger from '../../../lib/logger.js';
import { reportHubSpotError } from '../../utils/hubspotErrorCollector.js';

function reportIfActionable({ objectType, objectId, message, err }) {
  const status = err?.response?.status ?? err?.statusCode ?? null;
  if (status === null) { reportHubSpotError({ objectType, objectId, message }); return; }
  if (status === 429 || status >= 500) return;
  if (status >= 400 && status < 500) reportHubSpotError({ objectType, objectId, message });
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
 * - "Por Horas": ticket.total_de_horas_consumidas
 * - "Por Monto": ticket.total_real_a_facturar (neto sin IVA)
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

  const cupoConsumidoActual = parseNumber(dp.cupo_consumido, 0);
  const cupoTotal = tipoCupo === 'Por Horas'
    ? parseNumber(dp.cupo_total, 0)
    : parseNumber(dp.cupo_total_monto ?? dp.cupo_total, 0);

  // ========== CALCULAR CONSUMO SEGÚN TIPO ==========
  let consumo = 0;

  if (tipoCupo === 'Por Horas') {
    consumo = parseNumber(tp.total_de_horas_consumidas, 0);
    if (consumo === 0) {
      consumo = parseNumber(tp.cantidad_real, 0);
    }
  } else if (tipoCupo === 'Por Monto') {
    consumo = parseNumber(tp.subtotal_real, 0);
  } else {
    const reason = `tipo_de_cupo desconocido: "${tipoCupo}"`;
    logger.info({ module: 'consumeCupo', fn: 'consumeCupoAfterInvoice', dealId, tipoCupo, reason }, 'SKIP consumo de cupo');
    return { consumed: false, reason };
  }

  // ========== VALIDACIÓN 5: Consumo válido ==========
  if (consumo <= 0 || isNaN(consumo)) {
    const reason = `consumo inválido: ${consumo} (NaN o <=0)`;
    logger.info(
      { module: 'consumeCupo', fn: 'consumeCupoAfterInvoice', ticketId, tipoCupo, consumo, cantidad_real: tp.cantidad_real, total_de_horas_consumidas: tp.total_de_horas_consumidas, total_real_a_facturar: tp.total_real_a_facturar, reason },
      'SKIP consumo de cupo'
    );
    return { consumed: false, reason };
  }

  // ========== CALCULAR NUEVO ESTADO ==========
  const cupoConsumidoNuevo = cupoConsumidoActual + consumo;
  const cupoRestanteNuevo = cupoTotal - cupoConsumidoNuevo;

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
    reportIfActionable({ objectType: 'ticket', objectId: String(ticketId), message: 'Error actualizando ticket con consumo de cupo', err });
    logger.warn(
      { module: 'consumeCupo', fn: 'consumeCupoAfterInvoice', ticketId, err },
      'Error actualizando ticket con consumo de cupo (no interrumpe facturación)'
    );
    // No lanzar error: trazabilidad no debe romper facturación
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