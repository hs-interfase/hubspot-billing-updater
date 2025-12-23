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

/**
 * Helpers gating fase 2
 */
function isTruthy(raw) {
  const v = (raw ?? "").toString().trim().toLowerCase();
  return ["true", "1", "yes", "si", "sí"].includes(v);
}

function hasPropertyValue(raw) {
  // NOT_HAS_PROPERTY suele venir como undefined / null / ""
  return raw !== undefined && raw !== null && String(raw).trim() !== "";
}

function isClosedWonStage(rawDealstage, envStage) {
  const v = (rawDealstage ?? "").toString().trim().toLowerCase();
  const s = (envStage ?? "closedwon").toString().trim().toLowerCase();
  return v === s;
}

async function processSingleDeal(dealId) {
  console.log(`\n=== Procesando deal ${dealId} (Fase 1 -> Fase 2 -> Fase 3) ===`);

  // 1) Siempre fase 1
  const res1 = await runPhase1(dealId);
  console.log("[runBilling] Fase 1:", res1);

  // 2) Gate de fase 2: solo en closedwon (o stage env) + regla facturacion_activa
  const stageEnv = process.env.DEAL_STAGE_CIERRE_GANADO || "closedwon";

  const gateResp = await hubspotClient.crm.deals.basicApi.getById(String(dealId), [
    "dealname",
    "dealstage",
    "facturacion_activa",
  ]);
  const p = gateResp.properties || {};

  const inWon = isClosedWonStage(p.dealstage, stageEnv);
  const hasFA = hasPropertyValue(p.facturacion_activa);
  const faTrue = isTruthy(p.facturacion_activa);

  let res2 = { dealId: String(dealId), skipped: true, reason: "no evaluado" };

  if (!inWon) {
    res2 = {
      dealId: String(dealId),
      skipped: true,
      reason: `dealstage != ${stageEnv}`,
      dealstage: p.dealstage,
    };
    console.log("[runBilling] Fase 2:", res2);
  } else {
    // Está en cierre ganado: aplicar regla acordada
    if (!hasFA) {
      // ✅ primer arranque: si NO existe la property, activarla
      await hubspotClient.crm.deals.basicApi.update(String(dealId), {
        properties: { facturacion_activa: "true" },
      });
      console.log("[runBilling] facturacion_activa => true (primer arranque en cierre ganado)", {
        dealId,
        stage: p.dealstage,
      });

      res2 = await runPhase2(dealId);
      console.log("[runBilling] Fase 2:", res2);
    } else if (!faTrue) {
      // ✅ existe y es false: respetar pausa (no tocar, no tickets)
      res2 = {
        dealId: String(dealId),
        skipped: true,
        reason: "facturacion_activa=false (pausado, se respeta)",
      };
      console.log("[runBilling] Fase 2:", res2);
    } else {
      // ✅ existe y es true: ejecutar fase2 normal
      res2 = await runPhase2(dealId);
      console.log("[runBilling] Fase 2:", res2);
    }
  }

  // 3) Fase 3 (por ahora igual que tu flujo)
  const res3 = await runPhase3(dealId);
  console.log("[runBilling] Fase 3:", res3);

  console.log(`=== FIN deal ${dealId} ===\n`);

  return { res1, res2, res3 };
}

async function processAllClosedWonDeals() {
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
          filters: [{ propertyName: "dealstage", operator: "EQ", value: stage }],
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

  const dealIdFromFlag = getArgValue("--deal");
  const isAllWon = hasFlag("--allWon");

  if (isAllWon) {
    await processAllClosedWonDeals();
    return;
  }

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
