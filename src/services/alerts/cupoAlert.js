// src/services/alerts/cupoAlerts.js
import { hubspotClient } from "../../hubspotClient.js";
import { parseBool, parseNumber, safeString } from "../../utils/parsers.js";
import { getTodayYMD } from "../../utils/dateUtils.js";
import logger from "../../../lib/logger.js";
import { reportHubSpotError } from "../../utils/hubspotErrorCollector.js";

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
 *  - facturacion_activa (bool)
 *  - tipo_de_cupo (text/enum)
 *  - cupo_restante (number)
 *  - cupo_umbral (number)
 *
 * Line Item:
 *  - parte_del_cupo (bool)
 */
export async function applyCupoPreventiveAlertFromTicket({ deal, ticket, lineItem }) {
  const log = logger.child({
    module: "cupoAlerts",
    fn: "applyCupoPreventiveAlertFromTicket",
    dealId: deal?.id,
    ticketId: ticket?.id,
    lineItemId: lineItem?.id,
  });

  const dp = deal?.properties || {};
  const tp = ticket?.properties || {};
  const lp = lineItem?.properties || {};

  // 0) Solo aplica si este LI es parte del cupo
  const parteDelCupo = parseBool(lp.parte_del_cupo);
  if (!parteDelCupo) {
    log.debug({ parteDelCupo }, "skip: LI no es parte_del_cupo");
    return { applied: false, reason: "LI no es parte_del_cupo" };
  }

  // 1) Cupo "efectivo" (antes de facturar)
  const facturacionActiva = parseBool(dp.facturacion_activa);
  const cupoActivoStored = parseBool(dp.cupo_activo);
  const cupoActivoEfectivo = cupoActivoStored || (facturacionActiva && parteDelCupo);

  if (!cupoActivoEfectivo) {
    log.debug(
      { cupoActivoStored, facturacionActiva, parteDelCupo },
      "skip: cupo no activo"
    );
    return {
      applied: false,
      reason: "cupo no activo (stored=false y condiciones efectivas=false)",
      debug: { cupoActivoStored, facturacionActiva, parteDelCupo },
    };
  }

  // 2) Umbral válido + datos base
  const tipoCupoRaw = safeString(dp.tipo_de_cupo).toLowerCase();
  const cupoRestante = parseNumber(dp.cupo_restante, null);
  const cupoUmbral = parseNumber(dp.cupo_umbral, null);

  if (cupoRestante == null || cupoUmbral == null) {
    log.warn(
      { cupoRestante, cupoUmbral },
      "faltan cupo_restante o cupo_umbral"
    );
    return { applied: false, reason: "faltan cupo_restante o cupo_umbral" };
  }

  // 3) Idempotencia preventiva en Ticket
  if (parseBool(tp.of_cupo_alerta_preventiva_emitida)) {
    log.debug("skip: preventiva ya emitida");
    return { applied: false, reason: "preventiva ya emitida" };
  }

  // 4) Calcular consumo estimado desde el Ticket
  let consumo = 0;

  const isHoras =
    tipoCupoRaw.includes("horas");

  const isMonto =
    tipoCupoRaw.includes("monto");

  if (isHoras) {
    consumo = parseNumber(tp.cantidad_real, 0);
  } else if (isMonto) {
    consumo = parseNumber(tp.total_real_a_facturar, 0);
  } else {
    log.warn(
      { tipo_de_cupo: dp.tipo_de_cupo },
      "tipo_de_cupo desconocido"
    );
    return {
      applied: false,
      reason: `tipo_de_cupo desconocido: ${dp.tipo_de_cupo}`,
    };
  }

  const restanteProyectado = cupoRestante - consumo;

  // 5) Solo disparar si toca umbral
  if (restanteProyectado > cupoUmbral) {
    log.debug(
      { consumo, restanteProyectado, cupoUmbral },
      "skip: no toca umbral"
    );
    return {
      applied: false,
      reason: "no toca umbral",
      consumo,
      restanteProyectado,
    };
  }

  // 6) Marcar Ticket (dispara workflow HubSpot)
  const today = getTodayYMD();
  const ticketId = String(ticket?.id || ticket?.properties?.hs_object_id);

  const updateProps = {
    of_cupo_alerta_preventiva_emitida: "true",
    of_cupo_alerta_preventiva_fecha: today,
    of_cupo_restante_proyectado: String(restanteProyectado),
    of_cupo_consumo_estimado: String(consumo),
  };

  // Guard: skip if empty
  if (Object.keys(updateProps).length === 0) {
    log.info(
      { ticketId },
      "⊘ SKIP_EMPTY_UPDATE: No properties to update"
    );
    return { applied: false, consumo, restanteProyectado, ticketId, updateProps: {} };
  }

  try {
    await hubspotClient.crm.tickets.basicApi.update(ticketId, {
      properties: updateProps,
    });

    log.info(
      { ticketId, updateProps },
      "cupo preventive alert applied"
    );

  } catch (err) {
    const status = err?.response?.status ?? err?.statusCode ?? null;

    log.error(
      { err, status, ticketId },
      "ticket_update_failed: cupo_preventive_alert"
    );

    // Reportar SOLO errores accionables
    if (
      status === null ||
      (status >= 400 && status < 500 && status !== 429)
    ) {
      reportHubSpotError({
        objectType: "ticket",
        objectId: ticketId,
        message: `ticket_update_failed (cupo_preventive_alert): ${
          err?.message || err
        }`,
      });
    }

    throw err;
  }

  return { applied: true, consumo, restanteProyectado, ticketId, updateProps };
}
