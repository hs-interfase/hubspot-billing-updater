// src/utils/webhookQueueRules.js
//
// Reglas puras del reaper de webhook_queue. Viven acá (y no en webhookQueue.js)
// para poder testearlas sin levantar el pool de Postgres.

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
 * Detecta si un job que fue rescatado por el reaper llegó tarde: el trabajo
 * original ya se perdió porque `facturar_ahora` fue reseteado a false al inicio
 * de la corrida que murió (`_executeUrgentBillingForLineItem`). El re-run no
 * puede repetirlo — solo lo skipea. Sin este aviso, el job termina en `done` y
 * la pérdida queda invisible (justo el agujero de D8·Q2).
 */
export function esFacturacionUrgentePerdida(job, jobResult) {
  const esUrgente = job?.action_type === 'urgent_line_item' || job?.action_type === 'urgent_ticket';
  const perdioElFlag = Boolean(jobResult?.skipped) && jobResult?.reason === 'facturar_ahora_false';
  return Boolean(job?.reaped_at) && esUrgente && perdioElFlag;
}
