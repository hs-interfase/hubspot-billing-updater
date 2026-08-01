// src/services/mirrorUtils.js
//
// Utilidades para resolver relaciones PY ↔ UY mirror en line items (y futuro: tickets).
// Este módulo es el punto central de lookup — no contiene lógica de negocio,
// solo resolución de IDs entre objetos espejados.
import { hubspotClient } from '../hubspotClient.js';
import logger from '../../lib/logger.js';
import { reportHubSpotError } from '../utils/hubspotErrorCollector.js';
import { emailAvisoMirror } from './notifications/mirrorAlert.js';
import { avisarTicketEspejo } from './notifications/mirrorTicketAlert.js';
import { mirrorPuntualEnabled } from '../config/mirrorPuntualFlags.js';
import { parseTicketKeyFromLineItemKey } from '../utils/ticketKey.js';
import { getAllAssociatedIds } from '../utils/hubspotAssociations.js';
import { withRetry } from '../utils/withRetry.js';
import {
  TICKET_PIPELINE,
  TICKET_STAGES,
  AUTOMATED_TICKET_PIPELINE,
  FORECAST_AUTO_STAGES,
} from '../config/constants.js';

/**
 * Dado el ID de un line item PY, encuentra su line item espejo en el deal UY.
 *
 * Flujo:
 *   pyLineItemId
 *     → deal asociado al LI (associations v4)
 *     → deal.properties.deal_uy_mirror_id
 *     → line items del deal UY (associations v4)
 *     → batch read → encontrar of_line_item_py_origen_id === pyLineItemId
 *
 * Protección anti-loop: si el deal del LI tiene es_mirror_de_py=true,
 * retorna null inmediatamente (no propagar desde UY hacia UY).
 *
 * @param {string|number} pyLineItemId
 * @returns {Promise<{ mirrorDealId: string, mirrorLineItemId: string } | null>}
 */
export async function findMirrorLineItem(pyLineItemId) {
  const log = logger.child({
    module: 'mirrorUtils',
    fn: 'findMirrorLineItem',
    pyLineItemId: String(pyLineItemId),
  });

  // 1) Obtener deal asociado al LI PY
  let dealAssocResp;
  try {
    dealAssocResp = await hubspotClient.crm.associations.v4.basicApi.getPage(
      'line_items',
      String(pyLineItemId),
      'deals',
      10
    );
  } catch (err) {
    log.warn({ err }, 'No se pudo obtener deal del line item PY');
    return null;
  }

  const dealId = String((dealAssocResp.results || [])[0]?.toObjectId || '').trim();
  if (!dealId) {
    log.warn('Line item PY sin deal asociado');
    return null;
  }

  // 2) Leer deal PY: verificar que no sea ya un mirror + obtener deal_uy_mirror_id
  let deal;
  try {
    deal = await hubspotClient.crm.deals.basicApi.getById(
      dealId,
      ['deal_uy_mirror_id', 'es_mirror_de_py']
    );
  } catch (err) {
    log.warn({ err, dealId }, 'No se pudo leer el deal PY');
    return null;
  }

  const dealProps = deal?.properties || {};

  // Anti-loop: si este LI pertenece a un deal que ya ES mirror, no propagar
  if (String(dealProps.es_mirror_de_py || '').toLowerCase() === 'true') {
    log.debug({ dealId }, 'Deal es mirror de PY, no se propaga para evitar loop');
    return null;
  }

  const mirrorDealId = String(dealProps.deal_uy_mirror_id || '').trim();
  if (!mirrorDealId) {
    log.debug({ dealId }, 'Deal PY sin deal_uy_mirror_id, nada que propagar');
    return null;
  }

  // 3) Obtener IDs de line items del deal UY espejo (con paginación completa)
  let mirrorLiIds;
  try {
    mirrorLiIds = await getAllAssociatedIds(hubspotClient, 'deals', mirrorDealId, 'line_items');
  } catch (err) {
    log.warn({ err, mirrorDealId }, 'No se pudo obtener line items del deal UY');
    return null;
  }
  if (!mirrorLiIds.length) {
    log.debug({ mirrorDealId }, 'Deal UY sin line items asociados');
    return null;
  }

  // 4) Batch read para encontrar el espejo por of_line_item_py_origen_id
  let batchResp;
  try {
    batchResp = await hubspotClient.crm.lineItems.batchApi.read({
      inputs: mirrorLiIds.map(id => ({ id })),
      properties: ['of_line_item_py_origen_id', 'name', 'uy', 'pais_operativo'],
    });
  } catch (err) {
    log.warn({ err, mirrorDealId }, 'No se pudo batch-read line items del deal UY');
    return null;
  }

  const pyId = String(pyLineItemId);
  const mirrorLi = (batchResp.results || []).find(li =>
    String(li.properties?.of_line_item_py_origen_id || '').trim() === pyId
  );

  if (!mirrorLi) {
    log.debug({ mirrorDealId, pyLineItemId }, 'No se encontró line item espejo UY para este PY');
    return null;
  }

  log.info(
    { mirrorDealId, mirrorLineItemId: mirrorLi.id, name: mirrorLi.properties?.name },
    'Line item espejo UY encontrado'
  );

  return {
    mirrorDealId,
    mirrorLineItemId: String(mirrorLi.id),
    pyDealId: dealId,
  };
}

/**
 * Dado el ID de un line item PY automático que acaba de facturar,
 * encuentra su ticket forecast en el mirror UY y lo promueve al pipeline
 * manual en stage "Próximos a Facturar" (TICKET_STAGES.NEW).
 * El admin luego lo mueve a "Listo para Facturar" (TICKET_STAGES.READY) para emitir.
 *
 * Solo debe llamarse cuando el LI PY es automático.
 * Para PY manuales usar notifyMirrorDealOnManualEmission.
 *
 * Diseñado para llamarse fire-and-forget desde phase3 y urgentBillingService.
 * Nunca lanza — todos los errores son capturados y logueados.
 *
 * @param {string|number} pyLineItemId  ID del line item PY que facturó
 */
export async function promoteMirrorTicketToManualReady(pyLineItemId, billingYMD) {
  const log = logger.child({
    module: 'mirrorUtils',
    fn: 'promoteMirrorTicketToManualReady',
    pyLineItemId: String(pyLineItemId),
  });

  // 1) Encontrar el LI UY espejo
  let mirrorInfo;
  try {
    mirrorInfo = await findMirrorLineItem(pyLineItemId);
  } catch (err) {
    log.warn({ err }, 'Error buscando mirror line item, abortando promoción');
    return;
  }

  if (!mirrorInfo) {
    log.debug('Sin mirror UY para este LI PY, nada que promover');
    return;
  }

const { mirrorLineItemId, mirrorDealId, pyDealId } = mirrorInfo;

  // 2) Leer LI UY: necesitamos line_item_key y facturacion_automatica
  let mirrorLi;
  try {
    mirrorLi = await hubspotClient.crm.lineItems.basicApi.getById(
      String(mirrorLineItemId),
    ['line_item_key', 'facturacion_automatica', 'name', 'hs_recurring_billing_number_of_payments', 'hs_recurring_billing_period']
    );
  } catch (err) {
    log.warn({ err, mirrorLineItemId }, 'Error leyendo LI UY, abortando');
    return;
  }

  const mirrorProps = mirrorLi?.properties || {};
  const mirrorLik = String(mirrorProps.line_item_key || '').trim();

  if (!mirrorLik) {
    log.warn({ mirrorLineItemId }, 'LI UY sin line_item_key, no se puede buscar ticket');
    return;
  }

  // 3) Buscar ticket forecast automático del LI UY por of_line_item_key
  let forecastTicket;
  try {
    if (!billingYMD) {
      log.warn({ mirrorLik }, 'billingYMD no recibido, no se puede buscar ticket por key exacta');
      return;
    }

    const { buildTicketKeyFromLineItemKey } = await import('../utils/ticketKey.js');
    const ticketKey = buildTicketKeyFromLineItemKey(mirrorDealId, mirrorLik, billingYMD);

    const searchBody = {
      filterGroups: [{
        filters: [
          { propertyName: 'of_ticket_key', operator: 'EQ', value: ticketKey },
        ],
      }],
      properties: ['hs_pipeline_stage', 'hs_pipeline', 'of_ticket_key', 'of_line_item_key'],
      limit: 2,
    };

    const resp = await withRetry(
      () => hubspotClient.crm.tickets.searchApi.doSearch(searchBody),
      { module: 'mirrorUtils', fn: 'promoteMirrorTicketToManualReady', ticketKey }
    );

    forecastTicket = (resp?.results || [])[0] || null;
  } catch (err) {
    log.warn({ err, mirrorLik }, 'Error buscando ticket forecast UY');
    return;
  }

  if (!forecastTicket) {
    log.info({ mirrorLik }, 'Sin ticket forecast automático UY para promover (puede no existir aún)');
    return;
  }

  const ticketId = String(forecastTicket.id);
  log.info({ ticketId, mirrorLik }, 'Ticket forecast UY encontrado, promoviendo a "Próximos a Facturar"');

  // 4) Mover ticket al pipeline manual en stage "Próximos a Facturar" (TICKET_STAGES.NEW).
  //    NO va a TICKET_STAGES.READY ("Listo para Facturar"): el admin debe revisarlo primero.
  try {
    await hubspotClient.crm.tickets.basicApi.update(ticketId, {
      properties: {
        hs_pipeline: TICKET_PIPELINE,
        hs_pipeline_stage: TICKET_STAGES.NEW,
      },
    });
    log.info({ ticketId }, 'Ticket UY movido a "Próximos a Facturar" (pipeline manual)');
  } catch (err) {
    log.error({ err, ticketId }, 'Error moviendo ticket UY a manual READY');
    return;
  }

  // 6) Notificar al deal UY que PY facturó y hay que facturar manualmente
  const productName = String(mirrorProps.name || '').trim() || 'Producto desconocido';
  const aviso = `Factura PY emitida. Deal PY: ${pyDealId} | Producto: ${productName} | LI PY: ${pyLineItemId} → LI UY: ${mirrorLineItemId}. Revisar y facturar manualmente en UY.`;

  reportHubSpotError({
    level: 'warn',
    objectType: 'deal',
    objectId: mirrorDealId,
    message: aviso,
  });

  // Todos los avisos a mirror van también por correo (usuaria 25-jul).
  await emailAvisoMirror({
    mirrorDealId,
    title: 'Factura PY emitida — revisar y facturar manualmente en UY',
    message: aviso,
    meta: { deal_py: pyDealId, li_py: String(pyLineItemId), li_uy: mirrorLineItemId, producto: productName },
  });

  log.info({ mirrorDealId, aviso }, 'Aviso de factura PY escrito en deal UY');
}


/**
 * Período (YYYY-MM-DD) del ticket PY que originó la cancelación/reversión: es
 * lo que enlaza con el ticket del espejo del MISMO período (TANDA D). Sin
 * ticket o sin fecha devuelve '' → el aviso cae al deal espejo.
 */
async function ymdDelTicketPy(ticketId, deps = {}) {
  if (!ticketId) return '';
  const { client = hubspotClient } = deps;
  try {
    const tk = await client.crm.tickets.basicApi.getById(String(ticketId), [
      'fecha_resolucion_esperada',
      'of_ticket_key',
    ]);
    const directa = String(tk?.properties?.fecha_resolucion_esperada || '').slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(directa)) return directa;
    const parsed = parseTicketKeyFromLineItemKey(tk?.properties?.of_ticket_key);
    return parsed?.ok ? parsed.ymd : '';
  } catch {
    return '';
  }
}

/** line_item_key del LI espejo, para poder armar la clave de su ticket. */
async function lineItemKeyDelEspejo(mirrorLineItemId, deps = {}) {
  if (!mirrorLineItemId) return '';
  const { client = hubspotClient } = deps;
  try {
    const li = await client.crm.lineItems.basicApi.getById(String(mirrorLineItemId), ['line_item_key']);
    return String(li?.properties?.line_item_key || '').trim();
  } catch {
    return '';
  }
}

/**
 * Decide si una emisión PY es NOTA DE CRÉDITO a partir de señales del ticket y del LI.
 * Prioriza el SIGNO del ticket (mismo criterio que consumeCupo / Paso D: cantidad o
 * monto negativos) y usa el flag `nc` del LI PY solo como respaldo. Pura y testeable.
 *
 * @param {{cantidadReal?:number|string, subtotalReal?:number|string, ncFlag?:*}} [signals]
 * @returns {boolean}
 */
export function isNotaCreditoFromSignals({ cantidadReal, subtotalReal, ncFlag } = {}) {
  const cant = Number(cantidadReal);
  const sub = Number(subtotalReal);
  const porSigno = (Number.isFinite(cant) && cant < 0) || (Number.isFinite(sub) && sub < 0);
  const porFlag = String(ncFlag ?? '').toLowerCase() === 'true';
  return porSigno || porFlag;
}

/**
 * Cuando un LI PY manual emite factura, escribe un aviso en el deal UY espejo
 * para que el equipo sepa que debe facturar manualmente.
 * No promueve ticket — Phase 2 ya lo hizo dentro de la ventana de 30 días.
 *
 * Diseñado para llamarse fire-and-forget desde phase3.
 * Nunca lanza — todos los errores son capturados y logueados.
 *
 * @param {string|number} pyLineItemId  ID del line item PY que facturó
 * @param {string} billingYMD           Fecha de facturación YYYY-MM-DD
 * @param {{pyTicketId?: string|number}} [opts]  Ticket PY que originó la emisión
 *                                               (se cita en el aviso y sirve para
 *                                               detectar NC por signo).
 */
export async function notifyMirrorDealOnManualEmission(pyLineItemId, billingYMD, { pyTicketId = null } = {}) {
  const log = logger.child({
    module: 'mirrorUtils',
    fn: 'notifyMirrorDealOnManualEmission',
    pyLineItemId: String(pyLineItemId),
  });

  // 1) Encontrar el LI UY espejo
  let mirrorInfo;
  try {
    mirrorInfo = await findMirrorLineItem(pyLineItemId);
  } catch (err) {
    log.warn({ err }, 'Error buscando mirror line item, abortando aviso');
    return;
  }

  if (!mirrorInfo) {
    log.debug('Sin mirror UY para este LI PY, nada que notificar');
    return;
  }

  const { mirrorLineItemId, mirrorDealId, pyDealId } = mirrorInfo;

  // 2) Leer LI UY: solo necesitamos name
  let mirrorLi;
  try {
    mirrorLi = await hubspotClient.crm.lineItems.basicApi.getById(
      String(mirrorLineItemId),
      ['name']
    );
  } catch (err) {
    log.warn({ err, mirrorLineItemId }, 'Error leyendo LI UY, abortando aviso');
    return;
  }

 const productName = String(mirrorLi?.properties?.name || '').trim() || 'Producto desconocido';

  // ¿Es NOTA DE CRÉDITO? Detección robusta: el SIGNO del ticket PY que originó la
  // emisión manda (mismo criterio que consumeCupo / Paso D); el flag `nc` del LI PY
  // queda como respaldo cuando no tenemos el ticket. Antes dependía solo de la marca.
  let cantidadReal, subtotalReal;
  if (pyTicketId) {
    try {
      const pyTk = await hubspotClient.crm.tickets.basicApi.getById(
        String(pyTicketId),
        ['cantidad_real', 'subtotal_real']
      );
      cantidadReal = pyTk?.properties?.cantidad_real;
      subtotalReal = pyTk?.properties?.subtotal_real;
    } catch (err) {
      log.debug({ err, pyTicketId }, 'No se pudo leer el ticket PY para detectar NC por signo');
    }
  }
  let ncFlag;
  try {
    const pyLi = await hubspotClient.crm.lineItems.basicApi.getById(String(pyLineItemId), ['nc']);
    ncFlag = pyLi?.properties?.nc;
  } catch (err) {
    log.debug({ err, pyLineItemId }, 'No se pudo leer flag nc del LI PY');
  }
  const esNotaCredito = isNotaCreditoFromSignals({ cantidadReal, subtotalReal, ncFlag });

  // El ID del ticket PY que originó la emisión evita buscarlo a mano por invoice ID.
  const refTicket = pyTicketId ? ` | Ticket PY origen: ${pyTicketId}` : '';

  const aviso = esNotaCredito
    ? `⚠️ NOTA DE CRÉDITO emitida en PY. Deal PY: ${pyDealId} | Producto: ${productName} | LI PY: ${pyLineItemId} → LI UY: ${mirrorLineItemId}${refTicket} | Período: ${billingYMD}. Registrar la nota de crédito correspondiente en el espejo UY.`
    : `Factura PY original ha sido enviada a facturar. Deal PY: ${pyDealId} | Producto: ${productName} | LI PY: ${pyLineItemId} → LI UY: ${mirrorLineItemId}${refTicket} | Período: ${billingYMD}. Ticket UY ya promovido por Phase 2 — revisar y confirmar.`;

  reportHubSpotError({
    level: 'warn',
    objectType: 'deal',
    objectId: mirrorDealId,
    message: aviso,
  });

  // Todos los avisos a mirror van también por correo (usuaria 25-jul).
  await emailAvisoMirror({
    mirrorDealId,
    title: esNotaCredito
      ? 'Nota de crédito emitida en PY — registrar en espejo UY'
      : 'Emisión PY manual — revisar espejo UY',
    message: aviso,
    meta: { deal_py: pyDealId, li_py: String(pyLineItemId), li_uy: mirrorLineItemId, producto: productName, periodo: billingYMD },
  });

  log.info({ mirrorDealId, esNotaCredito, aviso }, 'Aviso de emisión PY manual escrito en deal UY');
}

/**
 * Cuando la factura de un ticket PY se CANCELA definitivamente o se REVIERTE
 * para refacturar (flujo cancelar/revertir, Bloque 4), escribe un aviso en el
 * deal UY espejo y manda el email de mirror, para que el equipo operativo
 * verifique el ticket UY a mano (la promoción del ticket UY no se deshace
 * automáticamente).
 *
 * ⚠️ SOLO debe llamarse con cancelIntent EXPLÍCITO ('cancel'/'revert') desde
 * la rama 5b de propagacion/invoice.js. NUNCA con intent null: el cron sweep
 * propagateCancelledInvoicesForDeal re-propaga las MISMAS invoices canceladas
 * en cada corrida y este aviso spamearía el espejo en cada pasada.
 *
 * Clon estructural de notifyMirrorDealOnManualEmission:
 * findMirrorLineItem → sin espejo: return silencioso → con espejo:
 * reportHubSpotError al deal UY + emailAvisoMirror con el mismo texto.
 *
 * Diseñado para llamarse fire-and-forget. Nunca lanza.
 *
 * @param {string|number} pyLineItemId  ID del line item PY cuya factura cambió
 * @param {Object} opts
 * @param {'cancel'|'revert'} opts.tipo - rama del flujo que se completó
 * @param {string|number} opts.invoiceId
 * @param {string|number} [opts.ticketId] - ticket PY (se cita en el aviso)
 * @param {Object} [deps] - inyección de dependencias (tests)
 * @param {Function} [deps.findMirrorLineItemFn] - default findMirrorLineItem
 * @param {Function} [deps.reportFn]             - default reportHubSpotError
 * @param {Function} [deps.emailFn]              - default emailAvisoMirror
 */
export async function notifyMirrorDealOnCancelOrRevert(
  pyLineItemId,
  { tipo, invoiceId, ticketId = null } = {},
  deps = {}
) {
  const {
    findMirrorLineItemFn = findMirrorLineItem,
    reportFn = reportHubSpotError,
    emailFn = emailAvisoMirror,
    avisarTicketFn = avisarTicketEspejo,
  } = deps;

  const log = logger.child({
    module: 'mirrorUtils',
    fn: 'notifyMirrorDealOnCancelOrRevert',
    pyLineItemId: String(pyLineItemId),
    tipo: String(tipo),
  });

  try {
    if (tipo !== 'cancel' && tipo !== 'revert') {
      log.warn('Tipo desconocido (esperaba cancel|revert), no se notifica nada');
      return;
    }

    // 1) Encontrar el LI UY espejo (valida deal_uy_mirror_id internamente)
    let mirrorInfo;
    try {
      mirrorInfo = await findMirrorLineItemFn(pyLineItemId);
    } catch (err) {
      log.warn({ err }, 'Error buscando mirror line item, abortando aviso cancel/revert');
      return;
    }

    if (!mirrorInfo) {
      log.debug('Sin mirror UY para este LI PY, nada que notificar');
      return;
    }

    const { mirrorLineItemId, mirrorDealId, pyDealId } = mirrorInfo;

    // 2) Componer el aviso según la rama completada
    const refTicket = ticketId ? ` | Ticket PY: ${ticketId}` : '';
    const contexto = `Deal PY: ${pyDealId} | LI PY: ${pyLineItemId} → LI UY: ${mirrorLineItemId}${refTicket}`;

    const aviso = tipo === 'cancel'
      ? `Factura ${invoiceId} del negocio original PY cancelada DEFINITIVAMENTE (período cerrado, no se refactura). ` +
        `La promoción del ticket UY NO se deshace — verificar el ticket UY manualmente. ${contexto}`
      : `Factura ${invoiceId} del negocio original PY revertida: el período se va a refacturar. ` +
        `Verificar el ticket UY manualmente. ${contexto}`;

    const title = tipo === 'cancel'
      ? 'Factura PY cancelada definitivamente — verificar ticket UY'
      : 'Factura PY revertida (se refactura) — verificar ticket UY';
    const meta = {
      deal_py: pyDealId,
      li_py: String(pyLineItemId),
      li_uy: mirrorLineItemId,
      invoice_py: String(invoiceId),
      ...(ticketId ? { ticket_py: String(ticketId) } : {}),
      tipo: tipo === 'cancel' ? 'cancelación definitiva' : 'reversión para refacturar',
    };

    // ── TANDA D: el aviso va al TICKET del espejo, no sólo al deal ───────────
    // Es LO COMPROMETIDO POR CORREO el 29-jul (hilo "VALOR TOTAL - notas"):
    // «ante una reversión o cancelación del ticket original, se avise al mirror».
    // Va al ticket del MISMO período, resuelto por clave; si el espejo no tiene
    // ticket de ese período, avisarTicketEspejo cae solo al deal espejo — o sea
    // el comportamiento de hoy, nunca menos.
    if (mirrorPuntualEnabled()) {
      const ymd = await ymdDelTicketPy(ticketId, deps);
      const r = await avisarTicketFn(
        {
          mirrorDealId,
          mirrorLineItemId,
          mirrorLineItemKey: await lineItemKeyDelEspejo(mirrorLineItemId, deps),
          ymd,
          mensaje: aviso,
          title,
          meta,
        },
        deps
      );
      log.info({ mirrorDealId, ymd, via: r?.via }, 'Aviso de cancelación/reversión PY enviado al espejo (TANDA D)');
      return;
    }

    reportFn({
      level: 'warn',
      objectType: 'deal',
      objectId: mirrorDealId,
      message: aviso,
    });

    // Todos los avisos a mirror van también por correo (usuaria 25-jul).
    await emailFn({ mirrorDealId, title, message: aviso, meta });

    log.info({ mirrorDealId, aviso }, 'Aviso de cancelación/reversión PY escrito en deal UY');
  } catch (err) {
    // Nunca lanza: es fire-and-forget desde la propagación de invoices.
    log.warn({ err: err?.message }, 'notifyMirrorDealOnCancelOrRevert falló (no bloquea nada)');
  }
}

/**
 * Cuando un LI PY automático con uy=true cambia su estado de pausa (se pausa
 * o se reactiva), escribe un aviso en `billing_error` del deal UY espejo para
 * que el equipo —que factura manualmente en UY— pause o reactive allí también.
 *
 * El aviso al admin del deal PY (mensaje Mantsoft tipo baja) lo maneja el flujo
 * Mantsoft existente; esta función cubre solo el lado espejo.
 *
 * Las condiciones de aplicabilidad (automático, PY no-espejo, uy=true y que la
 * pausa realmente cambió de estado) se evalúan en el call site (Phase P). Aquí
 * el último gate es la existencia del mirror UY: si no hay, no se avisa nada.
 *
 * Diseñado para llamarse fire-and-forget desde Phase P.
 * Nunca lanza — todos los errores son capturados y logueados.
 *
 * @param {string|number} pyLineItemId   ID del line item PY cuya pausa cambió
 * @param {Object}  opts
 * @param {boolean} opts.paused          true si quedó pausado, false si se reactivó
 * @param {Object}  [opts.details]       Datos del contrato PY para el texto del aviso
 * @param {string}  [opts.details.cliente]
 * @param {string}  [opts.details.negocio]
 * @param {string}  [opts.details.producto]
 * @param {string}  [opts.details.tipo]         'Renovación automática' | 'Plan fijo'
 * @param {string}  [opts.details.inicio]       YYYY-MM-DD inicio de la serie
 * @param {string}  [opts.details.vencimiento]  YYYY-MM-DD (solo plan fijo)
 * @param {string}  [opts.details.frecuencia]
 * @param {string}  [opts.details.monto]
 * @param {string}  [opts.details.motivo]       Motivo de pausa (solo al pausar)
 */
export async function notifyMirrorDealOnPauseChange(pyLineItemId, { paused, details = {} } = {}) {
  const log = logger.child({
    module: 'mirrorUtils',
    fn: 'notifyMirrorDealOnPauseChange',
    pyLineItemId: String(pyLineItemId),
    paused: !!paused,
  });

  // 1) Encontrar el LI UY espejo (valida deal_uy_mirror_id internamente)
  let mirrorInfo;
  try {
    mirrorInfo = await findMirrorLineItem(pyLineItemId);
  } catch (err) {
    log.warn({ err }, 'Error buscando mirror line item, abortando aviso de pausa');
    return;
  }

  if (!mirrorInfo) {
    log.debug('Sin mirror UY para este LI PY, nada que notificar');
    return;
  }

  const { mirrorLineItemId, mirrorDealId, pyDealId } = mirrorInfo;

  // 2) Componer el aviso de texto plano (cae en billing_error del deal UY)
  const d = details || {};
  const tipoLinea = [d.tipo, d.inicio ? `inicio ${d.inicio}` : null]
    .filter(Boolean)
    .join(' · ');
  const venc = d.vencimiento ? ` · vence ${d.vencimiento}` : '';

  const encabezado = paused
    ? 'PAUSA línea PY — pausar la facturación manual en UY'
    : 'REACTIVACIÓN línea PY — reactivar la facturación manual en UY';

  const lineas = [
    encabezado,
    `Cliente: ${d.cliente || '-'} | Negocio: ${d.negocio || '-'} | Producto: ${d.producto || '-'}`,
    `Tipo: ${tipoLinea || '-'}${venc}`,
    `Frecuencia: ${d.frecuencia || '-'} | Monto: ${d.monto || '-'}`,
    paused && d.motivo ? `Motivo: ${d.motivo}` : null,
    `Deal PY ${d.pyDealId || pyDealId} · LI PY ${pyLineItemId} → Deal UY ${mirrorDealId} · LI UY ${mirrorLineItemId}`,
  ].filter(Boolean);

  const aviso = lineas.join('\n');

  reportHubSpotError({
    level: 'warn',
    objectType: 'deal',
    objectId: mirrorDealId,
    message: aviso,
  });

  // Todos los avisos a mirror van también por correo (usuaria 25-jul).
  await emailAvisoMirror({
    mirrorDealId,
    title: paused
      ? 'Pausa de línea PY — pausar la facturación manual en UY'
      : 'Reactivación de línea PY — reactivar la facturación manual en UY',
    message: aviso,
    meta: { deal_py: String(d.pyDealId || pyDealId), li_py: String(pyLineItemId), li_uy: mirrorLineItemId },
  });

  log.info({ mirrorDealId, paused, aviso }, 'Aviso de cambio de pausa PY escrito en deal UY');
}