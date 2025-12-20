// src/cupo/recalcCupoForDeal.js
import { hubspotClient } from "../hubspotClient.js";

/**
 * Helpers
 */
const asBool = (raw) => {
  const v = (raw ?? "").toString().trim().toLowerCase();
  return v === "true" || v === "1" || v === "sí" || v === "si" || v === "yes";
};

const asNumber = (raw) => {
  const n = Number(raw);
  return Number.isFinite(n) ? n : NaN;
};

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

/**
 * Lee ids de tickets asociados al deal (v4)
 */
async function getAssociatedTicketIds(dealId) {
  const out = [];
  let after;
  do {
    const page = await hubspotClient.crm.associations.v4.basicApi.getPage(
      "deals",
      String(dealId),
      "tickets",
      100,
      after
    );
    for (const r of page.results || []) out.push(String(r.toObjectId));
    after = page.paging?.next?.after;
  } while (after);
  return out;
}

/**
 * Lee ids de line items asociados al ticket (v4)
 */
async function getAssociatedLineItemIds(ticketId) {
  const out = [];
  let after;
  do {
    const page = await hubspotClient.crm.associations.v4.basicApi.getPage(
      "tickets",
      String(ticketId),
      "line_items",
      100,
      after
    );
    for (const r of page.results || []) out.push(String(r.toObjectId));
    after = page.paging?.next?.after;
  } while (after);
  return out;
}

/**
 * Recalcula cupo desde tickets (Opción A).
 *
 * Reglas:
 * - Un ticket consume cupo SOLO si alguno de sus line items tiene parte_del_cupo = true
 * - tipo_de_cupo = "Por horas"  => consume horas = ticket.total_de_horas_consumidas
 * - tipo_de_cupo = "Por Monto"  => consume monto = horas * valor_hora
 *   - horas = ticket.total_de_horas_consumidas
 *   - valor_hora = ticket.bolsa_precio_hora (si no existe, se busca en el line item)
 *
 * Deal:
 * - cupo_total (number)
 * - cupo_umbral (0..1)
 * - cupo_consumido, cupo_restante, cupo_estado (se actualizan)
 */
export async function recalcCupoForDeal(dealId) {
  // 1) Leer deal
  const deal = await hubspotClient.crm.deals.basicApi.getById(String(dealId), [
    "cupo_activo",
    "tipo_de_cupo",
    "cupo_total",
    "cupo_umbral",
  ]);

  const p = deal.properties || {};
  const cupoActivo = asBool(p.cupo_activo);

  // Si no está activo, seteo a 0/OK (simple e idempotente)
  if (!cupoActivo) {
    await hubspotClient.crm.deals.basicApi.update(String(dealId), {
      properties: {
        cupo_consumido: "0",
        cupo_restante: p.cupo_total ?? "0",
        cupo_estado: "OK",
      },
    });
    return { dealId, cupoActivo: false };
  }

  const tipo = (p.tipo_de_cupo || "").toString().trim(); // "Por horas" | "Por Monto"
  const total = asNumber(p.cupo_total);
  const umbral = clamp(asNumber(p.cupo_umbral), 0, 1);

  if (!tipo || !Number.isFinite(total) || total <= 0 || !Number.isFinite(umbral)) {
    await hubspotClient.crm.deals.basicApi.update(String(dealId), {
      properties: { cupo_estado: "Inconsistente" },
    });
    return { dealId, cupoActivo: true, estado: "Inconsistente" };
  }

  const ticketIds = await getAssociatedTicketIds(dealId);

  if (!ticketIds.length) {
    const restante = total;
    const estado =
      restante <= 0 ? "Agotado" : (restante / total <= umbral ? "Bajo Umbral" : "OK");

    await hubspotClient.crm.deals.basicApi.update(String(dealId), {
      properties: {
        cupo_consumido: "0",
        cupo_restante: String(restante),
        cupo_estado: estado,
      },
    });
    return { dealId, consumido: 0, restante, estado };
  }

  // 2) Leer tickets en batch
  // - total_de_horas_consumidas = verdad (editable en ticket)
  // - bolsa_precio_hora = valor hora (idealmente también en ticket)
  const ticketsBatch = await hubspotClient.crm.tickets.batchApi.read({
    inputs: ticketIds.map((id) => ({ id })),
    properties: ["total_de_horas_consumidas", "bolsa_precio_hora"],
  });

  let consumido = 0; // será horas o monto dependiendo del tipo
  let inconsistente = false;

  // 3) Por cada ticket, verificar si su line item es parte del cupo
  for (const t of ticketsBatch.results || []) {
    const ticketId = String(t.id);
    const tp = t.properties || {};

    const liIds = await getAssociatedLineItemIds(ticketId);
    if (!liIds.length) continue;

    // Leer line items para ver si alguno tiene parte_del_cupo = true
    // y también por si necesitamos valor_hora desde ahí
    const liBatch = await hubspotClient.crm.lineItems.batchApi.read({
      inputs: liIds.map((id) => ({ id })),
      properties: ["parte_del_cupo", "bolsa_precio_hora"],
    });

    const liParteCupo = (liBatch.results || []).find((li) =>
      asBool(li.properties?.parte_del_cupo)
    );

    // si ninguno de los line items del ticket es "parte del cupo", no consume
    if (!liParteCupo) continue;

    const horas = asNumber(tp.total_de_horas_consumidas);

    if (tipo === "Por horas") {
      if (Number.isFinite(horas) && horas > 0) consumido += horas;
      else {
        // si hay ticket marcado como parte del cupo pero no hay horas reales -> inconsistente
        inconsistente = true;
      }
      continue;
    }

    if (tipo === "Por Monto") {
      // Convertimos horas * valor_hora
      if (!Number.isFinite(horas) || horas <= 0) {
        // sin horas no puedo convertir
        inconsistente = true;
        continue;
      }

      // Prioridad: precio hora del ticket, si no del line item
      let valorHora = asNumber(tp.bolsa_precio_hora);
      if (!Number.isFinite(valorHora) || valorHora <= 0) {
        valorHora = asNumber(liParteCupo.properties?.bolsa_precio_hora);
      }

      if (!Number.isFinite(valorHora) || valorHora <= 0) {
        inconsistente = true;
        continue;
      }

      consumido += horas * valorHora;
      continue;
    }

    // tipo inválido
    await hubspotClient.crm.deals.basicApi.update(String(dealId), {
      properties: { cupo_estado: "Inconsistente" },
    });
    return { dealId, estado: "Inconsistente" };
  }

  const restante = total - consumido;

  let estado = "OK";
  if (inconsistente) estado = "Inconsistente";
  else if (restante <= 0) estado = "Agotado";
  else if (restante / total <= umbral) estado = "Bajo Umbral";

  await hubspotClient.crm.deals.basicApi.update(String(dealId), {
    properties: {
      cupo_consumido: String(consumido),
      cupo_restante: String(restante),
      cupo_estado: estado,
    },
  });

  return { dealId, consumido, restante, estado };
}
