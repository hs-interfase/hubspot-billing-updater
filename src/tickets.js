// src/tickets.js
import { hubspotClient } from './hubspotClient.js';
import { computeBillingCountersForLineItem } from './billingEngine.js';

// ---------------------------------------------------------------------------
// Helper: arma todas las fechas de facturación de un line item (YYYY-MM-DD)
// ---------------------------------------------------------------------------
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

  // fecha_inicio_de_facturacion + fecha_2..fecha_48
  add(p.fecha_inicio_de_facturacion);
  for (let i = 2; i <= 48; i++) {
    add(p[`fecha_${i}`]);
  }
  return out;
}

/**
 * Crea tickets de órdenes de facturación para las líneas que deben facturarse
 * en la próxima fecha. 1 ticket POR LINE ITEM.
 *
 * Además:
 * - Si el line item tiene bolsa (aplica_cupo != vacío),
 *   inicializa consumo_bolsa_horas_pm = 0 y monto_bolsa_periodo = 0 en el ticket.
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

  // normalizamos nextBillingDate
  const next = new Date(nextBillingDate);
  next.setHours(0, 0, 0, 0);
  const nextIso = next.toISOString().slice(0, 10);

  // si la próxima fecha no está entre hoy y +3 días, no generamos tickets
  const diffDays = Math.ceil(
    (next.getTime() - todayStart.getTime()) / (1000 * 60 * 60 * 24)
  );
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
      'Faltan BILLING_ORDER_PIPELINE_ID o BILLING_ORDER_STAGE_ID en variables de entorno'
    );
  }

  // -------------------------------------------------------------------------
  // Buscar empresa asociada al deal (para asociarla al ticket)
  // -------------------------------------------------------------------------
  let associatedCompanyId = null;
  try {
    const assocResp = await hubspotClient.crm.associations.v4.basicApi.getPage(
      'deals',
      String(deal.id),
      'companies',
      100
    );
    if (assocResp && Array.isArray(assocResp.results) && assocResp.results.length > 0) {
      associatedCompanyId = assocResp.results[0].toObjectId;
    }
  } catch (err) {
    console.warn(
      `[createBillingOrderTicketsForDeal] No se pudieron obtener compañías asociadas para el deal ${deal.id}:`,
      err?.message || err
    );
  }

  const parseBool = (raw) => {
    const v = (raw ?? '').toString().trim().toLowerCase();
    return v === 'true' || v === '1' || v === 'sí' || v === 'si' || v === 'yes';
  };

  const createdTickets = [];

  for (const li of lineItems) {
    const dates = collectBillingDateStrings(li);
    if (!dates.includes(nextIso)) continue;

    const p = li.properties || {};
    const counters = computeBillingCountersForLineItem(li, todayStart);
    const cuotaActual = counters.avisos_emitidos_facturacion + 1;
    const totalCuotas = counters.facturacion_total_avisos;

    const qty = Number(p.quantity || 1);
    const unitPrice = Number(p.price || 0);
    const importe = qty * unitPrice;

    const cost = Number(p.costo || 0);
    const margin = (unitPrice - cost) * qty;

    const freqRaw = (
      p.frecuencia_de_facturacion ||
      p.facturacion_frecuencia_de_facturacion ||
      ''
    )
      .toString()
      .toLowerCase();
    const recurrentFrequencies = [
      'mensual',
      'bimestral',
      'trimestral',
      'semestral',
      'anual',
    ];
    const isRepetitive = recurrentFrequencies.includes(freqRaw) ? 'true' : 'false';

    const isResale = parseBool(p.terceros) ? 'true' : 'false';
    const rubro = (p.servicio || p.of_rubro || '').toString();

    const iva = (p.iva || '').toString();
    const exoneraIrae = (p.of_exonera_irae || p.exonera_irae || '').toString();
    const remuneracionVariable = (p.remuneracion_variable || '').toString();

    const dealName = (deal.properties?.dealname || '').toString();
    const productoNombre = (p.name || '').toString();
    const servicioNombre = (p.servicio || '').toString();
    const productoServicio = [productoNombre, servicioNombre]
      .filter(Boolean)
      .join(' – ');

    const ticketSubject = `Orden de facturación: ${
      dealName || 'Negocio'
    } – ${productoServicio || 'Producto'}`;

    // ⚠️ nueva propiedad de bolsa en line item
    const aplicaCupo = (p.aplica_cupo || '').toString().trim(); // '', 'por_horas', 'por_monto'

    const ticketProps = {
      hs_pipeline: pipelineId,
      hs_pipeline_stage: stageId,
      subject: ticketSubject,

      of_aplica_para_cupo: aplicaCupo || undefined, // en ticket

      of_cantidad: qty,
      of_costo_usd: cost,
      of_descuento: (p.of_descuento ?? 0).toString(),
      of_exonera_irae: exoneraIrae || '',
      of_margen: Number.isFinite(margin) ? margin : 0,
      of_moneda: (
        p.of_moneda ||
        deal.properties?.deal_currency_code ||
        ''
      ).toString(),
      of_monto_total: importe,
      of_pais_operativo: (
        p.of_pais_operativo ||
        deal.properties?.pais_operativo ||
        ''
      ).toString(),
      of_rubro: rubro,

      numero_de_cuota: cuotaActual,
      total_cuotas: totalCuotas,
      monto_a_facturar: importe,

      of_fecha_de_facturacion: nextIso,
      of_line_item_id: String(li.id),
      of_deal_id: String(deal.id),
      of_producto_nombres: productoServicio,

      iva: iva,
      remuneracion_variable: remuneracionVariable,
      repetitivo: isRepetitive,
      reventa: isResale,

      of_cliente: associatedCompanyId ? String(associatedCompanyId) : '',

      numero_de_factura: '',
      monto_total_en_dolares: '',
    };

    // 🔹 inicializar campos de bolsa EN EL TICKET si aplica cupo
    if (aplicaCupo) {
      ticketProps.consumo_bolsa_horas_pm = 0;
      ticketProps.monto_bolsa_periodo = 0;
    }

    // 1) crear ticket
    const createResp = await hubspotClient.crm.tickets.basicApi.create({
      properties: ticketProps,
    });
    const ticketId = createResp.id;

    // 2) asociar ticket al deal
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

    // 3) asociar ticket a la compañía
    if (associatedCompanyId) {
      try {
        await hubspotClient.crm.associations.v4.basicApi.createDefault(
          'companies',
          String(associatedCompanyId),
          'tickets',
          String(ticketId)
        );
      } catch (err) {
        console.warn(
          `[createBillingOrderTicketsForDeal] No se pudo asociar ticket ${ticketId} a la empresa ${associatedCompanyId}:`,
          err?.message || err
        );
      }
    }

    createdTickets.push(ticketId);
  }

  return { created: createdTickets.length > 0, tickets: createdTickets };
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

