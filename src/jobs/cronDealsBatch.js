/*import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { hubspotClient, getDealWithLineItems } from '../hubspotClient.js';
import { getTodayYMD } from '../utils/dateUtils.js';
import { runPhasesForDeal } from '../phases/index.js';

const STATE_PATH =
  process.env.CRON_STATE_PATH ||
  path.resolve(process.cwd(), 'cron_state_deals.json');

const FAILED_PATH =
  process.env.CRON_FAILED_PATH ||
  path.resolve(process.cwd(), 'cron_failed_deals.json');

const LOCK_PATH =
  process.env.CRON_LOCK_PATH ||
  path.resolve(process.cwd(), 'cron_state_deals.lock');

const CANCELLED_STAGE_ID = process.env.CANCELLED_STAGE_ID; // dealstage cancelado (value exacto)

// “presupuesto” de corrida (ej 25 min) para no pisarse con el cron de 30 min
const MAX_RUN_MS = Number(process.env.CRON_MAX_RUN_MS || 25 * 60 * 1000);

// límite por página de search (HubSpot permite 100)
const PAGE_LIMIT = Number(process.env.CRON_PAGE_LIMIT || 100);

// micro pausa para no golpear HubSpot
const DEAL_PAUSE_MS = Number(process.env.CRON_DEAL_PAUSE_MS || 150);

// ✅ TTL del lock: si el proceso murió, no queda bloqueado para siempre
const LOCK_TTL_MS = Number(process.env.CRON_LOCK_TTL_MS || 60 * 60 * 1000);

function readJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
}

function acquireLock({ ttlMs = LOCK_TTL_MS } = {}) {
  try {
    // si existe lock, revisar edad
    if (fs.existsSync(LOCK_PATH)) {
      const stat = fs.statSync(LOCK_PATH);
      const age = Date.now() - stat.mtimeMs;

      if (age > ttlMs) {
        console.warn(
          `[cron] stale lock (${Math.round(age / 1000)}s) -> removing`
        );
        try {
          fs.unlinkSync(LOCK_PATH);
        } catch {}
      } else {
        return false;
      }
    }

    fs.writeFileSync(LOCK_PATH, String(Date.now()), { flag: 'wx' });
    return true;
  } catch {
    return false;
  }
}

function releaseLock() {
  try {
    fs.unlinkSync(LOCK_PATH);
  } catch {}
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

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
      console.warn(
        `[cron] retryable error (status=${status}) attempt=${attempt}/${maxRetries}: ${msg} -> wait ${backoffMs}ms`
      );
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
  fresh.items.push({
    dealId: String(dealId),
    reason: String(reason),
    at: new Date().toISOString(),
  });
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
    // Con "más recientes primero" puede re-procesar algunos, pero garantiza priorizar los últimos cambios.
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

    console.log('[cron] start', {
      today,
      after: state.after,
      maxRunMs: MAX_RUN_MS,
      pageLimit: PAGE_LIMIT,
      sort: '-hs_lastmodifieddate',
    });

    // Mientras haya tiempo, ir pidiendo páginas y procesando
    while (Date.now() < deadline) {
      const resp = await withRetry(() =>
        hubspotClient.crm.deals.searchApi.doSearch({
          filterGroups: [
            {
              filters: CANCELLED_STAGE_ID
                ? [
                    {
                      propertyName: 'dealstage',
                      operator: 'NEQ',
                      value: String(CANCELLED_STAGE_ID),
                    },
                  ]
                : [],
            },
          ],
          // ✅ incluimos hs_lastmodifieddate para ordenar y para debug si querés
          properties: ['dealname', 'dealstage', 'hs_object_id', 'hs_lastmodifieddate'],
          // ✅ más recientes primero
          sorts: ['-hs_lastmodifieddate'],
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
          const { deal, lineItems } = await getDealWithLineItems(dealId);
          await runPhasesForDeal({ deal, lineItems });
          ok++;
        } catch (e1) {
          // retry 1 vez
          console.warn(`[cron] retry once deal=${dealId}:`, e1?.message || e1);
          try {
            const { deal, lineItems } = await getDealWithLineItems(dealId);
            await runPhasesForDeal({ deal, lineItems });
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

    console.log('\n[cron] done', {
      processed,
      ok,
      failed,
      savedAfter: readJson(STATE_PATH, {}).after,
    });

    return { processed, ok, failed };
  } finally {
    releaseLock();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runDealsBatchCron()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}
*/



// src/cron/runDealsBatchCron.js
// Cron batch runner (Weekdays = last N days, Weekend = full scan)
// Enforces: mirror suelto = SKIP, original corre mirror inmediatamente después.
//
// Reqs: your existing modules:
// - hubspotClient, getDealWithLineItems from ../hubspotClient.js
// - runPhasesForDeal from ../phases/index.js
// - getTodayYMD from ../utils/dateUtils.js (YMD in your billing TZ utils)

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { hubspotClient, getDealWithLineItems } from "../hubspotClient.js";
import { getTodayYMD } from "../utils/dateUtils.js";
import { runPhasesForDeal } from "../phases/index.js";

// -------------------- Paths / Config --------------------
const STATE_PATH =
  process.env.CRON_STATE_PATH ||
  path.resolve(process.cwd(), "cron_state_deals.json");

const FAILED_PATH =
  process.env.CRON_FAILED_PATH ||
  path.resolve(process.cwd(), "cron_failed_deals.json");

const LOCK_PATH =
  process.env.CRON_LOCK_PATH ||
  path.resolve(process.cwd(), "cron_state_deals.lock");

// Where audit logs are written
const LOG_DIR = process.env.CRON_LOG_DIR || "/data/logs";

// Dealstage to exclude (exact value)
const CANCELLED_STAGE_ID = process.env.CANCELLED_STAGE_ID || "";

// Runtime budget (ms)
const MAX_RUN_MS = Number(process.env.CRON_MAX_RUN_MS || 6 * 60 * 60 * 1000); // default 6h

// HubSpot search limit (<=100)
const PAGE_LIMIT = Number(process.env.CRON_PAGE_LIMIT || 100);

// Small pause between deals
const DEAL_PAUSE_MS = Number(process.env.CRON_DEAL_PAUSE_MS || 150);

// Lock TTL
const LOCK_TTL_MS = Number(process.env.CRON_LOCK_TTL_MS || 60 * 60 * 1000);

// Weekdays lookback days for hs_lastmodifieddate filter
const LOOKBACK_DAYS = Number(process.env.CRON_WEEKDAYS_LOOKBACK_DAYS || 7);

// Sorting
const SORTS = ["-hs_lastmodifieddate"];

// -------------------- Helpers --------------------
function ensureDir(p) {
  try {
    fs.mkdirSync(p, { recursive: true });
  } catch {}
}

function readJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), "utf8");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function acquireLock({ ttlMs = LOCK_TTL_MS } = {}) {
  try {
    if (fs.existsSync(LOCK_PATH)) {
      const stat = fs.statSync(LOCK_PATH);
      const age = Date.now() - stat.mtimeMs;
      if (age > ttlMs) {
        console.warn(`[cron] stale lock (${Math.round(age / 1000)}s) -> removing`);
        try {
          fs.unlinkSync(LOCK_PATH);
        } catch {}
      } else {
        return false;
      }
    }
    fs.writeFileSync(LOCK_PATH, String(Date.now()), { flag: "wx" });
    return true;
  } catch {
    return false;
  }
}

function releaseLock() {
  try {
    fs.unlinkSync(LOCK_PATH);
  } catch {}
}

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
      console.warn(
        `[cron] retryable error (status=${status}) attempt=${attempt}/${maxRetries}: ${msg} -> wait ${backoffMs}ms`
      );
      await sleep(backoffMs);
    }
  }
}

function appendAudit(event) {
  try {
    ensureDir(LOG_DIR);
    const ymd = getTodayYMD();
    const file = path.join(LOG_DIR, `cron_deals_${ymd}.log.jsonl`);
    fs.appendFileSync(file, JSON.stringify(event) + "\n", "utf8");
  } catch (e) {
    // last resort: don't crash cron due to logging issues
    console.warn("[cron] audit log append failed:", e?.message || e);
  }
}

function addFailed(dealId, reason) {
  const today = getTodayYMD();
  const data = readJson(FAILED_PATH, { date: today, items: [] });
  if (data.date !== today) {
    writeJson(FAILED_PATH, { date: today, items: [] });
  }
  const fresh = readJson(FAILED_PATH, { date: today, items: [] });
  fresh.items.push({
    dealId: String(dealId),
    reason: String(reason),
    at: new Date().toISOString(),
  });
  writeJson(FAILED_PATH, fresh);
}

// Weekdays: Mon-Fri. Weekend: Sat-Sun.
// Note: JS getDay(): 0=Sun .. 6=Sat
function getModeForToday() {
  const d = new Date().getDay();
  if (d === 0 || d === 6) return "weekend"; // Sun/Sat
  return "weekday";
}

// HubSpot hs_lastmodifieddate is ms epoch.
function getLookbackTimestampMs(days) {
  const ms = Date.now() - days * 24 * 60 * 60 * 1000;
  return String(ms);
}

// -------------------- Mirror Detection --------------------
// Mirror suelto = skip.
// Original -> run mirror immediately after (if mirror id known).
//
// Because property names may vary, we try a small set of likely fields.
// You can adjust these names to match your portal.

function parseBoolLoose(v) {
  if (v === true) return true;
  const s = String(v ?? "").trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes" || s === "si";
}

function getMirrorOriginalIdFromProps(p = {}) {
  // mirror deal typically stores the original PY deal id
  return (
    p.of_py_origen_deal_id ||
    p.of_deal_py_origen_id ||
    p.of_original_deal_id ||
    p.py_origen_deal_id ||
    ""
  );
}

function getMirrorIdFromOriginalProps(p = {}) {
  // original deal storing the UY mirror id
  return (
    p.of_mirror_deal_id ||
    p.of_uy_mirror_deal_id ||
    p.of_deal_mirror_id ||
    p.uy_mirror_deal_id ||
    ""
  );
}

function isMirrorDeal(deal) {
  const p = deal?.properties || {};
  const uyFlag = parseBoolLoose(p.uy) || String(p.pais_operativo || "").toLowerCase() === "uruguay";
  const hasOriginalRef = Boolean(getMirrorOriginalIdFromProps(p));
  // Conservative: only treat as mirror if uyFlag AND hasOriginalRef (prevents false positives)
  return Boolean(uyFlag && hasOriginalRef);
}

// -------------------- Main --------------------
export async function runDealsBatchCron() {
  const start = Date.now();
  const deadline = start + MAX_RUN_MS;
  const today = getTodayYMD();
  const mode = getModeForToday();

  if (!acquireLock()) {
    console.warn("[cron] lock present -> skip");
    return { skipped: true };
  }

  let processed = 0;
  let ok = 0;
  let failed = 0;
  let skippedMirror = 0;

  // Store cursor separately for weekday/weekend runs
  const state = readJson(STATE_PATH, {
    after_weekday: null,
    after_weekend: null,
    // optional: lastRun fields (informational)
    lastRunYMD_weekday: null,
    lastRunYMD_weekend: null,
  });

  const stateKeyAfter = mode === "weekend" ? "after_weekend" : "after_weekday";
  const stateKeyLast = mode === "weekend" ? "lastRunYMD_weekend" : "lastRunYMD_weekday";

  appendAudit({
    at: new Date().toISOString(),
    type: "cron_start",
    mode,
    today,
    maxRunMs: MAX_RUN_MS,
    pageLimit: PAGE_LIMIT,
    lookbackDays: mode === "weekday" ? LOOKBACK_DAYS : null,
    after: state[stateKeyAfter],
  });

  try {
    if (!CANCELLED_STAGE_ID) {
      console.warn("[cron] CANCELLED_STAGE_ID not set -> NO excluirá cancelados");
      appendAudit({
        at: new Date().toISOString(),
        type: "warn",
        msg: "CANCELLED_STAGE_ID not set; cancelled deals not excluded",
      });
    }

    // Build filter groups
    const baseFilters = [];
    if (CANCELLED_STAGE_ID) {
      baseFilters.push({
        propertyName: "dealstage",
        operator: "NEQ",
        value: String(CANCELLED_STAGE_ID),
      });
    }

    // Weekdays filter by last modified >= now - N days
    const weekdayFilters =
      mode === "weekday"
        ? [
            {
              propertyName: "hs_lastmodifieddate",
              operator: "GTE",
              value: getLookbackTimestampMs(LOOKBACK_DAYS),
            },
          ]
        : [];

    // We search deals; we then fetch deal+lineItems. If a deal has no line items, we skip quickly.
    while (Date.now() < deadline) {
      const resp = await withRetry(() =>
        hubspotClient.crm.deals.searchApi.doSearch({
          filterGroups: [
            {
              filters: [...baseFilters, ...weekdayFilters],
            },
          ],
          properties: [
            "dealname",
            "dealstage",
            "hs_object_id",
            "hs_lastmodifieddate",
            // Mirror-related props we might need without refetch (optional)
            "uy",
            "pais_operativo",
            "of_mirror_deal_id",
            "of_uy_mirror_deal_id",
            "of_deal_mirror_id",
            "uy_mirror_deal_id",
            "of_py_origen_deal_id",
            "of_deal_py_origen_id",
            "of_original_deal_id",
            "py_origen_deal_id",
          ],
          sorts: SORTS,
          limit: PAGE_LIMIT,
          after: state[stateKeyAfter] || undefined,
        })
      );

      const deals = resp?.results || [];
      const nextAfter = resp?.paging?.next?.after || null;

      if (deals.length === 0) {
        // End of list: reset cursor for this mode
        state[stateKeyAfter] = null;
        state[stateKeyLast] = today;
        writeJson(STATE_PATH, state);

        appendAudit({
          at: new Date().toISOString(),
          type: "cron_end_of_list",
          mode,
        });
        break;
      }

      for (const d of deals) {
        if (Date.now() >= deadline) break;

        const dealId = String(d.id || d.properties?.hs_object_id);
        const name = d.properties?.dealname || dealId;

        // Fetch full deal + line items
        try {
          const { deal, lineItems } = await getDealWithLineItems(dealId);

          // Skip deals without line items (keeps full scan safe)
          if (!Array.isArray(lineItems) || lineItems.length === 0) {
            processed++;
            appendAudit({
              at: new Date().toISOString(),
              type: "skip",
              reason: "no_line_items",
              dealId,
              dealname: name,
              mode,
            });
            await sleep(DEAL_PAUSE_MS);
            continue;
          }

          // Mirror suelto => SKIP
          if (isMirrorDeal(deal)) {
            skippedMirror++;
            processed++;
            appendAudit({
              at: new Date().toISOString(),
              type: "skip",
              reason: "mirror_suelto_skip",
              dealId,
              dealname: name,
              originalRef: getMirrorOriginalIdFromProps(deal.properties || {}) || null,
              mode,
            });
            await sleep(DEAL_PAUSE_MS);
            continue;
          }

          // Run original
          appendAudit({
            at: new Date().toISOString(),
            type: "deal_start",
            dealId,
            dealname: name,
            mode,
          });

          await runPhasesForDeal({ deal, lineItems });
          ok++;
          processed++;

          appendAudit({
            at: new Date().toISOString(),
            type: "deal_ok",
            dealId,
            dealname: name,
            mode,
          });

          // Immediately run mirror if original points to one
          const mirrorId = String(getMirrorIdFromOriginalProps(deal.properties || "") || "").trim();
          if (mirrorId) {
            try {
              const { deal: mDeal, lineItems: mLineItems } = await getDealWithLineItems(mirrorId);

              // Only run if it truly looks like mirror (defensive)
              if (isMirrorDeal(mDeal) && Array.isArray(mLineItems) && mLineItems.length > 0) {
                appendAudit({
                  at: new Date().toISOString(),
                  type: "mirror_start",
                  originalDealId: dealId,
                  mirrorDealId: mirrorId,
                  mode,
                });

                await runPhasesForDeal({ deal: mDeal, lineItems: mLineItems });

                appendAudit({
                  at: new Date().toISOString(),
                  type: "mirror_ok",
                  originalDealId: dealId,
                  mirrorDealId: mirrorId,
                  mode,
                });
              } else {
                appendAudit({
                  at: new Date().toISOString(),
                  type: "skip",
                  reason: "mirror_not_valid_or_no_line_items",
                  originalDealId: dealId,
                  mirrorDealId: mirrorId,
                  mode,
                });
              }
            } catch (eMirror) {
              appendAudit({
                at: new Date().toISOString(),
                type: "error",
                where: "mirror_run",
                originalDealId: dealId,
                mirrorDealId: mirrorId,
                msg: eMirror?.message || String(eMirror),
                mode,
              });
              // mirror failure shouldn't stop the whole cron
            }
          }

        } catch (e1) {
          // Retry once
          try {
            appendAudit({
              at: new Date().toISOString(),
              type: "warn",
              where: "deal_run",
              dealId,
              dealname: name,
              msg: `retry_once: ${e1?.message || String(e1)}`,
              mode,
            });

            const { deal, lineItems } = await getDealWithLineItems(dealId);

            if (!Array.isArray(lineItems) || lineItems.length === 0) {
              processed++;
              appendAudit({
                at: new Date().toISOString(),
                type: "skip",
                reason: "no_line_items_after_retry",
                dealId,
                dealname: name,
                mode,
              });
              await sleep(DEAL_PAUSE_MS);
              continue;
            }

            if (isMirrorDeal(deal)) {
              skippedMirror++;
              processed++;
              appendAudit({
                at: new Date().toISOString(),
                type: "skip",
                reason: "mirror_suelto_skip_after_retry",
                dealId,
                dealname: name,
                mode,
              });
              await sleep(DEAL_PAUSE_MS);
              continue;
            }

            await runPhasesForDeal({ deal, lineItems });
            ok++;
            processed++;

            appendAudit({
              at: new Date().toISOString(),
              type: "deal_ok_after_retry",
              dealId,
              dealname: name,
              mode,
            });
          } catch (e2) {
            failed++;
            processed++;
            const msg = e2?.message || String(e2);
            addFailed(dealId, msg);
            appendAudit({
              at: new Date().toISOString(),
              type: "error",
              where: "deal_failed_twice",
              dealId,
              dealname: name,
              msg,
              mode,
            });
          }
        }

        await sleep(DEAL_PAUSE_MS);
      }

      // Save cursor after each page
      state[stateKeyAfter] = nextAfter;
      state[stateKeyLast] = today;
      writeJson(STATE_PATH, state);

      if (!nextAfter) {
        // End of list, reset for next run
        state[stateKeyAfter] = null;
        writeJson(STATE_PATH, state);
        appendAudit({
          at: new Date().toISOString(),
          type: "cron_end_of_list",
          mode,
        });
        break;
      }
    }

    appendAudit({
      at: new Date().toISOString(),
      type: "cron_done",
      mode,
      processed,
      ok,
      failed,
      skippedMirror,
      savedAfter: readJson(STATE_PATH, {})[stateKeyAfter],
    });

    console.log("[cron] done", { mode, processed, ok, failed, skippedMirror });
    return { mode, processed, ok, failed, skippedMirror };
  } finally {
    releaseLock();
  }
}

// Allow running directly: node src/cron/runDealsBatchCron.js
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runDealsBatchCron()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error("[cron] fatal:", e?.message || e);
      process.exit(1);
    });
}
