// src/services/manualTicketService.js

import { hubspotClient } from '../../hubspotClient.js';
import { TICKET_PIPELINE, TICKET_STAGES } from '../../config/constants.js';
import { createTicketSnapshots } from '../snapshotService.js';
import { getTodayYMD } from '../../utils/dateUtils.js';
import { parseBool } from '../../utils/parsers.js';
import { applyCupoPreventiveAlertFromTicket } from '../alerts/cupoAlert.js';

// Helpers compartidos (para evitar duplicar lógica y evitar imports circulares)
import {
  ensureTicketCanonical,
  getTicketStage,
  getDealCompanies,
  getDealContacts,
  createTicketAssociations,
} from './ticketService.js';

/**
 * Crea un ticket de orden de facturación manual.
 *
 * Reglas de fechas:
 * - expectedDate = billingDate (siempre)
 * - orderedDate = HOY solo si lineItem.facturar_ahora == true
 * - orderedDate = null en manual normal (se setea luego cuando el responsable manda a facturar)
 *
 * Con deduplicación: marca tickets clonados por UI como DUPLICADO_UI.
 *
 * @param {Object} deal - Deal de HubSpot
 * @param {Object} lineItem - Line Item de HubSpot
 * @param {string} billingDate - Fecha planificada (YYYY-MM-DD)
 * @returns {Object} { ticketId, created, duplicatesMarked }
 */
export async function createManualBillingTicket(deal, lineItem, billingDate) {
  const dealId = String(deal?.id || deal?.properties?.hs_object_id);
  const lineItemId = String(lineItem?.id || lineItem?.properties?.hs_object_id);

  const dp = deal?.properties || {};
  const lp = lineItem?.properties || {};

  // ✅ ID estable para idempotencia (sirve tanto para PY como para espejo UY)
  // ⚠️ IMPORTANTE: NO agregar prefijo LI: aquí, generateTicketKey() / buildTicketKey ya lo manejan
  const stableLineId = lp.of_line_item_py_origen_id
    ? `PYLI:${String(lp.of_line_item_py_origen_id)}`
    : lineItemId; // ✅ Solo el ID numérico, SIN prefijo LI:

  console.log('[ticketService] 🔍 MANUAL - stableLineId:', stableLineId, '(real:', lineItemId, ')');
  console.log('[ticketService] 🔍 MANUAL - billingDate:', billingDate);

  // Usar la nueva función de deduplicación
  const result = await ensureTicketCanonical({
    dealId,
    stableLineId,
    billDateYMD: billingDate,
    lineItemId,
    buildTicketPayload: async ({ billDateYMD, expectedKey }) => {
      // 1) Determinar fechas según reglas
      const expectedDate = billDateYMD;

      // ✅ Importante: NO redeclarar lp dentro de este bloque (evita TDZ)
      const lineProps = lineItem?.properties || {};
      const facturarAhora = parseBool(lineProps.facturar_ahora);
      const orderedDate = facturarAhora ? getTodayYMD() : null;

      console.log(`[ticketService] 📅 MANUAL - Fechas:`);
      console.log(`   - expectedDate: ${expectedDate} (siempre = billingDate)`);
      console.log(
        `   - orderedDate: ${orderedDate || 'null'} ${
          facturarAhora ? '(HOY por facturar_ahora=true)' : '(null en manual normal)'
        }`
      );

      // 2) Snapshots con firma nueva
      const snapshots = createTicketSnapshots(deal, lineItem, expectedDate, orderedDate);

      console.log(`[ticketService] 💰 MANUAL - Montos iniciales:`);
      console.log(`   - of_monto_total: ${snapshots.of_monto_total}`);
      console.log(`   - monto_real_a_facturar: ${snapshots.monto_real_a_facturar}`);
      console.log(`   ℹ️ En tickets MANUALES, monto_real_a_facturar es EDITABLE por el responsable.`);
      console.log(`   ℹ️ NO se sincroniza con cambios posteriores del Line Item (snapshot inmutable).`);

      console.log(`[ticketService] 📊 MANUAL - Frecuencia:`);
      console.log(`   - of_frecuencia_de_facturacion: ${snapshots.of_frecuencia_de_facturacion}`);
      console.log(`   - repetitivo: ${snapshots.repetitivo}`);

      console.log('[ticketService] 🔍 MANUAL - fecha_de_resolucion_esperada:', snapshots.fecha_de_resolucion_esperada);
      console.log('[ticketService] 🔍 MANUAL - of_fecha_de_facturacion:', snapshots.of_fecha_de_facturacion ?? '(no seteada)');

      // 3) Título
      const dealName = dp.dealname || 'Deal';
      const productName = lineProps.name || 'Producto';
      const rubro = snapshots.of_rubro || 'Sin rubro';

      // 4) Stage según fecha y flag
      const stage = getTicketStage(billDateYMD, lineItem);

      // 5) Facturar ahora -> nota urgente en descripción
      let descripcionProducto = snapshots.of_descripcion_producto || '';
      if (facturarAhora) {
        const notaUrgente = '⚠️ URGENTE: Vendedor solicitó facturar ahora.';
        descripcionProducto = descripcionProducto ? `${notaUrgente}\n\n${descripcionProducto}` : notaUrgente;
      }

      // 6) Owner (responsable del ticket) y vendedor (informativo)
      const vendedorId = dp.hubspot_owner_id ? String(dp.hubspot_owner_id) : null;

      // ✅ Regla: responsable sale del Line Item (solo al crear ticket)
      const responsable = lineProps.responsable_asignado ? String(lineProps.responsable_asignado) : null;

      console.log('[ticketService] MANUAL - vendedorId:', vendedorId, 'responsable:', responsable);

      // 7) Props del ticket
      const ticketProps = {
        subject: `${dealName} | ${productName} | ${rubro} | ${billDateYMD}`,
        hs_pipeline: TICKET_PIPELINE,
        hs_pipeline_stage: stage,

        of_deal_id: dealId,
        of_line_item_ids: lineItemId,
        of_ticket_key: expectedKey,

        ...snapshots,

        ...(vendedorId ? { of_propietario_secundario: vendedorId } : {}),
        ...(responsable ? { hubspot_owner_id: responsable } : {}),

        of_descripcion_producto: descripcionProducto,
      };

      console.log('[ticketService] 🔍 MANUAL - of_propietario_secundario:', ticketProps.of_propietario_secundario);
      console.log('[ticketService] 🔍 MANUAL - responsable del ticket (hubspot_owner_id):', ticketProps.hubspot_owner_id);

      return { properties: ticketProps };
    },
  });

  const { ticketId, created, ticketKey, duplicatesMarked } = result;

  // Si se creó el ticket, crear asociaciones y alerta de cupo
  if (created && ticketId) {
    try {
      const [companyIds, contactIds] = await Promise.all([getDealCompanies(dealId), getDealContacts(dealId)]);
      await createTicketAssociations(ticketId, dealId, lineItemId, companyIds, contactIds);

      // Alerta preventiva de cupo
      try {
        const createdTicket = await hubspotClient.crm.tickets.basicApi.getById(String(ticketId), [
          'of_monto_total',
          'monto_real_a_facturar',
          'of_fecha_de_facturacion',
          'of_ticket_key',
          'of_deal_id',
          'of_line_item_ids',
        ]);
        await applyCupoPreventiveAlertFromTicket({ deal, ticket: createdTicket, lineItem });
      } catch (err) {
        console.warn('[ticketService] Error en alerta preventiva de cupo:', err?.message);
      }

      // ✅ NO uses "linp" acá (no existe en este scope). Reusa lp (outer) o vuelve a leer props:
      const facturarAhoraPost = parseBool(lp.facturar_ahora);
      const stage = getTicketStage(billingDate, lineItem);
      const stageLabel =
        stage === TICKET_STAGES.READY ? 'READY' : stage === TICKET_STAGES.INVOICED ? 'INVOICED' : 'NEW';
      const urgentLabel = facturarAhoraPost ? ' [URGENTE]' : '';

      console.log(
        `[ticketService] ✓ Ticket manual creado: ${ticketId} para ${ticketKey} (stage: ${stageLabel}${urgentLabel})`
      );
      console.log(
        `[ticketService] Responsable (LI.responsable_asignado): ${lp.responsable_asignado || 'N/A'}, Vendedor (Deal): ${
          dp.hubspot_owner_id || 'N/A'
        }`
      );

      if (duplicatesMarked > 0) {
        console.log(`[ticketService] 🧹 ${duplicatesMarked} duplicado(s) marcados`);
      }
    } catch (err) {
      console.error('[ticketService] Error en post-creación de ticket:', err?.message);
      throw err;
    }
  } else {
    console.log(`[ticketService] ✓ Ticket manual existente: ${ticketId}`);
    if (duplicatesMarked > 0) {
      console.log(`[ticketService] 🧹 ${duplicatesMarked} duplicado(s) marcados`);
    }
  }

  return { ticketId, created, duplicatesMarked };
}
