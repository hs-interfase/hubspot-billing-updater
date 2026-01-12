// src/services/cupo/consumeCupo.js

import { hubspotClient } from '../../hubspotClient.js';
import { parseNumber, safeString, parseBool } from '../../utils/parsers.js';
import { getTodayYMD } from '../../utils/dateUtils.js';

/**
 * CONSUMO IDEMPOTENTE DE CUPO POST-FACTURACIÓN
 * 
 * REGLAS (fuente de verdad):
 * 1) Invoice es la única fuente de verdad: invoice.of_cupo_consumido == true → ya consumió
 * 2) Solo consume si lineItem.parte_del_cupo == true
 * 3) Solo consume si deal.cupo_activo == true
 * 4) Una invoice consume cupo UNA SOLA VEZ (idempotencia por invoice)
 * 
 * TIPO DE CONSUMO:
 * - "Por Horas": ticket.total_de_horas_consumidas (fallback: ticket.of_cantidad)
 * - "Por Monto": ticket.monto_real_a_facturar (neto sin IVA)
 * 
 * ESCRITURAS:
 * - Deal: cupo_consumido, cupo_restante, cupo_ultima_actualizacion, cupo_activo (si agotado)
 * - Invoice: of_cupo_consumido, of_cupo_consumo_valor, of_cupo_consumo_fecha
 * - Ticket: of_cupo_consumido, of_cupo_consumo_invoice_id (trazabilidad)
 * 
 * @param {Object} params
 * @param {Object} params.deal - Deal de HubSpot
 * @param {Object} params.ticket - Ticket de HubSpot
 * @param {Object} params.lineItem - Line Item de HubSpot (puede ser null)
 * @param {Object} params.invoice - Invoice de HubSpot (recién creada)
 * @returns {Object} { consumed, reason, consumo, cupoRestanteNuevo }
 */
export async function consumeCupoAfterInvoice({ deal, ticket, lineItem, invoice }) {
  const dealId = String(deal?.id || deal?.properties?.hs_object_id);
  const ticketId = String(ticket?.id || ticket?.properties?.hs_object_id);
  const lineItemId = lineItem ? String(lineItem?.id || lineItem?.properties?.hs_object_id) : null;
  const invoiceId = String(invoice?.id || invoice?.properties?.hs_object_id);

  const dp = deal?.properties || {};
  const tp = ticket?.properties || {};
  const lp = lineItem?.properties || {};
  const ip = invoice?.properties || {};
  
  // 🔄 Si faltan datos de consumo, re-leer el ticket con esas props
  try {
    const tipoCupoTmp = safeString(dp.tipo_de_cupo);
    const ticketKey = ticket?.id || ticket?.properties?.hs_object_id;
    const propsToFetch = [];

    if (tipoCupoTmp === 'Por Horas') {
      if (!tp.total_de_horas_consumidas) propsToFetch.push('total_de_horas_consumidas');
      if (!tp.of_cantidad) propsToFetch.push('of_cantidad');
    } else if (tipoCupoTmp === 'Por Monto') {
      if (!tp.monto_real_a_facturar) propsToFetch.push('monto_real_a_facturar');
    }

    if (ticketKey && propsToFetch.length > 0) {
      const refreshed = await hubspotClient.crm.tickets.basicApi.getById(String(ticketKey), propsToFetch);
      const refreshedProps = refreshed?.properties || {};
      // Actualizar el objeto tp con los valores recargados
      if (tipoCupoTmp === 'Por Horas') {
        if (refreshedProps.total_de_horas_consumidas)
          tp.total_de_horas_consumidas = refreshedProps.total_de_horas_consumidas;
        if (refreshedProps.of_cantidad)
          tp.of_cantidad = refreshedProps.of_cantidad;
      } else if (tipoCupoTmp === 'Por Monto') {
        if (refreshedProps.monto_real_a_facturar)
          tp.monto_real_a_facturar = refreshedProps.monto_real_a_facturar;
      }
    }
  } catch (e) {
    console.warn(`[consumeCupo] ⚠️ No se pudo recargar ticket para consumo:`, e?.message);
  }

  console.log(`\n[consumeCupo] 💳 Iniciando validación de consumo de cupo`);
  console.log(`   Deal: ${dealId}`);
  console.log(`   Ticket: ${ticketId}`);
  console.log(`   Line Item: ${lineItemId || 'N/A'}`);
  console.log(`   Invoice: ${invoiceId}`);

  // ========== VALIDACIÓN 1: Idempotencia por Invoice ==========
  const yaConsumido = parseBool(ip.of_cupo_consumido);
  if (yaConsumido) {
    const reason = 'invoice ya consumió cupo (idempotencia)';
    console.log(`[consumeCupo] ⊘ SKIP: ${reason}`);
    console.log(`   of_cupo_consumido: ${ip.of_cupo_consumido}`);
    return { consumed: false, reason };
  }

  // ========== VALIDACIÓN 2: Line Item identificable ==========
  if (!lineItemId || lineItemId === 'undefined' || lineItemId === 'null') {
    const reason = 'lineItemId no identificable';
    console.log(`[consumeCupo] ⊘ SKIP: ${reason}`);
    console.log(`   of_line_item_ids: ${tp.of_line_item_ids}`);
    return { consumed: false, reason };
  }

  // ========== VALIDACIÓN 3: parte_del_cupo ==========
  const parteDelCupo = parseBool(lp.parte_del_cupo);
  if (!parteDelCupo) {
    const reason = 'line item NO es parte_del_cupo';
    console.log(`[consumeCupo] ⊘ SKIP: ${reason}`);
    console.log(`   parte_del_cupo: ${lp.parte_del_cupo}`);
    return { consumed: false, reason };
  }

  // ========== VALIDACIÓN 4: cupo_activo ==========
  const cupoActivo = parseBool(dp.cupo_activo);
  if (!cupoActivo) {
    const reason = 'deal.cupo_activo != true';
    console.log(`[consumeCupo] ⊘ SKIP: ${reason}`);
    console.log(`   cupo_activo: ${dp.cupo_activo} (parsed: ${cupoActivo})`);
    return { consumed: false, reason };
  }

  // ========== LEER ESTADO ACTUAL DEL CUPO ==========
  const tipoCupo = safeString(dp.tipo_de_cupo);
  
  // ⚠️ Warning si cupo_activo=true pero tipo_de_cupo vacío
  if (!tipoCupo) {
    console.warn(`[consumeCupo] ⚠️ Deal ${dealId} cupo_activo=true pero tipo_de_cupo vacío`);
    const reason = 'tipo_de_cupo vacío';
    return { consumed: false, reason };
  }
  
  const cupoConsumidoActual = parseNumber(dp.cupo_consumido, 0);
  const cupoTotal = tipoCupo === "Por Horas" 
    ? parseNumber(dp.cupo_total, 0)
    : parseNumber(dp.cupo_total_monto ?? dp.cupo_total, 0);

  console.log(`[consumeCupo] 📊 Estado ANTES del consumo:`);
  console.log(`   tipo_de_cupo: ${tipoCupo}`);
  console.log(`   cupo_total: ${cupoTotal}`);
  console.log(`   cupo_consumido: ${cupoConsumidoActual}`);

  // ========== CALCULAR CONSUMO SEGÚN TIPO ==========
  let consumo = 0;

  if (tipoCupo === "Por Horas") {
    // Priorizar total_de_horas_consumidas, fallback a of_cantidad
    consumo = parseNumber(tp.total_de_horas_consumidas, 0);
    if (consumo === 0) {
      consumo = parseNumber(tp.of_cantidad, 0);
      console.log(`[consumeCupo] 💰 Tipo: Por Horas | Consumo: ${consumo} hrs (desde ticket.of_cantidad)`);
    } else {
      console.log(`[consumeCupo] 💰 Tipo: Por Horas | Consumo: ${consumo} hrs (desde ticket.total_de_horas_consumidas)`);
    }
  } else if (tipoCupo === "Por Monto") {
    // Monto neto sin IVA
    consumo = parseNumber(tp.monto_real_a_facturar, 0);
    console.log(`[consumeCupo] 💰 Tipo: Por Monto | Consumo: ${consumo} (desde ticket.monto_real_a_facturar)`);
  } else {
    const reason = `tipo_de_cupo desconocido: "${tipoCupo}"`;
    console.log(`[consumeCupo] ⊘ SKIP: ${reason}`);
    return { consumed: false, reason };
  }

  // ========== VALIDACIÓN 5: Consumo válido ==========
  if (consumo <= 0 || isNaN(consumo)) {
    const reason = `consumo inválido: ${consumo} (NaN o <=0)`;
    console.log(`[consumeCupo] ⊘ SKIP: ${reason}`);
    console.log(`   of_cantidad: ${tp.of_cantidad}`);
    console.log(`   total_de_horas_consumidas: ${tp.total_de_horas_consumidas}`);
    console.log(`   monto_real_a_facturar: ${tp.monto_real_a_facturar}`);
    return { consumed: false, reason };
  }

  // ========== CALCULAR NUEVO ESTADO ==========
  const cupoConsumidoNuevo = cupoConsumidoActual + consumo;
  const cupoRestanteNuevo = cupoTotal - cupoConsumidoNuevo;

  console.log(`[consumeCupo] 📉 Nuevo estado del cupo:`);
  console.log(`   Consumo a aplicar: ${consumo}`);
  console.log(`   Cupo consumido: ${cupoConsumidoActual} → ${cupoConsumidoNuevo}`);
  console.log(`   Cupo restante: ${cupoTotal - cupoConsumidoActual} → ${cupoRestanteNuevo}`);

  // ========== PREPARAR PROPIEDADES DEL DEAL ==========
  const dealUpdateProps = {
    cupo_consumido: String(cupoConsumidoNuevo),
    cupo_restante: String(cupoRestanteNuevo),
    cupo_ultima_actualizacion: getTodayYMD(),
  };

  // ========== DESACTIVAR SI SE AGOTA ==========
  let cupoDeactivated = false;
  if (cupoRestanteNuevo <= 0) {
    console.log(`[consumeCupo] 🔴 CUPO AGOTADO - Desactivando cupo (cupo_restante=${cupoRestanteNuevo})`);
    dealUpdateProps.cupo_activo = 'false';
    cupoDeactivated = true;
  }

  // ========== ACTUALIZAR DEAL ==========
  try {
    await hubspotClient.crm.deals.basicApi.update(dealId, { properties: dealUpdateProps });
    console.log(`[consumeCupo] ✅ Deal ${dealId} actualizado`);
    console.log(`[consumeCupo] 📝 Props:`, dealUpdateProps);
  } catch (err) {
    console.error(`[consumeCupo] ❌ Error actualizando deal ${dealId}:`, err?.message);
    throw err;
  }

  // ========== ACTUALIZAR INVOICE (IDEMPOTENCIA) ==========
  const invoiceUpdateProps = {
    of_cupo_consumido: 'true',
    of_cupo_consumo_valor: String(consumo),
    of_cupo_consumo_fecha: getTodayYMD(),
  };

  try {
    await hubspotClient.crm.commerce.invoices.basicApi.update(invoiceId, { properties: invoiceUpdateProps });
    console.log(`[consumeCupo] ✅ Invoice ${invoiceId} marcada con consumo`);
  } catch (err) {
    console.error(`[consumeCupo] ❌ Error actualizando invoice ${invoiceId}:`, err?.message);
    throw err;
  }

  // ========== ACTUALIZAR TICKET (TRAZABILIDAD) ==========
  const ticketUpdateProps = {
    of_cupo_consumido: 'true',
    of_cupo_consumo_invoice_id: invoiceId,
  };

  try {
    await hubspotClient.crm.tickets.basicApi.update(ticketId, { properties: ticketUpdateProps });
    console.log(`[consumeCupo] ✅ Ticket ${ticketId} marcado con consumo`);
  } catch (err) {
    console.error(`[consumeCupo] ⚠️ Error actualizando ticket ${ticketId}:`, err?.message);
    // No lanzar error, es solo trazabilidad
  }

  // ========== RESUMEN ==========
  console.log(`\n[consumeCupo] 📊 RESUMEN:`);
  console.log(`   Consumo aplicado: ${consumo} ${tipoCupo === "Por Horas" ? "hrs" : "$"}`);
  console.log(`   Cupo restante: ${cupoRestanteNuevo}`);
  console.log(`   Cupo desactivado: ${cupoDeactivated ? "SÍ" : "NO"}`);
  console.log(`[consumeCupo] ✅ Consumo completado\n`);

  return { 
    consumed: true, 
    consumo, 
    cupoRestanteNuevo,
    cupoDeactivated,
  };
}