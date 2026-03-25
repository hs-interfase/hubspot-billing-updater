// src/runBilling.js
import { hubspotClient, getDealWithLineItems } from "./hubspotClient.js";
import { runPhasesForDeal } from "./phases/index.js";
import { emitInvoicesForReadyTickets } from "./invoices.js";
import { fileURLToPath } from 'url';
import { resolve } from 'path';
import logger from "../lib/logger.js";

/**
 * Modo de ejecución:
 *   --deal <ID>     procesa un solo negocio
 *   --allDeals      procesa TODOS los negocios
 *
 * (Opcional) EMIT_READY_TICKETS=true para emitir facturas por tickets READY (legacy)
 */

function parseArgs(argv) {
  const args = {
    dealId: null,
    allDeals: false,
    help: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];

    if (a === "--help" || a === "-h") {
      args.help = true;
      continue;
    }

    if (a === "--deal" || a === "--dealId") {
      const v = argv[i + 1];
      if (!v) throw new Error("Falta el valor para --deal <ID>");
      args.dealId = String(v);
      i++;
      continue;
    }

    if (a === "--allDeals") {
      args.allDeals = true;
      continue;
    }
  }

  return args;
}

function printHelp() {
  // printHelp va a stdout plano intencionalmente (es UI de CLI, no log operativo)
  // eslint-disable-next-line no-console
  console.log(`
Uso:
  node ./src/runBilling.js --deal <DEAL_ID>
  node ./src/runBilling.js --allDeals

Opciones:
  --deal <id>     Procesa SOLO ese negocio
  --allDeals      Procesa TODOS los negocios (paginado)
  -h, --help      Muestra esta ayuda

Env opcional:
  EMIT_READY_TICKETS=true   (emite facturas por stage READY - legacy)
`);
}

async function getAllDealIds() {
  const out = [];
  let after;

  do {
    const resp = await hubspotClient.crm.deals.basicApi.getPage(
      100,
      after,
      ["dealname"],
      undefined,
      false
    );

    out.push(...(resp.results || []).map((d) => String(d.id)));
    after = resp.paging?.next?.after;
  } while (after);

  return out;
}

export async function runBilling({ dealId, allDeals } = {}) {
  if (!dealId && !allDeals) {
    throw new Error("Debes usar --deal <ID> o --allDeals");
  }
  if (dealId && allDeals) {
    throw new Error("Usa solo uno: --deal o --allDeals (no ambos)");
  }

  const modo = dealId ? `deal específico: ${dealId}` : 'todos los deals';
  logger.info({
    module: 'runBilling',
    fn: 'runBilling',
    modo,
    dealId: dealId || null,
    allDeals: !!allDeals,
    fecha: new Date().toISOString(),
  }, `[runBilling] INICIO — ${modo}`);

  const ids = dealId ? [String(dealId)] : await getAllDealIds();
  logger.info({ module: 'runBilling', fn: 'runBilling', total: ids.length }, `[runBilling] Total deals a procesar: ${ids.length}`);

  let totalDeals = 0;
  let totalTickets = 0;
  let totalInvoicesAuto = 0;

  for (const id of ids) {
    try {
      const { deal, lineItems } = await getDealWithLineItems(id);
      const dealName = deal?.properties?.dealname || 'Sin nombre';

      if (lineItems.length === 0) {
        logger.info({ module: 'runBilling', fn: 'runBilling', dealId: id, dealName }, '[runBilling] Deal sin line items, saltando');
        continue;
      }

      totalDeals++;

      const res = await runPhasesForDeal({ deal, lineItems });

      totalTickets += res.ticketsCreated || 0;
      totalInvoicesAuto += res.autoInvoicesEmitted || 0;

      logger.info({
        module: 'runBilling',
        fn: 'runBilling',
        dealId: id,
        dealName,
        ticketsCreated: res.ticketsCreated || 0,
        autoInvoicesEmitted: res.autoInvoicesEmitted || 0,
      }, `[runBilling] Deal ${id} completado`);

    } catch (err) {
      logger.error({
        module: 'runBilling',
        fn: 'runBilling',
        dealId: id,
        err,
        responseBody: err?.response?.body,
      }, `[runBilling] Error procesando negocio ${id}`);
    }
  }

  // Legacy/Opcional: emitir facturas de tickets listos por stage READY
  const emitReady = (process.env.EMIT_READY_TICKETS || "").toLowerCase() === "true";
  if (emitReady) {
    try {
      const { processed } = await emitInvoicesForReadyTickets();
      logger.info({ module: 'runBilling', fn: 'runBilling', processed }, '[runBilling] Facturas emitidas por READY');
    } catch (err) {
      logger.error({ module: 'runBilling', fn: 'runBilling', err }, '[runBilling] Error emitiendo facturas de tickets READY');
    }
  }

  logger.info({
    module: 'runBilling',
    fn: 'runBilling',
    totalDeals,
    totalTickets,
    totalInvoicesAuto,
    emitReadyActivo: emitReady,
  }, '[runBilling] RESUMEN FINAL');

  return { totalDeals, totalTickets, totalInvoicesAuto };
}

// Entry point ESM - FIX para Windows
const __filename = fileURLToPath(import.meta.url);
const argvPath = resolve(process.argv[1]);

async function main() {
  const args = parseArgs(process.argv);

  if (args.help) {
    printHelp();
    process.exitCode = 0;
    return;
  }

  try {
    await runBilling(args);
  } catch (err) {
    logger.error({ module: 'runBilling', err }, 'cron_failed');
    process.exitCode = 1;
  }
}

if (__filename === argvPath) {
  main().catch((err) => {
    logger.error({ module: 'runBilling', err }, '[runBilling] Fatal en main()');
    process.exitCode = 1;
  });
}

/*
 * ─────────────────────────────────────────────────────────────
 * CATCHES con reportHubSpotError agregados: NINGUNO
 *
 * Este archivo es el orquestador/entry point. No hace updates
 * directos a tickets ni line items — delega en runPhasesForDeal
 * y emitInvoicesForReadyTickets, que tienen sus propios reportes.
 *
 * Logs eliminados (~30 console.log):
 * - Startup banners (🔥 cargándose, ✅ imports, 🔍 entry point,
 *   __filename, argvPath) — ruido de desarrollo
 * - Banners ASCII (=.repeat(80)) — reemplazados por logger.info estructurado
 * - Logs paso a paso del loop (🔄 Llamando a..., ✅ completado)
 *   — colapsados en un único log pre/post por deal con datos relevantes
 * - Resumen final multi-línea — un único logger.info con objeto
 *
 * printHelp() conserva console.log intencionalmente:
 * — es output de CLI para el usuario, no log operativo.
 * ─────────────────────────────────────────────────────────────
 */