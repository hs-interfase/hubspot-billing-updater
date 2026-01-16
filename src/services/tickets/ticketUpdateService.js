// src/services/tickets/ticketUpdateService.js
import { hubspotClient } from '../../hubspotClient.js';
import { parseNumber } from '../../utils/parsers.js';

/**
 * Servicio para procesar actualizaciones de tickets cuando se activa
 * la propiedad "actualizar" en un ticket.
 * 
 * Este servicio maneja la lógica independiente de tickets, separada
 * del flujo de recalculación de line items.
 * 
 * IMPORTANTE: No sobrescribimos hubspot_owner_id en updates porque
 * el usuario puede reasignarlo manualmente en HubSpot.
 * 
 * @param {string} ticketId - ID del ticket a procesar
 * @returns {Promise<Object>} Resultado del procesamiento
 */

export async function processTicketUpdate(ticketId) {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`[ticket:update] 🎫 Procesando actualización de ticket ${ticketId}`);
  console.log('='.repeat(80));
  
  try {
    // ========================================
    // 1. LEER TICKET ACTUAL (BEFORE)
    // ========================================
    const ticketBefore = await hubspotClient.crm.tickets.basicApi.getById(String(ticketId), [
      // Propiedades *_real
      'monto_unitario_real',
      'cantidad_real',
      'subtotal_real',
      'costo_real',
      'descuento_unit',
      'descuento_porcentaje_real',
      'descuento_monto_total_real',
      'total_real_a_facturar',
      
      // Propiedades base (snapshots)
      'of_monto_unitario',
      'of_cantidad',
      'of_costo',
      'of_descuento',
      'of_descuento_monto',
      'of_monto_total',
      'monto_real_a_facturar',
      'iva',
      
      // Metadata
      'hs_pipeline_stage',
      'subject',
    ]);
    
    const propsBefore = ticketBefore.properties || {};
    
    console.log('[ticket:update] 📊 BEFORE → Valores actuales del ticket:');
    console.log(`  monto_unitario_real: ${propsBefore.monto_unitario_real || 'null'}`);
    console.log(`  cantidad_real: ${propsBefore.cantidad_real || 'null'}`);
    console.log(`  subtotal_real: ${propsBefore.subtotal_real || 'null'}`);
    console.log(`  costo_real: ${propsBefore.costo_real || 'null'}`);
    console.log(`  descuento_unit: ${propsBefore.descuento_unit || 'null'}`);
    console.log(`  descuento_porcentaje_real: ${propsBefore.descuento_porcentaje_real || 'null'}`);
    console.log(`  descuento_monto_total_real: ${propsBefore.descuento_monto_total_real || 'null'}`);
    console.log(`  total_real_a_facturar: ${propsBefore.total_real_a_facturar || 'null'}`);
    
    // ========================================
    // 2. CALCULAR VALORES *_real
    // ========================================
    const calculatedProps = computeRealProps(propsBefore);
    
    console.log('\n[ticket:update] 🧮 CALC → Resultado de computeRealProps:');
    console.log(`  monto_unitario_real: ${calculatedProps.monto_unitario_real}`);
    console.log(`  cantidad_real: ${calculatedProps.cantidad_real}`);
    console.log(`  subtotal_real: ${calculatedProps.subtotal_real}`);
    console.log(`  costo_real: ${calculatedProps.costo_real}`);
    console.log(`  descuento_unit: ${calculatedProps.descuento_unit}`);
    console.log(`  descuento_porcentaje_real: ${calculatedProps.descuento_porcentaje_real}`);
    console.log(`  descuento_monto_total_real: ${calculatedProps.descuento_monto_total_real}`);
    console.log(`  total_real_a_facturar: ${calculatedProps.total_real_a_facturar}`);
    
    // ========================================
    // 3. VALIDACIÓN DE CAMPOS CRÍTICOS
    // ========================================
    const hasQty = calculatedProps.cantidad_real && calculatedProps.cantidad_real !== '0';
    const hasUnit = calculatedProps.monto_unitario_real && calculatedProps.monto_unitario_real !== '0';
    const hasTotal = calculatedProps.total_real_a_facturar && calculatedProps.total_real_a_facturar !== '0';
    
    if (!hasQty || !hasUnit || !hasTotal) {
      console.error('\n[ticket:update] ❌ VALIDATION_FAILED - Faltan campos críticos:');
      console.error(`  cantidad_real: ${hasQty ? '✅' : '❌ MISSING/ZERO'}`);
      console.error(`  monto_unitario_real: ${hasUnit ? '✅' : '❌ MISSING/ZERO'}`);
      console.error(`  total_real_a_facturar: ${hasTotal ? '✅' : '❌ MISSING/ZERO'}`);
      
      // Marcar ticket como BLOCKED
      await hubspotClient.crm.tickets.basicApi.update(String(ticketId), {
        properties: {
          hs_pipeline_stage: '3', // Ajustar ID según tu pipeline (ej: "BLOCKED")
        }
      });
      
      console.log('[ticket:update] 🚫 Ticket marcado como BLOCKED');
      console.log('='.repeat(80) + '\n');
      
      return {
        ticketId,
        processed: false,
        blocked: true,
        reason: 'Campos críticos faltantes o en cero',
        timestamp: new Date().toISOString(),
      };
    }
    
    // ========================================
    // 4. CONSTRUIR PAYLOAD DE UPDATE
    // ========================================
    // Solo incluir propiedades que cambiaron
    const updatePayload = {};
    
    for (const [key, newValue] of Object.entries(calculatedProps)) {
      const oldValue = propsBefore[key];
      // Comparar como strings (formato HubSpot)
      if (String(newValue) !== String(oldValue || '')) {
        updatePayload[key] = newValue;
      }
    }
    
    console.log('\n[ticket:update] 📤 UPDATE payload → Claves que se envían a HubSpot:');
    if (Object.keys(updatePayload).length === 0) {
      console.log('  ⚠️ SKIP_UPDATE_EMPTY_PAYLOAD - No hay cambios que aplicar');
      console.log('='.repeat(80) + '\n');
      
      return {
        ticketId,
        processed: true,
        updated: false,
        reason: 'No hay cambios que aplicar',
        timestamp: new Date().toISOString(),
      };
    }
    
    for (const [key, value] of Object.entries(updatePayload)) {
      console.log(`  ${key}: ${value}`);
    }
    
    // ========================================
    // 5. ACTUALIZAR TICKET EN HUBSPOT
    // ========================================
    await hubspotClient.crm.tickets.basicApi.update(String(ticketId), {
      properties: updatePayload
    });
    
    console.log('\n[ticket:update] ✅ Ticket actualizado en HubSpot');
    
    // ========================================
    // 6. LEER TICKET ACTUALIZADO (AFTER)
    // ========================================
    const ticketAfter = await hubspotClient.crm.tickets.basicApi.getById(String(ticketId), [
      'monto_unitario_real',
      'cantidad_real',
      'subtotal_real',
      'costo_real',
      'descuento_unit',
      'descuento_porcentaje_real',
      'descuento_monto_total_real',
      'total_real_a_facturar',
    ]);
    
    const propsAfter = ticketAfter.properties || {};
    
    console.log('\n[ticket:update] 📊 AFTER → Valores reales del ticket luego del update:');
    console.log(`  monto_unitario_real: ${propsAfter.monto_unitario_real || 'null'}`);
    console.log(`  cantidad_real: ${propsAfter.cantidad_real || 'null'}`);
    console.log(`  subtotal_real: ${propsAfter.subtotal_real || 'null'}`);
    console.log(`  costo_real: ${propsAfter.costo_real || 'null'}`);
    console.log(`  descuento_unit: ${propsAfter.descuento_unit || 'null'}`);
    console.log(`  descuento_porcentaje_real: ${propsAfter.descuento_porcentaje_real || 'null'}`);
    console.log(`  descuento_monto_total_real: ${propsAfter.descuento_monto_total_real || 'null'}`);
    console.log(`  total_real_a_facturar: ${propsAfter.total_real_a_facturar || 'null'}`);
    
    console.log('\n' + '='.repeat(80));
    console.log('[ticket:update] 🎉 Procesamiento completado exitosamente');
    console.log('='.repeat(80) + '\n');
    
    return {
      ticketId,
      processed: true,
      updated: true,
      fieldsUpdated: Object.keys(updatePayload),
      timestamp: new Date().toISOString(),
    };
    
  } catch (err) {
    console.error(`\n[ticket:update] ❌ Error procesando ticket ${ticketId}:`, err?.message || err);
    console.error(err?.stack);
    console.log('='.repeat(80) + '\n');
    
    throw err;
  }
}

/**
 * Calcula las propiedades *_real de un ticket a partir de sus snapshots.
 * 
 * Lógica de cálculo:
 * 1. monto_unitario_real = of_monto_unitario (snapshot del line item)
 * 2. cantidad_real = of_cantidad (snapshot del line item, editable en tickets manuales)
 * 3. subtotal_real = monto_unitario_real × cantidad_real
 * 4. costo_real = of_costo (snapshot del line item)
 * 5. descuento_unit = of_descuento_monto (descuento por unidad)
 * 6. descuento_porcentaje_real = of_descuento (% en formato decimal, ej: 0.1 = 10%)
 * 7. descuento_monto_total_real = (descuento_porcentaje × subtotal) + (descuento_unit × cantidad)
 * 8. total_real_a_facturar = subtotal - descuento_monto_total + IVA (si aplica)
 * 
 * @param {Object} ticketProps - Propiedades del ticket
 * @returns {Object} Propiedades calculadas en formato string para HubSpot
 */
function computeRealProps(ticketProps) {
  try {
    // DEBUG: Ver propiedades originales del ticket
    console.log('\n[ticket:update:computeRealProps] 🔍 Propiedades originales recibidas:');
    console.log(`  of_monto_unitario: ${ticketProps.of_monto_unitario || 'VACÍO'}`);
    console.log(`  of_cantidad: ${ticketProps.of_cantidad || 'VACÍO'}`);
    console.log(`  of_costo: ${ticketProps.of_costo || 'VACÍO'}`);
    console.log(`  of_descuento: ${ticketProps.of_descuento || 'VACÍO'}`);
    console.log(`  of_descuento_monto: ${ticketProps.of_descuento_monto || 'VACÍO'}`);
    console.log(`  iva: ${ticketProps.iva || 'VACÍO'}`);
    
    // Valores base desde snapshots
    const montoUnitario = parseNumber(ticketProps.of_monto_unitario, 0);
    const cantidad = parseNumber(ticketProps.of_cantidad, 0);
    const costo = parseNumber(ticketProps.of_costo, 0);
    const descuentoPorcentaje = parseNumber(ticketProps.of_descuento, 0); // decimal (ej: 0.1 = 10%)
    const descuentoUnit = parseNumber(ticketProps.of_descuento_monto, 0); // por unidad
    const iva = ticketProps.iva === 'true' || ticketProps.iva === true; // boolean
    
    console.log('\n[ticket:update:computeRealProps] 🔢 Valores parseados:');
    console.log(`  montoUnitario: ${montoUnitario}`);
    console.log(`  cantidad: ${cantidad}`);
    console.log(`  costo: ${costo}`);
    console.log(`  descuentoPorcentaje: ${descuentoPorcentaje}`);
    console.log(`  descuentoUnit: ${descuentoUnit}`);
    console.log(`  iva: ${iva}`);
    
    // 1. Monto unitario real (igual al snapshot)
    const montoUnitarioReal = montoUnitario;
    
    // 2. Cantidad real (igual al snapshot, puede haber sido editado manualmente)
    const cantidadReal = cantidad;
    
    // 3. Subtotal real (antes de descuentos)
    const subtotalReal = montoUnitarioReal * cantidadReal;
    
    // 4. Costo real (igual al snapshot)
    const costoReal = costo;
    
    // 5. Descuento por unidad (igual al snapshot)
    const descuentoUnitReal = descuentoUnit;
    
    // 6. Descuento porcentaje real (igual al snapshot)
    const descuentoPorcentajeReal = descuentoPorcentaje;
    
    // 7. Descuento monto total
    // = (porcentaje × subtotal) + (descuento_unit × cantidad)
    const descuentoPorPorcentaje = descuentoPorcentajeReal * subtotalReal;
    const descuentoPorUnidad = descuentoUnitReal * cantidadReal;
    const descuentoMontoTotalReal = descuentoPorPorcentaje + descuentoPorUnidad;
    
    // 8. Total real a facturar
    // = subtotal - descuento + IVA (22% en Uruguay si aplica)
    const subtotalConDescuento = subtotalReal - descuentoMontoTotalReal;
    const ivaRate = iva ? 0.22 : 0; // 22% IVA Uruguay
    const ivaAmount = subtotalConDescuento * ivaRate;
    const totalRealAFacturar = subtotalConDescuento + ivaAmount;
    
    // Retornar como strings (formato HubSpot)
    return {
      monto_unitario_real: String(montoUnitarioReal),
      cantidad_real: String(cantidadReal),
      subtotal_real: String(subtotalReal),
      costo_real: String(costoReal),
      descuento_unit: String(descuentoUnitReal),
      descuento_porcentaje_real: String(descuentoPorcentajeReal),
      descuento_monto_total_real: String(descuentoMontoTotalReal),
      total_real_a_facturar: String(totalRealAFacturar),
    };
  } catch (err) {
    console.error('[ticket:update:computeRealProps] ❌ Error calculando propiedades reales:', err?.message || err);
    
    // Retornar valores por defecto en caso de error
    return {
      monto_unitario_real: '0',
      cantidad_real: '0',
      subtotal_real: '0',
      costo_real: '0',
      descuento_unit: '0',
      descuento_porcentaje_real: '0',
      descuento_monto_total_real: '0',
      total_real_a_facturar: '0',
    };
  }
}
