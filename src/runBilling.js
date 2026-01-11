// src/runBilling.js
console.log('🔥 ARCHIVO runBilling.js CARGÁNDOSE...');

import { hubspotClient, getDealWithLineItems } from "./services/hubspotClient.js";
import { runPhasesForDeal } from "./phases/index.js";
import { emitInvoicesForReadyTickets } from "./invoices.js";
import { fileURLToPath } from 'url';
import { resolve } from 'path';

console.log('✅ Imports completados');

/**
 * Modo de ejecución:
 *   --deal <ID>     procesa un solo negocio
 *   --allDeals      procesa TODOS los negocios
 *
 * (Opcional) EMIT_READY_TICKETS=true para emitir facturas por tickets READY (legacy)
 */

function parseArgs(argv) {
  console.log('🔍 parseArgs llamado con:', argv);
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

  console.log('✅ Args parseados:', args);
  return args;
}

function printHelp() {
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

  // Trae TODOS los deals del portal (paginado)
  do {
    const resp = await hubspotClient.crm.deals.basicApi.getPage(
      100,
      after,
      ["dealname"], // props mínimas (solo para log)
      undefined,
      false
    );

    out.push(...(resp.results || []).map((d) => String(d.id)));
    after = resp.paging?.next?.after;
  } while (after);

  return out;
}

export async function runBilling({ dealId, allDeals } = {}) {
  console.log('🎯 runBilling() EJECUTÁNDOSE!');
  console.log('   dealId:', dealId);
  console.log('   allDeals:', allDeals);
  
  if (!dealId && !allDeals) {
    throw new Error("Debes usar --deal <ID> o --allDeals");
  }
  if (dealId && allDeals) {
    throw new Error("Usa solo uno: --deal o --allDeals (no ambos)");
  }

  console.log("\n" + "=".repeat(80));
  console.log("🚀 HUBSPOT BILLING UPDATER v2.0 - INICIO");
  console.log("=".repeat(80));
  console.log("[runBilling] Modo:", dealId ? `Deal específico: ${dealId}` : 'TODOS los deals');
  console.log("[runBilling] Fecha:", new Date().toISOString());
  console.log("=".repeat(80) + "\n");

  const ids = dealId ? [String(dealId)] : await getAllDealIds();
  console.log(`[runBilling] 📊 Total deals a procesar: ${ids.length}\n`);

  let totalDeals = 0;
  let totalTickets = 0;
  let totalInvoicesAuto = 0;

  for (const id of ids) {
    try {
      console.log(`\n${"-".repeat(80)}`);
      console.log(`📋 PROCESANDO DEAL: ${id}`);
      console.log("-".repeat(80));
      
      console.log(`🔄 Llamando a getDealWithLineItems(${id})...`);
      const { deal, lineItems } = await getDealWithLineItems(id);
      const dealName = deal?.properties?.dealname || 'Sin nombre';
      
      console.log(`[Deal] Nombre: ${dealName}`);
      console.log(`[Deal] Line Items encontrados: ${lineItems.length}`);
      
      if (lineItems.length === 0) {
        console.log(`⚠️  Deal sin line items, saltando...\n`);
        continue;
      }
      
      totalDeals++;

      console.log(`🔄 Llamando a runPhasesForDeal()...`);
      // Ejecuta fases (Phase1 cupo + Phase2 tickets manuales + Phase3 auto invoices)
      const res = await runPhasesForDeal({ deal, lineItems });

      console.log(`✅ runPhasesForDeal() completado. Resultado:`, res);

      totalTickets += res.ticketsCreated || 0;
      totalInvoicesAuto += res.autoInvoicesEmitted || 0;

      console.log(`\n✅ Deal ${id} completado:`);
      console.log(`   - Tickets creados: ${res.ticketsCreated || 0}`);
      console.log(`   - Facturas emitidas: ${res.autoInvoicesEmitted || 0}`);
    } catch (err) {
      console.error(`❌ [runBilling] Error procesando negocio ${id}:`);
      console.error('   Error completo:', err);
      console.error('   Stack:', err?.stack);
      console.error('   Response body:', err?.response?.body);
    }
  }

  // Legacy/Opcional: emitir facturas de tickets listos por stage READY
  const emitReady = (process.env.EMIT_READY_TICKETS || "").toLowerCase() === "true";
  if (emitReady) {
    try {
      const { processed } = await emitInvoicesForReadyTickets();
      console.log("[runBilling] Facturas emitidas por READY:", processed);
    } catch (e) {
      console.error(
        "[runBilling] Error emitiendo facturas de tickets READY",
        e?.response?.body || e?.message || e
      );
    }
  }

  console.log("\n" + "=".repeat(80));
  console.log("📊 RESUMEN FINAL");
  console.log("=".repeat(80));
  console.log(`✅ Deals procesados: ${totalDeals}`);
  console.log(`🎫 Tickets creados: ${totalTickets}`);
  console.log(`💰 Facturas emitidas: ${totalInvoicesAuto}`);
  if (emitReady) {
    console.log(`🔄 Modo EMIT_READY_TICKETS: activo`);
  }
  console.log("=".repeat(80) + "\n");

  return { totalDeals, totalTickets, totalInvoicesAuto };
}

// Entry point ESM - FIX para Windows
console.log('🔍 Verificando entry point...');

const __filename = fileURLToPath(import.meta.url);
const argvPath = resolve(process.argv[1]);

console.log('   __filename:', __filename);
console.log('   argvPath:', argvPath);
console.log('   Son iguales?', __filename === argvPath);

if (__filename === argvPath) {
  console.log('✅ Entry point detectado, ejecutando...');
  
  try {
    const args = parseArgs(process.argv);

    if (args.help) {
      printHelp();
      process.exit(0);
    }

    console.log('🚀 Llamando a runBilling()...');
    runBilling(args).catch((err) => {
      console.error("❌ [runBilling] Error fatal:");
      console.error('   Mensaje:', err?.message);
      console.error('   Stack:', err?.stack);
      printHelp();
      process.exit(1);
    });
  } catch (err) {
    console.error("❌ [runBilling] Error en parseArgs:");
    console.error('   Mensaje:', err?.message);
    console.error('   Stack:', err?.stack);
    printHelp();
    process.exit(1);
  }
} else {
  console.log('⚠️  Entry point NO detectado (módulo importado)');
}