// src/services/deal/recalcValorTotal.js
//
// Calcula el valor total de un deal sumando el `subtotal_real` de sus tickets
// asociados (no cancelados), aplicando la regla de auto-renovación:
//
//   - Ticket con renovacion_automatica=true (suscripción abierta):
//       solo cuenta si la fecha del pago cae en el AÑO EN CURSO (ene–dic).
//   - Resto (plan fijo / manual):
//       cuenta siempre (todos los pagos).
//
// Prioridad de fecha del pago:
//   fecha_real_de_facturacion → of_fecha_de_facturacion → fecha_resolucion_esperada
//
// Asunciones de negocio (confirmadas):
//   - Todos los tickets de un deal comparten la misma moneda → suma directa.
//   - Los tickets del año ya existen (se crean por adelantado).
//   - Cada deal (incluido el mirror UY) se calcula con SUS propios tickets.
//
// Diseñada para llamarse al final de runPhasesForDeal, de modo que queda
// cubierta por los tres disparadores (runBilling, cronWeekendFull, webhook).

import { hubspotClient } from '../../hubspotClient.js';
import { TICKET_STAGES, BILLING_AUTOMATED_CANCELLED } from '../../config/constants.js';
import logger from '../../../lib/logger.js';

const MOD = 'recalcValorTotal';

// Nombre de la propiedad destino (override por env para renombrar sin tocar código).
const PROP_DEAL_TOTAL = process.env.PROP_DEAL_TOTAL || 'valor_total';

// Propiedad del TICKET que apunta al deal. Es la fuente principal porque los
// tickets forecast NO siempre están asociados al deal, pero sí llevan of_deal_id.
const PROP_TICKET_DEAL_ID = process.env.PROP_TICKET_DEAL_ID || 'of_deal_id';

// Stages que NO cuentan (tickets cancelados en cualquiera de los dos pipelines).
const CANCELLED = new Set(
  [TICKET_STAGES.CANCELLED, BILLING_AUTOMATED_CANCELLED].filter(Boolean)
);

// Propiedades de fecha en orden de prioridad para ubicar el año del pago.
const FECHAS_PRIORIDAD = [
  'fecha_real_de_facturacion',
  'of_fecha_de_facturacion',
  'fecha_resolucion_esperada',
];

/**
 * Extrae el año (UTC) de la primera propiedad de fecha con valor.
 * Soporta YYYY-MM-DD, YYYY-MM-DDThh:mm:ss y epoch ms (string).
 * Retorna null si no hay fecha utilizable.
 */
function anioDelPago(p) {
  for (const f of FECHAS_PRIORIDAD) {
    const raw = p?.[f];
    if (raw === undefined || raw === null || raw === '') continue;
    const s = String(raw).trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return Number(s.slice(0, 4));
    const ms = Number(s);
    if (Number.isFinite(ms) && ms > 0) return new Date(ms).getUTCFullYear();
  }
  return null;
}

/**
 * Trae TODOS los IDs de tickets de un deal, combinando dos fuentes:
 *   1) Búsqueda por of_deal_id  → incluye forecasts NO asociados (fuente principal).
 *   2) Asociaciones deal→tickets → por si algún ticket no tiene of_deal_id seteado.
 * Se deduplican por id.
 */
export async function getDealTicketIds(dealId) {
  const ids = new Set();

  // 1) Por of_deal_id (paginado)
  let after;
  do {
    const res = await hubspotClient.crm.tickets.searchApi.doSearch({
      filterGroups: [{ filters: [{ propertyName: PROP_TICKET_DEAL_ID, operator: 'EQ', value: String(dealId) }] }],
      properties: ['hs_object_id'],
      limit: 100,
      after,
    });
    for (const t of res.results || []) ids.add(String(t.id));
    after = res.paging?.next?.after;
  } while (after);

  // 2) Unión con asociaciones (paginado)
  let aAfter;
  do {
    const resp = await hubspotClient.crm.associations.v4.basicApi.getPage(
      'deals', String(dealId), 'tickets', 500, aAfter
    );
    for (const r of resp.results || []) ids.add(String(r.toObjectId));
    aAfter = resp.paging?.next?.after;
  } while (aAfter);

  return [...ids];
}

/**
 * Recalcula `valor_total` de un deal desde sus tickets.
 *
 * @param {object}  params
 * @param {string}  params.dealId
 * @param {boolean} [params.applyUpdate=true] - si false, solo retorna el total (no escribe).
 * @returns {Promise<{ total: number, ticketCount: number, changed: boolean }>}
 */
export async function recalcValorTotal({ dealId, applyUpdate = true }) {
  const log = logger.child({ module: MOD, dealId });

  const ticketIds = await getDealTicketIds(dealId);
  const ANIO = new Date().getUTCFullYear();

  let total = 0;
  let counted = 0;

  for (let i = 0; i < ticketIds.length; i += 100) {
    const chunk = ticketIds.slice(i, i + 100);
    const batch = await hubspotClient.crm.tickets.batchApi.read(
      {
        inputs: chunk.map((id) => ({ id })),
        properties: [
          'renovacion_automatica',
          'subtotal_real',
          'hs_pipeline_stage',
          ...FECHAS_PRIORIDAD,
        ],
      },
      false
    );

    for (const t of batch.results || []) {
      const p = t.properties || {};

      // Excluir cancelados.
      if (CANCELLED.has(String(p.hs_pipeline_stage || ''))) continue;

      const valor = Number.parseFloat(p.subtotal_real) || 0;
      const esRenew = String(p.renovacion_automatica || '').toLowerCase() === 'true';

      if (esRenew) {
        // Suscripción abierta → solo pagos del año en curso.
        if (anioDelPago(p) === ANIO) {
          total += valor;
          counted++;
        }
      } else {
        // Plan fijo / manual → todos los pagos.
        total += valor;
        counted++;
      }
    }
  }

  total = Math.round(total * 100) / 100;

  let changed = false;
  if (applyUpdate) {
    let prev = NaN;
    try {
      const cur = await hubspotClient.crm.deals.basicApi.getById(String(dealId), [PROP_DEAL_TOTAL]);
      prev = Number.parseFloat(cur?.properties?.[PROP_DEAL_TOTAL]);
    } catch (err) {
      log.warn({ err }, 'No se pudo leer valor_total actual, se hará update igual');
    }

    if (prev !== total) {
      await hubspotClient.crm.deals.basicApi.update(String(dealId), {
        properties: { [PROP_DEAL_TOTAL]: String(total) },
      });
      changed = true;
      log.info(
        { prev: Number.isFinite(prev) ? prev : null, total, tickets: ticketIds.length, counted },
        'valor_total actualizado'
      );
    } else {
      log.debug({ total, tickets: ticketIds.length, counted }, 'valor_total sin cambios');
    }
  }

  return { total, ticketCount: ticketIds.length, changed };
}
