// src/utils/cronLock.js
// Candado de crons en PostgreSQL con latido (heartbeat).
// Reemplaza el file lock en disco efímero de Railway.
//
// Reglas:
// - Un candado por cron (job_name es la clave).
// - La corrida viva renueva heartbeat_at cada HEARTBEAT_INTERVAL_MS.
// - Otra corrida solo puede robar el candado si el último latido
//   tiene más de STALE_AFTER_MS (= corrida muerta).
// - El timer del latido usa .unref() para NO impedir que el proceso
//   termine (crítico en Railway: el cron debe salir solo).

import pool from "../db.js";
import logger from "../../lib/logger.js";

const HEARTBEAT_INTERVAL_MS = Number(process.env.CRON_LOCK_HEARTBEAT_MS || 2 * 60 * 1000); // 2 min
const STALE_AFTER_MS = Number(process.env.CRON_LOCK_STALE_MS || 5 * 60 * 1000); // 5 min

let heartbeatTimer = null;

export async function initCronLocksTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cron_locks (
      job_name     TEXT PRIMARY KEY,
      holder       TEXT NOT NULL,
      started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

/**
 * Intenta tomar el candado del cron en una sola operación atómica:
 * - Si no hay candado -> lo crea y devuelve true.
 * - Si hay candado pero su latido es viejo (corrida muerta) -> lo roba y devuelve true.
 * - Si hay candado con latido reciente (corrida viva) -> devuelve false.
 * Al adquirir, arranca el latido automático.
 */
export async function acquireCronLock(jobName, holder) {
  await initCronLocksTable();
  const res = await pool.query(
    `INSERT INTO cron_locks (job_name, holder, started_at, heartbeat_at)
     VALUES ($1, $2, now(), now())
     ON CONFLICT (job_name) DO UPDATE
       SET holder = EXCLUDED.holder,
           started_at = now(),
           heartbeat_at = now()
       WHERE cron_locks.heartbeat_at < now() - ($3 || ' milliseconds')::interval
     RETURNING holder`,
    [jobName, holder, String(STALE_AFTER_MS)]
  );

  const acquired = res.rowCount > 0 && res.rows[0]?.holder === holder;
  if (!acquired) {
    return false;
  }

  startHeartbeat(jobName, holder);
  logger.info({ jobName, holder }, "[cronLock] lock acquired");
  return true;
}

/**
 * Suelta el candado (solo si esta corrida es la dueña) y frena el latido.
 * Nunca lanza: un fallo acá no debe romper el cron; el latido viejo
 * hará que el candado se considere muerto solo.
 */
export async function releaseCronLock(jobName, holder) {
  stopHeartbeat();
  try {
    await pool.query(
      `DELETE FROM cron_locks WHERE job_name = $1 AND holder = $2`,
      [jobName, holder]
    );
    logger.info({ jobName, holder }, "[cronLock] lock released");
  } catch (e) {
    logger.warn({ jobName, holder, err: e?.message }, "[cronLock] release failed (se vencerá solo por latido)");
  }
}

// -------------------- internos --------------------

function startHeartbeat(jobName, holder) {
  stopHeartbeat();
  heartbeatTimer = setInterval(async () => {
    try {
      await pool.query(
        `UPDATE cron_locks SET heartbeat_at = now() WHERE job_name = $1 AND holder = $2`,
        [jobName, holder]
      );
    } catch (e) {
      logger.warn({ jobName, holder, err: e?.message }, "[cronLock] heartbeat failed");
    }
  }, HEARTBEAT_INTERVAL_MS);
  // Clave: no mantener vivo el proceso por culpa del timer
  heartbeatTimer.unref();
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}