// src/services/cupo/revertCupo.js
//
// REVERSIÓN IDEMPOTENTE DE CUPO (inversa exacta de consumeCupoAfterInvoice).
//
// SIN CALL SITES TODAVÍA: este módulo se cablea en el bloque 2 del flujo
// cancelar/revertir. Nada lo llama hoy.
//
// DISEÑO
//
// 1) ORDEN INVERSO AL CONSUMO (fail-closed, nunca doble crédito):
//    El consumo escribe deal PRIMERO y ticket (marker) DESPUÉS; si el marker
//    falla, el riesgo es DOBLE CONSUMO (ver catch de consumeCupo). Acá se
//    invierte: se limpia el marker del ticket PRIMERO y el deal DESPUÉS.
//    - Si falla el ticket → no se tocó el deal → estado intacto, reintentable.
//    - Si falla el deal   → el marker ya quedó limpio → SUB-crédito (el deal
//      quedó con el consumo aplicado), reconciliable a mano con instrucción
//      exacta en el reporte. Jamás SOBRE-crédito: una reversión repetida ve el
//      marker limpio y hace skip.
//
// 2) IDEMPOTENCIA por el marker de consumo (cupo_consumo_invoice_id, con
//    fallback de lectura a of_cupo_consumo_invoice_id, mismo patrón que
//    consumeCupo): solo se revierte si el ticket consumió ESTA invoice.
//    Nota: el repo solo ESCRIBE cupo_consumo_invoice_id (of_… solo se lee),
//    por eso acá solo se limpia esa. Marker distinto/vacío → skip sin
//    escrituras. Esto también da la regla 'solo hacia adelante' para legacy:
//    tickets viejos sin marker registrado no se revierten automáticamente.
//
// 3) NC POR SIGNO, sin rama especial: el crédito es of_cupo_consumo_valor con
//    su signo. Un consumo de nota de crédito quedó registrado NEGATIVO, así
//    que revertirlo RE-DEBITA por pura aritmética (consumido - (-300) suma).
//
// 4) REACTIVACIÓN CONDICIONADA: cupo_activo vuelve a 'true' SOLO si lo apagó
//    el motor (cupo_activo='false' con cupo_estado 'Agotado' o 'Pasado') y la
//    reversión deja restante > 0. Si cupo_estado es 'Desactivado' fue un
//    apagado humano y NO se toca.
//
// 5) DATO FIEL MANDA (criterio de consumeCupo): si los números nuevos dan
//    'Inconsistente' o cupo_consumido negativo, la reversión se aplica igual
//    (la evidencia reconcilia) y se devuelve inconsistente:true para que el
//    orquestador avise (reportFn warn).
//
// ESCRITURAS
// - Ticket (1º): cupo_consumo_invoice_id='', of_cupo_consumido='false',
//                of_cupo_historial += línea 'reversion'.
//                (of_cupo_consumo_valor NO se pisa: es la evidencia.)
// - Deal (2º, un solo update): cupo_consumido, cupo_restante, cupo_estado,
//                cupo_ultima_actualizacion, y cupo_activo='true' si reactiva.

import { hubspotClient } from '../../hubspotClient.js';
import { parseNumber, safeString, parseBool } from '../../utils/parsers.js';
import { getTodayYMD } from '../../utils/dateUtils.js';
import { calculateCupoEstado } from '../../utils/propertyHelpers.js';
import logger from '../../../lib/logger.js';
import { reportHubSpotError } from '../../utils/hubspotErrorCollector.js';
import { buildCupoHistorialLine, appendHistorial } from './cupoHistorial.js';

const MODULE = 'revertCupo';

/**
 * CÁLCULO PURO DE LA REVERSIÓN (sin HubSpot, testeable).
 *
 * Inversa exacta de calcularConsumoCupo aplicada al deal:
 *   consumo:   cupo_consumido += consumo ; cupo_restante = total - consumido
 *   reversión: cupo_consumido -= valor   ; cupo_restante += valor
 * (si el invariante consumido+restante=total valía antes, se conserva).
 *
 * @param {Object} params
 * @param {number|string} params.valorConsumido - of_cupo_consumo_valor del ticket
 * @param {Object} params.dealProps             - props actuales del deal (cupo_*)
 * @param {Object} [helpers]
 * @param {Function} [helpers.calculateCupoEstadoFn] - inyectable (tests)
 * @returns {{ok:boolean, reason?:string, credito?:number, cupoConsumidoNuevo?:number,
 *            cupoRestanteNuevo?:number, cupoReactivable?:boolean,
 *            cupoEstadoNuevo?:string, inconsistente?:boolean}}
 */
export function calcularReversionCupo(
  { valorConsumido, dealProps = {} } = {},
  { calculateCupoEstadoFn = calculateCupoEstado } = {}
) {
  const dp = dealProps || {};

  // of_cupo_consumo_valor vacío/no numérico → no sabemos cuánto devolver.
  // (Number('') es 0, por eso el chequeo explícito de vacío ANTES de Number.)
  if (valorConsumido === null || valorConsumido === undefined || safeString(valorConsumido) === '') {
    return { ok: false, reason: 'sin_valor_registrado' };
  }
  const credito = Number(valorConsumido);
  if (Number.isNaN(credito)) {
    return { ok: false, reason: 'sin_valor_registrado' };
  }

  const cupoConsumidoActual = parseNumber(dp.cupo_consumido, 0);
  const cupoRestanteActual = parseNumber(dp.cupo_restante, 0);

  // Inverso exacto del consumo. NC por signo: credito negativo re-debita.
  const cupoConsumidoNuevo = cupoConsumidoActual - credito;
  const cupoRestanteNuevo = cupoRestanteActual + credito;

  // Reactivación: solo si lo apagó el motor (Agotado/Pasado) y vuelve a haber
  // cupo. 'Desactivado' = apagado humano → no tocar.
  const estadoActual = safeString(dp.cupo_estado);
  const cupoReactivable =
    !parseBool(dp.cupo_activo) &&
    (estadoActual === 'Agotado' || estadoActual === 'Pasado') &&
    cupoRestanteNuevo > 0;

  // Estado nuevo sobre los números nuevos (y el cupo_activo que va a quedar).
  const cupoEstadoNuevo = calculateCupoEstadoFn({
    ...dp,
    cupo_activo: cupoReactivable ? 'true' : dp.cupo_activo,
    cupo_consumido: String(cupoConsumidoNuevo),
    cupo_restante: String(cupoRestanteNuevo),
  });

  // Dato fiel manda (criterio de consumeCupo): números raros no bloquean la
  // reversión, solo se señalizan para que el orquestador avise.
  const inconsistente = cupoEstadoNuevo === 'Inconsistente' || cupoConsumidoNuevo < 0;

  return {
    ok: true,
    credito,
    cupoConsumidoNuevo,
    cupoRestanteNuevo,
    cupoReactivable,
    cupoEstadoNuevo,
    inconsistente,
  };
}

/**
 * Revierte el consumo de cupo de un ticket para UNA invoice.
 * NUNCA lanza: todo error devuelve { reverted:false, reason } y reporta.
 *
 * @param {Object} params
 * @param {string|number} params.dealId
 * @param {string|number} params.ticketId
 * @param {string|number} params.invoiceId
 * @param {string} [params.usuario] - quién pidió la reversión (para el historial)
 * @param {Object} [deps] - inyección de dependencias (tests)
 * @param {Object}   [deps.client]               - hubspotClient
 * @param {Function} [deps.reportFn]             - reportHubSpotError
 * @param {Function} [deps.calculateCupoEstadoFn]
 * @param {Function} [deps.todayYMDFn]           - () => 'YYYY-MM-DD'
 * @returns {Promise<{reverted:boolean, reason?:string, credito?:number,
 *           cupoRestanteNuevo?:number, cupoReactivado?:boolean, inconsistente?:boolean}>}
 */
export async function revertCupoForInvoice({ dealId, ticketId, invoiceId, usuario } = {}, deps = {}) {
  const {
    client = hubspotClient,
    reportFn = reportHubSpotError,
    calculateCupoEstadoFn = calculateCupoEstado,
    todayYMDFn = getTodayYMD,
  } = deps;
  const fn = 'revertCupoForInvoice';

  try {
    // ========== 1. LEER TICKET Y DEAL ==========
    const ticket = await client.crm.tickets.basicApi.getById(String(ticketId), [
      'cupo_consumo_invoice_id',
      'of_cupo_consumo_invoice_id',
      'of_cupo_consumo_valor',
      'of_cupo_historial',
      'of_cupo_consumido',
    ]);
    const deal = await client.crm.deals.basicApi.getById(String(dealId), [
      'cupo_activo',
      'tipo_de_cupo',
      'cupo_consumido',
      'cupo_restante',
      'cupo_total',
      'cupo_total_monto',
      'cupo_umbral',
      'cupo_estado',
    ]);

    const tp = ticket?.properties || {};
    const dp = deal?.properties || {};

    // ========== 2. IDEMPOTENCIA (marker de consumo) ==========
    const marker = safeString(tp.cupo_consumo_invoice_id || tp.of_cupo_consumo_invoice_id);
    if (marker !== String(invoiceId)) {
      logger.info(
        { module: MODULE, fn, ticketId, invoiceId, marker: marker || '(vacío)' },
        'SKIP reversión: el ticket no consumió cupo con esta invoice (o ya se revirtió)'
      );
      return { reverted: false, reason: 'no_consumio_o_ya_revertido' };
    }

    // ========== 3. CALCULAR REVERSIÓN (helper puro) ==========
    const calc = calcularReversionCupo(
      { valorConsumido: tp.of_cupo_consumo_valor, dealProps: dp },
      { calculateCupoEstadoFn }
    );
    if (!calc.ok) {
      logger.warn(
        { module: MODULE, fn, dealId, ticketId, invoiceId, of_cupo_consumo_valor: tp.of_cupo_consumo_valor },
        'Reversión sin valor registrado: no se toca nada, reconciliar a mano'
      );
      reportFn({
        level: 'error',
        objectType: 'deal',
        objectId: String(dealId),
        message:
          `Reversión de cupo NO aplicada: el ticket ${ticketId} consumió cupo con la invoice ` +
          `${invoiceId} pero of_cupo_consumo_valor está vacío o no es numérico (monto desconocido). ` +
          `Reconciliar a mano el cupo del deal ${dealId} con el monto real de esa invoice.`,
      });
      return { reverted: false, reason: 'sin_valor_registrado' };
    }

    const { credito, cupoConsumidoNuevo, cupoRestanteNuevo, cupoReactivable, cupoEstadoNuevo, inconsistente } = calc;

    // ========== 4. TICKET PRIMERO (fail-closed: nunca doble crédito) ==========
    const linea = buildCupoHistorialLine({
      fecha: todayYMDFn(),
      tipo: 'reversion',
      valor: credito,
      invoiceId,
      extra: usuario ? `por ${usuario}` : undefined,
    });

    const ticketUpdateProps = {
      cupo_consumo_invoice_id: '',       // única marker que el repo escribe
      of_cupo_consumido: 'false',
      of_cupo_historial: appendHistorial(tp.of_cupo_historial, linea),
    };

    try {
      await client.crm.tickets.basicApi.update(String(ticketId), { properties: ticketUpdateProps });
    } catch (err) {
      // El deal NO se tocó: estado intacto, se puede reintentar sin riesgo.
      logger.error(
        { module: MODULE, fn, dealId, ticketId, invoiceId, err: err?.message },
        'Reversión abortada: no se pudo limpiar el marker del ticket (deal intacto)'
      );
      reportFn({
        level: 'error',
        objectType: 'ticket',
        objectId: String(ticketId),
        message:
          `Reversión de cupo ABORTADA (invoice ${invoiceId}): no se pudo limpiar el marker de ` +
          `consumo del ticket. El deal ${dealId} NO se tocó — reintentar la reversión.`,
      });
      return { reverted: false, reason: 'ticket_write_failed' };
    }

    // ========== 5. DEAL DESPUÉS (un solo update) ==========
    const dealUpdateProps = {
      cupo_consumido: String(cupoConsumidoNuevo),
      cupo_restante: String(cupoRestanteNuevo),
      cupo_estado: cupoEstadoNuevo,
      cupo_ultima_actualizacion: todayYMDFn(),
    };
    if (cupoReactivable) {
      dealUpdateProps.cupo_activo = 'true';
    }

    try {
      await client.crm.deals.basicApi.update(String(dealId), { properties: dealUpdateProps });
    } catch (err) {
      // El marker ya quedó limpio → SUB-crédito reconciliable, jamás sobre-crédito.
      logger.error(
        { module: MODULE, fn, dealId, ticketId, invoiceId, credito, err: err?.message },
        'Reversión INCOMPLETA: marker del ticket limpio pero el deal no se actualizó'
      );
      reportFn({
        level: 'error',
        objectType: 'deal',
        objectId: String(dealId),
        message:
          `Reversión de cupo INCOMPLETA: el marker del ticket ya se limpió pero el deal no se ` +
          `pudo actualizar. Reconciliar a mano: sumar ${credito} a cupo_restante y restarlo de ` +
          `cupo_consumido del deal ${dealId}; invoice ${invoiceId}, ticket ${ticketId}.`,
      });
      return { reverted: false, reason: 'deal_write_failed', credito };
    }

    // ========== 6. AVISO SI QUEDÓ INCONSISTENTE ==========
    if (inconsistente) {
      reportFn({
        level: 'warn',
        objectType: 'deal',
        objectId: String(dealId),
        message:
          `Reversión de cupo aplicada pero los números del deal ${dealId} quedaron inconsistentes ` +
          `(consumido ${cupoConsumidoNuevo}, restante ${cupoRestanteNuevo}, estado ` +
          `${cupoEstadoNuevo || '(vacío)'}). Revisar (invoice ${invoiceId}, ticket ${ticketId}).`,
      });
    }

    logger.info(
      { module: MODULE, fn, dealId, ticketId, invoiceId, credito, cupoRestanteNuevo, cupoReactivado: cupoReactivable, inconsistente },
      'Reversión de cupo completada'
    );

    return {
      reverted: true,
      credito,
      cupoRestanteNuevo,
      cupoReactivado: cupoReactivable,
      inconsistente,
    };
  } catch (err) {
    // NUNCA lanza: cualquier error no contemplado se reporta y devuelve reason:'error'.
    logger.error(
      { module: MODULE, fn, dealId, ticketId, invoiceId, err: err?.message },
      'Error inesperado en la reversión de cupo'
    );
    try {
      reportFn({
        level: 'error',
        objectType: 'deal',
        objectId: String(dealId),
        message: `Error inesperado en la reversión de cupo (invoice ${invoiceId}, ticket ${ticketId}): ${err?.message}`,
      });
    } catch { /* el reporte jamás debe tumbar la reversión */ }
    return { reverted: false, reason: 'error' };
  }
}
