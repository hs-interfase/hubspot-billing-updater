// src/services/cupo/consumeCupo.js

import { hubspotClient } from '../../hubspotClient.js';
import { parseNumber, safeString, parseBool } from '../../utils/parsers.js';
import { getTodayYMD } from '../../utils/dateUtils.js';

/**
 * CONSUMO IDEMPOTENTE DE CUPO POST-FACTURACIÓN
 * 
 * REGLAS
 * 1) Ticket es la fuente de verdad: ticket. == invoiceId → ya consumió
 * 2) Solo consume si lineItem.parte_del_cupo == true
 * 3) Solo consume si deal.cupo_activo == true
+ * 4) Un ticket consume cupo UNA SOLA VEZ por invoice (idempotencia por ticket+invoice)
 * TIPO DE CONSUMO:
 * - "Por Horas": ticket.total_de_horas_consumidas (fallback: ticket.of_cantidad)
 * - "Por Monto": ticket.monto_real_a_facturar (neto sin IVA)
 * 
 * ESCRITURAS:
 * - Deal: cupo_consumido, cupo_restante, cupo_ultima_actualizacion, cupo_activo (si agotado)
 * + * - Ticket: of_cupo_consumido, of_cupo_consumo_valor, 

 * 
 * @param {Object} params
 * @param {string} params.dealId - ID del Deal
 * @param {string} params.ticketId - ID del Ticket
 * @param {string} params.lineItemId - ID del Line Item (puede ser null)
 * @param {string} params.invoiceId - ID de la Invoice recién creada
 * @returns {Object} { consumed, reason, consumo, cupoRestanteNuevo }
 */

export async function consumeCupoAfterInvoice({ dealId, ticketId, lineItemId, invoiceId }) {
  console.log(`\n[consumeCupo] 💳 Iniciando validación de consumo de cupo`);
  console.log(`   Deal: ${dealId}`);
  console.log(`   Ticket: ${ticketId}`);
  console.log(`   Line Item: ${lineItemId || 'N/A'}`);
  console.log(`   Invoice: ${invoiceId}`);

  // ========== VALIDACIÓN 0: Invoice ID válido ==========
  if (!invoiceId || invoiceId === 'undefined' || invoiceId === 'null') {
    const reason = 'invoiceId inválido o vacío';
    console.log(`[consumeCupo] ⊘ SKIP: ${reason}`);
    return { consumed: false, reason };
  }
 
// ========== RE-LEER DATOS NECESARIOS ==========
  let deal, ticket, lineItem;

  try {
    // Re-leer Deal
    deal = await hubspotClient.crm.deals.basicApi.getById(dealId, [
      'cupo_activo', 'tipo_de_cupo', 'cupo_consumido', 'cupo_restante',
      'cupo_total', 'cupo_total_monto'
    ]);

    // Re-leer Ticket
    ticket = await hubspotClient.crm.tickets.basicApi.getById(ticketId, [
      'total_de_horas_consumidas',
      'of_cantidad', 'monto_real_a_facturar'
    ]);

    // Re-leer Line Item si existe
    if (lineItemId && lineItemId !== 'undefined' && lineItemId !== 'null') {
      lineItem = await hubspotClient.crm.lineItems.basicApi.getById(lineItemId, ['parte_del_cupo']);
    }
  } catch (err) {
    console.error(`[consumeCupo] ❌ Error re-leyendo datos:`, err?.message);
    return { consumed: false, reason: 'error al leer datos de HubSpot' };
  }
 
const dp = deal?.properties || {};
  const tp = ticket?.properties || {};
  const lp = lineItem?.properties || {};
 
  // ========== VALIDACIÓN 1: Idempotencia por Ticket + Invoice ==========
  if (invoiceIdEnTicket === invoiceId) {
    const reason = 'ticket ya consumió cupo con esta invoice (idempotencia)';
    console.log(`[consumeCupo] ⊘ SKIP: ${reason}`);
    return { consumed: false, reason };
  }

  // ========== VALIDACIÓN 2: Line Item identificable ==========
  if (!lineItemId || lineItemId === 'undefined' || lineItemId === 'null') {
    const reason = 'lineItemId no identificable';
    console.log(`[consumeCupo] ⊘ SKIP: ${reason}`);
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


// ========== ACTUALIZAR TICKET (IDEMPOTENCIA + TRAZABILIDAD + VALOR) ==========
  const ticketUpdateProps = {
    of_cupo_consumido: 'true',
    of_cupo_consumo_valor: String(consumo),
  };
  try {
    await hubspotClient.crm.tickets.basicApi.update(ticketId, { properties: ticketUpdateProps });
    console.log(`[consumeCupo] ✅ Ticket ${ticketId} marcado con consumo`);
} catch (err) {
    console.error(`[consumeCupo] ⚠️ Error actualizando ticket ${ticketId}:`, err?.message);
    // No lanzar error: trazabilidad no debe romper facturación
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