// api/debugInspect.js
//
// Endpoints de diagnóstico (solo lectura) para inspeccionar line items y deals.
//
// GET /api/debug/line-item/:id  — LI + deal asociado + tickets
// GET /api/debug/deal/:id       — deal + todos sus LIs + tickets por LI
//
// Protegido con DEBUG_TOKEN (si está definido).

import { Router } from 'express';
import { hubspotClient } from '../src/hubspotClient.js';
import logger from '../lib/logger.js';

const router = Router();
const DEBUG_TOKEN = process.env.DEBUG_TOKEN || null;

// ── Auth middleware ──────────────────────────────────────────
function authGuard(req, res, next) {
  if (!DEBUG_TOKEN) return next();
  const token = req.headers['x-debug-token'] || req.query.token;
  if (token !== DEBUG_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

router.use(authGuard);

// ── Propiedades a traer ─────────────────────────────────────
const LI_PROPS = [
  'name', 'amount', 'hs_sku',
  'line_item_key', 'of_line_item_py_origen_id',
  'billing_next_date', 'last_ticketed_date', 'billing_anchor_date',
  'facturacion_automatica', 'facturacion_activa', 'fechas_completas',
  'facturar_ahora', 'pausa', 'motivo_de_pausa',
  'uy', 'pais_operativo', 'moneda',
  'recurringbillingfrequency', 'frecuencia_de_facturacion',
  'hs_recurring_billing_start_date', 'fecha_inicio_de_facturacion',
  'hs_recurring_billing_number_of_payments', 'number_of_payments',
  'renovacion_automatica',
  'pagos_emitidos', 'facturas_restantes',
  'last_billing_period',
  'mansoft_pendiente',
  'responsable_asignado',
];

const DEAL_PROPS = [
  'dealname', 'pipeline', 'dealstage',
  'pais_operativo', 'deal_currency_code',
  'facturacion_activa',
  'deal_uy_mirror_id', 'es_mirror_de_py',
  'hubspot_owner_id',
];

const TICKET_PROPS = [
  'subject', 'hs_pipeline', 'hs_pipeline_stage',
  'of_ticket_key', 'of_line_item_key', 'of_deal_id',
  'of_line_item_ids',
  'of_invoice_id', 'of_invoice_key', 'numero_de_factura',
  'of_estado', 'of_invoice_status',
  'fecha_resolucion_esperada', 'of_fecha_de_facturacion',
  'fecha_real_de_facturacion',
  'of_pais_operativo', 'of_moneda',
  'facturar_ahora',
  'createdate', 'hs_lastmodifieddate',
];

// ── Helpers ─────────────────────────────────────────────────

async function getAssociatedIds(fromType, fromId, toType) {
  try {
    const resp = await hubspotClient.crm.associations.v4.basicApi.getPage(
      fromType, String(fromId), toType, 200
    );
    return (resp.results || []).map(r => String(r.toObjectId));
  } catch {
    return [];
  }
}

async function batchRead(objectType, ids, properties) {
  if (!ids.length) return [];
  const results = [];
  // Batch max 100
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    try {
      const resp = await hubspotClient.crm[objectType].batchApi.read({
        inputs: batch.map(id => ({ id })),
        properties,
      });
      results.push(...(resp?.results || []));
    } catch (err) {
      logger.warn({ module: 'debugInspect', objectType, err: err?.message }, 'Error en batch read');
    }
  }
  return results;
}

function pickProps(obj) {
  return { id: obj.id, ...obj.properties };
}

function classifyTicket(ticket) {
  const p = ticket.properties || {};
  const hasBilled = !!(p.of_invoice_id || p.numero_de_factura);
  const stage = p.hs_pipeline_stage || '';
  const estado = (p.of_estado || '').toUpperCase();

  if (estado === 'DUPLICADO_UI' || estado === 'DEPRECATED') return 'descartado';
  if (hasBilled) return 'facturado';
  // Heurística: si no tiene invoice y está en stage forecast, es forecast
  // No hardcodeamos stages — dejamos que el campo of_estado o invoice lo digan
  return 'pendiente';
}

// ── GET /api/debug/line-item/:id ────────────────────────────
router.get('/line-item/:id', async (req, res) => {
  const lineItemId = String(req.params.id).trim();
  if (!lineItemId || !/^\d+$/.test(lineItemId)) {
    return res.status(400).json({ error: 'lineItemId debe ser un número' });
  }

  try {
    // 1. Leer line item
    let lineItem;
    try {
      lineItem = await hubspotClient.crm.lineItems.basicApi.getById(lineItemId, LI_PROPS);
    } catch (err) {
      return res.status(404).json({ error: `Line item ${lineItemId} no encontrado`, detail: err?.message });
    }

    // 2. Deal asociado
    const dealIds = await getAssociatedIds('line_items', lineItemId, 'deals');
    let deal = null;
    if (dealIds.length > 0) {
      try {
        deal = await hubspotClient.crm.deals.basicApi.getById(dealIds[0], DEAL_PROPS);
      } catch { /* deal queda null */ }
    }

    // 3. Tickets asociados al line item
    const ticketIds = await getAssociatedIds('line_items', lineItemId, 'tickets');
    const tickets = await batchRead('tickets', ticketIds, TICKET_PROPS);

    // 4. Clasificar tickets
    const ticketsSorted = tickets
      .map(t => ({ ...pickProps(t), _clasificacion: classifyTicket(t) }))
      .sort((a, b) => (a.fecha_resolucion_esperada || '').localeCompare(b.fecha_resolucion_esperada || ''));

    const resumen = {
      total_tickets: tickets.length,
      facturados: ticketsSorted.filter(t => t._clasificacion === 'facturado').length,
      pendientes: ticketsSorted.filter(t => t._clasificacion === 'pendiente').length,
      descartados: ticketsSorted.filter(t => t._clasificacion === 'descartado').length,
    };

    return res.json({
      lineItem: pickProps(lineItem),
      deal: deal ? pickProps(deal) : null,
      dealIds,
      tickets: ticketsSorted,
      resumen,
    });

  } catch (err) {
    logger.error({ module: 'debugInspect', fn: 'line-item', lineItemId, err }, 'Error en debug line-item');
    return res.status(500).json({ error: 'Error interno', detail: err?.message });
  }
});

// ── GET /api/debug/deal/:id ─────────────────────────────────
router.get('/deal/:id', async (req, res) => {
  const dealId = String(req.params.id).trim();
  if (!dealId || !/^\d+$/.test(dealId)) {
    return res.status(400).json({ error: 'dealId debe ser un número' });
  }

  try {
    // 1. Leer deal
    let deal;
    try {
      deal = await hubspotClient.crm.deals.basicApi.getById(dealId, DEAL_PROPS);
    } catch (err) {
      return res.status(404).json({ error: `Deal ${dealId} no encontrado`, detail: err?.message });
    }

    // 2. Line items del deal
    const liIds = await getAssociatedIds('deals', dealId, 'line_items');
    const lineItems = await batchRead('lineItems', liIds, LI_PROPS);

    // 3. Para cada LI, buscar tickets asociados
    const lineItemsConTickets = [];

    for (const li of lineItems) {
      const ticketIds = await getAssociatedIds('line_items', li.id, 'tickets');
      const tickets = await batchRead('tickets', ticketIds, TICKET_PROPS);

      const ticketsSorted = tickets
        .map(t => ({ ...pickProps(t), _clasificacion: classifyTicket(t) }))
        .sort((a, b) => (a.fecha_resolucion_esperada || '').localeCompare(b.fecha_resolucion_esperada || ''));

      lineItemsConTickets.push({
        lineItem: pickProps(li),
        tickets: ticketsSorted,
        resumen: {
          total_tickets: tickets.length,
          facturados: ticketsSorted.filter(t => t._clasificacion === 'facturado').length,
          pendientes: ticketsSorted.filter(t => t._clasificacion === 'pendiente').length,
          descartados: ticketsSorted.filter(t => t._clasificacion === 'descartado').length,
        },
      });
    }

    // 4. Resumen global del deal
    const totalTickets = lineItemsConTickets.reduce((s, x) => s + x.resumen.total_tickets, 0);
    const totalFacturados = lineItemsConTickets.reduce((s, x) => s + x.resumen.facturados, 0);
    const totalPendientes = lineItemsConTickets.reduce((s, x) => s + x.resumen.pendientes, 0);

    return res.json({
      deal: pickProps(deal),
      lineItems: lineItemsConTickets,
      resumen: {
        total_line_items: lineItems.length,
        total_tickets: totalTickets,
        total_facturados: totalFacturados,
        total_pendientes: totalPendientes,
      },
    });

  } catch (err) {
    logger.error({ module: 'debugInspect', fn: 'deal', dealId, err }, 'Error en debug deal');
    return res.status(500).json({ error: 'Error interno', detail: err?.message });
  }
});

export default router;