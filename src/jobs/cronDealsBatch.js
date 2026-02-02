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








//////////////////////////////////////////////////////////////////////////////////////////



////////////////////////////////////////////////////////////
/*{
  "date": "2026-01-25",
  "items": [
    {
      "dealId": "54504601985",
      "reason": "Cannot read properties of undefined (reading 'id')",
      "at": "2026-01-25T04:08:19.646Z"
    },
    {
      "dealId": "54421044143",
      "reason": "Cannot read properties of undefined (reading 'id')",
      "at": "2026-01-25T04:08:19.863Z"
    },
    {
      "dealId": "54115153836",
      "reason": "Cannot read properties of undefined (reading 'id')",
      "at": "2026-01-25T04:08:20.078Z"
    },
    {
      "dealId": "51881724541",
      "reason": "Cannot read properties of undefined (reading 'id')",
      "at": "2026-01-25T04:08:20.289Z"
    },
    {
      "dealId": "38682629444",
      "reason": "Cannot read properties of undefined (reading 'id')",
      "at": "2026-01-25T04:08:20.507Z"
    },
    {
      "dealId": "50870553450",
      "reason": "Cannot read properties of undefined (reading 'id')",
      "at": "2026-01-25T04:08:20.725Z"
    }
  ]
}*/

///////////////////////////////////////////////
/*
{
  "after": null,
  "lastRunYMD": "2026-01-26"
}
*/

////////////////////////////////////


/////////////////////////////////









// src/cron/runDealsBatchCron.js
// Cron batch runner with MANUAL trigger and smart selection.
// - Weekdays: (1) billing_next_date==today AND auto=true
//             (2) billing_next_date>=today+30 AND auto!=true
//             (3) hs_lastmodifieddate in last N days
// - Weekend: FULL scan (all deals, excluding cancelled if configured)
// - Enforces: mirror suelto = SKIP, original runs mirror immediately
//
// Run examples:
//   node src/cron/runDealsBatchCron.js --once
//   node src/cron/runDealsBatchCron.js --once --mode weekday
//   node src/cron/runDealsBatchCron.js --once --mode weekend
//   node src/cron/runDealsBatchCron.js --deal 123456789
//
// Env (optional):
//   CRON_LOG_DIR=/data/logs
//   CRON_MAX_RUN_MS=21600000
//   CRON_PAGE_LIMIT=100
//   CRON_DEAL_PAUSE_MS=150
//   CRON_LOCK_TTL_MS=3600000
//   CRON_WEEKDAYS_LOOKBACK_DAYS=7
//   CANCELLED_STAGE_ID=...
//
// IMPORTANT: This file does NOT schedule itself. Use system cron/pm2 to call it.
// Manual mode is for testing.




































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

const LOG_DIR = process.env.CRON_LOG_DIR || "/data/logs";

const CANCELLED_STAGE_ID = process.env.CANCELLED_STAGE_ID || "";

const MAX_RUN_MS = Number(process.env.CRON_MAX_RUN_MS || 6 * 60 * 60 * 1000);
const PAGE_LIMIT = Number(process.env.CRON_PAGE_LIMIT || 100);
const DEAL_PAUSE_MS = Number(process.env.CRON_DEAL_PAUSE_MS || 150);
const LOCK_TTL_MS = Number(process.env.CRON_LOCK_TTL_MS || 60 * 60 * 1000);

const LOOKBACK_DAYS = Number(process.env.CRON_WEEKDAYS_LOOKBACK_DAYS || 7);

// Your deal properties (adjust if your portal uses different names)
const PROP_BILLING_NEXT_DATE = process.env.PROP_BILLING_NEXT_DATE || "billing_next_date";
const PROP_AUTO = process.env.PROP_AUTO || "facturacion_automatica"; // or "auto" if that's your real prop

// Mirror props (ajustado a tu portal real)
const PROP_IS_MIRROR = process.env.PROP_IS_MIRROR || "es_mirror_de_py";
const PROP_MIRROR_ID = process.env.PROP_MIRROR_ID || "deal_uy_mirror_id";
const PROP_ORIGINAL_ID = process.env.PROP_ORIGINAL_ID || "deal_py_origen_id";


// (Opcional: si querés conservar heurística UY, dejalo; pero NO lo uses para decidir mirror)
const PROP_UY_FLAG = process.env.PROP_UY_FLAG || "uy";
const PROP_COUNTRY = process.env.PROP_COUNTRY || "pais_operativo";


// Sorting
const SORTS = [
  { propertyName: "hs_lastmodifieddate", direction: "DESCENDING" },
];


// -------------------- Helpers --------------------
function ensureDir(p) {
  try { fs.mkdirSync(p, { recursive: true }); } catch {}
}
function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fallback; }
}
function writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), "utf8");
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function acquireLock({ ttlMs = LOCK_TTL_MS } = {}) {
  try {
    if (fs.existsSync(LOCK_PATH)) {
      const stat = fs.statSync(LOCK_PATH);
      const age = Date.now() - stat.mtimeMs;
      if (age > ttlMs) {
        console.warn(`[cron] stale lock (${Math.round(age / 1000)}s) -> removing`);
        try { fs.unlinkSync(LOCK_PATH); } catch {}
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
  try { fs.unlinkSync(LOCK_PATH); } catch {}
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
    console.warn("[cron] audit log append failed:", e?.message || e);
  }
}

function addFailed(dealId, reason) {
  const today = getTodayYMD();
  const data = readJson(FAILED_PATH, { date: today, items: [] });
  if (data.date !== today) writeJson(FAILED_PATH, { date: today, items: [] });

  const fresh = readJson(FAILED_PATH, { date: today, items: [] });
  fresh.items.push({ dealId: String(dealId), reason: String(reason), at: new Date().toISOString() });
  writeJson(FAILED_PATH, fresh);
}

// JS: 0=Sun..6=Sat
function defaultModeForToday() {
  const d = new Date().getDay();
  return (d === 0 || d === 6) ? "weekend" : "weekday";
}

// HubSpot hs_lastmodifieddate is epoch ms.
function lookbackMs(days) {
  return String(Date.now() - days * 24 * 60 * 60 * 1000);
}

// YYYY-MM-DD -> epoch ms at start of day UTC (good enough for filtering); your real YMD is TZ-based.
function ymdToMsUTC(ymd) {
  return String(Date.parse(`${ymd}T00:00:00.000Z`));
}
function addDaysYMD(ymd, days) {
  const d = new Date(`${ymd}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function parseBoolLoose(v) {
  if (v === true) return true;
  const s = String(v ?? "").trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes" || s === "si";
}

function isMirrorDealFromDeal(deal) {
  const p = deal?.properties || {};
  if (parseBoolLoose(p[PROP_IS_MIRROR])) return true;
  return Boolean(String(p[PROP_ORIGINAL_ID] || "").trim());
}



function getMirrorIdFromOriginalDeal(deal) {
  const p = deal?.properties || {};
  return String(p[PROP_MIRROR_ID] || "").trim();
}

// -------------------- Search Builders --------------------
// We do multiple searches for weekday mode and union them in-memory,
// prioritizing: modified desc; then we process in that order.

async function searchDeals({ after, limit, filters, properties, sorts }) {
  return await withRetry(() =>
    hubspotClient.crm.deals.searchApi.doSearch({
      filterGroups: [{ filters }],
      properties,
      sorts,
      limit,
      after: after || undefined,
    })
  );
}

function baseFiltersCancelled() {
  if (!CANCELLED_STAGE_ID) return [];
  return [{ propertyName: "dealstage", operator: "NEQ", value: String(CANCELLED_STAGE_ID) }];
}

function baseFiltersNoMirrors() {
  // Excluir mirrors desde el search
  return [{ propertyName: PROP_IS_MIRROR, operator: "NEQ", value: "true" }];
}

function weekdayFilters_set1_todayAutoTrue(todayYMD) {
  // billing_next_date == today AND auto == true
  return [
  ...baseFiltersCancelled(),
  ...baseFiltersNoMirrors(),
  { propertyName: PROP_BILLING_NEXT_DATE, operator: "EQ", value: String(todayYMD) },
];
}

function weekdayFilters_set2_30daysAutoNotTrue(todayPlus30YMD) {
  // billing_next_date >= today+30 AND auto != true (covers false/null/empty if stored as non-true)
  // Note: HubSpot doesn't have "NOT_EQ true" for boolean in all cases, but NEQ should work for strings.
return [
  ...baseFiltersCancelled(),
  ...baseFiltersNoMirrors(),
  { propertyName: PROP_BILLING_NEXT_DATE, operator: "GTE", value: String(todayPlus30YMD) },
];
}

function weekdayFilters_set3_modifiedLookback(days) {
return [
  ...baseFiltersCancelled(),
  ...baseFiltersNoMirrors(),
  { propertyName: "hs_lastmodifieddate", operator: "GTE", value: lookbackMs(days) },
];
}

function weekendFilters_full() {
return [
  ...baseFiltersCancelled(),
  ...baseFiltersNoMirrors(),
];
}

function dealPropsForSearch() {
  return [
    "dealname",
    "dealstage",
    "hs_object_id",
    "hs_lastmodifieddate",
    PROP_BILLING_NEXT_DATE,
    PROP_AUTO,

    // mirror props (las reales)
    PROP_IS_MIRROR,
    PROP_MIRROR_ID,
    PROP_ORIGINAL_ID,
  ];
}

// -------------------- Main Runner --------------------
export async function runDealsBatchCron({ modeOverride = null, onlyDealId = null, once = false, dry = false } = {}) {
  const start = Date.now();
  const deadline = start + MAX_RUN_MS;
  const today = getTodayYMD();
  const mode = modeOverride || defaultModeForToday();
  const todayPlus30 = addDaysYMD(today, 30);

  if (!acquireLock()) {
    console.warn("[cron] lock present -> skip");
    return { skipped: true };
  }

  let processed = 0, ok = 0, failed = 0, skippedMirror = 0, skippedNoLI = 0;

  // State includes cursors per mode AND per weekday-filter-set
  const state = readJson(STATE_PATH, {
    weekday: { after_s1: null, after_s2: null, after_s3: null },
    weekend: { after_full: null },
    lastRun: {},
  });

  appendAudit({
    at: new Date().toISOString(),
    type: "cron_start",
    mode,
    today,
    todayPlus30,
    maxRunMs: MAX_RUN_MS,
    pageLimit: PAGE_LIMIT,
    lookbackDays: LOOKBACK_DAYS,
    onlyDealId: onlyDealId || null,
    dry,
  });

  try {
    if (!CANCELLED_STAGE_ID) {
      console.warn("[cron] CANCELLED_STAGE_ID not set -> NO excluirá cancelados");
      appendAudit({ at: new Date().toISOString(), type: "warn", msg: "CANCELLED_STAGE_ID not set" });
    }

if (onlyDealId) {
  const dealId = String(onlyDealId); // ✅ define
  const { deal, lineItems } = await getDealWithLineItems(dealId);
  const name = deal?.properties?.dealname || dealId; // ✅ define

  if (!Array.isArray(lineItems) || lineItems.length === 0) {
    appendAudit({ at: new Date().toISOString(), type: "skip", reason: "no_line_items", dealId, dealname: name, mode });
    return { processed: 1, ok: 0, failed: 0, skippedNoLI: 1 };
  }

  if (isMirrorDealFromDeal(deal)) {
    appendAudit({ at: new Date().toISOString(), type: "skip", reason: "mirror_suelto_skip", dealId, dealname: name, mode });
    return { processed: 1, ok: 0, failed: 0, skippedMirror: 1 };
  }

  appendAudit({ at: new Date().toISOString(), type: "deal_start", dealId, dealname: name, mode });
  if (!dry) await runPhasesForDeal({ deal, lineItems });
  appendAudit({ at: new Date().toISOString(), type: "deal_ok", dealId, dealname: name, mode });

  // Mirror immediate
  const mirrorId = getMirrorIdFromOriginalDeal(deal);

  if (!mirrorId) {
    appendAudit({
      at: new Date().toISOString(),
      type: "info",
      msg: "original_sin_mirror_id",
      dealId,
      dealname: name,
      mode,
    });
  } else {
    try {
      const { deal: mDeal, lineItems: mLineItems } = await getDealWithLineItems(String(mirrorId));
      if (isMirrorDealFromDeal(mDeal) && Array.isArray(mLineItems) && mLineItems.length > 0) {
        appendAudit({ at: new Date().toISOString(), type: "mirror_start", originalDealId: dealId, mirrorDealId: String(mirrorId), mode });
        if (!dry) await runPhasesForDeal({ deal: mDeal, lineItems: mLineItems });
        appendAudit({ at: new Date().toISOString(), type: "mirror_ok", originalDealId: dealId, mirrorDealId: String(mirrorId), mode });
      } else {
        appendAudit({ at: new Date().toISOString(), type: "skip", reason: "mirror_not_valid_or_no_line_items", originalDealId: dealId, mirrorDealId: String(mirrorId), mode });
      }
    } catch (eMirror) {
      appendAudit({ at: new Date().toISOString(), type: "error", where: "mirror_run", originalDealId: dealId, mirrorDealId: String(mirrorId), msg: eMirror?.message || String(eMirror), mode });
    }
  }

  return { processed: 1, ok: 1, failed: 0 };
}


    // Iterator that yields candidate deal IDs in priority order, de-duped.
    // Weekday: union of (s1,s2,s3) pages, always sorting by hs_lastmodifieddate desc.
    // Weekend: full scan pages.
    const seen = new Set();

    async function* candidateDealsGenerator() {
      const props = dealPropsForSearch();

      if (mode === "weekend") {
        while (Date.now() < deadline) {
          const resp = await searchDeals({
            after: state.weekend.after_full,
            limit: PAGE_LIMIT,
            filters: weekendFilters_full(),
            properties: props,
            sorts: SORTS,
          });
          const deals = resp?.results || [];
          const nextAfter = resp?.paging?.next?.after || null;

          for (const d of deals) {
            const id = String(d.id || d.properties?.hs_object_id);
            if (!seen.has(id)) {
              seen.add(id);
              yield { id, summary: d };
            }
          }
          state.weekend.after_full = nextAfter;
          writeJson(STATE_PATH, state);
          if (!nextAfter || deals.length === 0) {
            state.weekend.after_full = null;
            writeJson(STATE_PATH, state);
            break;
          }
        }
        return;
      }

      // Weekday: fetch a page from each set, merge-sort by hs_lastmodifieddate (desc), yield.
      while (Date.now() < deadline) {
        const [r1, r2, r3] = await Promise.all([
          searchDeals({
            after: state.weekday.after_s1,
            limit: PAGE_LIMIT,
            filters: weekdayFilters_set1_todayAutoTrue(today),
            properties: props,
            sorts: SORTS,
          }),
          searchDeals({
            after: state.weekday.after_s2,
            limit: PAGE_LIMIT,
            filters: weekdayFilters_set2_30daysAutoNotTrue(todayPlus30),
            properties: props,
            sorts: SORTS,
          }),
          searchDeals({
            after: state.weekday.after_s3,
            limit: PAGE_LIMIT,
            filters: weekdayFilters_set3_modifiedLookback(LOOKBACK_DAYS),
            properties: props,
            sorts: SORTS,
          }),
        ]);

        const a1 = r1?.results || [];
        const a2 = r2?.results || [];
        const a3 = r3?.results || [];
        const merged = [...a1, ...a2, ...a3];

        if (merged.length === 0) {
          // reset cursors (end of all lists)
          state.weekday.after_s1 = null;
          state.weekday.after_s2 = null;
          state.weekday.after_s3 = null;
          writeJson(STATE_PATH, state);
          break;
        }

        // sort by lastmodified desc
        merged.sort((x, y) => {
          const ax = Number(x?.properties?.hs_lastmodifieddate || 0);
          const ay = Number(y?.properties?.hs_lastmodifieddate || 0);
          return ay - ax;
        });

        for (const d of merged) {
          const id = String(d.id || d.properties?.hs_object_id);
          if (seen.has(id)) continue;
          seen.add(id);
          yield { id, summary: d };
        }

        // advance cursors
        state.weekday.after_s1 = r1?.paging?.next?.after || null;
        state.weekday.after_s2 = r2?.paging?.next?.after || null;
        state.weekday.after_s3 = r3?.paging?.next?.after || null;
        writeJson(STATE_PATH, state);

        // if all cursors ended, stop
        if (!state.weekday.after_s1 && !state.weekday.after_s2 && !state.weekday.after_s3) {
          break;
        }
      }
    }

    for await (const item of candidateDealsGenerator()) {
      if (Date.now() >= deadline) break;

      const dealId = String(item.id);
      const name = item.summary?.properties?.dealname || dealId;

      try {
        const { deal, lineItems } = await getDealWithLineItems(dealId);

        if (!Array.isArray(lineItems) || lineItems.length === 0) {
          skippedNoLI++;
          processed++;
          appendAudit({ at: new Date().toISOString(), type: "skip", reason: "no_line_items", dealId, dealname: name, mode });
          await sleep(DEAL_PAUSE_MS);
          continue;
        }

        // Mirror suelto => SKIP
        if (isMirrorDealFromDeal(deal)) {
          skippedMirror++;
          processed++;
          appendAudit({
            at: new Date().toISOString(),
            type: "skip",
            reason: "mirror_suelto_skip",
            dealId,
            dealname: name,
            originalRef: String(deal?.properties?.[PROP_ORIGINAL_ID] || "").trim() || null,
            mode,
          });
          await sleep(DEAL_PAUSE_MS);
          continue;
        }

        appendAudit({ at: new Date().toISOString(), type: "deal_start", dealId, dealname: name, mode });

        if (!dry) await runPhasesForDeal({ deal, lineItems });

        ok++;
        processed++;
        appendAudit({ at: new Date().toISOString(), type: "deal_ok", dealId, dealname: name, mode });

        // Immediately run mirror if original points to one
const mirrorId = getMirrorIdFromOriginalDeal(deal);

if (!mirrorId) {
  appendAudit({
    at: new Date().toISOString(),
    type: "info",
    msg: "original_sin_mirror_id",
    dealId,
    dealname: name,
    mode,
  });
} else {
  try {
    const { deal: mDeal, lineItems: mLineItems } = await getDealWithLineItems(String(mirrorId));
    if (isMirrorDealFromDeal(mDeal) && Array.isArray(mLineItems) && mLineItems.length > 0) {
      appendAudit({ at: new Date().toISOString(), type: "mirror_start", originalDealId: dealId, mirrorDealId: String(mirrorId), mode });
      if (!dry) await runPhasesForDeal({ deal: mDeal, lineItems: mLineItems });
      appendAudit({ at: new Date().toISOString(), type: "mirror_ok", originalDealId: dealId, mirrorDealId: String(mirrorId), mode });
    } else {
      appendAudit({ at: new Date().toISOString(), type: "skip", reason: "mirror_not_valid_or_no_line_items", originalDealId: dealId, mirrorDealId: String(mirrorId), mode });
    }
  } catch (eMirror) {
    appendAudit({ at: new Date().toISOString(), type: "error", where: "mirror_run", originalDealId: dealId, mirrorDealId: String(mirrorId), msg: eMirror?.message || String(eMirror), mode });
  }
}


      } catch (e1) {
        // retry once
        try {
          appendAudit({ at: new Date().toISOString(), type: "warn", where: "deal_run", dealId, dealname: name, msg: `retry_once: ${e1?.message || String(e1)}`, mode });
          const { deal, lineItems } = await getDealWithLineItems(dealId);

          if (!Array.isArray(lineItems) || lineItems.length === 0) {
            skippedNoLI++;
            processed++;
            appendAudit({ at: new Date().toISOString(), type: "skip", reason: "no_line_items_after_retry", dealId, dealname: name, mode });
            await sleep(DEAL_PAUSE_MS);
            continue;
          }
          if (isMirrorDealFromDeal(deal)) {
            skippedMirror++;
            processed++;
            appendAudit({ at: new Date().toISOString(), type: "skip", reason: "mirror_suelto_skip_after_retry", dealId, dealname: name, mode });
            await sleep(DEAL_PAUSE_MS);
            continue;
          }

          if (!dry) await runPhasesForDeal({ deal, lineItems });

          ok++;
          processed++;
          appendAudit({ at: new Date().toISOString(), type: "deal_ok_after_retry", dealId, dealname: name, mode });
        } catch (e2) {
          failed++;
          processed++;
          const msg = e2?.message || String(e2);
          addFailed(dealId, msg);
          appendAudit({ at: new Date().toISOString(), type: "error", where: "deal_failed_twice", dealId, dealname: name, msg, mode });
        }
      }

      await sleep(DEAL_PAUSE_MS);
      if (once) break;
    }

    appendAudit({
      at: new Date().toISOString(),
      type: "cron_done",
      mode,
      processed,
      ok,
      failed,
      skippedMirror,
      skippedNoLI,
      stateSnapshot: state,
    });

    console.log("[cron] done", { mode, processed, ok, failed, skippedMirror, skippedNoLI });
    return { mode, processed, ok, failed, skippedMirror, skippedNoLI };
  } finally {
    releaseLock();
  }
}

// -------------------- CLI --------------------
function parseArgs(argv) {
  const args = { once: false, mode: null, deal: null, dry: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--once") args.once = true;
    else if (a === "--dry") args.dry = true;
    else if (a === "--mode") args.mode = argv[i + 1] || null, i++;
    else if (a === "--deal") args.deal = argv[i + 1] || null, i++;
  }
  return args;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { once, mode, deal, dry } = parseArgs(process.argv.slice(2));
  runDealsBatchCron({
    modeOverride: mode,
    onlyDealId: deal,
    once,
    dry,
  })
    .then(() => process.exit(0))
    .catch((e) => {
      console.error("[cron] fatal:", e?.message || e);
      process.exit(1);
    });
}
