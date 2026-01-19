import { hubspotClient } from './hubspotClient.js';
import { hasParteDelCupoActiva } from './services/cupo/cupoUtils.js';
import { calculateCupoEstado } from './utils/propertyHelpers.js';

/*
 * Calcula y actualiza el cupo de un negocio.
 * Solo considera line items con `parte_del_cupo=true` y `facturacion_activa=true`.
 */

export function computeCupoStatus(deal, lineItems) {
  if (!deal || !deal.properties) {
    return { consumido: 0, restante: 0 };
  }
  const props = deal.properties;
  const tipo = (props.tipo_de_cupo || '').toString().trim().toUpperCase();

  const totalHoras = parseFloat(props.cupo_total) || 0;
  const totalMonto = parseFloat(props.cupo_total_monto) || 0;
  const totalGenerico = parseFloat(props.cupo_total) || 0;

  let total;
  if (tipo === 'HORAS' || tipo === 'POR HORAS') {
    total = totalHoras || totalGenerico;
  } else if (tipo === 'MONTO' || tipo === 'POR MONTO') {
    total = totalMonto || totalGenerico;
  } else {
    total = totalGenerico;
  }

  let consumido = 0;
  for (const li of lineItems || []) {
    const lp = li.properties || {};
    const parteDelCupo = lp.parte_del_cupo === true || lp.parte_del_cupo === 'true';
    const facturacionActiva = lp.facturacion_activa === true || lp.facturacion_activa === 'true';
    if (!parteDelCupo || !facturacionActiva) continue;

    const qty = parseFloat(lp.quantity) || 0;
    const price = parseFloat(lp.price) || 0;

    if (tipo === 'HORAS' || tipo === 'POR HORAS') {
      consumido += qty;
    } else {
      consumido += qty * price;
    }
  }

  const restante = total - consumido;
  return { consumido, restante };
}

export async function updateDealCupo(deal, lineItems) {
  console.log('[cupo:updateDealCupo] running', { dealId: deal.id, lineItems: lineItems?.length });

  if (!deal || !deal.id) return { consumido: 0, restante: 0 };

  const { consumido, restante } = computeCupoStatus(deal, lineItems);

  const dp = deal.properties || {};
  const cupoActivo = String(dp.cupo_activo || '').toLowerCase() === 'true';

  const properties = {
    cupo_consumido: String(consumido),
    cupo_restante: String(restante),
  };

  // ✅ 1) Estado de cupo (para que la alerta funcione)
  // Regla: si cupo está desactivado, el estado lo calcula el helper ("Desactivado")
  // pero si hay LI parte_del_cupo activa y cupo_activo=false => Inconsistente
  const hayParteCupoActiva = hasParteDelCupoActiva(lineItems);

  let estado;
  if (!cupoActivo && hayParteCupoActiva) {
    estado = 'Inconsistente';
  } else {
    estado = calculateCupoEstado({ ...dp, ...properties });
  }

  // Si no querés guardar "Desactivado" en cupo_estado, lo podés limpiar:
  if (estado === 'Desactivado') {
    properties.cupo_estado = ''; // o no setearlo
  } else if (estado) {
    properties.cupo_estado = estado;
  }

  try {
    await hubspotClient.crm.deals.basicApi.update(String(deal.id), { properties });
  } catch (err) {
    console.error('[cupo] Error actualizando cupo del deal', deal.id, err?.response?.body || err?.message);
  }

  return { consumido, restante, estado };
}
