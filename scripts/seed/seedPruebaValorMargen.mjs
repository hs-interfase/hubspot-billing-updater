// scripts/seed/seedPruebaValorMargen.mjs
//
// CASO DE PRUEBA de la usuaria (2026-07-19) para validar VALOR TOTAL USD y MARGEN
// BRUTO USD del negocio, calculados desde TICKETS.
//
// ⚠️ CORRE CONTRA EL PORTAL DEL .env (debe ser SANDBOX/pruebas). NO usar en producción.
//
// El negocio:
//   moneda UYU · país operativo Uruguay · dólar = 40
//
//   3 × line item MANUAL (pago único, sin frecuencia)  40.000 c/u · costo USD 250 c/u
//       previstos al 2-ene-2028
//   1 × line item AUTO-RENEW mensual desde 2023, SIN fin  20.000/mes · sin costo
//   1 × line item PLAN FIJO mensual 2023→2024, 12 pagos    2.000/mes · sin costo
//
// VALOR esperado (USD, dólar 40):
//   3 manuales      120.000 / 40 =  3.000
//   auto-renew      12 meses del AÑO EN CURSO: 240.000 / 40 = 6.000
//   plan fijo       12 pagos × 2.000 = 24.000 / 40 =            600
//                                              TOTAL =        9.600
// COSTO esperado :  250 × 3 =                                    750
// MARGEN esperado:  9.600 − 750 =                              8.850
//
// Uso:
//   node ./scripts/seed/seedPruebaValorMargen.mjs            → crea el negocio
//   node ./scripts/seed/seedPruebaValorMargen.mjs --cleanup  → archiva lo creado

import 'dotenv/config';
import fs from 'node:fs';
import { hubspotClient } from '../../src/hubspotClient.js';

const MANIFEST = 'prueba-valor-margen-manifest.json';
const SUFIJO = process.env.SUFIJO || '';
const PREFIX = '[TEST-VALOR]';
const CLEANUP = process.argv.includes('--cleanup');

const DOLAR = '40';
const FECHA_MANUAL = '2028-01-02';
const INICIO_RECURRENTE = '2023-01-02';
const FIN_PLAN_FIJO = '2024-12-02';

async function createDeal(properties) {
  const d = await hubspotClient.crm.deals.basicApi.create({ properties });
  console.log(`  ✅ deal ${d.id}`);
  return d;
}

async function createLineItem(properties) {
  const li = await hubspotClient.crm.lineItems.basicApi.create({ properties });
  return li;
}

async function assocLiToDeal(liId, dealId) {
  await hubspotClient.crm.associations.v4.basicApi.create(
    'line_items', String(liId), 'deals', String(dealId),
    [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 20 }]
  );
}

async function cleanup() {
  if (!fs.existsSync(MANIFEST)) {
    console.error(`No existe ${MANIFEST}`);
    process.exit(1);
  }
  const m = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  console.log(`Archivando deal ${m.dealId} y ${m.lineItems.length} line items...`);
  for (const li of m.lineItems) {
    try { await hubspotClient.crm.lineItems.basicApi.archive(String(li.id)); } catch (e) { console.warn(`  li ${li.id}: ${e.message}`); }
  }
  // Los tickets que haya generado el motor se archivan aparte (ver of_deal_id).
  try { await hubspotClient.crm.deals.basicApi.archive(String(m.dealId)); } catch (e) { console.warn(`  deal: ${e.message}`); }
  console.log('✅ cleanup hecho (los TICKETS generados por el motor NO se tocan acá)');
  process.exit(0);
}

if (CLEANUP) await cleanup();

console.log(`Portal: ${process.env.HUBSPOT_ENV || '(sin HUBSPOT_ENV)'}`);
if (process.env.HUBSPOT_ENV !== 'sandbox') {
  console.error('\n⛔ ABORTADO: HUBSPOT_ENV no es "sandbox". Esta prueba NO se corre en producción.');
  process.exit(1);
}

console.log('\n🏗️  Creando negocio de prueba VALOR/MARGEN\n');

const deal = await createDeal({
  dealname: `${PREFIX}${SUFIJO} Valor y Margen USD desde tickets`,
  pipeline: 'default',
  dealstage: 'qualifiedtobuy',          // en pipeline: los tickets nacen como forecast
  deal_currency_code: 'UYU',
  pais_operativo: 'Uruguay',
  dolar: DOLAR,
  facturacion_activa: 'true',
});

const defs = [
  // ── 3 manuales, pago único, al 2-ene-2028 ──
  ...[1, 2, 3].map((i) => ({
    name: `${PREFIX} Manual ${i} — 40.000 UYU · costo 250 USD · 2-ene-2028`,
    price: '40000',
    quantity: '1',
    costo_total_usd: '250',
    hs_recurring_billing_start_date: FECHA_MANUAL,
    fecha_inicio_de_facturacion: FECHA_MANUAL,
    facturacion_automatica: 'false',    // MANUAL
    facturacion_activa: 'true',
    // sin recurringbillingfrequency y sin nº de pagos ⇒ pago ÚNICO
  })),
  // ── auto-renew mensual desde 2023, SIN fecha de fin ──
  {
    name: `${PREFIX} Auto-renew mensual — 20.000 UYU/mes · desde 2023 · sin fin`,
    price: '20000',
    quantity: '1',
    recurringbillingfrequency: 'monthly',
    hs_recurring_billing_start_date: INICIO_RECURRENTE,
    fecha_inicio_de_facturacion: INICIO_RECURRENTE,
    facturacion_automatica: 'true',
    facturacion_activa: 'true',
    // sin nº de pagos y CON frecuencia ⇒ AUTO-RENEW
  },
  // ── plan fijo mensual 2023→2024, 12 pagos ──
  {
    name: `${PREFIX} Plan fijo 12 pagos — 2.000 UYU/mes · 2023-2024`,
    price: '2000',
    quantity: '1',
    recurringbillingfrequency: 'monthly',
    hs_recurring_billing_start_date: INICIO_RECURRENTE,
    fecha_inicio_de_facturacion: INICIO_RECURRENTE,
    // ⚠️ hs_recurring_billing_number_of_payments es CALCULADA y de SOLO LECTURA:
    // el nº de pagos se define con el PERIODO (ISO-8601). P12M = 12 pagos mensuales.
    // Setearlo directo no hace nada (el LI queda como auto-renew).
    hs_recurring_billing_period: 'P12M',
    facturacion_automatica: 'true',
    facturacion_activa: 'true',
  },
];

const lineItems = [];
for (const d of defs) {
  const li = await createLineItem(d);
  await assocLiToDeal(li.id, deal.id);
  console.log(`  ✅ LI ${li.id} — ${d.name.replace(PREFIX + ' ', '')}`);
  lineItems.push({ id: li.id, name: d.name });
}

fs.writeFileSync(MANIFEST, JSON.stringify({ dealId: deal.id, lineItems }, null, 2));

console.log(`
${'='.repeat(70)}
NEGOCIO CREADO: ${deal.id}
${'='.repeat(70)}

ESPERADO (dólar 40):
  VALOR moneda original : 384.000 UYU
  VALOR USD             :   9.600
  COSTO USD             :     750
  MARGEN USD            :   8.850

Próximo paso — correr el motor sobre este deal:
  node ./src/runBilling.js --dealId ${deal.id}

Y verificar:
  node ./scripts/diagnostics/verifyValorMargenTickets.mjs ${deal.id}

Manifest: ${MANIFEST}   ·   Cleanup: node ./scripts/seed/seedPruebaValorMargen.mjs --cleanup
`);
process.exit(0);
