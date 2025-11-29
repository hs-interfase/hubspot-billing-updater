// src/tickets.js
import { hubspotClient } from './hubspotClient.js';
import { computeBillingCountersForLineItem } from './billingEngine.js';

/**
 * Devuelve todas las fechas de facturación de un line item (YYYY-MM-DD).
 * Replica la lógica de collectBillingDateStringsForLineItem de processDeal.js.
 */
function collectBillingDateStrings(li) {
  const p = li.properties || {};
  const out = [];
  const add = (raw) => {
    if (!raw) return;
    const d = new Date(raw.toString());
    if (Number.isNaN(d.getTime())) return;
    d.setHours(0, 0, 0, 0);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    out.push(`${y}-${m}-${dd}`);
  };
  add(p.fecha_inicio_de_facturacion);
  for (let i = 2; i <= 48; i++) {
    add(p[`fecha_${i}`]);
  }
  return out;
}

/**
 * Crea tickets de órdenes de facturación para las líneas que deben facturarse hoy.
 * Requiere definir las variables de entorno BILLING_ORDER_PIPELINE_ID y BILLING_ORDER_STAGE_ID.
 *
 * @param {Object} deal - Objeto de negocio
 * @param {Array} lineItems - Array de line items del negocio
 * @param {Date} nextBillingDate - Próxima fecha calculada
 * @param {Object} options - { today, pipelineId, stageId }
 */
export async function createBillingOrderTicketsForDeal(
  deal,
  lineItems,
  nextBillingDate,
  options = {}
) {
  const today = options.today || new Date();
  const todayStart = new Date(today);
  todayStart.setHours(0, 0, 0, 0);

  const next = new Date(nextBillingDate);
  next.setHours(0, 0, 0, 0);

  // Si la próxima fecha no es hoy, no crear tickets
  if (next.getTime() !== todayStart.getTime()) {
    return { created: false, reason: 'La próxima fecha no es hoy' };
  }

  const pipelineId =
    options.pipelineId || process.env.BILLING_ORDER_PIPELINE_ID;
  const stageId = options.stageId || process.env.BILLING_ORDER_STAGE_ID;
  if (!pipelineId || !stageId) {
    throw new Error('Faltan BILLING_ORDER_PIPELINE_ID o BILLING_ORDER_STAGE_ID');
  }

  const createdTickets = [];

  for (const li of lineItems) {
    // Comprobar si la línea tiene la fecha de facturación de hoy
    const dates = collectBillingDateStrings(li);
    const nextIso = next.toISOString().slice(0, 10);
    if (!dates.includes(nextIso)) continue;

    const p = li.properties || {};
    const counters = computeBillingCountersForLineItem(li, todayStart);
    const cuotaActual = counters.avisos_emitidos_facturacion + 1;
    const totalCuotas = counters.facturacion_total_avisos;

    const qty = Number(p.quantity || 1);
    const unitPrice = Number(p.price || 0);
    const importe = qty * unitPrice;

    // Construir propiedades del ticket (ajusta según nombres reales)
    const ticketProps = {
      hs_pipeline: pipelineId,
      hs_pipeline_stage: stageId,
      subject: `Orden de facturación: ${p.name || 'Producto'}`,
      of_aplica_para_cupo: p.of_aplica_para_cupo ?? '',
      of_cantidad: qty,
      of_costo_usd: unitPrice,
      of_descuento: p.of_descuento ?? 0,
      of_exonera_irae: p.of_exonera_irae ?? 'false',
      of_margen: p.of_margen ?? 0,
      of_moneda: p.of_moneda || deal.properties.deal_currency_code || '',
      of_monto_total: importe,
      of_pais_operativo: p.of_pais_operativo ?? '',
      of_rubro: p.servicio || p.of_rubro || '',
      numero_de_cuota: cuotaActual,
      total_cuotas: totalCuotas,
      monto_a_facturar: importe,
    };

    // Crear el ticket y asociarlo al negocio (associationTypeId 10 es Ticket -> Deal)
    const ticketReq = {
      properties: ticketProps,
      associations: [
        {
          to: { id: String(deal.id) },
          types: [
            {
              associationCategory: 'HUBSPOT_DEFINED',
              associationTypeId: 10,
            },
          ],
        },
      ],
    };

    const resp = await hubspotClient.crm.tickets.basicApi.create(ticketReq);
    createdTickets.push(resp.id);
  }

  return { created: true, tickets: createdTickets };
}
