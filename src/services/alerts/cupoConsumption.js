// src/services/alerts/cupoConsumption.js

import { hubspotClient } from '../../hubspotClient.js';
import { parseBool, parseNumber, safeString } from '../../utils/parsers.js';
import { getTodayYMD } from '../../utils/dateUtils.js';

/**
 * Aplica consumo REAL de cupo cuando se emite una factura desde un ticket manual.
 * 
 * Lógica:
 * - Solo aplica si line item tiene parte_del_cupo=true
 * - Idempotente: si ticket.of_cupo_consumido=true, no hace nada
 * - Calcula consumo según tipo de cupo del deal
 * - Actualiza cupo_consumido y cupo_restante en Deal
 * - Emite alerta si cupo_restante <= cupo_umbral
 * - Desactiva cupo si cupo_restante <= 0
 * - Registra consumo en Ticket
 * 
 * @param {Object} deal - Deal de HubSpot
 * @param {Object} ticket - Ticket de HubSpot (con factura ya emitida)
 * @param {Object} lineItem - Line Item de HubSpot
 * @param {Object} invoice - Invoice de HubSpot (recién creada)
 */
export async function applyCupoConsumptionAfterInvoice({ deal, ticket, lineItem, invoice }) {
  const dealId = String(deal?.id || deal?.properties?.hs_object_id);
  const ticketId = String(ticket?.id || ticket?.properties?.hs_object_id);
  const lineItemId = String(lineItem?.id || lineItem?.properties?.hs_object_id);
  const invoiceId = String(invoice?.id || invoice?.properties?.hs_object_id);

  const dp = deal?.properties || {};
  const tp = ticket?.properties || {};
  const lp = lineItem?.properties || {};

  console.log(`\n[cupoConsumption] 💳 Aplicando consumo REAL de cupo - Deal ${dealId}, Ticket ${ticketId}, Invoice ${invoiceId}`);

  // 1) Verificar si el line item aplica para cupo
  const parteDelCupo = parseBool(lp.parte_del_cupo);
  if (!parteDelCupo) {
    console.log(`[cupoConsumption] ✓ Line item ${lineItemId} NO aplica para cupo (parte_del_cupo=false). Skip.`);
    return;
  }

  // 2) Verificar si el cupo está activo en el deal
  const cupoActivo = parseBool(dp.cupo_activo);
  if (!cupoActivo) {
    console.log(`[cupoConsumption] ✓ Deal ${dealId} tiene cupo_activo=false. Skip.`);
    return;
  }

  // 3) Verificar idempotencia: si ya se consumió cupo para este ticket
  const yaConsumido = parseBool(tp.of_cupo_consumido);
  if (yaConsumido) {
    console.log(`[cupoConsumption] ✓ Ticket ${ticketId} ya tiene cupo consumido (of_cupo_consumido=true). Skip.`);
    return;
  }

  // 4) Obtener datos del cupo del deal
  const tipoCupo = safeString(dp.tipo_de_cupo);
  const cupoConsumidoActual = parseNumber(dp.cupo_consumido, 0);
  const cupoRestanteActual = parseNumber(dp.cupo_restante, 0);
  const cupoUmbral = parseNumber(dp.cupo_umbral, 0);

  console.log(`[cupoConsumption] 📊 Deal cupo ANTES del consumo:`, {
    tipo_de_cupo: tipoCupo,
    cupo_consumido: cupoConsumidoActual,
    cupo_restante: cupoRestanteActual,
    cupo_umbral: cupoUmbral,
  });

  // 5) Calcular consumo según tipo de cupo
  let consumo = 0;

  if (tipoCupo === "Por Horas") {
    // Usar of_cantidad del ticket (horas reales ajustadas por responsable)
    consumo = parseNumber(tp.of_cantidad, 0);
    console.log(`[cupoConsumption] 💰 Tipo: Por Horas | Consumo: ${consumo} hrs (desde ticket.of_cantidad)`);
  } else if (tipoCupo === "Por Monto") {
    // Usar monto_real_a_facturar del ticket (monto neto sin IVA ajustado por responsable)
    consumo = parseNumber(tp.monto_real_a_facturar, 0);
    console.log(`[cupoConsumption] 💰 Tipo: Por Monto | Consumo: ${consumo} (desde ticket.monto_real_a_facturar)`);
  } else {
    console.log(`[cupoConsumption] ⚠️ tipo_de_cupo desconocido: "${tipoCupo}". Skip.`);
    return;
  }

  if (consumo <= 0) {
    console.log(`[cupoConsumption] ⚠️ Consumo calculado es ${consumo} (<=0). Skip.`);
    return;
  }

  // 6) Calcular nuevos valores de cupo
  const cupoConsumidoNuevo = cupoConsumidoActual + consumo;
  const cupoRestanteNuevo = cupoRestanteActual - consumo;

  console.log(`[cupoConsumption] 📉 Nuevo estado del cupo:`);
  console.log(`   - Consumo a aplicar: ${consumo}`);
  console.log(`   - Cupo consumido: ${cupoConsumidoActual} → ${cupoConsumidoNuevo}`);
  console.log(`   - Cupo restante: ${cupoRestanteActual} → ${cupoRestanteNuevo}`);

  // 7) Preparar propiedades del deal
  const dealUpdateProps = {
    cupo_consumido: String(cupoConsumidoNuevo),
    cupo_restante: String(cupoRestanteNuevo),
    cupo_ultima_actualizacion: getTodayYMD(),
  };

  // 8) Evaluar alerta de umbral
  const alertaYaDisparada = parseBool(dp.cupo_alerta_disparada);
  let alertTriggered = false;

  if (cupoRestanteNuevo <= cupoUmbral && !alertaYaDisparada) {
    console.log(`[cupoConsumption] 🚨 ALERTA DE UMBRAL - Restante (${cupoRestanteNuevo}) <= Umbral (${cupoUmbral})`);
    dealUpdateProps.cupo_alerta_disparada = 'true';
    dealUpdateProps.cupo_alerta_fecha = getTodayYMD();
    alertTriggered = true;
  }

  // 9) Evaluar desactivación de cupo
  let cupoDeactivated = false;
  if (cupoRestanteNuevo <= 0) {
    console.log(`[cupoConsumption] 🔴 CUPO AGOTADO - Desactivando cupo (cupo_restante=${cupoRestanteNuevo})`);
    dealUpdateProps.cupo_activo = 'false';
    cupoDeactivated = true;
  }

  // 10) Actualizar Deal
  try {
    await hubspotClient.crm.deals.basicApi.update(dealId, { properties: dealUpdateProps });
    console.log(`[cupoConsumption] ✅ Deal ${dealId} actualizado con consumo de cupo`);
    console.log(`[cupoConsumption] 📝 Propiedades actualizadas:`, dealUpdateProps);
  } catch (err) {
    console.error(`[cupoConsumption] ❌ Error actualizando deal ${dealId}:`, err?.message);
    throw err;
  }

  // 11) Actualizar Ticket con registro de consumo
  const ticketUpdateProps = {
    of_cupo_consumido: 'true',
    of_cupo_consumido_fecha: getTodayYMD(),
    of_cupo_consumo_valor: String(consumo),
    of_cupo_consumo_invoice_id: invoiceId,
  };

  try {
    await hubspotClient.crm.tickets.basicApi.update(ticketId, { properties: ticketUpdateProps });
    console.log(`[cupoConsumption] ✅ Ticket ${ticketId} marcado con consumo de cupo`);
    console.log(`[cupoConsumption] 📝 Propiedades actualizadas:`, ticketUpdateProps);
  } catch (err) {
    console.error(`[cupoConsumption] ❌ Error actualizando ticket ${ticketId}:`, err?.message);
    throw err;
  }

  // 12) Resumen final
  console.log(`\n[cupoConsumption] 📊 RESUMEN DEL CONSUMO:`);
  console.log(`   Deal: ${dealId}`);
  console.log(`   Ticket: ${ticketId}`);
  console.log(`   Line Item: ${lineItemId}`);
  console.log(`   Invoice: ${invoiceId}`);
  console.log(`   Consumo aplicado: ${consumo} ${tipoCupo === "Por Horas" ? "hrs" : "$"}`);
  console.log(`   Cupo restante: ${cupoRestanteActual} → ${cupoRestanteNuevo}`);
  console.log(`   Alerta disparada: ${alertTriggered ? "SÍ" : "NO"}`);
  console.log(`   Cupo desactivado: ${cupoDeactivated ? "SÍ" : "NO"}`);
  console.log(`[cupoConsumption] ✅ Consumo de cupo completado\n`);
}