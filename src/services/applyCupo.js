// src/services/applyCupo.js

import { hubspotClient } from '../hubspotClient.js';
import { parseNumber, safeString } from '../utils/parsers.js';
import { getTodayYMD } from '../utils/dateUtils.js';
import { isDryRun } from '../config/constants.js';

/**
 * Aplica consumo de cupo después de crear una factura.
 * 
 * REGLAS:
 * - CUPO POR HORAS: Consume total_de_horas_consumidas (o of_cantidad si no existe)
 * - CUPO POR MONTO: Consume monto_real_a_facturar (neto sin IVA)
 * - Actualiza: cupo_consumido, cupo_restante, cupo_ultima_actualizacion en Deal
 * - Guarda of_cupo_consumo_resultante en Ticket para trazabilidad
 * - ⚠️ NO bloquea cupo_activo automáticamente (se gestiona manualmente)
 * 
 * @param {Object} params
 * @param {Object} params.ticket - Ticket de HubSpot
 * @param {string} params.invoiceId - ID de la factura creada
 */
export async function applyCupoAfterInvoiceCreated({ ticket, invoiceId }) {
  const tp = ticket.properties || {};
  const dealId = tp.of_deal_id;
  
  // Verificar si el ticket aplica para cupo
  const aplicaParaCupo = tp.of_aplica_para_cupo; // "Por Horas" | "Por Monto" | null
  if (!aplicaParaCupo) {
    console.log('[applyCupo] Ticket no aplica para cupo, skip');
    return;
  }
  
  if (!dealId) {
    console.warn('[applyCupo] Ticket sin of_deal_id, no se puede actualizar cupo');
    return;
  }
  
  console.log('\n========== APLICANDO CONSUMO DE CUPO ==========');
  console.log('Ticket ID:', ticket.id);
  console.log('Invoice ID:', invoiceId);
  console.log('Deal ID:', dealId);
  console.log('Tipo de aplicación:', aplicaParaCupo);
  
  try {
    // 1) Obtener el Deal para leer propiedades de cupo
    const deal = await hubspotClient.crm.deals.basicApi.getById(dealId, [
      'tipo_de_cupo',
      'cupo_total_horas',
      'cupo_total_monto',
      'cupo_total',
      'cupo_consumido',
      'cupo_restante',
      'cupo_activo',
    ]);
    const dp = deal.properties || {};
    
    // 2) Determinar tipo de cupo y total
    const tipoCupo = safeString(dp.tipo_de_cupo).toUpperCase();
    let cupoTotal = 0;
    
    if (tipoCupo.includes('HORA')) {
      cupoTotal = parseNumber(dp.cupo_total_horas, 0);
    } else if (tipoCupo.includes('MONTO')) {
      cupoTotal = parseNumber(dp.cupo_total_monto, 0);
    }
    
    // Fallback a cupo_total genérico
    if (cupoTotal === 0) {
      cupoTotal = parseNumber(dp.cupo_total, 0);
    }
    
    console.log('Cupo total del Deal:', cupoTotal);
    console.log('Tipo de cupo:', tipoCupo);
    
    // Si no hay cupo configurado, skip
    if (cupoTotal <= 0) {
      console.log('[applyCupo] Deal sin cupo configurado (total=0), skip');
      return;
    }
    
    // 3) Calcular consumo según tipo
    let consumo = 0;
    
    if (tipoCupo.includes('HORA')) {
      // CUPO POR HORAS: priorizar total_de_horas_consumidas, fallback a of_cantidad
      consumo = parseNumber(tp.total_de_horas_consumidas, 0);
      if (consumo === 0) {
        consumo = parseNumber(tp.of_cantidad, 0);
        console.log('[applyCupo] Usando of_cantidad como horas (total_de_horas_consumidas no existe)');
      } else {
        console.log('[applyCupo] Usando total_de_horas_consumidas como horas reales');
      }
    } else if (tipoCupo.includes('MONTO')) {
      // CUPO POR MONTO: monto neto sin IVA
      consumo = parseNumber(tp.monto_real_a_facturar, 0);
      console.log('[applyCupo] Usando monto_real_a_facturar como consumo de monto');
    }
    
    console.log('Consumo calculado:', consumo);
    
    if (consumo <= 0) {
      console.warn('[applyCupo] Consumo es 0, no se actualiza cupo');
      return;
    }
    
    // 4) Calcular nuevo estado del cupo
    const cupoConsumidoAnterior = parseNumber(dp.cupo_consumido, 0);
    const cupoConsumidoNuevo = cupoConsumidoAnterior + consumo;
    const cupoRestanteNuevo = cupoTotal - cupoConsumidoNuevo;
    
    console.log('Cupo consumido anterior:', cupoConsumidoAnterior);
    console.log('Cupo consumido nuevo:', cupoConsumidoNuevo);
    console.log('Cupo restante nuevo:', cupoRestanteNuevo);
    
    // 5) Advertir si el cupo está agotado (pero NO bloquearlo)
    if (cupoRestanteNuevo <= 0) {
      console.warn('⚠️ CUPO AGOTADO - Restante:', cupoRestanteNuevo);
      console.warn('⚠️ cupo_activo NO se bloquea automáticamente (gestión manual)');
    }
    
    // 6) Actualizar Deal (sin modificar cupo_activo)
    const dealUpdateProps = {
      cupo_consumido: String(cupoConsumidoNuevo),
      cupo_restante: String(cupoRestanteNuevo),
      cupo_ultima_actualizacion: getTodayYMD(),
    };
    
    console.log('\n--- ACTUALIZANDO DEAL ---');
    console.log('Propiedades:', dealUpdateProps);
    
    if (!isDryRun()) {
      await hubspotClient.crm.deals.basicApi.update(dealId, {
        properties: dealUpdateProps,
      });
      console.log('✓ Deal actualizado con nuevo estado de cupo');
    } else {
      console.log('DRY_RUN: no se actualiza Deal');
    }
    
    // 7) Guardar consumo en ticket para trazabilidad
    console.log('\n--- ACTUALIZANDO TICKET CON CONSUMO ---');
    const ticketUpdateProps = {
      of_cupo_consumo_resultante: String(consumo),
    };
    
    console.log('Guardando en ticket: of_cupo_consumo_resultante =', consumo);
    
    if (!isDryRun()) {
      await hubspotClient.crm.tickets.basicApi.update(ticket.id, {
        properties: ticketUpdateProps,
      });
      console.log('✓ Ticket actualizado con consumo resultante');
    } else {
      console.log('DRY_RUN: no se actualiza Ticket');
    }
    
    console.log('\n✅ CUPO APLICADO EXITOSAMENTE');
    console.log('Consumo de esta factura:', consumo);
    console.log('Cupo restante en Deal:', cupoRestanteNuevo);
    console.log('================================================\n');
    
  } catch (err) {
    console.error('\n❌ ERROR APLICANDO CUPO:');
    console.error('Mensaje:', err?.message);
    console.error('Stack:', err?.stack);
    console.error('================================================\n');
    // No re-lanzar el error para no afectar la creación de la factura
  }
}