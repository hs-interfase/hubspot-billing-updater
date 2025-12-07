// src/bagProcessor.js
import { hubspotClient } from './hubspotClient.js';

function parseNumber(raw) {
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Procesa tickets de bolsa:
 * - Ticket debe tener of_aplica_para_cupo != vacío
 * - consumo_bolsa_horas_pm > 0
 * - monto_bolsa_periodo vacío o 0 (para no procesar dos veces)
 *
 * Para cada ticket:
 *  - Calcula monto_bolsa_periodo = horas * bolsa_precio_hora
 *  - Actualiza contadores en el line item (horas/montos consumidos/restantes)
 */
export async function processBagTickets({ batchSize = 50 } = {}) {
  let after = undefined;
  let processed = 0;

  do {
    const searchRequest = {
      filterGroups: [
        {
          filters: [
            {
              propertyName: 'of_aplica_para_cupo',
              operator: 'HAS_PROPERTY',
            },
            {
              propertyName: 'consumo_bolsa_horas_pm',
              operator: 'GT',
              value: '0',
            },
            {
              // solo tickets que todavía no tienen monto calculado
              propertyName: 'monto_bolsa_periodo',
              operator: 'LTE',
              value: '0',
            },
          ],
        },
      ],
      properties: [
        'of_line_item_id',
        'of_deal_id',
        'of_aplica_para_cupo',
        'consumo_bolsa_horas_pm',
        'monto_bolsa_periodo',
      ],
      limit: batchSize,
      after,
    };

    const searchResp = await hubspotClient.crm.tickets.searchApi.doSearch(
      searchRequest
    );

    const tickets = searchResp.results || [];
    if (!tickets.length) break;

    for (const ticket of tickets) {
      const tp = ticket.properties || {};
      const lineItemId = tp.of_line_item_id;
      const aplicaCupo = (tp.of_aplica_para_cupo || '').toString().trim();
      const horasPeriodo = parseNumber(tp.consumo_bolsa_horas_pm);

      if (!lineItemId || !aplicaCupo || horasPeriodo <= 0) {
        continue;
      }

      // -------------------------------------------------------------------
      // 1) Leer el line item con las propiedades de bolsa
      // -------------------------------------------------------------------
      const liResp = await hubspotClient.crm.lineItems.basicApi.getById(
        String(lineItemId),
        [
          'aplica_cupo',
          'bolsa_precio_hora',
          'horas_bolsa',
          'precio_bolsa',
          'bolsa_horas_restantes',
          'bolsa_monto_restante',
          'bolsa_monto_consumido',
          'bolsa_horas_consumidas',
          'total_bolsa_horas',
          'total_bolsa_monto',
        ]
      );
      const lp = liResp.properties || {};

      const precioHora = parseNumber(lp.bolsa_precio_hora);
      const totalHoras =
        parseNumber(lp.total_bolsa_horas) || parseNumber(lp.horas_bolsa);
      const totalMonto =
        parseNumber(lp.total_bolsa_monto) || parseNumber(lp.precio_bolsa);

      let horasConsumidas = parseNumber(lp.bolsa_horas_consumidas);
      let horasRestantes =
        parseNumber(lp.bolsa_horas_restantes) || (totalHoras || 0) - horasConsumidas;

      let montoConsumido = parseNumber(lp.bolsa_monto_consumido);
      let montoRestante =
        parseNumber(lp.bolsa_monto_restante) || (totalMonto || 0) - montoConsumido;

      // -------------------------------------------------------------------
      // 2) Calcular monto del período en base a horas PM * precio hora
      // -------------------------------------------------------------------
      const montoPeriodo = horasPeriodo * precioHora;

      // Actualizar horas
      horasConsumidas += horasPeriodo;
      if (totalHoras) {
        horasRestantes = Math.max(totalHoras - horasConsumidas, 0);
      }

      // Actualizar montos
      if (montoPeriodo && totalMonto) {
        // no dejar que se pase del total de la bolsa
        const montoAplicable = Math.min(montoPeriodo, Math.max(montoRestante, 0));
        montoConsumido += montoAplicable;
        montoRestante = Math.max(totalMonto - montoConsumido, 0);
      }

      // -------------------------------------------------------------------
      // 3) Escribir cambios en ticket y line item
      // -------------------------------------------------------------------
      await hubspotClient.crm.tickets.basicApi.update(String(ticket.id), {
        properties: {
          monto_bolsa_periodo: montoPeriodo,
        },
      });

      await hubspotClient.crm.lineItems.basicApi.update(String(lineItemId), {
        properties: {
          bolsa_horas_consumidas: horasConsumidas,
          bolsa_horas_restantes: horasRestantes,
          bolsa_monto_consumido: montoConsumido,
          bolsa_monto_restante: montoRestante,
          total_bolsa_horas: totalHoras,
          total_bolsa_monto: totalMonto,
        },
      });

      processed += 1;
    }

    after = searchResp.paging?.next?.after;
  } while (after);

  return { processed };
}
