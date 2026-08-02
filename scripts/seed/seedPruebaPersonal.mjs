#!/usr/bin/env node
/**
 * seedPruebaPersonal.mjs
 *
 * SEED para la prueba a mano de la usuaria (2-ago-2026).
 *
 * UN solo negocio, de PARAGUAY, **todavía NO ganado**, con cinco line items que
 * cubren las cinco formas de facturar que existen en el sistema. La idea es
 * mirar el cronograma ANTES del cierre ganado —que es donde los errores de
 * cálculo se ven sin que nada los tape— y recién después avanzar la etapa.
 *
 * ⚠️ SOLO SANDBOX (HUBSPOT_ENV=sandbox). Aborta en cualquier otro portal.
 *
 * ─── LOS CINCO LINE ITEMS ─────────────────────────────────────────────────────
 *   LI-1  Pago único a 3 MESES          — sin frecuencia = pago único
 *   LI-2  Pago único a 15 DÍAS          — el más cercano; el primero que se mueve
 *   LI-3  Recurrente AUTO-RENEW mensual — frecuencia SIN número de pagos
 *   LI-4  Recurrente 1 AÑO (12 cuotas)  — plan fijo, frecuencia + P12M
 *   LI-5  Pago único a 2 MESES CON CUPO — parte_del_cupo=true + uy=true (ESPEJO)
 *
 * ─── POR QUÉ CADA COSA ES COMO ES (verificado en el código) ───────────────────
 * · PAGO ÚNICO = `recurringbillingfrequency` VACÍO. `getEffectiveBillingConfig`
 *   (billingEngine.js:196-206): sin frecuencia y sin irregular → interval null.
 *   NO existe un valor "pago único": es la ausencia de frecuencia.
 * · AUTO-RENEW = frecuencia puesta y SIN número de pagos
 *   (`isAutoRenew`, services/billing/mode.js:22: freq !== '' && !(payments > 0)).
 * · PLAN FIJO 1 AÑO = frecuencia + `hs_recurring_billing_period: 'P12M'`.
 *   ⚠️ NO se escribe `hs_recurring_billing_number_of_payments`: HubSpot la
 *   calcula sola desde el period y es de sólo lectura.
 * · ESPEJO = el negocio en `pais_operativo: 'Paraguay'` + algún LI con `uy: 'true'`
 *   (`shouldMirrorDealToUruguay`, dealMirroring.js:560-577). El espejo lo crea
 *   Phase 1 en cualquier pasada — NO hace falta que el negocio esté ganado.
 * · CUPO = en el NEGOCIO `tipo_de_cupo` ('Por Monto' | 'Por Horas'), `cupo_total`
 *   y `cupo_activo`; en el LINE ITEM `parte_del_cupo: 'true'`.
 * · NO GANADO = etapa `contractsent` (bucket 75%). Phase P igual genera el
 *   cronograma completo en etapa forecast: es exactamente lo que hay que mirar.
 *
 * ─── LAS FECHAS SON RELATIVAS A HOY ───────────────────────────────────────────
 * Se calculan al correr, así que el seed sirve cualquier día. Quedan anotadas en
 * el manifest para poder comparar contra lo que genere el motor.
 *
 * Uso:
 *   node scripts/seed/seedPruebaPersonal.mjs --dry   → no escribe nada, muestra qué haría
 *   node scripts/seed/seedPruebaPersonal.mjs         → siembra
 *
 * Manifest: prueba-personal-manifest.json
 * Limpieza: los objetos llevan el prefijo [PRUEBA-MICH] en el nombre.
 */

import 'dotenv/config';
import fs from 'fs';
import { hubspotClient } from '../../src/hubspotClient.js';
import { buildLineItemKey } from '../../src/utils/lineItemKey.js';

// ─── Guardas ──────────────────────────────────────────────────────────────────

if (String(process.env.HUBSPOT_ENV || '').toLowerCase() !== 'sandbox') {
  console.error('❌ Este seed es SOLO para sandbox (HUBSPOT_ENV=sandbox). Abortando.');
  process.exit(1);
}

const DRY      = process.argv.includes('--dry');
const PREFIX   = '[PRUEBA-MICH]';
const MANIFEST = 'prueba-personal-manifest.json';

// Etapa NO ganada: 'decisionmakerboughtin' = «Calificado» (50%), bucket 50 en
// resolveBucketFromDealStage. Existe con el MISMO id en sandbox y en PROD.
//
// 🔴 NO usar la etapa de 75% en sandbox: ahí «Aprobación verbal» es `1311813160`,
//    mientras que en PROD la misma etapa es `contractsent` — que es el id que el
//    motor tiene cableado (phasep.js:243-252). O sea que en SANDBOX un negocio en
//    75% cae en `dealstage_not_in_forecast_buckets` y NO genera ningún ticket,
//    mientras que en PROD sí. Verificado por API el 2-ago contra los dos portales.
//    Es desfasaje del sandbox, no un bug de producción, pero hace que una prueba
//    sobre esa etapa no pruebe nada.
const DEAL_STAGE_NO_GANADO = process.env.DEAL_STAGE_NO_GANADO || 'decisionmakerboughtin';

// ─── Fechas relativas a hoy ───────────────────────────────────────────────────

function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function enDias(n)  { const d = new Date(); d.setDate(d.getDate() + n); return ymd(d); }
function enMeses(n) { const d = new Date(); d.setMonth(d.getMonth() + n); return ymd(d); }

const F_15_DIAS = enDias(15);
const F_2_MESES = enMeses(2);
const F_3_MESES = enMeses(3);
const F_1_MES   = enMeses(1);

// ─── Definición ───────────────────────────────────────────────────────────────

const DEAL = {
  dealname: `${PREFIX} Cliente Paraguay — prueba a mano`,
  dealstage: DEAL_STAGE_NO_GANADO,
  pipeline: process.env.DEAL_PIPELINE_ID || 'default',
  pais_operativo: 'Paraguay',
  // 🔴 `facturacion_activa` NO SE TOCA (pedido de la usuaria, 2-ago): el seed no la
  // escribe ni en el negocio ni en los line items — queda como nace, y la prende ella
  // a mano cuando quiera. Vacía se comporta igual que 'false' (todos los lectores
  // pasan por parseBool), así que el cronograma se genera igual: Phase P no depende
  // de esta llave.
  // Cupo por monto, con saldo de sobra para que el LI-5 lo consuma sin agotarlo
  cupo_activo: 'true',
  tipo_de_cupo: 'Por Monto',
  cupo_total: '100000',
};

// PRODUCTO: se siembra el select `nombre_producto`, NO el `hs_product_id`. El motor
// reasocia el id solo (RUTA 3 → product_reassign → reassignLineItemProduct), que es
// justo el camino que queremos ejercitar. Los nombres son opciones reales del select
// (verificadas contra el flow `Pasar producto de manual select` de los dos portales).
//
// ÁREA: NO se siembra a propósito (pedido de la usuaria, 2-ago). Tiene que calcularla
// el motor — `syncLineItemAreaByCountry` la fuerza a «Paraguay» por el país del
// negocio; en un negocio UY se heredaría del producto.
//
// COSTO: se siembra `costo_total_usd` (la FUENTE DE VERDAD, total y en USD) y NO
// `hs_cost_of_goods_sold`, que es la DERIVADA — el motor la calcula como
// `costo_total_usd × dolar(LI) ÷ quantity` (costoUsdService.js:14). Sembrar sólo la
// fuente es lo que permite verificar que la derivación corre de verdad.
const LINE_ITEMS = {
  'LI-1': {
    queEs: 'Pago único a 3 MESES',
    queMirar: 'un solo ticket, con esa fecha exacta, y nada más',
    props: {
      name: `${PREFIX} LI-1 — pago único a 3 meses`,
      price: '3000', quantity: '1',
      costo_total_usd: '1200',
      nombre_producto: 'PayRoll',
      hs_recurring_billing_start_date: F_3_MESES,
      // sin recurringbillingfrequency = PAGO ÚNICO
      facturacion_automatica: 'false',
    },
  },
  'LI-2': {
    queEs: 'Pago único a 15 DÍAS',
    queMirar: 'es el más cercano: el primero que debería moverse al avanzar el negocio',
    props: {
      name: `${PREFIX} LI-2 — pago único a 15 días`,
      price: '1500', quantity: '1',
      costo_total_usd: '600',
      nombre_producto: 'Portal',
      hs_recurring_billing_start_date: F_15_DIAS,
      facturacion_automatica: 'false',
    },
  },
  'LI-3': {
    queEs: 'Recurrente AUTO-RENEW mensual (sin fin)',
    queMirar: 'ventana móvil: no tiene última cuota. Compará cuántos tickets genera contra LI-4',
    props: {
      name: `${PREFIX} LI-3 — recurrente auto-renew mensual`,
      price: '2500', quantity: '1',
      costo_total_usd: '1000',
      nombre_producto: 'IJServ', // ⚠️ el valor real del select es 'IJServ', NO 'iJServ'
      recurringbillingfrequency: 'monthly',
      hs_recurring_billing_start_date: F_1_MES,
      // SIN period ni number_of_payments = AUTO-RENEW
      facturacion_automatica: 'false',
    },
  },
  'LI-4': {
    queEs: 'Recurrente 1 AÑO — plan fijo de 12 cuotas',
    queMirar: '🔴 tienen que ser 12 tickets, no 13. Es el hallazgo #2 de la tanda B',
    props: {
      name: `${PREFIX} LI-4 — recurrente 12 meses (plan fijo)`,
      // quantity 2 A PROPÓSITO: es el único LI donde se ve que el costo unitario
      // es el TOTAL dividido la cantidad (4000 ÷ 2 = 2000), no una copia del total.
      price: '4000', quantity: '2',
      costo_total_usd: '4000',
      nombre_producto: 'i2',
      recurringbillingfrequency: 'monthly',
      hs_recurring_billing_start_date: F_1_MES,
      hs_recurring_billing_period: 'P12M',
      facturacion_automatica: 'false',
    },
  },
  'LI-5': {
    queEs: 'Pago único a 2 MESES, CON CUPO y CON ESPEJO UY',
    queMirar: 'el espejo UY tiene que nacer solo, y el precio del espejo debe ser el COSTO de este',
    props: {
      name: `${PREFIX} LI-5 — pago único con cupo y espejo`,
      price: '5000', quantity: '1',
      costo_total_usd: '2000',
      nombre_producto: 'iGDoc',
      hs_recurring_billing_start_date: F_2_MESES,
      parte_del_cupo: 'true',
      uy: 'true',
      pais_operativo: 'Paraguay',
      facturacion_automatica: 'false',
    },
  },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function crearEmpresa(name) {
  if (DRY) { console.log(`  🔍 [DRY] company: ${name}`); return { id: 'DRY_CO' }; }
  const r = await hubspotClient.crm.companies.basicApi.create({ properties: { name } });
  console.log(`  🏢 company ${r.id} — ${name}`);
  return r;
}

async function crearDeal(props) {
  if (DRY) { console.log(`  🔍 [DRY] deal: ${props.dealname} (etapa ${props.dealstage})`); return { id: 'DRY_DEAL' }; }
  const r = await hubspotClient.crm.deals.basicApi.create({ properties: props });
  console.log(`  ✅ deal ${r.id} — ${props.dealname}`);
  return r;
}

async function crearLineItem(props) {
  if (DRY) { console.log(`    🔍 [DRY] LI: ${props.name}`); return { id: 'DRY_LI' }; }
  const r = await hubspotClient.crm.lineItems.basicApi.create({ properties: props });
  console.log(`    📦 LI ${r.id} — ${props.name}`);
  return r;
}

async function asociar(fromType, fromId, toType, toId, typeId) {
  if (DRY) return;
  await hubspotClient.crm.associations.v4.basicApi.create(
    fromType, String(fromId), toType, String(toId),
    [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: typeId }]
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n═══ SEED prueba personal ${DRY ? '(DRY RUN)' : ''} ═══`);
  console.log(`Portal: ${process.env.HUBSPOT_ENV} · etapa del negocio: ${DEAL_STAGE_NO_GANADO} (NO ganado)`);
  console.log(`Fechas: 15 días=${F_15_DIAS} · 1 mes=${F_1_MES} · 2 meses=${F_2_MESES} · 3 meses=${F_3_MESES}\n`);

  const co = await crearEmpresa(`${PREFIX} Cliente PY`);
  const deal = await crearDeal(DEAL);
  await asociar('companies', co.id, 'deals', deal.id, 342);

  const manifest = {
    prefix: PREFIX,
    createdAt: new Date().toISOString(),
    companyId: co.id,
    dealId: deal.id,
    dealStageInicial: DEAL_STAGE_NO_GANADO,
    fechas: { d15: F_15_DIAS, m1: F_1_MES, m2: F_2_MESES, m3: F_3_MESES },
    cupo: { tipo: DEAL.tipo_de_cupo, total: DEAL.cupo_total },
    lineItems: {},
  };

  for (const [slug, def] of Object.entries(LINE_ITEMS)) {
    const li = await crearLineItem({ ...def.props });
    await asociar('line_items', li.id, 'deals', deal.id, 20);

    const lik = DRY ? `${deal.id}:${li.id}:dry` : buildLineItemKey({ dealId: deal.id, lineItemIdOriginal: li.id });
    if (!DRY) {
      await hubspotClient.crm.lineItems.basicApi.update(String(li.id), { properties: { line_item_key: lik } });
    }

    manifest.lineItems[slug] = {
      id: li.id, lineItemKey: lik,
      queEs: def.queEs, queMirar: def.queMirar,
      nombre: def.props.name,
      fecha: def.props.hs_recurring_billing_start_date,
    };
    console.log(`       ${slug}: ${def.queEs}`);
  }

  if (!DRY) fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));

  console.log(`\n═══ LISTO ═══`);
  console.log(`Negocio: ${deal.id}  (etapa: ${DEAL_STAGE_NO_GANADO} — NO ganado)`);
  console.log(`Manifest: ${MANIFEST}`);
  console.log(`\nEl motor todavía NO corrió: no hay tickets ni espejo. Para que aparezcan:`);
  console.log(`   node ./src/runBilling.js --deal ${deal.id}`);
  console.log(`\nY para borrar todo al terminar, buscá en el portal por: ${PREFIX}\n`);
}

main().catch((err) => {
  console.error('❌ Error:', err?.message || err);
  process.exit(1);
});
