/**
 * Calcula el estado del cupo en base a total, restante y umbral absoluto.
 *
 * - El `umbral` se interpreta como un valor absoluto (horas o monto), ya no como ratio.
 * - Si el total no es numérico o es ≤0, devuelve 'Inconsistente'.
 * - Si el restante ≤0, devuelve 'Agotado'.
 * - Si el umbral >0 y el restante ≤ umbral, devuelve 'Bajo Umbral'.
 * - En cualquier otro caso, devuelve 'OK'.
 *
 * @param {number} total – Total de horas o monto de la bolsa
 * @param {number} restante – Cantidad restante (horas o monto)
 * @param {number|null} umbral – Umbral absoluto (horas o monto) o null si no se definió
 * @returns {'OK'|'Bajo Umbral'|'Agotado'|'Inconsistente'}
 */
export function computeCupoStatus(total, restante, umbral) {
  const t = Number(total);
  const r = Number(restante);
  const u = umbral == null ? null : Number(umbral);

  if (!Number.isFinite(t) || t <= 0) return 'Inconsistente';
  if (!Number.isFinite(r)) return 'Inconsistente';
  if (r <= 0) return 'Agotado';
  if (Number.isFinite(u) && u > 0 && r <= u) return 'Bajo Umbral';
  return 'OK';
}

/**
 * Agrega los datos de cupo a nivel negocio a partir de las propiedades del negocio y
 * de los line items.
 *
 * - Lee `tipo_de_cupo` para decidir si el cupo es por horas o por monto.
 * - Lee `cupo_total`/`cupo_total_monto` y `cupo_umbral`/`cupo_umbral_monto` exclusivamente del negocio.
 * - Suma consumidos y restantes únicamente de line items con `parte_del_cupo = true`.
 * - Si ningún line item participa, `consumido = 0` y `restante = total`.
 *
 * Regla: si hay tipo_de_cupo, total y umbral son obligatorios.
 * Si faltan => cupoActivo=true pero estado='Inconsistente' (para que se vea el problema).
 *
 * @param {Array<Object>} lineItems – Lista de line items asociados
 * @param {Object} [dealProps={}] – Propiedades del negocio (p. ej. deal.properties)
 * @returns {Object|null} { tipo, total, consumido, restante, umbral, estado, cupoActivo }
 */
export function aggregateDealCupo(lineItems, dealProps = {}) {
  const props = dealProps || {};
  const rawTipo = (props.tipo_de_cupo || '').toString().trim().toLowerCase();

  let tipo = null;
  let total = 0;
  let umbral = null;

  // 1) Determinar tipo, total y umbral a partir del negocio
  if (rawTipo === 'por_horas' || rawTipo === 'horas' || rawTipo === 'por horas') {
    tipo = 'Por horas';
    total = Number(props.cupo_total) || 0;

    if (props.cupo_umbral !== undefined && props.cupo_umbral !== null && props.cupo_umbral !== '') {
      const v = Number(props.cupo_umbral);
      umbral = Number.isFinite(v) ? v : null;
    }
  } else if (rawTipo === 'por_monto' || rawTipo === 'monto' || rawTipo === 'por monto') {
    tipo = 'Por Monto';
    total = Number(props.cupo_total_monto) || 0;

    if (
      props.cupo_umbral_monto !== undefined &&
      props.cupo_umbral_monto !== null &&
      props.cupo_umbral_monto !== ''
    ) {
      const v = Number(props.cupo_umbral_monto);
      umbral = Number.isFinite(v) ? v : null;
    }
  }

  // 2) Sin tipo válido => no hay cupo
  if (!tipo) return null;

  // 3) Regla: si hay tipo, total y umbral son obligatorios
  const totalOk = Number.isFinite(total) && total > 0;
  const umbralOk = Number.isFinite(umbral) && umbral > 0;

  console.log('[cupo][DEAL INPUT]', {
    rawTipo,
    tipo,
    total,
    umbral,
    totalOk,
    umbralOk,
    lineItemsCount: Array.isArray(lineItems) ? lineItems.length : 0,
  });

  if (!totalOk || !umbralOk) {
    return {
      tipo,
      total: totalOk ? total : 0,
      consumido: 0,
      restante: 0,
      umbral: umbralOk ? umbral : null,
      estado: 'Inconsistente',
      cupoActivo: true,
    };
  }

  // 4) Agregado desde line items participantes
  let consumido = 0;
  let restante = 0;
  let foundParticipant = false;

  for (const li of lineItems || []) {
    const p = li?.properties || {};
    const partRaw = p.parte_del_cupo;

    let participates = false;
    if (partRaw !== undefined && partRaw !== null) {
      const v = partRaw.toString().trim().toLowerCase();
      if (['true', '1', 'yes', 'si', 'sí', 'verdadero'].includes(v)) participates = true;
    }
    if (!participates) continue;

    foundParticipant = true;
    

    if (tipo === 'Por horas') {
      const c = Number(p.bolsa_horas_consumidas) || 0;
      const r = Number(p.bolsa_horas_restantes) || 0;

    console.log('[cupo][LI RAW PROPS]', {
  liId: String(li?.id),
  name: p.name ?? p.hs_name ?? '',
  parte_del_cupo: p.parte_del_cupo,
  aplica_cupo: p.aplica_cupo,

  bolsa_precio_hora: p.bolsa_precio_hora,
  horas_bolsa: p.horas_bolsa,
  cant__hs_bolsa: p.cant__hs_bolsa,
  precio_bolsa: p.precio_bolsa,

  total_bolsa_horas: p.total_bolsa_horas,
  total_bolsa_monto: p.total_bolsa_monto,

  bolsa_horas_consumidas: p.bolsa_horas_consumidas,
  bolsa_horas_restantes: p.bolsa_horas_restantes,
  bolsa_monto_consumido: p.bolsa_monto_consumido,
  bolsa_monto_restante: p.bolsa_monto_restante,
});


      consumido += c;
      restante += r;
    } else {
      const c = Number(p.bolsa_monto_consumido) || 0;
      const r = Number(p.bolsa_monto_restante) || 0;

      console.log('[cupo][PARTICIPA monto]', {
        liId: String(li?.id),
        name: p.name ?? p.hs_name ?? '',
        parte_del_cupo: partRaw,
        bolsa_monto_consumido: p.bolsa_monto_consumido,
        bolsa_monto_restante: p.bolsa_monto_restante,
        addConsumido: c,
        addRestante: r,
      });

      consumido += c;
      restante += r;
    }
  }

  // 5) Si no hay participantes, el restante es el total
  if (!foundParticipant) {
    consumido = 0;
    restante = total;
  }

  // 6) Estado final
  const estado = computeCupoStatus(total, restante, umbral);

  console.log('[cupo][AGG RESULT]', {
    tipo,
    total,
    umbral,
    foundParticipant,
    consumido,
    restante,
    estado,
  });

  return { tipo, total, consumido, restante, umbral, estado, cupoActivo: true };
}

/**
 * Actualiza las propiedades de cupo a nivel negocio en HubSpot.
 *
 * - Lee tipo/total/umbral desde las propiedades del negocio, si se pasan.
 * - Calcula consumido/restante con aggregateDealCupo.
 * - Sólo actualiza campos derivados (cupo_activo, cupo_consumido_*, cupo_restante_*, cupo_estado).
 * - **NO** sobrescribe cupo_total_* ni cupo_umbral_* ni tipo_de_cupo.
 *
 * @param {string} dealId – ID del negocio
 * @param {Array<Object>} lineItems – Line items ya inicializados con campos de bolsa
 * @param {Object} [dealOrProps] – Opcional: objeto completo del deal o sólo sus properties.
 */
export async function updateDealCupo(dealId, lineItems, dealOrProps) {
  const id = String(dealId);

  const toStrOrNull = (n) => {
    const v = Number(n);
    return Number.isFinite(v) ? String(v) : null;
  };

  let dealProps = {};

  // 1) Permitir deal completo o sólo properties
  if (dealOrProps && typeof dealOrProps === 'object') {
    if (dealOrProps.properties && typeof dealOrProps.properties === 'object') {
      dealProps = dealOrProps.properties;
    } else {
      dealProps = dealOrProps;
    }
  }

  // 2) Si no tenemos props, traerlas (solo inputs necesarios)
  if (!dealProps || Object.keys(dealProps).length === 0) {
    try {
      const resp = await hubspotClient.crm.deals.basicApi.getById(id, [
        'tipo_de_cupo',
        'cupo_total',
        'cupo_total_monto',
        'cupo_umbral',
        'cupo_umbral_monto',
      ]);
      dealProps = resp.properties || {};
    } catch (err) {
      console.error('[cupo] No se pudieron leer las propiedades del negocio', id, err?.response?.body || err);
      dealProps = {};
    }
  }

  // 3) Calcular agregado
  const aggregated = aggregateDealCupo(lineItems || [], dealProps);

  // Debug útil
  console.log('[cupo][UPDATE DEAL]', {
    dealId: id,
    tipo_de_cupo: dealProps?.tipo_de_cupo,
    cupo_total: dealProps?.cupo_total,
    cupo_umbral: dealProps?.cupo_umbral,
    cupo_total_monto: dealProps?.cupo_total_monto,
    cupo_umbral_monto: dealProps?.cupo_umbral_monto,
    aggregated,
  });

  // 4) Preparar props DERIVADAS a escribir
  const propsToUpdate = {};

  if (!aggregated) {
    // No hay cupo definido => apagar
    propsToUpdate.cupo_activo = 'false';
    propsToUpdate.cupo_estado = null;

    // Limpiar outputs numéricos
    propsToUpdate.cupo_consumido = null;
    propsToUpdate.cupo_restante = null;
    propsToUpdate.cupo_consumido_monto = null;
    propsToUpdate.cupo_restante_monto = null;
  } else {
    // Hay tipo (y por regla puede ser consistente o inconsistente)
    propsToUpdate.cupo_activo = 'true';
    propsToUpdate.cupo_estado = aggregated.estado || null;

    if (aggregated.tipo === 'Por horas') {
      propsToUpdate.cupo_consumido = toStrOrNull(aggregated.consumido);
      propsToUpdate.cupo_restante = toStrOrNull(aggregated.restante);

      // limpiar monto (para no mezclar)
      propsToUpdate.cupo_consumido_monto = null;
      propsToUpdate.cupo_restante_monto = null;
    } else if (aggregated.tipo === 'Por Monto') {
      propsToUpdate.cupo_consumido_monto = toStrOrNull(aggregated.consumido);
      propsToUpdate.cupo_restante_monto = toStrOrNull(aggregated.restante);

      // limpiar horas (para no mezclar)
      propsToUpdate.cupo_consumido = null;
      propsToUpdate.cupo_restante = null;
    } else {
      // caso ultra defensivo
      propsToUpdate.cupo_consumido = null;
      propsToUpdate.cupo_restante = null;
      propsToUpdate.cupo_consumido_monto = null;
      propsToUpdate.cupo_restante_monto = null;
    }
  }

  console.log('[cupo][DEAL PROPS WRITE]', { dealId: id, properties: propsToUpdate });

  // 5) Escribir (solo outputs)
  try {
    await hubspotClient.crm.deals.basicApi.update(id, { properties: propsToUpdate });
    return { dealId: id, updated: true, aggregated };
  } catch (err) {
    console.error('[cupo] Error actualizando negocio', id, err?.response?.body || err?.message || err);
    return { dealId: id, updated: false, error: err?.response?.body || err?.message || String(err) };
  }
}
