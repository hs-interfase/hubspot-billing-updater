import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { hubspotClient, getDealWithLineItems } from "../hubspotClient.js";
import { getTodayYMD } from "../utils/dateUtils.js";
import { runPhasesForDeal } from "../phases/index.js";
import { flushHubSpotErrors } from "../utils/hubspotErrorCollector.js";
import crypto from "node:crypto";
import { sendSummary, pingHeartbeat } from '../../lib/alertService.js'
import logger from "../../lib/logger.js";
import pool, { initCronStateTable, getCronState, setCronState, initCronFailuresTable, insertCronFailure } from "../db.js";
import {
  FORECAST_MANUAL_STAGES,
} from '../config/constants.js';

// -------------------- Paths / Config --------------------
// const STATE_PATH =
//  process.env.CRON_WEEKEND_STATE_PATH ||
//  path.resolve(process.cwd(), "cron_state_weekend.json");

const FAILED_PATH =
  process.env.CRON_WEEKEND_FAILED_PATH ||
  path.resolve(process.cwd(), "cron_failed_weekend.json");

const LOCK_PATH =
  process.env.CRON_WEEKEND_LOCK_PATH ||
  path.resolve(process.cwd(), "cron_weekend.lock");

const LOG_DIR = process.env.CRON_LOG_DIR || "/data/logs";

const CANCELLED_STAGE_ID = process.env.CANCELLED_STAGE_ID || "";

const MAX_RUN_MS = Number(process.env.CRON_MAX_RUN_MS || 6 * 60 * 60 * 1000);
const PAGE_LIMIT = Number(process.env.CRON_PAGE_LIMIT || 100);
const DEAL_PAUSE_MS = Number(process.env.CRON_DEAL_PAUSE_MS || 150);
const LOCK_TTL_MS = Number(process.env.CRON_LOCK_TTL_MS || 60 * 60 * 1000);

const PROP_BILLING_NEXT_DATE = process.env.PROP_BILLING_NEXT_DATE || "billing_next_date";
const PROP_AUTO = process.env.PROP_AUTO || "facturacion_automatica";

const PROP_IS_MIRROR = process.env.PROP_IS_MIRROR || "es_mirror_de_py";
const PROP_MIRROR_ID = process.env.PROP_MIRROR_ID || "deal_uy_mirror_id";
const PROP_ORIGINAL_ID = process.env.PROP_ORIGINAL_ID || "deal_py_origen_id";

const SORTS = [
  { propertyName: "hs_object_id", direction: "ASCENDING" },
];

let lastCtx = {
  where: null,
  dealId: null,
  mirrorId: null,
  ticketId: null,
  lineItemId: null,
  lineItemKey: null,
};

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
        const lockAgeSec = Math.round(age / 1000);
        logger.warn(
          { lockAgeSec, lockPath: LOCK_PATH, ttlMs },
          "Stale lock detected -> removing"
        );
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
      logger.warn(
        { status, attempt, maxRetries, backoffMs },
        `[cronWeekend] retryable error (status=${status}) attempt=${attempt}/${maxRetries}: ${msg} -> wait ${backoffMs}ms`
      );
      await sleep(backoffMs);
    }
  }
}

function appendAudit(event) {
  try {
    ensureDir(LOG_DIR);
    const ymd = getTodayYMD();
    const file = path.join(LOG_DIR, `cron_weekend_${ymd}.log.jsonl`);
    fs.appendFileSync(file, JSON.stringify(event) + "\n", "utf8");
  } catch (e) {
    const errMsg = e?.message || e;
    logger.warn({ errMsg }, "[cronWeekend] audit log append failed");
  }
}

async function addFailed(dealId, reason, context = {}) {
  try {
    const today = getTodayYMD()
    const data = readJson(FAILED_PATH, { date: today, items: [] })
    if (data.date !== today) writeJson(FAILED_PATH, { date: today, items: [] })
    const fresh = readJson(FAILED_PATH, { date: today, items: [] })
    fresh.items.push({ dealId: String(dealId), reason: String(reason), at: new Date().toISOString() })
    writeJson(FAILED_PATH, fresh)
  } catch (e) {
    logger.warn({ err: e?.message }, '[cronWeekend] addFailed: escritura en archivo falló')
  }
  await insertCronFailure({
    jobName: 'cronWeekendFull',
    dealId: String(dealId),
    errorMsg: String(reason),
    context,
  })
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

async function searchOverdueForecasts({ after, limit }) {
  const todayMs = String(Date.now());
  const stages = [...FORECAST_MANUAL_STAGES];
  return await withRetry(() =>
    hubspotClient.crm.tickets.searchApi.doSearch({
      filterGroups: stages.map(stageId => ({
        filters: [
          { propertyName: 'hs_pipeline_stage', operator: 'EQ', value: stageId },
          { propertyName: 'fecha_resolucion_esperada', operator: 'LTE', value: todayMs },
        ],
      })),
      properties: ['hs_pipeline_stage', 'of_deal_id', 'fecha_resolucion_esperada', 'of_ticket_key'],
      sorts: [{ propertyName: 'fecha_resolucion_esperada', direction: 'ASCENDING' }],
      limit,
      after: after || undefined,
    })
  );
}

function baseFiltersCancelled() {
  if (!CANCELLED_STAGE_ID) return [];
  return [{ propertyName: "dealstage", operator: "NEQ", value: String(CANCELLED_STAGE_ID) }];
}

// Sin baseFiltersNoMirrors() — NEQ no funciona con campos vacíos en HubSpot.
// Los mirrors se skipean en memoria via isMirrorDealFromDeal().
function weekendFilters_full({ afterId = null } = {}) {
  return [
    ...baseFiltersCancelled(),
    ...(afterId ? [{ propertyName: "hs_object_id", operator: "GT", value: String(afterId) }] : []),
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
    PROP_IS_MIRROR,
    PROP_MIRROR_ID,
    PROP_ORIGINAL_ID,
  ];
}

// -------------------- Main Runner --------------------
export async function runWeekendFullCron({ onlyDealId = null, once = false, dry = false } = {}) {
  const mode = "weekend";
  const start = Date.now();
  const deadline = start + MAX_RUN_MS;
  const today = getTodayYMD();
  const jobRunId = crypto.randomUUID();
  logger.info({ jobRunId }, "[cronWeekend] Cron started");
  lastCtx = { ...lastCtx, where: "runWeekendFullCron.start", dealId: null, mirrorId: null };

  if (!acquireLock()) {
    logger.warn({ jobRunId, mode, reason: "lock_present" }, "[cronWeekend] Cron skipped (lock present)");
    return { skipped: true };
  }

  let processed = 0, ok = 0, failed = 0, skippedMirror = 0, skippedNoLI = 0;

 await initCronStateTable();
await initCronFailuresTable();

  appendAudit({
    at: new Date().toISOString(),
    type: "cron_start",
    mode,
    today,
    maxRunMs: MAX_RUN_MS,
    pageLimit: PAGE_LIMIT,
    onlyDealId: onlyDealId || null,
    dry,
  });

  try {
    if (!CANCELLED_STAGE_ID) {
      logger.warn("[cronWeekend] CANCELLED_STAGE_ID not set -> NO excluirá cancelados");
      appendAudit({ at: new Date().toISOString(), type: "warn", msg: "CANCELLED_STAGE_ID not set" });
    }

    // ---- Modo onlyDealId (debug/manual) ----
    if (onlyDealId) {
      const dealId = String(onlyDealId);
      lastCtx = { ...lastCtx, where: "onlyDealId.getDealWithLineItems", dealId, mirrorId: null };
      const { deal, lineItems } = await getDealWithLineItems(dealId);
      const name = deal?.properties?.dealname || dealId;

      if (!Array.isArray(lineItems) || lineItems.length === 0) {
        appendAudit({ at: new Date().toISOString(), type: "skip", reason: "no_line_items", dealId, dealname: name, mode });
        return { processed: 1, ok: 0, failed: 0, skippedNoLI: 1 };
      }
      if (isMirrorDealFromDeal(deal)) {
        appendAudit({ at: new Date().toISOString(), type: "skip", reason: "mirror_suelto_skip", dealId, dealname: name, mode });
        return { processed: 1, ok: 0, failed: 0, skippedMirror: 1 };
      }

      appendAudit({ at: new Date().toISOString(), type: "deal_start", dealId, dealname: name, mode });
      lastCtx = { ...lastCtx, where: "onlyDealId.runPhasesForDeal", dealId };
      if (!dry) await runPhasesForDeal({ deal, lineItems });
      appendAudit({ at: new Date().toISOString(), type: "deal_ok", dealId, dealname: name, mode });

      const mirrorId = getMirrorIdFromOriginalDeal(deal);
      if (!mirrorId) {
        appendAudit({ at: new Date().toISOString(), type: "info", msg: "original_sin_mirror_id", dealId, dealname: name, mode });
      } else {
        try {
          lastCtx = { ...lastCtx, where: "onlyDealId.mirror.getDealWithLineItems", dealId, mirrorId: String(mirrorId) };
          const { deal: mDeal, lineItems: mLineItems } = await getDealWithLineItems(String(mirrorId));
          if (isMirrorDealFromDeal(mDeal) && Array.isArray(mLineItems) && mLineItems.length > 0) {
            appendAudit({ at: new Date().toISOString(), type: "mirror_start", originalDealId: dealId, mirrorDealId: String(mirrorId), mode });
            lastCtx = { ...lastCtx, where: "onlyDealId.mirror.runPhasesForDeal", dealId, mirrorId: String(mirrorId) };
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

    // ---- Generator: full scan + overdue forecasts ----
    const seen = new Set();
    let lastIdFull = await getCronState('weekend_last_id_full');
    if (fullScanDoneDate === today) {
      logger.info({ today }, "[cronWeekend] full_scan already done today, skipping");
      appendAudit({ at: new Date().toISOString(), type: "skip", reason: "full_scan_already_done_today", today });
      return { mode, processed: 0, ok: 0, failed: 0, skippedMirror: 0, skippedNoLI: 0 };
    }
    let afterS4    = await getCronState('weekend_after_s4');


    async function* candidateDealsGenerator() {
      const props = dealPropsForSearch();

      // Full scan de deals
while (Date.now() < deadline) {
  const resp = await searchDeals({
    after: undefined,
    limit: PAGE_LIMIT,
    filters: weekendFilters_full({ afterId: lastIdFull }),
    properties: props,
    sorts: SORTS,
  });

  const deals = resp?.results || [];
  const pageLastId = deals.length > 0
    ? String(Math.max(...deals.map(d => Number(d.id || d.properties?.hs_object_id))))
    : null;

  logger.info({
    total: resp?.total,
    results: deals.length,
    lastIdFull,
    pageLastId,
  }, "[cronWeekend] search_page");

  for (const d of deals) {
    const id = String(d.id || d.properties?.hs_object_id);
    if (!seen.has(id)) {
      seen.add(id);
      yield { id, summary: d };
    }
  }

  if (deals.length === 0) {
    lastIdFull = null;
    await setCronState('weekend_last_id_full', null);
    await setCronState('weekend_full_scan_done_date', today); 
    logger.info({ totalSeenAfterFullScan: seen.size }, "[cronWeekend] full_scan_done"); // ← acá
    break;
  }

  lastIdFull = pageLastId;
  await setCronState('weekend_last_id_full', lastIdFull);
  await sleep(500);
}

      // S4: tickets forecast manuales con fecha_resolucion_esperada vencida
      while (Date.now() < deadline) {
        try {
          const r4 = await searchOverdueForecasts({ after: afterS4, limit: PAGE_LIMIT });
          for (const t of r4?.results || []) {
            const dealId = String(t?.properties?.of_deal_id || '').trim();
            if (!dealId || seen.has(dealId)) continue;
            seen.add(dealId);
            yield { id: dealId, summary: null };
          }
          afterS4 = r4?.paging?.next?.after || null;
          await setCronState('weekend_after_s4', afterS4);

          if (!afterS4 || (r4?.results || []).length === 0) {
            afterS4 = null;
            await setCronState('weekend_after_s4', null);
            break;
          }
        } catch (e4) {
          appendAudit({
            at: new Date().toISOString(),
            type: 'error',
            where: 'candidateDealsGenerator.s4_overdue_forecasts',
            msg: e4?.message || String(e4),
            status: e4?.code || e4?.statusCode || e4?.response?.status || null,
          });
          break;
        }
      }
    }

    // ---- Loop principal ----
    for await (const item of candidateDealsGenerator()) {
      if (Date.now() >= deadline) break;

      const dealId = String(item.id);
      const name = item.summary?.properties?.dealname || dealId;

      try {
        lastCtx = { ...lastCtx, where: "processDeal.start", dealId, mirrorId: null };
        logger.info({ dealId, jobRunId, mode }, "[cronWeekend] Processing deal");
        lastCtx = { ...lastCtx, where: "batch.getDealWithLineItems", dealId };
        const { deal, lineItems } = await getDealWithLineItems(dealId);

        if (!Array.isArray(lineItems) || lineItems.length === 0) {
          skippedNoLI++;
          processed++;
          appendAudit({ at: new Date().toISOString(), type: "skip", reason: "no_line_items", dealId, dealname: name, mode });
          await sleep(DEAL_PAUSE_MS);
          continue;
        }

        // Mirror suelto => SKIP (en memoria, ya que el search no filtra por NEQ)
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
        lastCtx = { ...lastCtx, where: "batch.runPhasesForDeal", dealId };
        if (!dry) await runPhasesForDeal({ deal, lineItems });
        ok++;
        processed++;
        appendAudit({ at: new Date().toISOString(), type: "deal_ok", dealId, dealname: name, mode });

        // Mirror inmediato
        const mirrorId = getMirrorIdFromOriginalDeal(deal);
        if (!mirrorId) {
          appendAudit({ at: new Date().toISOString(), type: "info", msg: "original_sin_mirror_id", dealId, dealname: name, mode });
        } else {
          try {
            lastCtx = { ...lastCtx, where: "batch.mirror.getDealWithLineItems", dealId, mirrorId: String(mirrorId) };
            const { deal: mDeal, lineItems: mLineItems } = await getDealWithLineItems(String(mirrorId));
            if (isMirrorDealFromDeal(mDeal) && Array.isArray(mLineItems) && mLineItems.length > 0) {
              appendAudit({ at: new Date().toISOString(), type: "mirror_start", originalDealId: dealId, mirrorDealId: String(mirrorId), mode });
              lastCtx = { ...lastCtx, where: "batch.mirror.runPhasesForDeal", dealId, mirrorId: String(mirrorId) };
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
          lastCtx = { ...lastCtx, where: "retry.getDealWithLineItems", dealId };
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

          lastCtx = { ...lastCtx, where: "retry.runPhasesForDeal", dealId };
          if (!dry) await runPhasesForDeal({ deal, lineItems });
          ok++;
          processed++;
          appendAudit({ at: new Date().toISOString(), type: "deal_ok_after_retry", dealId, dealname: name, mode });
        } catch (e2) {
          failed++;
          processed++;
          const msg = e2?.message || String(e2);
          await addFailed(dealId, msg, { where: lastCtx?.where, mode });
          appendAudit({ at: new Date().toISOString(), type: "error", where: "deal_failed_twice", dealId, dealname: name, msg, mode });
        }
      }

      await sleep(DEAL_PAUSE_MS);
      if (once) break;
    }

    await setCronState('weekend_last_run', JSON.stringify({
      at: new Date().toISOString(), processed, ok, failed, skippedMirror, skippedNoLI,
    }));

    appendAudit({
      at: new Date().toISOString(),
      type: "cron_done",
      mode,
      processed,
      ok,
      failed,
      skippedMirror,
      skippedNoLI,
    });

    return { mode, processed, ok, failed, skippedMirror, skippedNoLI };

  } finally {
    try {
      await flushHubSpotErrors();
    } catch (e) {
      logger.warn(
        { jobRunId, where: "flushHubSpotErrors", error: e?.message || String(e) },
        "[cronWeekend] flushHubSpotErrors failed"
      );
    }

    releaseLock();
    logger.info({ jobRunId, mode, processed, ok, failed, skippedMirror, skippedNoLI }, "cron_done");
    logger.info({ jobRunId }, "[cronWeekend] Cron finished");

    const failedItems = readJson(FAILED_PATH, { items: [] }).items || []
    const failedDeals = failedItems.map(i => ({ dealId: i.dealId, error: i.reason }))

    sendSummary({
      jobName: 'cronWeekendFull',
      mode,
      processed,
      ok,
      failed,
      skippedMirror,
      skippedNoLI,
      elapsedMs: Date.now() - start,
      failedDeals,
    }).catch(() => {})

    pingHeartbeat().catch(() => {})
  }
}

// -------------------- CLI --------------------
function parseArgs(argv) {
  const args = { once: false, deal: null, dry: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--once") args.once = true;
    else if (a === "--dry") args.dry = true;
    else if (a === "--deal") args.deal = argv[i + 1] || null, i++;
  }
  return args;
}

const argv1 = process.argv?.[1];
const isDirectRun =
  typeof argv1 === "string" &&
  argv1.length > 0 &&
  import.meta.url === pathToFileURL(argv1).href;

if (isDirectRun) {
  const { once, deal, dry } = parseArgs(process.argv.slice(2));
  try {
    await runWeekendFullCron({ onlyDealId: deal, once, dry });
  } catch (e) {
    logger.error(
      { where: "fatal", lastCtx, error: e?.message || String(e), stack: e?.stack },
      "cron_weekend_failed"
    );
    process.exitCode = 1;
  }
}