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
import logger from '../../../lib/logger.js';

const MOD = 'dealAlerts';

// ── Helpers ──────────────────────────────────────────────────────────────────

function ts() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

/**
 * Resuelve el email de un HubSpot owner. Devuelve null si no se puede.
 */
async function resolveOwnerEmail(ownerId) {
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

/**
 * Escribe un mensaje en of_billing_error del ticket (con timestamp).
 */
async function writeTicketBillingError(ticketId, message) {
  try {
    await hubspotClient.crm.tickets.basicApi.update(String(ticketId), {
      properties: {
        of_billing_error: `${ts()} — ${message}`,
      },
    });
    logger.info({ module: MOD, fn: 'writeTicketBillingError', ticketId }, 'of_billing_error escrito en ticket');
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