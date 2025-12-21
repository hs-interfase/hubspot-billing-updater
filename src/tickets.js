// src/tickets.js
import { hubspotClient } from "./hubspotClient.js";

// Add known ticket properties to avoid sending unknown props to HubSpot.
const KNOWN_TICKET_PROPERTIES = new Set([
  "subject",
  "hs_pipeline",
  "hs_pipeline_stage",
  "of_deal_id",
  "of_line_item_ids",
  "of_fecha_de_facturacion",
  "of_ticket_key",
  "of_moneda",
  "of_pais_operativo",
  "of_rubro",
  "of_producto_nombres",
  "of_monto_total",
  "of_precio_unitario",
  "of_costo",
  "of_cantidad",
  "of_descuento",
  "of_margen",
  "of_aplica_para_cupo",
  "horas_bolsa",
  "precio_bolsa",
  "bolsa_precio_hora",
  "total_bolsa_horas",
  "total_bolsa_monto",
  "bolsa_horas_restantes",
  "bolsa_monto_restante",
  "repetitivo",
  "reventa",
  "i_v_a_",
  "exonera_irae",
  "remuneracion_variable",
  "consumo_bolsa_horas_pm",
  "monto_bolsa_periodo",
  // resultado factura (si existen en tu portal)
  "of_invoice_id",
  "of_invoice_url",
  "of_invoice_status",
  "of_invoice_key",
  "of_billing_error",
]);

// Keep track of any unknown properties encountered. We'll log these once per run.
const _missingTicketPropertyNames = new Set();

function filterTicketProps(props) {
  const out = {};
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined) continue;
    if (KNOWN_TICKET_PROPERTIES.has(key)) {
      out[key] = value;
    } else {
      _missingTicketPropertyNames.add(key);
    }
  }
  return out;
}

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
 * Parsea un booleano en HubSpot (acepta "true", "1", "sí", "si", "yes").
 */
function parseBool(raw) {
  const v = (raw ?? "").toString().trim().toLowerCase();
  return v === "true" || v === "1" || v === "sí" || v === "si" || v === "yes";
}

/**
 * --- FECHAS SIN TIMEZONE BUG ---
 * Trabajamos con strings "YYYY-MM-DD" (YMD).
 */
function isYMD(str) {
  return typeof str === "string" && /^\d{4}-\d{2}-\d{2}$/.test(str.trim());
}

/**
 * Convierte Date -> "YYYY-MM-DD" usando getters locales (NO toISOString).
 */
function dateToYMDLocal(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Parsea "YYYY-MM-DD" a Date local (sin UTC).
 */
function parseYMDToLocalDate(ymd) {
  const m = (ymd || "").toString().trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  return new Date(year, month - 1, day); // LOCAL
}

/**
 * Para comparar rangos, usamos UTC estable:
 * "YYYY-MM-DD" -> timestamp UTC (medianoche UTC).
 */
function ymdToUtcMs(ymd) {
  const m = (ymd || "").toString().trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return NaN;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  return Date.UTC(year, month - 1, day);
}

/**
 * Normaliza cualquier valor de fecha a YMD.
 * - si ya es "YYYY-MM-DD", lo devuelve tal cual
 * - si viene como Date o string con hora, intenta convertir a Date y luego a YMD local
 */
function normalizeToYMD(raw) {
  if (!raw) return null;
  const str = raw.toString().trim();

  if (isYMD(str)) return str;

  // Intento: Date con hora o formatos varios
  const d = new Date(str);
  if (Number.isNaN(d.getTime())) return null;

  // IMPORTANTE: usar local getters
  return dateToYMDLocal(d);
}

function computeRepetitivo(liProps) {
  const freq = (liProps.frecuencia_de_facturacion ?? "")
    .toString()
    .trim()
    .toLowerCase();

  const irregular = parseBool(liProps.irregular) || parseBool(liProps.facturacion_irregular);

  const isUnique =
    freq === "unique" ||
    freq === "one_time" ||
    freq === "one-time" ||
    freq === "once" ||
    freq === "unico" ||
    freq === "único";

  return !(isUnique && !irregular);
}

/**
 * Devuelve todas las fechas de facturación de un line item como strings "YYYY-MM-DD".
 * Usa fecha_inicio_de_facturacion y fecha_2 … fecha_48.
 *
 * ✅ CORREGIDO: NO usa new Date("YYYY-MM-DD") (UTC bug).
 */
function collectBillingDateStringsForLineItem(lineItem) {
  const p = lineItem.properties || {};
  const out = [];

  const add = (raw) => {
    const ymd = normalizeToYMD(raw);
    if (!ymd) return;
    out.push(ymd);
  };

  add(p.fecha_inicio_de_facturacion);
  for (let i = 2; i <= 48; i++) add(p[`fecha_${i}`]);

  // dedupe por si se repite
  return Array.from(new Set(out));
}

/**
 * Construye las propiedades del ticket a partir del negocio, el line item y la fecha (YMD).
 * ✅ billingDateYMD es "YYYY-MM-DD" (string).
 */
function buildTicketPropsBase({ deal, lineItem, billingDateYMD }) {
  const liProps = lineItem.properties || {};
  const dealProps = deal.properties || {};
  const fechaStr = billingDateYMD;

  const dealId = String(deal.id || deal._id || dealProps.hs_object_id || dealProps.dealId || "");
  const producto = liProps.name || "";
  const servicio = liProps.servicio || "";
  const subject = `${dealProps.dealname || "(sin negocio)"} | ${producto}${
    servicio ? ` (${servicio})` : ""
  } | ${fechaStr}`;

  // price/qty/discount
  const unitPrice = Number(liProps.price || 0);
  const quantity = Number(liProps.quantity || 0);
  const discount = Number(liProps.hs_total_discount || liProps.descuento || 0);
  const subtotal = unitPrice * quantity;
  const total = subtotal - discount;

  const repetitivoValue = computeRepetitivo(liProps);

  const props = {
    subject,
    of_deal_id: dealId,
    of_line_item_ids: String(lineItem.id),
    of_fecha_de_facturacion: fechaStr,
    of_ticket_key: `${dealId}::${lineItem.id}::${fechaStr}`,

    of_moneda: dealProps.deal_currency_code || "",
    of_pais_operativo: dealProps.pais_operativo || "",
    of_rubro: liProps.servicio || "",
    of_producto_nombres: producto,

    of_precio_unitario: unitPrice,
    of_monto_total: total >= 0 ? total : 0,
    of_costo: Number(liProps.hs_cost_of_goods_sold || 0),
    of_cantidad: quantity,
    of_descuento: discount,
    of_margen: Number(liProps.hs_margin || 0),

    of_aplica_para_cupo: (liProps.aplica_cupo || "").toString().trim(),
    precio_bolsa: liProps.precio_bolsa || null,
    bolsa_precio_hora: liProps.bolsa_precio_hora || null,
    total_bolsa_monto: liProps.total_bolsa_monto || null,

    repetitivo: repetitivoValue,
    reventa: parseBool(liProps.terceros),
    i_v_a_: liProps.i_v_a_ || null,
    exonera_irae: liProps.exonera_irae || null,
    remuneracion_variable: Number(liProps.remuneracion_variable || 0),
  };

  return filterTicketProps(props);
}

function buildTicketPropsForCreate({ deal, lineItem, billingDateYMD, todayYMD }) {
  const base = buildTicketPropsBase({ deal, lineItem, billingDateYMD });

  // stage inicial: si fecha == hoy => READY
  let stageId = process.env.BILLING_TICKET_STAGE_ID;
  const readyStage = process.env.BILLING_TICKET_STAGE_READY || process.env.BILLING_ORDER_STAGE_READY;
  if (readyStage && todayYMD && billingDateYMD === todayYMD) {
    stageId = readyStage;
  }

  const props = {
    hs_pipeline: process.env.BILLING_TICKET_PIPELINE_ID,
    hs_pipeline_stage: stageId,
    ...base,
    consumo_bolsa_horas_pm: null,
    monto_bolsa_periodo: null,
  };

  return filterTicketProps(props);
}

/**
 * Sincroniza tickets por línea dentro de los próximos 30 días (incluye hoy).
 * ✅ CORREGIDO: todo el rango compara por UTC usando ymdToUtcMs, sin Date("YYYY-MM-DD").
 */
export async function syncLineItemTicketsForDeal({ deal, lineItems, today = new Date() }) {
  const dealProps = deal.properties || {};
  const dealId = String(deal.id || deal._id || dealProps.hs_object_id || dealProps.dealId || "");

  console.log("[tickets] env", {
    BILLING_TICKET_PIPELINE_ID: process.env.BILLING_TICKET_PIPELINE_ID,
    BILLING_TICKET_STAGE_ID: process.env.BILLING_TICKET_STAGE_ID,
    BILLING_TICKET_STAGE_READY: process.env.BILLING_TICKET_STAGE_READY,
    BILLING_ORDER_STAGE_READY: process.env.BILLING_ORDER_STAGE_READY,
  });

  if (!dealId) {
    console.warn("[syncLineItemTicketsForDeal] Deal sin ID, se omite");
    return { created: 0, updated: 0, deleted: 0 };
  }

  const paused = parseBool(dealProps.pausa) || parseBool(dealProps.Pausa);

  // Leer tickets asociados
  const ticketIds = await getAssocIdsV4("deals", dealId, "tickets");
  let existingTickets = [];
  if (ticketIds.length) {
    const batch = await hubspotClient.crm.tickets.batchApi.read(
      {
        inputs: ticketIds.map((id) => ({ id: String(id) })),
        properties: [
          "subject",
          "hs_pipeline",
          "hs_pipeline_stage",
          "of_deal_id",
          "of_line_item_ids",
          "of_fecha_de_facturacion",
          "of_ticket_key",
          "of_invoice_id",
          "of_invoice_key",
        ],
      },
      false
    );
    existingTickets = batch.results || [];
  }

  const todayLocal = new Date(today);
  todayLocal.setHours(0, 0, 0, 0);
  const todayYMD = dateToYMDLocal(todayLocal);

  const todayUtcMs = ymdToUtcMs(todayYMD);
  const horizonUtcMs = todayUtcMs + 30 * 24 * 60 * 60 * 1000;

  // Si el negocio está en pausa, borrar tickets futuros (>= hoy) y salir
  if (paused) {
    let deletedCount = 0;
    for (const t of existingTickets) {
      const props = t.properties || {};
      const fechaStr = (props.of_fecha_de_facturacion || "").toString().trim();
      if (!isYMD(fechaStr)) continue;

      const dMs = ymdToUtcMs(fechaStr);
      if (Number.isNaN(dMs)) continue;

      if (dMs >= todayUtcMs) {
        try {
          await hubspotClient.crm.tickets.basicApi.archive(String(t.id));
          deletedCount++;
        } catch (err) {
          console.error(
            "[syncLineItemTicketsForDeal] Error al borrar ticket pausado",
            t.id,
            err?.response?.body || err?.message || err
          );
        }
      }
    }
    console.log("[syncLineItemTicketsForDeal] Negocio en pausa, tickets eliminados:", deletedCount);
    return { created: 0, updated: 0, deleted: deletedCount };
  }

  // Index existentes por key (migración suave + detección duplicados)
  const existingIndex = new Map();
  const migrationUpdates = [];
  const duplicateIds = [];

  for (const t of existingTickets) {
    const props = t.properties || {};
    const liId = (props.of_line_item_ids || "").toString().trim();
    const fechaRaw = (props.of_fecha_de_facturacion || "").toString().trim();
    const existingKeyProp = (props.of_ticket_key || "").toString().trim();

    if (!liId || !isYMD(fechaRaw)) continue;

    const computedKey = `${dealId}::${liId}::${fechaRaw}`;
    const key = existingKeyProp || computedKey;

    if (!existingKeyProp) {
      migrationUpdates.push({
        id: String(t.id),
        properties: { of_ticket_key: computedKey },
      });
    }

    if (existingIndex.has(key)) {
      duplicateIds.push(String(t.id));
    } else {
      existingIndex.set(key, t);
    }
  }

  // soft migration keys faltantes
  if (migrationUpdates.length) {
    try {
      await hubspotClient.crm.tickets.batchApi.update({
        inputs: migrationUpdates.map((u) => ({
          id: u.id,
          properties: { of_ticket_key: u.properties.of_ticket_key },
        })),
      });
      console.log("[tickets] migration soft update count", migrationUpdates.length);
    } catch (err) {
      console.error("[tickets] error during migration update", err?.response?.body || err?.message || err);
    }
  }

  const currentLineItemIds = new Set(lineItems.map((li) => String(li.id)));

  const toCreate = [];
  const toUpdate = [];
  const toDelete = [];

  // 2) Para cada line item actual…
  for (const li of lineItems) {
    const liId = String(li.id);
    const liProps = li.properties || {};

    const pausedLineItem = parseBool(liProps.pausa) || parseBool(liProps.Pausa);

    const dates = collectBillingDateStringsForLineItem(li);

    for (const ymd of dates) {
      if (!isYMD(ymd)) continue;

      const dMs = ymdToUtcMs(ymd);
      if (Number.isNaN(dMs)) continue;

      // ventana 0..30
      if (dMs < todayUtcMs || dMs > horizonUtcMs) continue;

      const key = `${dealId}::${liId}::${ymd}`;
      const existing = existingIndex.get(key);

      if (existing) {
        if (pausedLineItem) {
          toDelete.push(String(existing.id));
        } else {
          const props = buildTicketPropsBase({
            deal,
            lineItem: li,
            billingDateYMD: ymd,
          });

          // si es hoy => READY (solo si existe env)
          const readyStage =
            process.env.BILLING_TICKET_STAGE_READY || process.env.BILLING_ORDER_STAGE_READY;
          if (readyStage && ymd === todayYMD) {
            props.hs_pipeline_stage = readyStage;
          }

          toUpdate.push({
            id: String(existing.id),
            properties: filterTicketProps(props),
          });
        }
        existingIndex.delete(key);
      } else {
        if (!pausedLineItem) {
          const props = buildTicketPropsForCreate({
            deal,
            lineItem: li,
            billingDateYMD: ymd,
            todayYMD,
          });

          toCreate.push({
            properties: props,
            associations: [
              {
                to: { id: dealId },
                types: [
                  {
                    associationCategory: "HUBSPOT_DEFINED",
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

  // duplicados por key -> borrar
  if (duplicateIds.length) {
    console.log("[tickets] found duplicate tickets by key:", duplicateIds);
    for (const dupId of duplicateIds) toDelete.push(dupId);
  }

  console.log("[tickets] pre-resumen", {
    dealId,
    existingTickets: existingTickets.length,
    toCreate: toCreate.length,
    toUpdate: toUpdate.length,
    toDelete: toDelete.length,
  });

  if (toCreate[0]) console.log("[tickets] ejemplo create props", toCreate[0].properties);
  if (toUpdate[0]) console.log("[tickets] ejemplo update props", toUpdate[0].properties);

  // 3) Tickets restantes para line items que ya no existen → eliminar si >= hoy
  for (const [key, t] of existingIndex.entries()) {
    const props = t.properties || {};
    const liId = (props.of_line_item_ids || "").toString().trim();
    const fechaStr = (props.of_fecha_de_facturacion || "").toString().trim();

    if (!liId || !isYMD(fechaStr)) continue;

    const stillExists = currentLineItemIds.has(liId);
    if (!stillExists) {
      const dMs = ymdToUtcMs(fechaStr);
      if (!Number.isNaN(dMs) && dMs >= todayUtcMs) {
        toDelete.push(String(t.id));
      }
    }
  }

  // 4) Ejecutar borrados, updates, creates
  let createdCount = 0;
  let updatedCount = 0;
  let deletedCount = 0;

  for (const id of toDelete) {
    try {
      await hubspotClient.crm.tickets.basicApi.archive(id);
      deletedCount++;
    } catch (err) {
      console.error(
        "[syncLineItemTicketsForDeal] Error al borrar ticket",
        id,
        err?.response?.body || err?.message || err
      );
    }
  }

  if (toUpdate.length) {
    await hubspotClient.crm.tickets.batchApi.update({
      inputs: toUpdate.map((u) => ({ id: u.id, properties: u.properties })),
    });
    updatedCount += toUpdate.length;
  }

  if (toCreate[0]) {
    console.log("[tickets] create pipeline/stage", {
      hs_pipeline: toCreate[0].properties.hs_pipeline,
      hs_pipeline_stage: toCreate[0].properties.hs_pipeline_stage,
    });
  }

  if (toCreate.length) {
    const resp = await hubspotClient.crm.tickets.batchApi.create({ inputs: toCreate });
    createdCount += (resp.results || []).length;
  }

  console.log("[syncLineItemTicketsForDeal] resumen", {
    dealId,
    created: createdCount,
    updated: updatedCount,
    deleted: deletedCount,
  });

  if (_missingTicketPropertyNames.size) {
    console.log(
      "[tickets] propiedades ignoradas (no existen en el portal):",
      Array.from(_missingTicketPropertyNames)
    );
  }

  return { created: createdCount, updated: updatedCount, deleted: deletedCount };
}
