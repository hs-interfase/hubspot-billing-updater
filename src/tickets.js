import { hubspotClient } from './hubspotClient.js';

/**
 * Helper interno para obtener todas las asociaciones (versión simplificada de getAssocIdsV4).
 */
async function getAssocIdsV4(fromType, fromId, toType, limit = 100) {
  const out = [];
  let after;

  do {
    const resp = await hubspotClient.crm.associations.v4.basicApi.getPage(
      fromType,
      fromId,
      toType,
      limit,
      after
    );
    for (const r of resp.results || []) {
      out.push(r.toObjectId);
    }
    after = resp.paging?.next?.after;
  } while (after);

  return out;
}

/**
 * Convierte cualquier fecha en un string YYYY-MM-DD (fecha “solo día”).
 */
function toDateOnlyString(date) {
  const d = new Date(date);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Parsea un booleano en HubSpot (acepta "true", "1", "sí", "si", "yes").
 */
function parseBool(raw) {
  const v = (raw ?? '').toString().trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'sí' || v === 'si' || v === 'yes';
}

function computeRepetitivo(liProps) {
  const freq = (liProps.frecuencia_de_facturacion ?? '')
    .toString()
    .trim()
    .toLowerCase();

  const irregular =
    parseBool(liProps.irregular) || parseBool(liProps.facturacion_irregular);

  const isUnique =
    freq === 'unique' ||
    freq === 'one_time' ||
    freq === 'one-time' ||
    freq === 'once' ||
    freq === 'unico' ||
    freq === 'único';

  return !(isUnique && !irregular);
}


/**
 * Devuelve todas las fechas de facturación de un line item como strings "YYYY-MM-DD".
 * Usa fecha_inicio_de_facturacion y fecha_2 … fecha_48.
 */
function collectBillingDateStringsForLineItem(lineItem) {
  const p = lineItem.properties || {};
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
 * Construye las propiedades del ticket a partir del negocio, el line item y la fecha.
 * Ajusta los nombres internos (`of_*`) según tus propiedades de ticket.
 */
function buildTicketPropsBase({ deal, lineItem, billingDate }) {
  const liProps = lineItem.properties || {};
  const dealProps = deal.properties || {};
  const fechaStr = toDateOnlyString(billingDate);

  const dealId = String(deal.id || deal._id || dealProps.hs_object_id || dealProps.dealId || '');
  const producto = liProps.name || '';
  const servicio = liProps.servicio || '';
  const subject = `${dealProps.dealname || '(sin negocio)'} | ${producto}${servicio ? ` (${servicio})` : ''} | ${fechaStr}`;

  return {
    subject,
    of_deal_id: dealId,
    of_line_item_ids: String(lineItem.id),
    of_fecha_de_facturacion: fechaStr,

    of_moneda: dealProps.deal_currency_code || '',
    of_pais_operativo: dealProps.pais_operativo || '',
    of_rubro: liProps.servicio || '',
    of_producto_nombres: producto,
    of_monto_total: Number(liProps.price || 0),
    of_costo: Number(liProps.hs_cost_of_goods_sold || 0),
    of_cantidad: Number(liProps.quantity || 0),
    of_descuento: Number(liProps.hs_total_discount || 0),
    of_margen: Number(liProps.hs_margin || 0),


    of_aplica_para_cupo: (liProps.aplica_cupo || '').toString().trim(),
    horas_bolsa: liProps.horas_bolsa || null,
    precio_bolsa: liProps.precio_bolsa || null,
    bolsa_precio_hora: liProps.bolsa_precio_hora || null,
    total_bolsa_horas: liProps.total_bolsa_horas || null,
    total_bolsa_monto: liProps.total_bolsa_monto || null,
    bolsa_horas_restantes: liProps.bolsa_horas_restantes || null,
    bolsa_monto_restante: liProps.bolsa_monto_restante || null,

    repetitivo: parseBool(liProps),
    reventa: parseBool(liProps.terceros),
    i_v_a_: liProps.i_v_a_ || null,
    exonera_irae: liProps.exonera_irae || null,
    remuneracion_variable: Number(liProps.remuneracion_variable || 0),
  };
}

function buildTicketPropsForCreate(args) {
  return {
    hs_pipeline: process.env.BILLING_TICKET_PIPELINE_ID,
    hs_pipeline_stage: process.env.BILLING_TICKET_STAGE_ID,
    ...buildTicketPropsBase(args),
    consumo_bolsa_horas_pm: null,
    monto_bolsa_periodo: null,
  };
}


/**
 * Sincroniza los tickets de facturación por línea:
 * - Crea o actualiza un ticket por combinación (deal, lineItem, fecha) en los próximos 30 días.
 * - Elimina tickets futuros de line items que ya no existen.
 * - Si la propiedad `pausa` (o `Pausa`) del negocio está marcada en HubSpot, elimina todos los tickets futuros y no crea ninguno nuevo.
 *
 * @param {Object} params.deal       Objeto del negocio (deal).
 * @param {Array}  params.lineItems  Array de line items actuales del negocio.
 * @param {Date}   params.today      Fecha actual (opcional, default = hoy).
 * @returns {Promise<{created: number, updated: number, deleted: number}>}
 */
export async function syncLineItemTicketsForDeal({ deal, lineItems, today = new Date() }) {
  const dealProps = deal.properties || {};
  const dealId = String(
    deal.id ||
      deal._id ||
      dealProps.hs_object_id ||
      dealProps.dealId ||
      ''
  );
  console.log('[tickets] env', {
  BILLING_TICKET_PIPELINE_ID: process.env.BILLING_TICKET_PIPELINE_ID,
  BILLING_TICKET_STAGE_ID: process.env.BILLING_TICKET_STAGE_ID,
});

  if (!dealId) {
    console.warn('[syncLineItemTicketsForDeal] Deal sin ID, se omite');
    return { created: 0, updated: 0, deleted: 0 };
  }

  // ¿El negocio está en pausa?
  const paused =
    parseBool(dealProps.pausa) || parseBool(dealProps.Pausa);

  // 1) Leer todos los tickets asociados al negocio (deal ↔ tickets)
  const ticketIds = await getAssocIdsV4('deals', dealId, 'tickets');
  let existingTickets = [];
  if (ticketIds.length) {
    const batch = await hubspotClient.crm.tickets.batchApi.read(
      {
        inputs: ticketIds.map((id) => ({ id: String(id) })),
        properties: [
          'subject',
          'of_deal_id',
          'of_line_item_ids',
          'of_fecha_de_facturacion',
        ],
      },
      false
    );
    existingTickets = batch.results || [];
  }

  const todayMid = new Date(today);
  todayMid.setHours(0, 0, 0, 0);

  // Si el negocio está en pausa, borramos todos los tickets futuros y salimos.
  if (paused) {
    let deletedCount = 0;
    for (const t of existingTickets) {
      const props = t.properties || {};
      // Solo consideramos nuestros tickets (los que tienen fecha y line item)
      const fechaStr = props.of_fecha_de_facturacion;
      if (!fechaStr) continue;
      const d = new Date(fechaStr);
      if (Number.isNaN(d.getTime())) continue;
      d.setHours(0, 0, 0, 0);
      if (d >= todayMid) {
        try {
          await hubspotClient.crm.tickets.basicApi.archive(String(t.id));
          deletedCount++;
        } catch (err) {
          console.error(
            '[syncLineItemTicketsForDeal] Error al borrar ticket pausado',
            t.id,
            err?.response?.body || err?.message || err
          );
        }
      }
    }
    console.log('[syncLineItemTicketsForDeal] Negocio en pausa, tickets eliminados:', deletedCount);
    return { created: 0, updated: 0, deleted: deletedCount };
  }

// Índice de tickets existentes (clave = lineItemId::fecha)
const existingIndex = new Map();
for (const t of existingTickets) {
  const props = t.properties || {};
  const liId = (props.of_line_item_ids || '').toString();
  const fRaw = props.of_fecha_de_facturacion;
  if (!liId || !fRaw) continue;

  const d = new Date(fRaw);
  if (Number.isNaN(d.getTime())) continue;
  const f = toDateOnlyString(d); // <-- CLAVE

  existingIndex.set(`${liId}::${f}`, t);
}



  const currentLineItemIds = new Set(lineItems.map((li) => String(li.id)));

  const toCreate = [];
  const toUpdate = [];
  const toDelete = [];

  // 2) Para cada line item actual…
  for (const li of lineItems) {
    const liId = String(li.id);
    const liProps = li.properties || {};

    // Si hay una propiedad de pausa a nivel de línea y es true, no programamos tickets para esta línea
    const pausedLineItem =
      parseBool(liProps.pausa) || parseBool(liProps.Pausa);

    // Recoger las fechas de facturación de este line item
    const dates = collectBillingDateStringsForLineItem(li);

    for (const ds of dates) {
      const d = new Date(ds);
      if (Number.isNaN(d.getTime())) continue;
      d.setHours(0, 0, 0, 0);
      // Solo consideramos fechas dentro de los próximos 30 días
      const horizon = new Date(todayMid);
      horizon.setDate(horizon.getDate() + 30);
      if (d < todayMid || d > horizon) continue;

      const fechaStr = toDateOnlyString(d);
      const key = `${liId}::${fechaStr}`;

      // Si ya tenemos un ticket existente para este (deal, lineItem, fecha)…
      const existing = existingIndex.get(key);
      if (existing) {
        // Si el line item está marcado en pausa, eliminamos el ticket futuro
        if (pausedLineItem) {
          // Marcar para borrado
          toDelete.push(String(existing.id));
        } else {
          // Lo actualizamos con los nuevos datos
          const props = buildTicketPropsBase({
            deal,
  lineItem: li,
  billingDate: d,
          });
          toUpdate.push({
            id: String(existing.id),
            properties: props,
          });
        }
        // Ya procesado, quitar del índice
        existingIndex.delete(key);
      } else {
        // No existe → crear, si el line item no está pausado
        if (!pausedLineItem) {
          const props = buildTicketPropsForCreate({
            deal,
            lineItem: li,
            billingDate: d,
          });
          toCreate.push({
            properties: props,
            associations: [
              {
                to: { id: dealId },
                types: [
                  {
                    associationCategory: 'HUBSPOT_DEFINED',
                    associationTypeId: 28, // deal ↔ ticket
                  },
                ],
              },
            ],
          });
        }
      }
    }
  }

console.log('[tickets] pre-resumen', {
  dealId,
  existingTickets: existingTickets.length,
  toCreate: toCreate.length,
  toUpdate: toUpdate.length,
  toDelete: toDelete.length,
});

if (toCreate[0]) console.log('[tickets] ejemplo create props', toCreate[0].properties);
if (toUpdate[0]) console.log('[tickets] ejemplo update props', toUpdate[0].properties);


  // 3) Tickets “restantes” en existingIndex:
  //    para line items que ya no existen → eliminar si la fecha es futura
  for (const [key, t] of existingIndex.entries()) {
    const props = t.properties || {};
    const liId = (props.of_line_item_ids || '').toString();
    const fechaStr = props.of_fecha_de_facturacion;
    if (!liId || !fechaStr) continue;
    // Line item borrado
    const stillExists = currentLineItemIds.has(liId);
    if (!stillExists) {
      const d = new Date(fechaStr);
      if (Number.isNaN(d.getTime())) continue;
      d.setHours(0, 0, 0, 0);
      if (d >= todayMid) {
        toDelete.push(String(t.id));
      }
    }
  }

  // 4) Ejecutar los borrados, actualizaciones y creaciones
  let createdCount = 0;
  let updatedCount = 0;
  let deletedCount = 0;

  // Borrados
  for (const id of toDelete) {
    try {
      await hubspotClient.crm.tickets.basicApi.archive(id);
      deletedCount++;
    } catch (err) {
      console.error(
        '[syncLineItemTicketsForDeal] Error al borrar ticket',
        id,
        err?.response?.body || err?.message || err
      );
    }
  }

  // Actualizaciones
  if (toUpdate.length) {
    const batchUpdateInput = {
      inputs: toUpdate.map((u) => ({
        id: u.id,
        properties: u.properties,
      })),
    };
    await hubspotClient.crm.tickets.batchApi.update(batchUpdateInput);
    updatedCount += toUpdate.length;
  }

  if (toCreate[0]) {
    console.log('[tickets] create pipeline/stage', {
      hs_pipeline: toCreate[0].properties.hs_pipeline,
      hs_pipeline_stage: toCreate[0].properties.hs_pipeline_stage,
    });
  } 

  // Creaciones
  if (toCreate.length) {
    const resp = await hubspotClient.crm.tickets.batchApi.create({
      inputs: toCreate,
    });
    createdCount += (resp.results || []).length;
  }

  console.log('[syncLineItemTicketsForDeal] resumen', {
    dealId,
    created: createdCount,
    updated: updatedCount,
    deleted: deletedCount,
  });

  return {
    created: createdCount,
    updated: updatedCount,
    deleted: deletedCount,
  };
} // <-- esta cierra la función
