import { hubspotClient } from '../../hubspotClient.js';
import { cancelForecastTickets } from '../tickets/cancelForecastTickets.js';
import logger from '../../../lib/logger.js';
import { markMansoftBaja } from '../../services/billing/mansoftSnapshot.js';
import { parseBool } from '../../utils/parsers.js';
// En cancelDeal.js, agregar import de las constantes
import {
  DEAL_STAGE_LOST,
  DEAL_STAGE_SUSPENDED,
  DEAL_STAGE_VOIDED,
} from '../../config/constants.js';


// Nueva función helper (arriba de propagateDealCancellation)
function defaultCancellationReason(dealStage) {
  const stage = String(dealStage || '');
  if (stage === DEAL_STAGE_SUSPENDED) return 'Negocio suspendido';
  if (stage === DEAL_STAGE_VOIDED)    return 'Negocio anulado';
  return 'Negocio perdido';
}

/**
 * Propaga la cancelación de un deal:
 * 1. Pone facturacion_activa = false en el deal
 * 2. Cancela todos los tickets en stage FORECAST asociados a sus line items
 *
 * @param {Object} params
 * @param {string} params.dealId
 * @param {Object} params.dealProps  - properties del deal (deal.properties)
 * @param {Array}  params.lineItems  - line items del deal
 */
export async function propagateDealCancellation({ dealId, dealProps, lineItems }) {
  if (!dealId) {
    logger.warn({ module: 'cancelDeal' }, 'propagateDealCancellation llamado sin dealId');
    return;
  }

  const closedLostReason = dealProps?.closed_lost_reason || defaultCancellationReason(dealProps?.dealstage);

  logger.info(
    { module: 'cancelDeal', dealId, closedLostReason: closedLostReason || '(vacío)' },
    'Iniciando propagación de cancelación'
  );

  // 1) Marcar deal como inactivo
  try {
    await hubspotClient.crm.deals.basicApi.update(String(dealId), {
      properties: { facturacion_activa: 'false' },
    });

    logger.info(
      { module: 'cancelDeal', dealId },
      'facturacion_activa = false aplicado al deal'
    );
  } catch (err) {
    logger.error(
      { module: 'cancelDeal', dealId, err },
      'Error poniendo facturacion_activa = false en el deal'
    );
    // Continuamos igual: intentamos cancelar los tickets
  }

  // 2) Cancelar tickets forecast
  try {
    const result = await cancelForecastTickets({ lineItems, closedLostReason });

    logger.info(
      { module: 'cancelDeal', dealId, ...result },
      'cancelForecastTickets completado'
    );
  } catch (err) {
    logger.error(
      { module: 'cancelDeal', dealId, err },
      'Error en cancelForecastTickets'
    );
  }
  // 3) Marcar line items automáticos como baja Mantsoft
  const automaticos = (lineItems || []).filter(li =>
    parseBool(li?.properties?.facturacion_automatica)
  );

  if (automaticos.length > 0) {
    logger.info(
      { module: 'cancelDeal', dealId, count: automaticos.length },
      'Marcando LIs automáticos como baja Mantsoft'
    );

    for (const li of automaticos) {
      try {
        await markMansoftBaja(li.id, {
          tipoActual: li?.properties?.mansoft_tipo_aviso,
        });
      } catch (err) {
        logger.error(
          { module: 'cancelDeal', dealId, lineItemId: li?.id, err },
          'Error marcando baja Mantsoft en LI — no bloquea'
        );
      }
    }
  }
}
