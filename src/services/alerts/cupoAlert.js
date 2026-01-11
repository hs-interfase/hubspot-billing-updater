// src/services/alerts/cupoAlerts.js
import { hubspotClient } from "../../hubspotClient.js";
import { parseBool, parseNumber, safeString } from "../../utils/parsers.js";
import { getTodayYMD } from "../../utils/dateUtils.js";

/**
 * Alerta preventiva de cupo (ANTES de facturar).
 * - Vive en Ticket porque el monto/horas se edita ahí.
 * - Idempotente: si ya emitió preventiva, no vuelve a emitir.
 *
 * Requiere props en Ticket:
 *  - of_cupo_alerta_preventiva_emitida (bool)
 *  - of_cupo_alerta_preventiva_fecha (date)
 *  - of_cupo_restante_proyectado (number)
 *  - of_cupo_consumo_estimado (number)
 *
 * Deal:
 *  - cupo_activo (bool)
 *  - tipo_de_cupo (text/enum)
 *  - cupo_restante (number)
 *  - cupo_umbral (number)
 *
 * Line Item:
 *  - parte_del_cupo (bool)
 */
export async function applyCupoPreventiveAlertFromTicket({
  deal,
  ticket,
  lineItem,
}) {
  const dp = deal?.properties || {};
  const tp = ticket?.properties || {};
  const lp = lineItem?.properties || {};

  // 0) Solo aplica si este LI es parte del cupo
  const parteDelCupo = parseBool(lp.parte_del_cupo);
  if (!parteDelCupo) return { applied: false, reason: "LI no es parte_del_cupo" };

  // 1) Cupo activo y umbral válido
  const cupoActivo = parseBool(dp.cupo_activo);
  if (!cupoActivo) return { applied: false, reason: "cupo_activo=false" };

  const tipoCupoRaw = safeString(dp.tipo_de_cupo).toLowerCase();
  const cupoRestante = parseNumber(dp.cupo_restante, null);
  const cupoUmbral = parseNumber(dp.cupo_umbral, null);

  if (cupoRestante == null || cupoUmbral == null) {
    return { applied: false, reason: "faltan cupo_restante o cupo_umbral" };
  }

  // 2) Idempotencia preventiva en Ticket
  if (parseBool(tp.of_cupo_alerta_preventiva_emitida)) {
    return { applied: false, reason: "preventiva ya emitida" };
  }

  // 3) Calcular consumo estimado desde el Ticket
  //    Ajustá los nombres a tus props reales:
  let consumo = 0;

  const isHoras =
    tipoCupoRaw.includes("horas") || tipoCupoRaw.includes("horas".toLowerCase());
  const isMonto =
    tipoCupoRaw.includes("monto") || tipoCupoRaw.includes("monto".toLowerCase());

  if (isHoras) {
    // ⬇️ Cambiá por tu propiedad real en Ticket
    consumo = parseNumber(tp.of_cantidad_horas ?? tp.of_cantidad ?? tp.of_horas, 0);
  } else if (isMonto) {
    // monto_real_a_facturar debería ser NETO (sin IVA)
    consumo = parseNumber(tp.monto_real_a_facturar, 0);
  } else {
    return { applied: false, reason: `tipo_de_cupo desconocido: ${dp.tipo_de_cupo}` };
  }

  const restanteProyectado = cupoRestante - consumo;

  // 4) Solo disparar si toca umbral
  //    (asumo umbral ABSOLUTO: horas o monto)
  if (restanteProyectado > cupoUmbral) {
    return {
      applied: false,
      reason: "no toca umbral",
      consumo,
      restanteProyectado,
    };
  }

  // 5) Marcar Ticket (dispara workflow HubSpot)
  const today = getTodayYMD();
  const ticketId = String(ticket?.id || ticket?.properties?.hs_object_id);

  const updateProps = {
    of_cupo_alerta_preventiva_emitida: "true",
    of_cupo_alerta_preventiva_fecha: today,
    of_cupo_restante_proyectado: String(restanteProyectado),
    of_cupo_consumo_estimado: String(consumo),
  };

  await hubspotClient.crm.tickets.basicApi.update(ticketId, { properties: updateProps });

  return { applied: true, consumo, restanteProyectado, ticketId, updateProps };
}
