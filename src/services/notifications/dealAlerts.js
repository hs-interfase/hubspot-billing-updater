// src/services/notifications/dealAlerts.js
//
// Alertas operativas cuando contadores de billing llegan a 0.
//
// Tres triggers:
//   1. pagos_restantes = 0      → billing_error en deal
//   2. facturas_por_derivar = 0 → billing_error en deal + of_billing_error en ticket + email Resend
//   3. fechas_completas = true   → billing_error en deal + of_billing_error en último ticket
//
// Todos los mensajes incluyen timestamp para garantizar que el workflow
// de HubSpot detecte un cambio y cree la tarea correspondiente.
//
// Llamados desde:
//   - syncAfterPromotion.js      (pagos_restantes)
//   - recalcDerivedFacturas.js   (facturas_por_derivar)
//   - recalcFacturasRestantes.js (fechas_completas)

import { hubspotClient } from '../../hubspotClient.js';
import { sendAlertTo } from '../../../lib/alertService.js';
import { toYMDInBillingTZ, getTodayYMD } from '../../utils/dateUtils.js';
import logger from '../../../lib/logger.js';

const MOD = 'dealAlerts';

// ── Acumulación por día de of_billing_error (5-ago-2026) ─────────────────────
// ANTES: cada productor PISABA la propiedad. Como varios escriben sobre el mismo
// ticket con segundos de diferencia (el aviso del espejo y, ~5 s después, el
// aviso al responsable que dispara la copia al LI espejo), el primero se perdía
// siempre — justo en el caso en que más hacía falta.
//
// AHORA: los avisos del MISMO DÍA se acumulan, el más nuevo arriba. Al primer
// aviso de un día nuevo el bloque arranca limpio, así la propiedad no crece sin
// techo y lo que se lee es "lo que pasó hoy con este ticket".
//
// El día se corta en BILLING_TZ (America/Montevideo), igual que el resto del
// motor, aunque el timestamp de cada línea se siga escribiendo en UTC — que es
// lo que ts() viene haciendo y lo que ya hay escrito en producción.
const MAX_ENTRADAS_BILLING_ERROR = 20;


// ── Llave global de estas alertas (usuaria 23-jul) ───────────────────────────
// DEAL_ALERTS_ENABLED=false apaga la EMISIÓN de las tres alertas (props billing_error
// + correos), sin tocar Phase R ni los contadores: los recálculos siguen corriendo.
// Pensada para migraciones/corridas históricas donde Phase R debe quedar prendida
// pero los avisos serían una avalancha. Vacía o ausente = PRENDIDA (no apagar por
// accidente, mismo criterio que ASSOC_NEXT_AUTO_FORECAST). Se evalúa en cada llamada
// (cambiarla en Railway no requiere redeploy del worker, solo del proceso).
function alertasApagadas(fn, ctx) {
  const raw = (process.env.DEAL_ALERTS_ENABLED ?? '').trim().toLowerCase();
  if (raw === 'false' || raw === '0' || raw === 'no') {
    logger.info({ module: MOD, fn, ...ctx }, 'DEAL_ALERTS_ENABLED=false — alerta OMITIDA (contadores intactos)');
    return true;
  }
  return false;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export function ts() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

/**
 * Resuelve el email de un HubSpot owner. Devuelve null si no se puede.
 */
export async function resolveOwnerEmail(ownerId) {
  if (!ownerId) return null;
  try {
    const owner = await hubspotClient.crm.owners.defaultApi.getById(Number(ownerId));
    return owner?.email || null;
  } catch (err) {
    logger.warn({ module: MOD, fn: 'resolveOwnerEmail', ownerId, err: err?.message }, 'No se pudo resolver email del owner');
    return null;
  }
}

/**
 * Lee props mínimas del deal (nombre + owner).
 */
async function getDealMeta(dealId) {
  try {
    const deal = await hubspotClient.crm.deals.basicApi.getById(String(dealId), [
      'dealname', 'hubspot_owner_id',
    ]);
    return {
      dealName: deal.properties?.dealname || String(dealId),
      ownerId: deal.properties?.hubspot_owner_id || null,
    };
  } catch (err) {
    logger.warn({ module: MOD, fn: 'getDealMeta', dealId, err: err?.message }, 'No se pudo leer deal');
    return { dealName: String(dealId), ownerId: null };
  }
}

/**
 * Lee nombre del line item.
 */
async function getLineItemName(lineItemId) {
  try {
    const li = await hubspotClient.crm.lineItems.basicApi.getById(String(lineItemId), ['name']);
    return li.properties?.name || String(lineItemId);
  } catch {
    return String(lineItemId);
  }
}

/**
 * Busca el último ticket (por fecha) de un LIK y devuelve su ID y owner.
 */
async function findLastTicketForLIK(lik) {
  if (!lik) return null;
  try {
    const resp = await hubspotClient.crm.tickets.searchApi.doSearch({
      filterGroups: [{
        filters: [{ propertyName: 'of_line_item_key', operator: 'EQ', value: lik }],
      }],
      properties: ['hubspot_owner_id', 'fecha_resolucion_esperada'],
      sorts: [{ propertyName: 'fecha_resolucion_esperada', direction: 'DESCENDING' }],
      limit: 1,
    });
    const t = resp?.results?.[0];
    if (!t) return null;
    return {
      ticketId: String(t.id),
      ownerId: t.properties?.hubspot_owner_id || null,
    };
  } catch (err) {
    logger.warn({ module: MOD, fn: 'findLastTicketForLIK', lik, err: err?.message }, 'Error buscando último ticket');
    return null;
  }
}

/**
 * Escribe un mensaje en billing_error del deal (con timestamp).
 */
async function writeDealBillingError(dealId, message) {
  try {
    await hubspotClient.crm.deals.basicApi.update(String(dealId), {
      properties: {
        billing_error: `${ts()} — ${message}`,
        billing_error_at: new Date().toISOString(),
      },
    });
    logger.info({ module: MOD, fn: 'writeDealBillingError', dealId }, 'billing_error escrito en deal');
  } catch (err) {
    logger.error({ module: MOD, fn: 'writeDealBillingError', dealId, err: err?.message }, 'Error escribiendo billing_error en deal');
  }
}

// Una entrada arranca con el timestamp de ts(): "YYYY-MM-DD HH:MM:SS — ".
const RE_ENTRADA = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) — /;

/**
 * Parte el valor acumulado en entradas. Una entrada puede ocupar varias líneas
 * (los mensajes de hoy son de una sola, pero no hay por qué asumirlo): cada
 * línea que arranca con timestamp abre una entrada nueva y el resto se le pega.
 * Texto suelto anterior al primer timestamp se conserva como una entrada sin
 * fecha — no se tira nada que hubiera escrito una persona a mano.
 *
 * @returns {Array<{ymd:string, texto:string}>} ymd en BILLING_TZ, '' si no parsea.
 */
export function parseEntradasBillingError(valor) {
  const lineas = String(valor ?? '').split('\n');
  const entradas = [];

  for (const linea of lineas) {
    const m = RE_ENTRADA.exec(linea);
    if (m) {
      // ts() escribe UTC sin sufijo; sin la 'Z' el motor de JS lo leería como
      // hora local y el corte de día se movería.
      entradas.push({ ymd: toYMDInBillingTZ(new Date(`${m[1]}T${m[2]}Z`)), texto: linea });
    } else if (entradas.length) {
      entradas[entradas.length - 1].texto += `\n${linea}`;
    } else if (linea.trim()) {
      entradas.push({ ymd: '', texto: linea });
    }
  }

  return entradas;
}

/**
 * Arma el nuevo valor de of_billing_error: la entrada nueva arriba, debajo las
 * que ya eran de hoy. Las de días anteriores se descartan.
 *
 * Pura y testeable — es el corazón del cambio.
 *
 * @param {string} valorActual  lo que hay hoy en la propiedad
 * @param {string} entradaNueva línea ya formateada ("ts — mensaje")
 * @param {string} hoyYMD       día actual en BILLING_TZ
 */
export function acumularBillingError(valorActual, entradaNueva, hoyYMD, max = MAX_ENTRADAS_BILLING_ERROR) {
  const deHoy = parseEntradasBillingError(valorActual)
    .filter((e) => e.ymd === hoyYMD)
    .map((e) => e.texto);

  return [entradaNueva, ...deHoy].slice(0, max).join('\n');
}

/**
 * Escribe un mensaje en of_billing_error del ticket (con timestamp),
 * ACUMULÁNDOLO con los del mismo día en vez de pisarlos. Ver el bloque de
 * arriba para el porqué.
 *
 * El valor siempre cambia (el timestamp es nuevo), así que el workflow de
 * HubSpot que crea la tarea al responsable sigue disparando igual que antes.
 *
 * Si la lectura del valor previo falla, se escribe igual: perder el historial
 * del día es mucho menos grave que perder el aviso.
 */
export async function writeTicketBillingError(ticketId, message, deps = {}) {
  const {
    getTicketFn = (id) => hubspotClient.crm.tickets.basicApi.getById(String(id), ['of_billing_error']),
    updateTicketFn = (id, props) => hubspotClient.crm.tickets.basicApi.update(String(id), { properties: props }),
    hoyYMD = getTodayYMD(),
  } = deps;

  const entradaNueva = `${ts()} — ${message}`;

  let valorActual = '';
  try {
    const ticket = await getTicketFn(ticketId);
    valorActual = ticket?.properties?.of_billing_error || '';
  } catch (err) {
    logger.warn(
      { module: MOD, fn: 'writeTicketBillingError', ticketId, err: err?.message },
      'No se pudo leer of_billing_error previo — se escribe solo el aviso nuevo'
    );
  }

  try {
    const acumulado = acumularBillingError(valorActual, entradaNueva, hoyYMD);
    await updateTicketFn(ticketId, { of_billing_error: acumulado });
    logger.info(
      { module: MOD, fn: 'writeTicketBillingError', ticketId, entradas: acumulado.split('\n').length },
      'of_billing_error escrito en ticket (acumulado del día)'
    );
  } catch (err) {
    logger.error({ module: MOD, fn: 'writeTicketBillingError', ticketId, err: err?.message }, 'Error escribiendo of_billing_error en ticket');
  }
}

// ── Alertas públicas ─────────────────────────────────────────────────────────

/**
 * Trigger 1: pagos_restantes = 0
 * → billing_error en deal
 *
 * "Todos los tickets de este line item [nombre, LI id] del deal [nombre, deal id]
 *  ya fueron promovidos. Revisa que sea correcto."
 */
export async function alertPagosCompletos({ dealId, lineItemId, lineItemName }) {
  const fn = 'alertPagosCompletos';
  if (alertasApagadas(fn, { dealId, lineItemId })) return { skipped: true, reason: 'DEAL_ALERTS_ENABLED=false' };
  try {
    const { dealName } = await getDealMeta(dealId);
    const liName = lineItemName || await getLineItemName(lineItemId);

    const msg = `Todos los tickets del elemento de pedido "${liName}" (${lineItemId}) del negocio "${dealName}" (${dealId}) ya fueron promovidos. Revisa que sea correcto.`;

    await writeDealBillingError(dealId, msg);

    logger.info({ module: MOD, fn, dealId, lineItemId }, 'Alerta pagos_restantes=0 emitida');
  } catch (err) {
    logger.error({ module: MOD, fn, dealId, lineItemId, err: err?.message }, 'Error emitiendo alerta pagos_restantes=0');
  }
}

/**
 * Trigger 2: facturas_por_derivar = 0
 * → billing_error en deal + of_billing_error en último ticket + email Resend
 *
 * "El deal [nombre, deal id] tiene un elemento de pedido [nombre, LI id]
 *  que ya ha derivado todos sus pagos a facturación. Revisar si es correcto."
 */
export async function alertDerivacionCompleta({ dealId, lineItemId, lineItemName, lik }) {
  const fn = 'alertDerivacionCompleta';
  if (alertasApagadas(fn, { dealId, lineItemId, lik })) return { skipped: true, reason: 'DEAL_ALERTS_ENABLED=false' };
  try {
    const [{ dealName, ownerId: dealOwnerId }, liName, lastTicket] = await Promise.all([
      getDealMeta(dealId),
      lineItemName ? Promise.resolve(lineItemName) : getLineItemName(lineItemId),
      findLastTicketForLIK(lik),
    ]);

    const msg = `El negocio "${dealName}" (${dealId}) tiene un elemento de pedido "${liName}" (${lineItemId}) que ya ha derivado todos sus pagos a facturación. Revisar si es correcto.`;

    // 1) billing_error en deal
    await writeDealBillingError(dealId, msg);

    // 2) of_billing_error en último ticket
    if (lastTicket?.ticketId) {
      await writeTicketBillingError(lastTicket.ticketId, msg);
    }

    // 3) Email a vendedor + responsable del LI
    const emailTargets = new Set();

    // Vendedor (deal owner)
    const dealOwnerEmail = await resolveOwnerEmail(dealOwnerId);
    if (dealOwnerEmail) emailTargets.add(dealOwnerEmail);

    // Responsable del LI (hubspot_owner_id del line item)
    try {
      const li = await hubspotClient.crm.lineItems.basicApi.getById(String(lineItemId), ['hubspot_owner_id']);
      const liOwnerEmail = await resolveOwnerEmail(li.properties?.hubspot_owner_id);
      if (liOwnerEmail) emailTargets.add(liOwnerEmail);
    } catch {
      // no bloquea
    }

    if (emailTargets.size > 0) {
      await sendAlertTo({
        to: [...emailTargets],
        level: 'warning',
        title: `Derivación completa — ${dealName}`,
        meta: {
          negocio: `${dealName} (${dealId})`,
          elemento_de_pedido: `${liName} (${lineItemId})`,
          mensaje: 'Todas las facturas fueron derivadas. El motor no generará más facturas para este elemento de pedido.',
        },
      });
    }

    logger.info({ module: MOD, fn, dealId, lineItemId, emailsSent: emailTargets.size }, 'Alerta facturas_por_derivar=0 emitida');
  } catch (err) {
    logger.error({ module: MOD, fn, dealId, lineItemId, err: err?.message }, 'Error emitiendo alerta facturas_por_derivar=0');
  }
}

/**
 * Trigger 3: fechas_completas = true
 * → billing_error en deal + of_billing_error en último ticket
 *
 * "Fechas completas para [line item]. Nodum ha facturado todo lo esperado
 *  para este elemento de pedido. El motor no pasará más por ese elemento de pedido."
 */
export async function alertFechasCompletas({ dealId, lineItemId, lineItemName, lik }) {
  const fn = 'alertFechasCompletas';
  if (alertasApagadas(fn, { dealId, lineItemId, lik })) return { skipped: true, reason: 'DEAL_ALERTS_ENABLED=false' };
  try {
    const [{ dealName }, liName, lastTicket] = await Promise.all([
      getDealMeta(dealId),
      lineItemName ? Promise.resolve(lineItemName) : getLineItemName(lineItemId),
      findLastTicketForLIK(lik),
    ]);

    const msg = `Fechas completas para "${liName}" (${lineItemId}). Nodum ha facturado todo lo esperado para este elemento de pedido. El motor no pasará más por ese elemento de pedido.`;

    // billing_error en deal
    await writeDealBillingError(dealId, msg);

    // of_billing_error en último ticket
    if (lastTicket?.ticketId) {
      await writeTicketBillingError(lastTicket.ticketId, msg);
    }

    logger.info({ module: MOD, fn, dealId, lineItemId }, 'Alerta fechas_completas emitida');
  } catch (err) {
    logger.error({ module: MOD, fn, dealId, lineItemId, err: err?.message }, 'Error emitiendo alerta fechas_completas');
  }
}