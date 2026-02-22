import { hubspotClient } from '../../hubspotClient.js';
import { cancelForecastTickets } from '../tickets/cancelForecastTickets.js';
import logger from '../../../lib/logger.js';

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

  const closedLostReason = dealProps?.closed_lost_reason || '';

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
}
