// cupoEngine.js
import { hubspotClient } from './hubspotClient.js';

/**
 * Recalcula el consumo de cupo para un deal en base a los tickets asociados.
 * - Suma horas consumidas (o montos) de tickets con of_aplica_para_cupo != ''.
 * - Actualiza cupo_consumido_horas/monto, cupo_restante_horas/monto y cupo_estado en el negocio.
 * - Usa las propiedades definidas a nivel deal (cupo_total_*, cupo_umbral_*, etc.).
 */
export async function updateCupoForDeal({ dealId, deal, lineItems, today = new Date() }) {
  // 1) Leer todos los tickets asociados al deal
  const ticketIds = await getAssocIdsV4('deals', String(dealId), 'tickets');
  let tickets = [];
  if (ticketIds.length) {
    const batch = await hubspotClient.crm.tickets.batchApi.read(
      {
        inputs: ticketIds.map((id) => ({ id: String(id) })),
        properties: [
          'of_line_item_ids',
          'of_aplica_para_cupo',
          'consumo_bolsa_horas_pm',
          'monto_bolsa_periodo',
          'hs_pipeline_stage',
        ],
      },
      false
    );
    tickets = batch.results || [];
  }

  // 2) Inicializar acumuladores
  let totalHorasConsumidas = 0;
  let totalMontoConsumido = 0;

  for (const t of tickets) {
    const p = t.properties || {};
    // Solo tickets que participan del cupo y estén en una etapa activa (ej. no cancelados)
    if (!p.of_aplica_para_cupo) continue;

    const horas = Number(p.consumo_bolsa_horas_pm || 0);
    const monto = Number(p.monto_bolsa_periodo || 0);

    // Suma horas y montos
    totalHorasConsumidas += horas;
    totalMontoConsumido += monto;
  }

  const dealProps = deal.properties || {};
  const cupoTipo = (dealProps.cupo_tipo || '').toString().trim().toLowerCase();
  const cupoTotalHoras = Number(dealProps.cupo_total_horas || 0);
  const cupoTotalMonto = Number(dealProps.cupo_total_monto || 0);
  const cupoUmbralHoras = Number(dealProps.cupo_umbral_horas || 0);
  const cupoUmbralMonto = Number(dealProps.cupo_umbral_monto || 0);

  // Ajuste manual opcional
  const ajusteManual = Number(dealProps.cupo_ajuste_manual || 0);
  // Aplica ajuste al total restante (puede ser positivo o negativo)
  let restanteHoras = Math.max(cupoTotalHoras - totalHorasConsumidas + ajusteManual, 0);
  let restanteMonto = Math.max(cupoTotalMonto - totalMontoConsumido + ajusteManual, 0);

  // Determinar estado
  let estado = 'OK';
  if (cupoTipo === 'por_horas') {
    if (cupoTotalHoras && restanteHoras <= 0) estado = 'Agotado';
    else if (cupoUmbralHoras && restanteHoras <= cupoUmbralHoras) estado = 'Bajo Umbral';
  } else if (cupoTipo === 'por_monto') {
    if (cupoTotalMonto && restanteMonto <= 0) estado = 'Agotado';
    else if (cupoUmbralMonto && restanteMonto <= cupoUmbralMonto) estado = 'Bajo Umbral';
  }

  // Actualizar negocio
  const updates = {};
  if (cupoTipo === 'por_horas') {
    updates.cupo_consumido_horas = String(totalHorasConsumidas);
    updates.cupo_restante_horas = String(restanteHoras);
  } else if (cupoTipo === 'por_monto') {
    updates.cupo_consumido_monto = String(totalMontoConsumido);
    updates.cupo_restante_monto = String(restanteMonto);
  }
  updates.cupo_estado = estado;

  await hubspotClient.crm.deals.basicApi.update(String(dealId), { properties: updates });
}
