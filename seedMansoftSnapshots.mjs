// seedMansoftSnapshots.mjs
//
// Script one-shot para seedear `mansoft_ultimo_snapshot` en line items
// que ya están facturando pero nunca pasaron por el sistema de aviso Mantsoft.
//
// Sin este seed, esos LIs no generan aviso de edición porque
// `hasPreviousSnapshot()` devuelve false y el guard de Phase P no entra.
//
// ─────────────────────────────────────────────────────────────────
// CRITERIO DE INCLUSIÓN (todas deben cumplirse)
// ─────────────────────────────────────────────────────────────────
//   - facturacion_automatica = true
//   - facturacion_activa = true
//   - of_line_item_py_origen_id vacío (no es mirror UY)
//   - mansoft_ultimo_snapshot vacío (idempotencia)
//   - AL MENOS UNA de:
//       * last_ticketed_date con valor (ya facturó alguna vez)
//       * hs_recurring_billing_start_date < hoy (debería haber arrancado)
//
// ─────────────────────────────────────────────────────────────────
// USO
// ─────────────────────────────────────────────────────────────────
//   node seedMansoftSnapshots.mjs              # dry-run (default)
//   node seedMansoftSnapshots.mjs --apply      # ejecuta de verdad
//   node seedMansoftSnapshots.mjs --deal 12345 # limitar a un deal (dry por default)
//   node seedMansoftSnapshots.mjs --deal 12345 --apply
//

import 'dotenv/config';
import { hubspotClient } from './src/hubspotClient.js';
import { withRetry } from './src/utils/withRetry.js';
import {
  buildMansoftSnapshot,
  serializeMansoftSnapshot,
  MANSOFT_WATCHED_PROPS,
} from './src/services/billing/mansoftSnapshot.js';
import logger from './lib/logger.js';

// ─────────────────────────────────────────────────────────────────
// Args
// ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const DRY = !APPLY;

const dealFlagIdx = args.indexOf('--deal');
const ONLY_DEAL_ID = dealFlagIdx >= 0 ? args[dealFlagIdx + 1] : null;

const MODE = DRY ? 'DRY' : 'APPLY';
const BATCH_SIZE = 100;
const PAGE_SIZE = 100;

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────
function todayYmd() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Montevideo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function toYmd(v) {
  return (v || '').toString().slice(0, 10);
}

function parseBool(v) {
  const s = String(v ?? '').trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'si' || s === 'sí' || s === 'yes';
}

/** Evalúa si un LI debe ser seedeado. Retorna { include, reason } */
function evaluateLineItem(li, today) {
  const p = li?.properties || {};

  // 1) facturacion_automatica debe ser true (aunque ya filtramos en Search,
  //    re-validamos por si la Search API devolvió algo inconsistente)
  if (!parseBool(p.facturacion_automatica)) {
    return { include: false, reason: 'not_automated' };
  }

  // 2) Debe ser mirror UY? Excluir.
  const pyOrigen = String(p.of_line_item_py_origen_id || '').trim();
  if (pyOrigen) {
    return { include: false, reason: 'mirror_uy' };
  }

  // 3) Ya tiene snapshot? Idempotencia: saltar.
  const existingSnap = String(p.mansoft_ultimo_snapshot || '').trim();
  if (existingSnap) {
    return { include: false, reason: 'already_has_snapshot' };
  }

  // 4) facturacion_activa debe ser true
  if (!parseBool(p.facturacion_activa)) {
    return { include: false, reason: 'facturacion_activa_false' };
  }

  // 5) Debe haber arrancado: last_ticketed_date con valor O start_date < hoy
  const lastTicketed = toYmd(p.last_ticketed_date);
  const startDate = toYmd(p.hs_recurring_billing_start_date);

  const yaFacturo = !!lastTicketed;
  const yaArranco = startDate && startDate < today;

  if (!yaFacturo && !yaArranco) {
    return { include: false, reason: 'not_yet_started' };
  }

  return { include: true, reason: parseBool(p.pausa) ? 'pausado' : 'activo' };
}

// ─────────────────────────────────────────────────────────────────
// Búsqueda de candidatos
// ─────────────────────────────────────────────────────────────────

/**
 * Pagina líneas con facturacion_automatica=true (+ opcionalmente deal_id)
 * Usa `after` cursor-based pagination.
 */
async function* iterateCandidateLineItems({ onlyDealId }) {
  // Props que necesitamos para evaluar + construir snapshot
  const properties = [
    // para evaluar inclusión
    'facturacion_automatica',
    'facturacion_activa',
    'of_line_item_py_origen_id',
    'mansoft_ultimo_snapshot',
    'last_ticketed_date',
    'hs_recurring_billing_start_date',
    'pausa',
    'line_item_key',
    // ID del deal asociado (si lo trae la Search API; si no, lo sacamos por association)
    // para construir el snapshot (watched props + su normalización)
    ...MANSOFT_WATCHED_PROPS,
  ];

  // Dedup por si alguna se repitió (MANSOFT_WATCHED_PROPS puede solaparse con las de filtro)
  const uniqueProps = [...new Set(properties)];

  const filters = [
    { propertyName: 'facturacion_automatica', operator: 'EQ', value: 'true' },
  ];

  if (onlyDealId) {
    filters.push({
      propertyName: 'associations.deal',
      operator: 'EQ',
      value: String(onlyDealId),
    });
  }

  let after;
  let safetyPages = 0;

  while (true) {
    if (++safetyPages > 500) {
      logger.warn({ module: 'seedMansoftSnapshots', safetyPages }, 'Safety break: >500 páginas');
      break;
    }

    const body = {
      filterGroups: [{ filters }],
      properties: uniqueProps,
      limit: PAGE_SIZE,
      after,
    };

    const resp = await withRetry(
      () => hubspotClient.crm.lineItems.searchApi.doSearch(body),
      { module: 'seedMansoftSnapshots', fn: 'iterateCandidateLineItems' }
    );

    const results = resp?.results || [];
    for (const li of results) yield li;

    after = resp?.paging?.next?.after;
    if (!after) break;
  }
}

// ─────────────────────────────────────────────────────────────────
// Update
// ─────────────────────────────────────────────────────────────────

/**
 * Actualiza un batch de LIs con su snapshot.
 * Fallback a update individual si el batch falla.
 */
async function applyBatch(batch) {
  if (!batch.length) return { ok: 0, failed: 0 };

  const inputs = batch.map(({ id, snapshot }) => ({
    id: String(id),
    properties: {
      mansoft_ultimo_snapshot: serializeMansoftSnapshot(snapshot),
    },
  }));

  try {
    await withRetry(
      () => hubspotClient.crm.lineItems.batchApi.update({ inputs }),
      { module: 'seedMansoftSnapshots', fn: 'applyBatch' }
    );
    return { ok: batch.length, failed: 0 };
  } catch (err) {
    logger.warn(
      { module: 'seedMansoftSnapshots', fn: 'applyBatch', count: batch.length, err: err?.message },
      'Batch falló, fallback a update individual'
    );

    let ok = 0, failed = 0;
    for (const { id, snapshot } of batch) {
      try {
        await hubspotClient.crm.lineItems.basicApi.update(String(id), {
          properties: {
            mansoft_ultimo_snapshot: serializeMansoftSnapshot(snapshot),
          },
        });
        ok++;
      } catch (e) {
        failed++;
        logger.error(
          { module: 'seedMansoftSnapshots', fn: 'applyBatch', lineItemId: id, err: e?.message },
          'Update individual falló'
        );
      }
    }
    return { ok, failed };
  }
}

// ─────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────
async function main() {
  const t0 = Date.now();
  const today = todayYmd();

  logger.info(
    {
      module: 'seedMansoftSnapshots',
      mode: MODE,
      onlyDealId: ONLY_DEAL_ID,
      today,
      watchedProps: MANSOFT_WATCHED_PROPS.length,
    },
    `🚀 Seed Mantsoft snapshots — modo ${MODE}${ONLY_DEAL_ID ? ` — deal ${ONLY_DEAL_ID}` : ''}`
  );

  // Contadores
  let scanned = 0;
  let included = 0;
  const skipped = {
    not_automated: 0,
    mirror_uy: 0,
    already_has_snapshot: 0,
    facturacion_activa_false: 0,
    not_yet_started: 0,
  };
  let pausadosIncluidos = 0;

  // Sample para dry-run
  const samples = [];

  // Batch acumulador (solo usado en APPLY)
  let batch = [];
  let totalOk = 0;
  let totalFailed = 0;

  // Iterar y procesar
  for await (const li of iterateCandidateLineItems({ onlyDealId: ONLY_DEAL_ID })) {
    scanned++;

    const { include, reason } = evaluateLineItem(li, today);

    if (!include) {
      if (skipped[reason] !== undefined) skipped[reason]++;
      continue;
    }

    included++;
    if (reason === 'pausado') pausadosIncluidos++;

    const snapshot = buildMansoftSnapshot(li);

    // Sample para dry-run
    if (samples.length < 5) {
      samples.push({
        lineItemId: li.id,
        lik: li.properties?.line_item_key,
        pausa: parseBool(li.properties?.pausa),
        price: li.properties?.price,
        snapshot,
      });
    }

    if (DRY) continue;

    // APPLY: acumular en batch
    batch.push({ id: li.id, snapshot });

    if (batch.length >= BATCH_SIZE) {
      const { ok, failed } = await applyBatch(batch);
      totalOk += ok;
      totalFailed += failed;
      batch = [];

      if ((totalOk + totalFailed) % 50 === 0 || totalOk + totalFailed < 100) {
        logger.info(
          { module: 'seedMansoftSnapshots', progress: { scanned, included, ok: totalOk, failed: totalFailed } },
          'Progreso'
        );
      }
    }
  }

  // Flush del último batch
  if (!DRY && batch.length) {
    const { ok, failed } = await applyBatch(batch);
    totalOk += ok;
    totalFailed += failed;
  }

  // ─────────────────────────────────────────────────────────────
  // Resumen final
  // ─────────────────────────────────────────────────────────────
  const elapsedMs = Date.now() - t0;

  logger.info(
    {
      module: 'seedMansoftSnapshots',
      mode: MODE,
      scanned,
      included,
      pausadosIncluidos,
      skipped,
      ok: totalOk,
      failed: totalFailed,
      elapsedMs,
    },
    `✅ Seed completado — modo ${MODE}`
  );

  // En dry-run imprimir resumen legible + samples
  if (DRY) {
    console.log('\n═══════════════════════════════════════════════');
    console.log(`DRY-RUN — ningún LI fue modificado`);
    console.log('═══════════════════════════════════════════════');
    console.log(`Escaneados:                    ${scanned}`);
    console.log(`A seedear (total):             ${included}`);
    console.log(`  └─ de los cuales pausados:   ${pausadosIncluidos}`);
    console.log(`Excluidos:`);
    console.log(`  - mirror UY:                 ${skipped.mirror_uy}`);
    console.log(`  - ya tienen snapshot:        ${skipped.already_has_snapshot}`);
    console.log(`  - facturacion_activa=false:  ${skipped.facturacion_activa_false}`);
    console.log(`  - aún no arrancaron:         ${skipped.not_yet_started}`);
    console.log(`  - (inconsistencia) not_aut:  ${skipped.not_automated}`);
    console.log(`\nSample (primeros ${samples.length}):`);
    for (const s of samples) {
      console.log(`  LI ${s.lineItemId} | ${s.lik || '-'} | pausa=${s.pausa} | price=${s.price}`);
    }
    console.log('\nPara ejecutar: node seedMansoftSnapshots.mjs --apply');
    console.log('═══════════════════════════════════════════════\n');
  } else {
    console.log('\n═══════════════════════════════════════════════');
    console.log(`APPLY — seed ejecutado`);
    console.log('═══════════════════════════════════════════════');
    console.log(`Escaneados:                    ${scanned}`);
    console.log(`Seedeados exitosamente:        ${totalOk}`);
    console.log(`Fallidos:                      ${totalFailed}`);
    console.log(`Pausados incluidos:            ${pausadosIncluidos}`);
    console.log(`Tiempo total:                  ${(elapsedMs / 1000).toFixed(1)}s`);
    console.log('═══════════════════════════════════════════════\n');
  }

  return { scanned, included, ok: totalOk, failed: totalFailed };
}

main().catch(err => {
  logger.error({ module: 'seedMansoftSnapshots', err }, '❌ Error fatal en seed');
  console.error(err);
  process.exit(1);
});
