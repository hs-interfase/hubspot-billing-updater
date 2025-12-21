// src/runBilling.js
import "dotenv/config";

import { runPhase1 } from "./phases/phase1.js";
import { runPhase2 } from "./phases/phase2.js";
import { runPhase3 } from "./phases/phase3.js";
import { hubspotClient } from "./hubspotClient.js";

/**
 * Pequeña ayuda para args.
 */
function hasFlag(flag) {
  return process.argv.slice(2).includes(flag);
}

function getArgValue(prefix) {
  // permite: --deal=123 o --deal 123
  const args = process.argv.slice(2);
  const eq = args.find((a) => a.startsWith(prefix + "="));
  if (eq) return eq.split("=")[1];
  const idx = args.indexOf(prefix);
  if (idx >= 0 && args[idx + 1]) return args[idx + 1];
  return null;
}

async function processSingleDeal(dealId) {
  console.log(`\n=== Procesando deal ${dealId} (Fase 1 -> Fase 2 -> Fase 3) ===`);

  const res1 = await runPhase1(dealId);
  console.log("[runBilling] Fase 1:", res1);

  const res2 = await runPhase2(dealId);
  console.log("[runBilling] Fase 2:", res2);

  const res3 = await runPhase3(dealId);
  console.log("[runBilling] Fase 3:", res3);

  console.log(`=== FIN deal ${dealId} ===\n`);
}

async function processAllClosedWonDeals() {
  // OJO: esta búsqueda es solo un ejemplo mínimo.
  // Vos definís el stage real por env:
  //   DEAL_STAGE_CIERRE_GANADO=closedwon (o tu stage internal id)
  const stage = process.env.DEAL_STAGE_CIERRE_GANADO;
  if (!stage) {
    throw new Error(
      "Falta env DEAL_STAGE_CIERRE_GANADO para usar --allWon (ej: closedwon o el stage interno que uses)."
    );
  }

  console.log("=== RUN BILLING (modo --allWon) ===");
  console.log("[runBilling] Buscando deals en cierre ganado:", stage);

  let after = undefined;
  let count = 0;

  do {
    const searchRequest = {
      filterGroups: [
        {
          filters: [
            { propertyName: "dealstage", operator: "EQ", value: stage }
          ],
        },
      ],
      properties: ["dealname", "dealstage", "facturacion_activa"],
      limit: 100,
      after,
    };

    const resp = await hubspotClient.crm.deals.searchApi.doSearch(searchRequest);
    const deals = resp.results || [];

    for (const d of deals) {
      count++;
      await processSingleDeal(String(d.id));
    }

    after = resp.paging?.next?.after;
  } while (after);

  console.log("=== FIN RUN BILLING --allWon ===");
  console.log("[runBilling] Deals procesados:", count);
}

async function main() {
  const args = process.argv.slice(2);

  // Permitir: node src/runBilling.js --deal=123
  const dealIdFromFlag = getArgValue("--deal");

  const isAllWon = hasFlag("--allWon");

  // Caso 1: --allWon
  if (isAllWon) {
    await processAllClosedWonDeals();
    return;
  }

  // Caso 2: deal por flag o primer arg posicional
  const dealId = dealIdFromFlag || args[0];
  if (!dealId) {
    console.log("Uso:");
    console.log("  node ./src/runBilling.js <DEAL_ID>");
    console.log("  node ./src/runBilling.js --deal=<DEAL_ID>");
    console.log("  node ./src/runBilling.js --allWon");
    process.exit(1);
  }

  await processSingleDeal(String(dealId));
}

main().catch((err) => {
  console.error("[runBilling] ERROR", err?.response?.body || err?.message || err);
  process.exit(1);
});
