// src/utils/webhookQueueRules.js
//
// Reglas puras del reaper y del COLAPSO de webhook_queue. Viven acá (y no en
// webhookQueue.js) para poder testearlas sin levantar el pool de Postgres.

/**
 * Decide qué hacer con un job `processing` huérfano.
 *
 * @param {Object} job          - fila de webhook_queue (usa `attempts`)
 * @param {number} maxAttempts  - intentos totales permitidos antes de rendirse
 * @returns {{ status: 'pending'|'failed', attempts: number }}
 */
export function decideReapAction(job, maxAttempts) {
  const attempts = (Number(job?.attempts) || 0) + 1;
  return attempts >= maxAttempts
    ? { status: 'failed', attempts }
    : { status: 'pending', attempts };
}

/**
 * Clasifica el job rescatado que, al re-ejecutarse, encontró `facturar_ahora`
 * ya en false. Qué significa eso depende de CUÁNDO resetea el flag el camino:
 *
 * - `urgent_ticket`: `processUrgentTicket` resetea recién en el `finally`.
 *   Si el proceso muere, el `finally` NO corre y el flag queda en true → el
 *   reaper reencola y la facturación se recupera sola. Por eso, encontrarlo
 *   en false significa que el `finally` sí corrió: el trabajo se completó y
 *   el proceso murió entre eso y el `UPDATE ... done`. No hay plata perdida
 *   → warn, no alerta.
 *
 * @returns {null | { severidad: 'critical'|'warn', mensaje: string, detalle: string }}
 */
export function clasificarJobRescatado(job, jobResult) {
  const perdioElFlag = Boolean(jobResult?.skipped) && jobResult?.reason === 'facturar_ahora_false';
  if (!job?.reaped_at || !perdioElFlag) return null;

  if (job.action_type === 'urgent_ticket') {
    return {
      severidad: 'warn',
      mensaje: 'Job de ticket rescatado: el trabajo ya se había completado',
      detalle:
        'El ticket ya tenía "facturar ahora" en false, que en este camino solo se escribe al ' +
        'terminar. El proceso murió después de facturar y antes de marcar el job como done.',
    };
  }

  return null;
}

// ─── Política de colapso de la cola (fix 1-ago-2026) ─────────────────────────
//
// Antes de procesar un job, `processNext` marca `superseded` los `pending` más
// viejos del mismo negocio. Eso es correcto SÓLO para los jobs que recalculan
// desde el ESTADO ACTUAL del objeto: dos de esos son intercambiables y el último
// ya hace el trabajo de todos — colapsarlos es justamente para lo que existe.
//
// Para los jobs ESPECÍFICOS DEL EVENTO no lo es. `li_prop_sync` se encola una vez
// por propiedad (`escuchar-cambios.js`, RUTA 4) y el worker sincroniza SÓLO esa
// propiedad: colapsar por `deal_id` descartaba en silencio la edición de otra
// prop del mismo line item — y también la de OTRO line item del mismo negocio,
// porque la clave era el negocio. Quedaba como `superseded`, que es un estado
// normal: sin error y sin log de fallo. Bug vivo en producción hasta el 1-ago-2026.
// Para estos la clave tiene que incluir el objeto y la propiedad.
//
// 🔴 LISTA BLANCA, no lista negra: un `action_type` que nadie clasificó NO
// colapsa. Procesar de más cuesta throughput; colapsar de más pierde trabajo sin
// dejar rastro.

/** No colapsar: cada job se procesa. */
export const COLLAPSE_NONE = 'none';
/** Colapso por `deal_id` + `action_type` (el de siempre). */
export const COLLAPSE_BY_DEAL = 'deal';
/** Colapso por `deal_id` + `action_type` + `object_id` + `property_name`. */
export const COLLAPSE_BY_OBJECT_PROP = 'object_prop';

/**
 * Clasificación explícita de los `action_type` que existen hoy. Lo que no está
 * acá cae en `COLLAPSE_NONE`.
 */
export const COLLAPSE_POLICY_BY_ACTION = Object.freeze({
  // ── Derivados del estado: colapso por negocio, como siempre ──
  recalc: COLLAPSE_BY_DEAL,             // re-corre las phases del deal entero
  valor_recalc: COLLAPSE_BY_DEAL,       // recalcValorTotal lee todos los LI/tickets
  deal_cancel: COLLAPSE_BY_DEAL,        // re-verifica el dealstage actual
  ticket_label_sync: COLLAPSE_BY_DEAL,  // re-sincroniza las etiquetas del negocio
  deal_prop_sync: COLLAPSE_BY_DEAL,     // tanda E: resuelve las props del estado del deal

  // ── Específicos del evento: la clave incluye objeto y propiedad ──
  li_prop_sync: COLLAPSE_BY_OBJECT_PROP,     // sincroniza SÓLO `property_name` de ESE line item
  product_reassign: COLLAPSE_BY_OBJECT_PROP, // reasigna el producto de ESE line item

  // ── Específicos del ticket: hoy se encolan con `deal_id` null, así que el
  //    colapso ni siquiera corre. Quedan declarados para que, si algún día la
  //    fila trajera un deal, NO se colapsen por negocio: dos tickets distintos
  //    del mismo negocio son trabajos distintos (una factura cada uno).
  urgent_ticket: COLLAPSE_NONE,
  ticket_update: COLLAPSE_NONE,
  ticket_cancel_request: COLLAPSE_NONE,
  ticket_revert_request: COLLAPSE_NONE,
});

/**
 * Red de emergencia sin deploy: `WEBHOOK_QUEUE_COLLAPSE_BY_DEAL` con una lista
 * de `action_type` separados por coma REEMPLAZA el conjunto de tipos que
 * colapsan por negocio. Vacía o ausente = la clasificación de arriba.
 *
 * Sirve en las dos direcciones: sacar un tipo del colapso si se descubre que
 * pierde trabajo, o volver a meterlo (incluido `li_prop_sync`, o sea el
 * comportamiento viejo) si la cola no da abasto con el volumen extra.
 *
 * @param {string} actionType
 * @param {Object} [env=process.env]
 * @returns {'none'|'deal'|'object_prop'}
 */
export function collapsePolicyFor(actionType, env = process.env) {
  const declarada = COLLAPSE_POLICY_BY_ACTION[actionType] || COLLAPSE_NONE;

  const override = String(env?.WEBHOOK_QUEUE_COLLAPSE_BY_DEAL ?? '').trim();
  if (!override) return declarada;

  const porDeal = new Set(override.split(',').map(s => s.trim()).filter(Boolean));
  if (porDeal.has(actionType)) return COLLAPSE_BY_DEAL;

  // Fuera de la lista nadie colapsa por negocio; el resto de la política se mantiene.
  return declarada === COLLAPSE_BY_DEAL ? COLLAPSE_NONE : declarada;
}

/**
 * Decide con qué clave colapsar los `pending` más viejos que este job.
 *
 * @param {Object} job   - fila de webhook_queue (deal_id, action_type, object_id, property_name)
 * @param {Object} [env=process.env]
 * @returns {null | { scope: 'deal'|'object_prop', dealId: string, actionType: string,
 *                    objectId: string|null, propertyName: string|null }}
 *          `null` = no colapsar nada.
 */
export function decideCollapse(job, env = process.env) {
  const dealId = job?.deal_id;
  // Sin negocio no hay con qué agrupar (tickets, que se encolan con deal_id null).
  if (!dealId) return null;

  const actionType = job?.action_type;
  const policy = collapsePolicyFor(actionType, env);
  if (policy === COLLAPSE_NONE) return null;

  if (policy === COLLAPSE_BY_DEAL) {
    return { scope: COLLAPSE_BY_DEAL, dealId, actionType, objectId: null, propertyName: null };
  }

  return {
    scope: COLLAPSE_BY_OBJECT_PROP,
    dealId,
    actionType,
    objectId: job?.object_id ?? null,
    propertyName: job?.property_name ?? null,
  };
}

/**
 * Arma el UPDATE que colapsa los `pending` más viejos que este job. Se construye
 * acá (y no en processNext) para que el test verifique el query REAL que corre
 * contra Postgres, no una copia que puede desincronizarse.
 *
 * @param {Object} job   - fila de webhook_queue
 * @param {Object} [env=process.env]
 * @returns {null | { scope: 'deal'|'object_prop', text: string, params: Array }}
 *          `null` = este job no colapsa nada.
 */
export function buildCollapseQuery(job, env = process.env) {
  const criteria = decideCollapse(job, env);
  if (!criteria) return null;

  const params = [criteria.dealId, criteria.actionType, job.id];
  let extraWhere = '';

  if (criteria.scope === COLLAPSE_BY_OBJECT_PROP) {
    params.push(criteria.objectId, criteria.propertyName);
    // IS NOT DISTINCT FROM: `property_name` puede ser NULL y `= NULL` nunca matchea.
    extraWhere = `
            AND object_id = $4
            AND property_name IS NOT DISTINCT FROM $5`;
  }

  return {
    scope: criteria.scope,
    text: `UPDATE webhook_queue
            SET status = 'superseded', finished_at = NOW()
          WHERE status = 'pending'
            AND deal_id = $1
            AND action_type = $2
            AND id < $3${extraWhere}
          RETURNING id`,
    params,
  };
}
