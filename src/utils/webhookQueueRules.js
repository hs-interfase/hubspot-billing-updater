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
