#!/usr/bin/env node
/**
 * seedMigration.mjs
 *
 * Crea 1 deal PY de prueba con 7 line items que simulan los escenarios
 * reales de la migración Mansoft → HubSpot.
 *
 * Los 7 LIs cubren:
 *   M1 — per_two_years, 1 pago, plan fijo ya vencido (2022-08)
 *   M2 — monthly, 12 pagos, plan fijo (renovación pendiente en nombre)
 *   M3 — annually, 1 pago, plan fijo 2025
 *   M4 — quarterly, 4 pagos, plan fijo 2025
 *   M5 — monthly, auto-renew (2099), start pasado (2023-12)
 *   M6 — annually, auto-renew (2099), start futuro (2025-06)
 *   M7 — per_six_months, auto-renew (2099), start muy viejo (2012-08)
 *
 * Todos llegan con:
 *   - facturacion_automatica = true
 *   - mansoft_pendiente = false
 *   - mansoft_tipo_aviso = '' (vacío)
 *   - mansoft_ultimo_snapshot = JSON con watched props
 *
 * Verificaciones post-cron:
 *   ✓ Cantidad correcta de tickets forecast por LI
 *   ✓ mansoft_pendiente sigue en false (no se disparó alta)
 *   ✓ mansoft_tipo_aviso sigue vacío
 *   ✓ mansoft_ultimo_snapshot no fue sobreescrito (debe quedar igual)
 *
 * Uso:
 *   node seedMigration.mjs              # real
 *   node seedMigration.mjs --dry        # dry run
 *
 * Después:
 *   node src/jobs/cronDealsBatch.js --deal <DEAL_ID>
 *
 * Para limpiar:
 *   node cleanupTestDeals.mjs --prefix "[MIG-SEED]"
 */

import 'dotenv/config';
import { hubspotClient } from '../../src/hubspotClient.js';
import fs from 'fs';

// ─── Config ────────────────────────────────────────────────────────────────────

const PREFIX     = '[MIG-SEED]';
const COMPANY_ID = process.env.TEST_COMPANY_ID || '43833570850';
const DEAL_STAGE = 'closedwon';   // 85%
const DRY_RUN    = process.argv.includes('--dry');

// ─── Helpers HubSpot ───────────────────────────────────────────────────────────

async function createDeal(props) {
  if (DRY_RUN) {
    console.log(`  🔍 [DRY] Crearía deal: ${props.dealname}`);
    return { id: `DRY_DEAL_${Math.random().toString(36).slice(2, 6)}` };
  }
  const resp = await hubspotClient.crm.deals.basicApi.create({ properties: props });
  console.log(`  ✅ Deal creado: ${resp.id} — ${props.dealname}`);
  return resp;
}

async function createLineItem(props) {
  if (DRY_RUN) {
    console.log(`    🔍 [DRY] Crearía LI: ${props.name}`);
    return { id: `DRY_LI_${Math.random().toString(36).slice(2, 6)}` };
  }
  const resp = await hubspotClient.crm.lineItems.basicApi.create({ properties: props });
  console.log(`    📦 LI: ${resp.id} — ${props.name}`);
  return resp;
}

async function associateLineItemToDeal(lineItemId, dealId) {
  if (DRY_RUN) return;
  await hubspotClient.crm.associations.v4.basicApi.create(
    'line_items', String(lineItemId),
    'deals',      String(dealId),
    [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 20 }]
  );
}

async function associateCompanyToDeal(companyId, dealId) {
  if (DRY_RUN) return;
  try {
    await hubspotClient.crm.associations.v4.basicApi.create(
      'companies', String(companyId),
      'deals',     String(dealId),
      [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 342 }]
    );
  } catch (err) {
    console.warn(`    ⚠️  No se pudo asociar company: ${err.message}`);
  }
}

// ─── Snapshot helper ───────────────────────────────────────────────────────────

/**
 * Construye el JSON snapshot idéntico a lo que buildMansoftSnapshot() produciría.
 * Props que no aplican van como null.
 */
function buildSnapshot(overrides = {}) {
  const base = {
    billing_anchor_date: null,
    hs_recurring_billing_start_date: null,
    price: null,
    quantity: null,
    hs_discount_percentage: null,
    of_iva: null,
    exonera_irae: null,
    of_moneda: null,
    recurringbillingfrequency: null,
    hs_recurring_billing_frequency: null,
    hs_recurring_billing_number_of_payments: null,
    renovacion_automatica: null,
    description: null,
    observaciones: null,
    nota: null,
    pausa: null,
  };
  return JSON.stringify({ ...base, ...overrides });
}

// ─── Line item definitions ─────────────────────────────────────────────────────

const LINE_ITEMS = [
  {
    // M1 — per_two_years, 1 pago, plan fijo, YA VENCIDO (2022-08)
    // Esperado: 1 ticket forecast (ya pasado), se promueve a READY
    label: 'M1',
    props: {
      name:                                `${PREFIX} M1: Mant All Inclusive 2do nivel POS (bianual 1p vencido)`,
      hs_product_id:                       '41943895217',
      price:                               '40',
      quantity:                            '1',
      recurringbillingfrequency:           'per_two_years',
      hs_recurring_billing_start_date:     '2022-08-01',
      hs_recurring_billing_period:         'P24M',
      hs_recurring_billing_number_of_payments: '1',
      momento_de_facturacion:              'adelantado',
    },
    snapshot: {
      billing_anchor_date: '2022-08-01', 
      hs_recurring_billing_start_date: '2022-08-01',
      price: '40',
      quantity: '1',
      recurringbillingfrequency: 'per_two_years',
      hs_recurring_billing_number_of_payments: '1',
    },
  },
  {
    // M2 — monthly, 12 pagos, plan fijo, renovación pendiente
    // Esperado: 12 tickets forecast, los pasados promovidos a READY
    label: 'M2',
    props: {
      name:                                `${PREFIX} M2: Sop Mant iGDoc Antel (mensual 12p)`,
      hs_product_id:                       '42010367402',
      price:                               '84000',
      quantity:                            '1',
      recurringbillingfrequency:           'monthly',
      hs_recurring_billing_start_date:     '2024-09-04',
      fecha_vencimiento_contrato:          '2025-09-03',
      hs_recurring_billing_period:         'P12M',
      hs_recurring_billing_number_of_payments: '12',
      momento_de_facturacion:              'vencido',
    },
    snapshot: {
        billing_anchor_date: '2024-09-04',
      hs_recurring_billing_start_date: '2024-09-04',
      price: '84000',
      quantity: '1',
      recurringbillingfrequency: 'monthly',
      hs_recurring_billing_number_of_payments: '12',
    },
  },
  {
    // M3 — annually, 1 pago, plan fijo 2025
    // Esperado: 1 ticket forecast
    label: 'M3',
    props: {
      name:                                `${PREFIX} M3: SMS Payroll DGI (anual 1p)`,
      hs_product_id:                       '42010367404',
      price:                               '84983.17',
      quantity:                            '1',
      recurringbillingfrequency:           'annually',
      hs_recurring_billing_start_date:     '2025-01-01',
      fecha_vencimiento_contrato:          '2025-12-31',
      hs_recurring_billing_period:         'P12M',
      hs_recurring_billing_number_of_payments: '1',
      momento_de_facturacion:              'fin_de_mes',
    },
    snapshot: {
      billing_anchor_date: '2025-01-01',
      hs_recurring_billing_start_date: '2025-01-01',
      price: '84983.17',
      quantity: '1',
      recurringbillingfrequency: 'annually',
      hs_recurring_billing_number_of_payments: '1',
    },
  },
  {
    // M4 — quarterly, 4 pagos, plan fijo 2025
    // Esperado: 4 tickets forecast (ene, abr, jul, oct)
    label: 'M4',
    props: {
      name:                                `${PREFIX} M4: Sop Técnico Canelones (trimestral 4p)`,
      hs_product_id:                       '42010367402',
      price:                               '472283.07',
      quantity:                            '1',
      recurringbillingfrequency:           'quarterly',
      hs_recurring_billing_start_date:     '2025-01-01',
      fecha_vencimiento_contrato:          '2025-12-31',
      hs_recurring_billing_period:         'P12M',
      hs_recurring_billing_number_of_payments: '4',
      momento_de_facturacion:              'fin_de_mes',
    },
    snapshot: {
      billing_anchor_date: '2025-01-01',
      hs_recurring_billing_start_date: '2025-01-01',
      price: '472283.07',
      quantity: '1',
      recurringbillingfrequency: 'quarterly',
      hs_recurring_billing_number_of_payments: '4',
    },
  },
  {
    // M5 — monthly, auto-renew (sin number_of_payments), start pasado
    // Esperado: hasta 24 tickets forecast (lookahead), los pasados promovidos
    label: 'M5',
    props: {
      name:                                `${PREFIX} M5: Sop MIFACTURA Central Seguros (mensual auto-renew)`,
      hs_product_id:                       '42010181659',
      price:                               '263.63',
      quantity:                            '1',
      recurringbillingfrequency:           'monthly',
      hs_recurring_billing_start_date:     '2023-12-21',
      fecha_vencimiento_contrato:          '2099-12-31',
      momento_de_facturacion:              'adelantado',
    },
    snapshot: {
      billing_anchor_date: '2023-12-21',
      hs_recurring_billing_start_date: '2023-12-21',
      price: '263.63',
      quantity: '1',
      recurringbillingfrequency: 'monthly',
    },
  },
  {
    // M6 — annually, auto-renew, start futuro (2025-06-01)
    // Esperado: 1 ticket forecast si está dentro del lookahead, 0 si no
    label: 'M6',
    props: {
      name:                                `${PREFIX} M6: Sop Anual MIFACTURA Consorcio (anual auto-renew futuro)`,
      hs_product_id:                       '42010181659',
      price:                               '35.98',
      quantity:                            '1',
      recurringbillingfrequency:           'annually',
      hs_recurring_billing_start_date:     '2025-06-01',
      fecha_vencimiento_contrato:          '2099-12-31',
      momento_de_facturacion:              'adelantado',
    },
    snapshot: {
      billing_anchor_date: '2025-06-01',
      hs_recurring_billing_start_date: '2025-06-01',
      price: '35.98',
      quantity: '1',
      recurringbillingfrequency: 'annually',
    },
  },
  {
    // M7 — per_six_months, auto-renew, start muy viejo (2012)
    // Esperado: hasta 24 tickets forecast, muchos ya promovidos
    label: 'M7',
    props: {
      name:                                `${PREFIX} M7: ASIST TEC URG METRO SURT Pinamar (semestral auto-renew viejo)`,
      hs_product_id:                       '41943895217',
      price:                               '11349',
      quantity:                            '1',
      recurringbillingfrequency:           'per_six_months',
      hs_recurring_billing_start_date:     '2012-08-01',
      fecha_vencimiento_contrato:          '2099-12-31',
      momento_de_facturacion:              'adelantado',
    },
    snapshot: {
      billing_anchor_date: '2012-08-01',    
      hs_recurring_billing_start_date: '2012-08-01',
      price: '11349',
      quantity: '1',
      recurringbillingfrequency: 'per_six_months',
    },
  },
];

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  SEED MIGRACIÓN MANSOFT ${DRY_RUN ? '(DRY RUN)' : '— Producción'}`);
  console.log('═══════════════════════════════════════════════════════════');

  // ── Deal ──────────────────────────────────────────────────────────────────

  console.log('\n🏗️  Creando deal PY...');
  const deal = await createDeal({
    dealname:           `${PREFIX} Migración Mansoft — 7 escenarios`,
    dealstage:          DEAL_STAGE,
    pipeline:           'default',
    facturacion_activa: 'true',
    pais_operativo:     'Paraguay',
    deal_currency_code: 'USD',
  });

  const dealId = deal.id;
  await associateCompanyToDeal(COMPANY_ID, dealId);
  console.log(`    🔗 Company asociada`);

  // ── Line Items ────────────────────────────────────────────────────────────

  const createdLIs = [];

  for (const liDef of LINE_ITEMS) {
    console.log(`\n  📦 ${liDef.label}: ${liDef.props.name.replace(PREFIX + ' ', '')}`);

    const snapshot = buildSnapshot(liDef.snapshot);

    const li = await createLineItem({
      facturacion_activa:       'true',
      facturacion_automatica:   'true',
      mansoft_pendiente:        'false',
      mansoft_tipo_aviso:       '',
      mansoft_ultimo_snapshot:  snapshot,
      pais_operativo:           'Paraguay',
      ...liDef.props,
    });

    await associateLineItemToDeal(li.id, dealId);
    createdLIs.push({ id: li.id, label: liDef.label, name: liDef.props.name });
  }

  // ── Manifest ──────────────────────────────────────────────────────────────

  const manifest = {
    prefix:    PREFIX,
    createdAt: new Date().toISOString(),
    deals: [{
      dealId,
      dealName: `${PREFIX} Migración Mansoft — 7 escenarios`,
      lineItemIds: createdLIs.map(li => li.id),
    }],
  };

  if (!DRY_RUN) {
    fs.writeFileSync('migration-seed-manifest.json', JSON.stringify(manifest, null, 2));
    console.log('\n💾 Manifest guardado en migration-seed-manifest.json');
  }

  // ── Resumen ───────────────────────────────────────────────────────────────

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  RESULTADO');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`\n  Deal ID: ${dealId}`);
  for (const li of createdLIs) {
    console.log(`    ${li.label} — ${li.id}`);
  }

  console.log('\n─── PRÓXIMOS PASOS ─────────────────────────────────────────');
  console.log(`\n  1. Correr phases:`);
  console.log(`     node src/jobs/cronDealsBatch.js --deal ${dealId}\n`);
  console.log('  2. Verificar en HubSpot:');
  console.log('     ✓ Tickets forecast generados por cada LI');
  console.log('     ✓ mansoft_pendiente sigue en false');
  console.log('     ✓ mansoft_tipo_aviso sigue vacío');
  console.log('     ✓ mansoft_ultimo_snapshot no fue sobreescrito\n');
  console.log('  3. Correr cron Mantsoft (debe ser no-op):');
  console.log(`     node src/jobs/cronMensajeMantsoft.js --deal ${dealId}\n`);
  console.log('  4. Verificar que NO se generó mensaje_mansoft en el deal\n');
  console.log('  5. Para limpiar:');
  console.log(`     node cleanupTestDeals.mjs --prefix "${PREFIX}"`);
  console.log('─────────────────────────────────────────────────────────────\n');

  console.log('─── TICKETS ESPERADOS ──────────────────────────────────────');
  console.log('  M1 (bianual 1p vencido):        1 ticket → READY (pasado)');
  console.log('  M2 (mensual 12p):              12 tickets → pasados a READY');
  console.log('  M3 (anual 1p):                  1 ticket');
  console.log('  M4 (trimestral 4p):             4 tickets');
  console.log('  M5 (mensual auto-renew):       24 tickets (lookahead max)');
  console.log('  M6 (anual auto-renew futuro):   depende de lookahead');
  console.log('  M7 (semestral auto-renew viejo): hasta 24 tickets');
  console.log('─────────────────────────────────────────────────────────────\n');
}

main().catch(err => {
  console.error('❌ Error fatal:', err.message);
  if (err.response?.data) console.error(JSON.stringify(err.response.data, null, 2));
  process.exit(1);
});
