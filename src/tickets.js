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
// Crea tickets de orden de facturación por cada línea que facture en la próxima fecha.
export async function createBillingOrderTicketsForDeal(
  deal,
  lineItems,
  nextBillingDate,
  options = {}
) {
  const today    = options.today || new Date();
  const todayStart = new Date(today);
  todayStart.setHours(0, 0, 0, 0);

  // Normalizar la próxima fecha y obtener su ISO
  const next = new Date(nextBillingDate);
  next.setHours(0, 0, 0, 0);
  const nextIso = next.toISOString().slice(0, 10);

  // si la próxima fecha no está entre hoy y 3 días, no crear tickets
  const diffDays = Math.ceil((next - todayStart) / (1000 * 60 * 60 * 24));
  if (diffDays < 0 || diffDays > 3) {
    return {
      created: false,
      reason: `La próxima fecha (${nextIso}) está fuera del rango de 3 días`,
    };
  }

  const pipelineId =
    options.pipelineId || process.env.BILLING_ORDER_PIPELINE_ID;
  const stageId = options.stageId || process.env.BILLING_ORDER_STAGE_ID;
  if (!pipelineId || !stageId) {
    throw new Error(
      'Faltan BILLING_ORDER_PIPELINE_ID o BILLING_ORDER_STAGE_ID'
    );
  }

  const createdTickets = [];

  for (const li of lineItems) {
    // ¿la línea factura en la próxima fecha?
    const dates = collectBillingDateStrings(li);
    if (!dates.includes(nextIso)) continue;

    const p       = li.properties || {};
    const counters   = computeBillingCountersForLineItem(li, todayStart);
    const cuotaActual = counters.avisos_emitidos_facturacion + 1;
    const totalCuotas = counters.facturacion_total_avisos;

    const qty   = Number(p.quantity || 1);
    const unitPrice = Number(p.price || 0);
    const importe  = qty * unitPrice;

    // propiedades del ticket
    const ticketProps = {
      hs_pipeline: pipelineId,
      hs_pipeline_stage: stageId,
      subject: `Orden de facturación: ${p.name || 'Producto'}`,
      of_aplica_para_cupo:  p.of_aplica_para_cupo ?? '',
      of_cantidad:       qty,
      of_costo_usd:      unitPrice,
      of_descuento:      p.of_descuento ?? 0,
      of_exonera_irae:   p.of_exonera_irae ?? 'false',
      of_margen:         p.of_margen ?? 0,
      of_moneda:         p.of_moneda || deal.properties.deal_currency_code || '',
      of_monto_total:    importe,
      of_pais_operativo: p.of_pais_operativo ?? '',
      of_rubro:          p.servicio || p.of_rubro || '',
      numero_de_cuota:   cuotaActual,
      total_cuotas:      totalCuotas,
      monto_a_facturar:  importe,

      // nuevas propiedades para facilitar el seguimiento
      of_fecha_de_facturacion: nextIso,
      of_line_item_id:    String(li.id),
      of_deal_id:         String(deal.id),
      of_producto_nombre: p.name || '',
      of_producto_servicio: p.servicio || '',
    };

    // 1. crear el ticket sin asociaciones
    const createResp = await hubspotClient.crm.tickets.basicApi.create({
      properties: ticketProps,
    });
    const ticketId = createResp.id;

    // 2. asociar el ticket al deal con la asociación por defecto
    try {
      await hubspotClient.crm.associations.v4.basicApi.createDefault(
        'deals',
        String(deal.id),
        'tickets',
        String(ticketId)
      );
    } catch (err) {
      console.warn(
        `[createBillingOrderTicketsForDeal] No se pudo asociar ticket ${ticketId} al deal ${deal.id}:`,
        err?.message || err
      );
    }

    createdTickets.push(ticketId);
  }

  return { created: true, tickets: createdTickets };
}

/** 
@param {Object} deal           Objeto del negocio
 * @param {Array} lineItems       Array de line items asociados
 * @param {Object} contexto       { proximaFecha: Date, mensaje: string }
 * @param {Object} options        { DRY_RUN, pipelineId, stageId }
 * @returns {Promise<Object>}     { created, ticketId?, reason? }
 */
// Crea un único ticket de orden de facturación para un negocio.
// Resume todas las líneas que facturan en la próxima fecha.
// Usa tus propiedades custom of_* y las estándar de tickets.
/*export async function createBillingTicketForDeal(
  deal,
  lineItems,
  contexto = {},
  options = {}
) {
  const { DRY_RUN = false, pipelineId, stageId } = options;

  const proximaFecha = contexto.proximaFecha;
  const mensaje = contexto.mensaje || '';

  if (!proximaFecha) {
    console.log('[tickets] No se crea ticket: sin próxima fecha.');
    return { created: false, reason: 'sin próxima fecha' };
  }

  // Normalizar fecha a YYYY-MM-DD
  const next = new Date(proximaFecha);
  if (Number.isNaN(next.getTime())) {
    console.log('[tickets] No se crea ticket: próxima fecha inválida.', proximaFecha);
    return { created: false, reason: 'fecha inválida' };
  }
  next.setHours(0, 0, 0, 0);
  const nextIso = next.toISOString().slice(0, 10); // yyyy-mm-dd

  // Pipeline / stage de tickets
  const pipeline = pipelineId || process.env.BILLING_TICKET_PIPELINE_ID;
  const stage = stageId || process.env.BILLING_TICKET_STAGE_ID;
  if (!pipeline || !stage) {
    throw new Error(
      'Faltan BILLING_TICKET_PIPELINE_ID o BILLING_TICKET_STAGE_ID. Configúralas en .env o pásalas en options.'
    );
  }

  // Helper local: recolecta todas las fechas de facturación de una línea en formato YYYY-MM-DD
  const collectBillingDateStrings = (li) => {
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
  };

  // Filtrar las líneas cuya tabla de fechas incluye la próxima fecha
  let relevant = [];
  for (const li of lineItems || []) {
    const dates = collectBillingDateStrings(li);
    if (dates.includes(nextIso)) {
      relevant.push(li);
    }
  }

  // Si ninguna coincide exactamente, usamos todas como fallback
  if (!relevant.length) {
    relevant = lineItems || [];
  }

  // Calcular importe total (qty * price) de las líneas relevantes
  let totalAmount = 0;
  for (const li of relevant) {
    const p = li.properties || {};
    const qty = Number(p.quantity || 1);
    const price = Number(p.price || 0);
    if (!Number.isNaN(qty) && !Number.isNaN(price)) {
      totalAmount += qty * price;
    }
  }
  totalAmount = Number(totalAmount.toFixed(2));

  const dealProps = deal?.properties || {};
  const moneda = dealProps.deal_currency_code || '';
  const paisOperativo = dealProps.pais_operativo || '';
  const dealName = dealProps.dealname || '';

  // Propiedades del ticket (solo válidas en tu portal)
  const ticketProps = {
    hs_pipeline: pipeline,
    hs_pipeline_stage: stage,

    // estándar de HubSpot
    subject: `Orden de facturación – ${dealName} – ${nextIso}`,
    content: [
      `Próxima fecha de facturación: ${nextIso}`,
      `Monto estimado: ${totalAmount.toFixed(2)} ${moneda || ''}`.trim(),
      '',
      mensaje || '',
    ].join('\n'),

    // tus propiedades custom
    of_moneda: moneda || '',
    of_monto_total: totalAmount,
    of_pais_operativo: paisOperativo || '',
  };

 console.log('[tickets] Creando ticket de facturación (sin asociación previa):', JSON.stringify(ticketProps, null, 2));

if (DRY_RUN) {
  console.log('[tickets] DRY_RUN activo: no se crea el ticket.');
  return { created: false, reason: 'dry-run', payload: ticketProps };
}

// Paso 1: Crear el ticket sin asociaciones
const createResp = await hubspotClient.crm.tickets.basicApi.create({
  properties: ticketProps,
});
const ticketId = createResp.id;
console.log('[tickets] Ticket creado. ID:', ticketId);

// Paso 2: Asociar el ticket al deal
await hubspotClient.crm.associations.v4.basicApi.create(
  'deals',
  String(deal.id),
  'tickets',
  [
    {
      associationTypeId: 10,
      associationCategory: 'HUBSPOT_DEFINED',
      to: { id: ticketId },
    },
  ]
);
console.log('[tickets] Asociación ticket ↔ deal creada.');

return { created: true, ticketId };
}
*/


export async function createBillingTicketForDeal(
  deal,
  lineItems,
  contexto = {},
  options = {}
) {
  const { DRY_RUN = false, pipelineId, stageId } = options;

  const proximaFecha = contexto.proximaFecha;
  const mensaje = contexto.mensaje || '';

  if (!proximaFecha) {
    console.log('[tickets] No se crea ticket: sin próxima fecha.');
    return { created: false, reason: 'sin próxima fecha' };
  }

  const next = new Date(proximaFecha);
  if (Number.isNaN(next.getTime())) {
    console.log('[tickets] No se crea ticket: próxima fecha inválida.', proximaFecha);
    return { created: false, reason: 'fecha inválida' };
  }
  next.setHours(0, 0, 0, 0);
  const nextIso = next.toISOString().slice(0, 10);

  const pipeline = pipelineId || process.env.BILLING_TICKET_PIPELINE_ID;
  const stage = stageId || process.env.BILLING_TICKET_STAGE_ID;
  if (!pipeline || !stage) {
    throw new Error('Faltan BILLING_TICKET_PIPELINE_ID o BILLING_TICKET_STAGE_ID.');
  }

  const collectBillingDateStrings = (li) => {
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
  };

  let relevant = [];
  for (const li of lineItems || []) {
    const dates = collectBillingDateStrings(li);
    if (dates.includes(nextIso)) relevant.push(li);
  }
  if (!relevant.length) relevant = lineItems || [];

  const lineItemIds = relevant.map(li => li.id).join(',');
  const productos = relevant
    .map(li => {
      const p = li.properties || {};
      const nombre = p.name || '';
      const servicio = p.servicio || '';
      return [nombre, servicio].filter(Boolean).join(' – ');
    })
    .join(' | ');

  const dealProps = deal?.properties || {};
  const moneda = dealProps.deal_currency_code || '';
  const paisOperativo = dealProps.pais_operativo || '';
  const dealName = dealProps.dealname || '';

const searchResp = await hubspotClient.crm.tickets.searchApi.doSearch({
  body: {
    filterGroups: [
      {
        filters: [
          { propertyName: 'of_fecha_de_facturacion', operator: 'EQ', value: nextIso },
          { propertyName: 'associations.deal', operator: 'EQ', value: String(deal.id) },
        ],
      },
    ],
    limit: 1,
    properties: ['subject', 'of_fecha_de_facturacion'],
  },
});

const total = searchResp?.body?.total || 0;
if (total > 0) {
  console.log(`[tickets] Ya existe ticket para el deal ${deal.id} y fecha ${nextIso}.`);
  return { created: false, reason: 'ya existe ticket para esta fecha y deal' };
}


let totalAmount = 0;
for (const li of relevant) {
  const p = li.properties || {};
  const qty = Number(p.quantity || 1);
  const price = Number(p.price || 0);
  totalAmount += qty * price;
}
totalAmount = Number(totalAmount.toFixed(2));


  //Propiedades del ticket
const ticketProps = {
  hs_pipeline: pipeline,
  hs_pipeline_stage: stage,
  subject: `Orden de facturación – ${dealName} – ${nextIso}`,
  content: [
    `Próxima fecha de facturación: ${nextIso}`,
    `Monto estimado: ${totalAmount.toFixed(2)} ${moneda}`.trim(),
    '',
    mensaje || '',
  ].join('\n'),

  // Propiedades personalizadas
  of_moneda: moneda || '',
  of_monto_total: totalAmount,
  of_pais_operativo: paisOperativo || '',
  of_fecha_de_facturacion: nextIso,
  of_line_item_ids: lineItemIds,
  of_deal_id: String(deal.id),
  of_producto_nombres: productos,
};


  console.log('[tickets] Creando ticket de facturación (sin asociación previa):', JSON.stringify(ticketProps, null, 2));

  if (DRY_RUN) {
    console.log('[tickets] DRY_RUN activo: no se crea el ticket.');
    return { created: false, reason: 'dry-run', payload: ticketProps };
  }

 const createResp = await hubspotClient.crm.tickets.basicApi.create({
  properties: ticketProps,
});
const ticketId = createResp.id;
console.log('[tickets] Ticket creado. ID:', ticketId);

await hubspotClient.crm.associations.v4.basicApi.createDefault(
  'deals',
  String(deal.id),
  'tickets',
  String(ticketId)
);
console.log('[tickets] Asociación ticket ↔ deal creada.');

return { created: true, ticketId };

}

