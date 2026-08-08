// src/services/lineItems/syncLineItemPropToTicket.js
//
// Tarea C (reunión 13-jul) — SYNC QUIRÚRGICO por-propiedad Line Item → Ticket.
//
// Hoy la propagación LI→ticket es full-snapshot y SOLO forecast (phaseP re-snapshotea
// cuando el LI cambió). Al promover a NEW/READY el LI deja de pisar el ticket, para no
// aplastar lo que edita el responsable. Definición nueva: el cambio del vendedor SÍ debe
// llegar al ticket editable, pero **solo la propiedad que tocó** — no un re-snapshot del
// ticket entero (así no pisa el trabajo del responsable en otras props).
//
// Mecanismo: ante un `line_item.propertyChange` de una prop ESCUCHADA, se reusa
// `extractLineItemSnapshots` (FUENTE ÚNICA del mapeo LI→ticket) y se escriben SOLO las
// claves de ticket que esa prop influye, sobre los tickets NO emitidos del LI.
//
// TRANSFERIR (definición 13-jul): todas las props visibles del LI MENOS Frecuencia de
// Facturación, Término de facturación, Término, Número de Pagos y Momento de Facturación;
// de "Más Opciones" solo NC. La lista exacta de "visibles" queda abierta hasta limpiar
// las vistas → este módulo aplica las EXCLUSIONES nombradas y mapea el resto.
//
// Gateado por flag LI_PROP_SYNC_ENABLED (default OFF).

import { hubspotClient } from '../../hubspotClient.js';
import { extractLineItemSnapshots } from '../snapshotService.js';
import { updateTicket } from '../tickets/ticketService.js';
import { PROXIMOS_A_FACTURAR_STAGE, TICKET_PIPELINE, isEngineManagedStage } from '../../config/constants.js';
import { etapaUnicaEnabled } from '../../config/etapaUnicaFlags.js';
import { reportIfActionable } from '../../utils/errorReporting.js';
import { reportHubSpotError } from '../../utils/hubspotErrorCollector.js';
import { findMirrorLineItem } from '../mirrorUtils.js';
import { avisarResponsableTicketPorSyncLI } from '../notifications/liSyncTicketAlert.js';
import { emailAvisoMirror } from '../notifications/mirrorAlert.js';
import { mirrorPuntualEnabled } from '../../config/mirrorPuntualFlags.js';
import { propagarCambioLiAlEspejo } from '../mirror/mirrorLiPuntualSync.js';
import { esPropSensible } from '../mirror/mirrorLiPropMap.js';
import { parseTicketKeyFromLineItemKey } from '../../utils/ticketKey.js';
import logger from '../../../lib/logger.js';

const MODULE = 'syncLineItemPropToTicket';

// ── Props del LI que NO se transfieren al ticket (definición 13-jul) ──────────
// Frecuencia de Facturación · Término de facturación · Término · Número de Pagos ·
// Momento de Facturación. (De "Más Opciones" solo se transfiere `nc`, que SÍ está mapeada.)
export const TRANSFER_EXCLUDED_LI_PROPS = new Set([
  'recurringbillingfrequency',            // Frecuencia de Facturación
  'hs_recurring_billing_frequency',       // idem (variante)
  'hs_recurring_billing_period',          // Término de facturación / Término
  'hs_recurring_billing_number_of_payments', // Número de Pagos
  'momento_de_facturacion',               // Momento de Facturación
]);

// ── Mapeo prop del LI → claves de snapshot del TICKET que influye ─────────────
// Derivado de extractLineItemSnapshots() (fuente de verdad). Una prop puede influir
// varias claves derivadas (ej. price → monto + costo/margen). Las props excluidas
// arriba NO figuran acá a propósito.
export const LI_PROP_TO_TICKET_KEYS = {
  // Texto / catálogo
  name: ['of_producto_nombres'],
  description: ['of_descripcion_producto'],
  servicio: ['of_rubro'],
  subrubro: ['of_subrubro'],
  area: ['area'],
  // of_codigo_rubro: RETIRADO de la escucha (decisión usuaria 26-jul). La prop
  // se conserva en HubSpot pero oculta de las vistas; el snapshot inicial del
  // forecast la sigue copiando — solo NO se sobreescribe por ediciones del LI.
  // mensaje_para_responsable → observaciones: RETIRADO (21-jul). "Observaciones" es
  // ahora un campo propio del ticket (nace vacío), NO un espejo del LI.
  nota: ['nota'],
  pais_operativo: ['of_pais_operativo'],
  empresa_que_factura: ['entidad_facturadora'],
  // Numéricos / montos (derivadas: of_costo/of_margen dependen de varios)
  price: ['monto_unitario_real', 'of_costo', 'of_margen'],
  quantity: ['cantidad_real', 'of_costo', 'of_margen'],
  hs_discount_percentage: ['descuento_en_porcentaje'],
  discount: ['descuento_por_unidad_real'],
  hs_cost_of_goods_sold: ['of_costo', 'of_margen'],
  costo_total_usd: ['of_costo', 'of_costo_usd', 'of_margen'],
  dolar: ['dolar', 'of_costo'],
  // Impuestos
  hs_tax_rate_group_id: ['of_iva'],
  exonera_irae: ['exonera_irae'],
  // Booleanos / flags
  parte_del_cupo: ['of_aplica_para_cupo'],
  reventa: ['reventa'],
  opera_trading: ['opera_trading'],
  nc: ['nc'],
  facturacion_automatica: ['facturacion_automatica'],
  // 🔴 8-ago: PLURAL. La propiedad real en los dos portales es `condiciones_de_pago`;
  // el singular no existe en ningún objeto y la escritura se caía en silencio.
  condiciones_de_pago: ['condiciones_de_pago'],
  // Tipo de venta: se movió del negocio al line item el 7-ago; desde el 8-ago
  // viaja al ticket como el resto.
  tipo_de_venta: ['tipo_de_venta'],
  // Fechas
  hs_recurring_billing_start_date: ['fecha_inicio_de_facturacion'],
  fecha_inicio_de_facturacion: ['fecha_inicio_de_facturacion'],
};

// LI props que hay que leer para reconstruir el snapshot (fuente: extractLineItemSnapshots).
const LI_PROPS_TO_FETCH = [
  'line_item_key',
  'price', 'quantity', 'amount', 'hs_cost_of_goods_sold',
  'hs_discount_percentage', 'discount',
  'hs_tax_rate_group_id', 'exonera_irae',
  'costo_total_usd', 'dolar',
  'recurringbillingfrequency', 'hs_recurring_billing_frequency', 'irregular',
  'name', 'description', 'servicio', 'subrubro', 'area', 'of_codigo_rubro',
  'momento_de_facturacion', 'nota', 'pais_operativo',
  'parte_del_cupo', 'reventa', 'opera_trading', 'nc', 'empresa_que_factura',
  'condiciones_de_pago', 'tipo_de_venta',
  'hs_recurring_billing_start_date', 'fecha_inicio_de_facturacion', 'facturacion_automatica',
  'hs_recurring_billing_number_of_payments',
];

const DEAL_PROPS_TO_FETCH = [
  'deal_currency_code', 'dolar', 'pais_operativo', 'es_mirror_de_py', 'tipo_de_cupo',
];

/**
 * Período (YYYY-MM-DD) del ticket: la fecha esperada y, si falta, la que trae su
 * clave. Es lo que enlaza el ticket del ORIGINAL con el ticket del ESPEJO del
 * mismo período (TANDA D, §3.2 caso 8). (pura, testeable)
 */
export function ymdDelTicket(ticket) {
  const directa = String(ticket?.properties?.fecha_resolucion_esperada || '').slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(directa)) return directa;
  const parsed = parseTicketKeyFromLineItemKey(ticket?.properties?.of_ticket_key);
  return parsed?.ok ? parsed.ymd : '';
}

/** ¿La prop del LI se transfiere al ticket? (pura, testeable) */
export function isTransferableLiProp(propertyName) {
  if (!propertyName) return false;
  if (TRANSFER_EXCLUDED_LI_PROPS.has(propertyName)) return false;
  return Array.isArray(LI_PROP_TO_TICKET_KEYS[propertyName]);
}

/**
 * Dado el snapshot completo del LI y la prop que cambió, devuelve el subconjunto de
 * props del ticket a escribir (solo las claves que esa prop influye). (pura, testeable)
 */
export function pickAffectedTicketProps(snapshot, propertyName) {
  const keys = LI_PROP_TO_TICKET_KEYS[propertyName];
  if (!Array.isArray(keys)) return {};
  const out = {};
  for (const k of keys) {
    if (k in snapshot) out[k] = snapshot[k];
  }
  return out;
}

/**
 * Sincroniza al/los ticket(s) del line item SOLO la(s) prop(s) de ticket influida(s) por
 * `propertyName`. Toca ÚNICAMENTE tickets en "Próximos a Facturar" del pipeline MANUAL
 * (definición usuaria 14-jul: el forecast lo cubre el re-snapshot del cron; el automático
 * no se edita; el emitido está congelado). No hace re-snapshot completo → no pisa otras
 * props que el responsable haya editado.
 *
 * Aviso al mirror: si el LI pertenece a un ORIGINAL (PY) que tiene mirror (UY) y se
 * actualizó algún ticket, escribe un aviso puntual en el `billing_error` del deal UY
 * (qué prop cambió) para que revisen el espejo. Anti-loop vía findMirrorLineItem (si el
 * LI ya es de un deal mirror, no avisa).
 *
 * Aviso al responsable del ticket: por cada ticket "Próximos a Facturar" que este
 * sync efectivamente modificó, se escribe of_billing_error del ticket vía
 * avisarResponsableTicketPorSyncLI (SIN correo — el workflow de HubSpot crea la
 * tarea al owner), gateado por LI_SYNC_OWNER_ALERT_ENABLED.
 * Fire-and-forget: nunca frena el sync.
 *
 * @returns {Promise<{applies:boolean, reason?:string, ticketsScanned:number,
 *   ticketsUpdated:number, skipped:number, keys:string[], errors:number, mirrorNotified:boolean,
 *   ownersNotified:number}>}
 */
export async function syncLineItemPropToTickets({
  lineItemId,
  propertyName,
  dealId = null,
  // Inyectables para tests (defaults = producción)
  client = hubspotClient,
  extractFn = extractLineItemSnapshots,
  updateTicketFn = updateTicket,
  findMirrorFn = findMirrorLineItem,
  reportErrorFn = reportHubSpotError,
  notifyOwnerFn = avisarResponsableTicketPorSyncLI,
  emailMirrorFn = emailAvisoMirror,
  propagarEspejoFn = propagarCambioLiAlEspejo,
}) {
  const stats = { applies: false, ticketsScanned: 0, ticketsUpdated: 0, skipped: 0, keys: [], errors: 0, mirrorNotified: false, ownersNotified: 0, mirrorLiCopiado: false, mirrorAvisos: 0 };

  if (!isTransferableLiProp(propertyName)) {
    return { ...stats, reason: TRANSFER_EXCLUDED_LI_PROPS.has(propertyName) ? 'excluded' : 'not_mapped' };
  }

  // Leer LI (props que necesita extractLineItemSnapshots)
  let lineItem;
  try {
    lineItem = await client.crm.lineItems.basicApi.getById(String(lineItemId), LI_PROPS_TO_FETCH);
  } catch (err) {
    logger.warn({ module: MODULE, lineItemId, err: err?.message }, 'No se pudo leer el line item');
    return { ...stats, reason: 'line_item_read_error', errors: 1 };
  }
  const lp = lineItem?.properties || {};
  const lineItemKey = lp.line_item_key;
  if (!lineItemKey) return { ...stats, reason: 'sin_line_item_key' };

  // Leer deal (extractLineItemSnapshots lo usa para moneda/dolar/país/cupo/intercompany)
  let deal = { properties: {} };
  if (dealId) {
    try {
      deal = await client.crm.deals.basicApi.getById(String(dealId), DEAL_PROPS_TO_FETCH);
    } catch (err) {
      logger.warn({ module: MODULE, dealId, err: err?.message }, 'No se pudo leer el deal (sigo con defaults)');
    }
  }

  // Snapshot completo → subconjunto afectado por la prop cambiada
  const snapshot = extractFn(lineItem, deal);
  const affected = pickAffectedTicketProps(snapshot, propertyName);
  const affectedKeys = Object.keys(affected);
  // 🔴 Salir acá cortaba el aviso al espejo. Hay props que NO tienen equivalente
  // en el ticket pero sí tienen que avisarle a UY — `uy` es el caso: María pidió
  // saber cuándo un line item entra o sale del espejo (correo del 6-jul), y eso
  // no se escribe en ningún ticket. Si la prop es sensible para el espejo se
  // sigue de largo, aunque no haya nada que sincronizar.
  if (!affectedKeys.length && !esPropSensible(propertyName)) {
    return { ...stats, reason: 'sin_claves_afectadas' };
  }
  stats.applies = true;
  stats.keys = affectedKeys;

  // Buscar tickets del LI (por of_line_item_key) trayendo pipeline+stage + las claves afectadas
  let tickets = [];
  try {
    const resp = await client.crm.tickets.searchApi.doSearch({
      filterGroups: [{ filters: [{ propertyName: 'of_line_item_key', operator: 'EQ', value: String(lineItemKey) }] }],
      properties: ['hs_pipeline', 'hs_pipeline_stage', 'of_ticket_key', 'fecha_resolucion_esperada', 'hubspot_owner_id', 'subject', ...affectedKeys],
      limit: 100,
    });
    tickets = resp?.results || [];
  } catch (err) {
    logger.error({ module: MODULE, lineItemId, lineItemKey, err }, 'Error buscando tickets del line item');
    return { ...stats, reason: 'ticket_search_error', errors: 1 };
  }

  const updatedTickets = []; // {ticketId, ownerId, subject, patch} de cada update exitoso

  for (const t of tickets) {
    stats.ticketsScanned++;
    const stage = String(t?.properties?.hs_pipeline_stage || '');
    const pipeline = String(t?.properties?.hs_pipeline || '');
    // SOLO "Próximos a Facturar" del pipeline MANUAL (definición usuaria 14-jul).
    // Forecast → lo cubre el re-snapshot del cron; automático no se edita; emitido congelado.
    //
    // ETAPA ÚNICA (flag ON): alcanza TODO lo no notificado del pipeline manual
    // — «Próximos a facturar» y los forecast, incluidos los viejos 85/95. Bajo
    // la misma flag el re-snapshot del cron ya NO reescribe esos tickets
    // (phasep.js §2.2), así que este sync pasa a ser el único camino por el que
    // el contenido del line item llega al ticket: si se dejara sólo en
    // «Próximos», el tramo forecast se quedaría con datos viejos.
    const alcanzaAlTicket = etapaUnicaEnabled()
      ? (pipeline === TICKET_PIPELINE && isEngineManagedStage(stage))
      : (pipeline === TICKET_PIPELINE && stage === PROXIMOS_A_FACTURAR_STAGE);
    if (!alcanzaAlTicket) { stats.skipped++; continue; }

    // Patch mínimo: solo las claves cuyo valor difiere.
    // `antes` guarda lo que el ticket TENÍA: es el único lugar del motor donde
    // existe el valor anterior, y es lo que el aviso al espejo necesita para
    // decir "pasó de X a Y" (TANDA D).
    const patch = {};
    const antes = {};
    for (const k of affectedKeys) {
      const nv = affected[k];
      if (String(nv ?? '') !== String(t?.properties?.[k] ?? '')) {
        patch[k] = nv;
        antes[k] = t?.properties?.[k];
      }
    }
    if (!Object.keys(patch).length) continue;

    try {
      await updateTicketFn(String(t.id), patch);
      stats.ticketsUpdated++;
      updatedTickets.push({
        ticketId: String(t.id),
        ownerId: t?.properties?.hubspot_owner_id || null,
        subject: t?.properties?.subject || null,
        patch,
        antes,
        ymd: ymdDelTicket(t),
      });
      logger.info(
        { module: MODULE, lineItemId, ticketId: t.id, propertyName, patchKeys: Object.keys(patch) },
        'Sync quirúrgico LI→ticket aplicado'
      );
    } catch (err) {
      stats.errors++;
      reportIfActionable({ objectType: 'ticket', objectId: String(t.id), message: `Sync LI→ticket falló (prop ${propertyName})`, err });
      logger.warn({ module: MODULE, lineItemId, ticketId: t.id, err }, 'Sync LI→ticket falló (no bloquea el resto)');
    }
  }

  // ── TANDA D — EL ESPEJO (flag MIRROR_PUNTUAL_ENABLED, default OFF) ─────────
  // Con la llave prendida, el espejo deja de enterarse sólo por el deal: se
  // COPIA la prop al line item espejo (puntual, con traducción costo→precio) y
  // se AVISA al ticket del espejo del MISMO período, con el antes y el después.
  //
  // Este es el único punto del motor donde el valor ANTERIOR existe: `t.properties[k]`
  // es lo que el ticket tenía y `patch[k]` lo que se le acaba de escribir. Por eso
  // el antes/después se arma acá y se le pasa hecho al orquestador del espejo.
  //
  // Corre aunque no se haya actualizado ningún ticket del original (la copia al
  // espejo no depende de eso); si no hay períodos, el aviso cae al deal espejo,
  // que es el comportamiento de hoy.
  if (mirrorPuntualEnabled()) {
    try {
      const cambiosPorPeriodo = [];
      for (const ut of updatedTickets) {
        const ymd = ut.ymd || '';
        if (!ymd) continue;
        cambiosPorPeriodo.push({ ymd, antes: ut.antes || {}, despues: ut.patch || {} });
      }
      const r = await propagarEspejoFn(
        {
          lineItemId,
          propertyName,
          cambiosPorPeriodo,
          valorNuevo: lp[propertyName],
          sourceCurrency: deal?.properties?.deal_currency_code || 'USD',
        },
        {}
      );
      stats.mirrorLiCopiado = !!r?.copiado;
      stats.mirrorAvisos = r?.avisos || 0;
      if (r?.avisos) stats.mirrorNotified = true;
    } catch (err) {
      logger.warn({ module: MODULE, lineItemId, err: err?.message }, 'Propagación al espejo falló (no bloquea el sync)');
    }
  }

  // Aviso puntual al mirror: si cambió algún ticket del ORIGINAL y ese LI tiene mirror (UY),
  // avisar en el deal UY qué prop cambió. findMirrorLineItem trae anti-loop (si el LI ya es de
  // un deal mirror, devuelve null → no avisa). Fire-and-forget: nunca frena el sync.
  //
  // Con MIRROR_PUNTUAL_ENABLED el aviso ya salió arriba, al TICKET del espejo (que es
  // lo que pedía §3.2 caso 2): repetirlo en el deal sería el mismo aviso dos veces.
  if (stats.ticketsUpdated > 0 && !mirrorPuntualEnabled()) {
    try {
      const mirror = await findMirrorFn(lineItemId);
      if (mirror?.mirrorDealId) {
        const nuevoValor = affectedKeys.map(k => `${k}="${affected[k] ?? ''}"`).join(', ');
        const aviso =
          `Cambio en el negocio ORIGINAL (ticket "Próximos a Facturar") — revisar el espejo UY. ` +
          `Deal PY: ${mirror.pyDealId} · LI PY: ${lineItemId} → Deal UY: ${mirror.mirrorDealId} · LI UY: ${mirror.mirrorLineItemId}. ` +
          `Propiedad del LI cambiada: ${propertyName}. Reflejado en ticket como: ${nuevoValor}. ` +
          `Tickets del original actualizados: ${stats.ticketsUpdated}.`;
        reportErrorFn({ level: 'warn', objectType: 'deal', objectId: mirror.mirrorDealId, message: aviso });
        stats.mirrorNotified = true;
        // Todos los avisos a mirror van también por correo (usuaria 25-jul).
        // emailAvisoMirror nunca lanza (llave DEAL_ALERTS_ENABLED adentro).
        await emailMirrorFn({
          mirrorDealId: mirror.mirrorDealId,
          title: 'Cambio del vendedor en original PY — revisar espejo UY',
          message: aviso,
          meta: { deal_py: mirror.pyDealId, li_py: String(lineItemId), li_uy: mirror.mirrorLineItemId, propiedad: propertyName },
        });
        logger.info({ module: MODULE, lineItemId, propertyName, mirrorDealId: mirror.mirrorDealId }, 'Aviso de cambio del original escrito en deal UY mirror');
      }
    } catch (err) {
      logger.warn({ module: MODULE, lineItemId, err }, 'Aviso al mirror falló (no bloquea el sync)');
    }
  }

  // Aviso al responsable de cada ticket modificado: el vendedor tocó el LI y el
  // cambio aterrizó en un ticket "Próximos a Facturar" → el owner debe verificar
  // antes de facturar. Gateado por LI_SYNC_OWNER_ALERT_ENABLED (dentro de
  // notifyOwnerFn). Fire-and-forget: nunca frena el sync.
  for (const ut of updatedTickets) {
    try {
      const r = await notifyOwnerFn({
        ticketId: ut.ticketId,
        ticketOwnerId: ut.ownerId,
        lineItemId,
        lineItemName: lp.name || null,
        propertyName,
        patch: ut.patch,
        dealId,
      });
      if (r?.notified) stats.ownersNotified++;
    } catch (err) {
      logger.warn({ module: MODULE, lineItemId, ticketId: ut.ticketId, err }, 'Aviso al responsable del ticket falló (no bloquea el sync)');
    }
  }

  logger.info({ module: MODULE, lineItemId, propertyName, ...stats }, 'syncLineItemPropToTickets completado');
  return stats;
}
