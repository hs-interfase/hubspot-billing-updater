import fs from 'node:fs';
import path from 'node:path';
import { hubspotClient } from '../hubspotClient.js';
import { getTodayYMD } from '../utils/dateUtils.js';
import { runPhasesForDeal } from '../runPhasesForDeal.js'; // ajustá path

const STATE_PATH = process.env.CRON_STATE_PATH || path.resolve(process.cwd(), 'cron_state_deals.json');
const FAILED_PATH = process.env.CRON_FAILED_PATH || path.resolve(process.cwd(), 'cron_failed_deals.json');
const LOCK_PATH = process.env.CRON_LOCK_PATH || path.resolve(process.cwd(), 'cron_state_deals.lock');

const CANCELLED_STAGE_ID = process.env.CANCELLED_STAGE_ID; // dealstage cancelado (value exacto)

// “presupuesto” de corrida (ej 25 min) para no pisarse con el cron de 30 min
const MAX_RUN_MS = Number(process.env.CRON_MAX_RUN_MS || 25 * 60 * 1000);

// límite por página de search (HubSpot permite 100)
const PAGE_LIMIT = Number(process.env.CRON_PAGE_LIMIT || 100);

// micro pausa para no golpear HubSpot
const DEAL_PAUSE_MS = Number(process.env.CRON_DEAL_PAUSE_MS || 150);

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}
function writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
}
function acquireLock() {
  try { fs.writeFileSync(LOCK_PATH, String(Date.now()), { flag: 'wx' }); return true; } catch { return false; }
}
function releaseLock() { try { fs.unlinkSync(LOCK_PATH); } catch {} }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function withRetry(fn, { maxRetries = 5 } = {}) {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (e) {
      attempt++;
      const status = e?.code || e?.statusCode || e?.response?.status;
      const msg = e?.message || String(e);
      const retryable = status === 429 || (status >= 500 && status <= 599);
      if (!retryable || attempt > maxRetries) throw e;
      const backoffMs = Math.min(30000, 1000 * 2 ** (attempt - 1));
      console.warn(`[cron] retryable error (status=${status}) attempt=${attempt}/${maxRetries}: ${msg} -> wait ${backoffMs}ms`);
      await sleep(backoffMs);
    }
  }
}

function addFailed(dealId, reason) {
  const today = getTodayYMD();
  const data = readJson(FAILED_PATH, { date: today, items: [] });

  // Si cambió el día, rotamos (dejamos lo anterior y arrancamos nuevo)
  if (data.date !== today) {
    writeJson(FAILED_PATH, { date: today, items: [] });
  }

  const fresh = readJson(FAILED_PATH, { date: today, items: [] });
  fresh.items.push({ dealId: String(dealId), reason: String(reason), at: new Date().toISOString() });
  writeJson(FAILED_PATH, fresh);
}

export async function runDealsBatchCron() {
  const start = Date.now();
  const deadline = start + MAX_RUN_MS;
  const today = getTodayYMD();

  if (!acquireLock()) {
    console.warn('[cron] lock present -> skip');
    return { skipped: true };
  }

  try {
    const state = readJson(STATE_PATH, { after: null, lastRunYMD: null });

    // Reiniciar cursor cada día (opcional, pero recomendado)
    if (state.lastRunYMD !== today) {
      console.log(`[cron] new day (${state.lastRunYMD} -> ${today}) reset after=null`);
      state.after = null;
      state.lastRunYMD = today;
      writeJson(STATE_PATH, state);
    }

    if (!CANCELLED_STAGE_ID) {
      console.warn('[cron] CANCELLED_STAGE_ID not set -> NO excluirá cancelados');
    }

    let processed = 0;
    let ok = 0;
    let failed = 0;

    console.log('[cron] start', { today, after: state.after, maxRunMs: MAX_RUN_MS, pageLimit: PAGE_LIMIT });

    // Mientras haya tiempo, ir pidiendo páginas y procesando
    while (Date.now() < deadline) {
      const resp = await withRetry(() =>
        hubspotClient.crm.deals.searchApi.doSearch({
          filterGroups: [{
            filters: CANCELLED_STAGE_ID
              ? [{ propertyName: 'dealstage', operator: 'NEQ', value: String(CANCELLED_STAGE_ID) }]
              : [],
          }],
          properties: ['dealname', 'dealstage'],
          limit: PAGE_LIMIT,
          after: state.after || undefined,
        })
      );

      const deals = resp?.results || [];
      const nextAfter = resp?.paging?.next?.after || null;

      if (deals.length === 0) {
        console.log('[cron] no deals -> reset after=null (end of list)');
        state.after = null;
        state.lastRunYMD = today;
        writeJson(STATE_PATH, state);
        break;
      }

      for (const d of deals) {
        if (Date.now() >= deadline) break;

        const dealId = String(d.id || d.properties?.hs_object_id);
        const name = d.properties?.dealname || dealId;

        // intento 1
        try {
          console.log(`\n[cron] -> ${name} (${dealId})`);
          await runPhasesForDeal({ dealId });
          ok++;
        } catch (e1) {
          // retry 1 vez
          console.warn(`[cron] retry once deal=${dealId}:`, e1?.message || e1);
          try {
            await runPhasesForDeal({ dealId });
            ok++;
          } catch (e2) {
            failed++;
            const msg = e2?.message || String(e2);
            console.error(`[cron] ❌ deal failed twice ${dealId}:`, msg);
            addFailed(dealId, msg);
          }
        }

        processed++;
        await sleep(DEAL_PAUSE_MS);
      }

      // Guardar cursor al terminar la página (o al cortarse por tiempo)
      state.after = nextAfter;
      state.lastRunYMD = today;
      writeJson(STATE_PATH, state);

      // Si no hay next, terminamos lista
      if (!nextAfter) {
        console.log('[cron] reached end of list -> after=null next run starts over');
        state.after = null;
        writeJson(STATE_PATH, state);
        break;
      }
    }

    console.log('\n[cron] done', { processed, ok, failed, savedAfter: readJson(STATE_PATH, {}).after });
    return { processed, ok, failed };
  } finally {
    releaseLock();
  }
}

// Ejecutar directo
if (import.meta.url === `file://${process.argv[1]}`) {
  runDealsBatchCron().then(() => process.exit(0)).catch(() => process.exit(1));
}
