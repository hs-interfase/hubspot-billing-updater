#!/usr/bin/env node
/**
 * seedMirrorDeal.mjs
 *
 * Crea un deal PY con 3 line items para probar el sistema mirror PY→UY.
 * NO crea el mirror UY — eso lo hace el Phase Engine al procesar el deal.
 *
 * LI1 — Automático + mirror UY: 12 pagos mensuales, cupo por monto, IVA, precio=100 cant=10
 * LI2 — Manual + mirror UY:     1 pago único, parte del cupo, precio=500 cant=1
 * LI3 — Automático + mirror UY: facturar_ahora=true (prueba urgente → propagación mirror)
 *
 * Uso:
 *   node seedMirrorDeal.mjs
 *   node seedMirrorDeal.mjs --dry
 *
 * Para limpiar (borra PY + mirror UY + todos sus tickets/invoices):
 *   node cleanupMirrorDeal.mjs
 */

import 'dotenv/config';
import { hubspotClient } from './src/hubspotClient.js';
import fs from 'fs';

// ─── Config ────────────────────────────────────────────────────────────────────

const PREFIX     = '[TEST-MIRROR]';
const COMPANY_ID = '43833570850';
const DEAL_STAGE = 'closedwon';
const DRY_RUN    = process.argv.includes('--dry');

// ─── Fecha ─────────────────────────────────────────────────────────────────────

function todayYMD() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
}

const TODAY = todayYMD();

// ─── Helpers ───────────────────────────────────────────────────────────────────

async function createDeal(props) {
  if (DRY_RUN) {
    console.log(`  🔍 [DRY] Crearía deal: ${props.dealname}`);
    return { id: 'DRY_DEAL' };
  }
  const resp = await hubspotClient.crm.deals.basicApi.create({ properties: props });
  console.log(`  ✅ Deal creado: ${resp.id} — ${props.dealname}`);
  return resp;
}

async function createLineItem(props) {
  if (DRY_RUN) {
    console.log(`    🔍 [DRY] Crearía LI: ${props.name}`);
    return { id: 'DRY_LI' };
  }
  const resp = await hubspotClient.crm.lineItems.basicApi.create({ properties: props });
  console.log(`    📦 Line Item: ${resp.id} — ${props.name}`);
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

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  SEED MIRROR DEAL ${DRY_RUN ? '(DRY RUN)' : '— Producción'}`);
  console.log(`  Fecha base: ${TODAY}`);
  console.log('═══════════════════════════════════════════════════════════\n');

  // ── Deal PY ──────────────────────────────────────────────────────────────────
  console.log('🏗️  Creando deal Paraguay con cupo por monto...');

  const deal = await createDeal({
    dealname:           `${PREFIX} Mirror PY — Cupo Monto`,
    dealstage:          DEAL_STAGE,
    pipeline:           'default',
    facturacion_activa: 'true',
    pais_operativo:     'Paraguay',
    tipo_de_cupo:       'Por Monto',
    cupo_total_monto:   '10000',
    cupo_activo:        'true',
  });

  const dealId = deal.id;
  await associateCompanyToDeal(COMPANY_ID, dealId);
  console.log('    🔗 Company asociada\n');

  // ── LI1: Automático + mirror UY ──────────────────────────────────────────────
  // 12 pagos mensuales, parte del cupo, IVA, precio=100 cant=10 → total=1000
  console.log('📦 LI1 — Automático + mirror UY (12 pagos mensuales, cupo, IVA)');
  const li1 = await createLineItem({
    name:                            `${PREFIX} LI1-Auto-Mirror 12p cupo IVA`,
    price:                           '100',
    quantity:                        '10',
    recurringbillingfrequency:       'monthly',
    hs_recurring_billing_start_date: TODAY,
    hs_recurring_billing_period:     'P12M',
    facturacion_activa:              'true',
    facturacion_automatica:          'true',
    uy:                              'true',
    pais_operativo:                  'Paraguay',
    parte_del_cupo:                  'true',
    of_iva:                          'true',
  });
  await associateLineItemToDeal(li1.id, dealId);

  // ── LI2: Manual + mirror UY ──────────────────────────────────────────────────
  // 1 pago único, parte del cupo
  console.log('📦 LI2 — Manual + mirror UY (1 pago único, cupo)');
  const li2 = await createLineItem({
    name:                            `${PREFIX} LI2-Manual-Mirror 1p cupo`,
    price:                           '500',
    quantity:                        '1',
    hs_recurring_billing_start_date: TODAY,
    facturacion_activa:              'true',
    facturacion_automatica:          'false',
    uy:                              'true',
    pais_operativo:                  'Paraguay',
    parte_del_cupo:                  'true',
    of_iva:                          'false',
    // Sin recurringbillingfrequency ni hs_recurring_billing_period → pago único
  });
  await associateLineItemToDeal(li2.id, dealId);

  // ── LI3: Automático + mirror UY + facturar_ahora ─────────────────────────────
  // Para probar propagación urgente PY → UY:
  // urgentBillingService._propagateToMirror → promoteMirrorTicketToManualReady
  // → ticket UY pasa a READY + aviso en billing_error del deal UY
  console.log('📦 LI3 — Automático + mirror UY + facturar_ahora=true (prueba urgente)');
  const li3 = await createLineItem({
    name:                            `${PREFIX} LI3-Auto-Mirror urgente`,
    price:                           '300',
    quantity:                        '2',
    recurringbillingfrequency:       'monthly',
    hs_recurring_billing_start_date: TODAY,
    hs_recurring_billing_period:     'P6M',
    facturacion_activa:              'true',
    facturacion_automatica:          'true',
    uy:                              'true',
    pais_operativo:                  'Paraguay',
    parte_del_cupo:                  'false',
    of_iva:                          'false',
    facturar_ahora:                  'true',
  });
  await associateLineItemToDeal(li3.id, dealId);

  // ── Resumen ───────────────────────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  RESUMEN');
  console.log('═══════════════════════════════════════════════════════════\n');
  console.log(`📋 Deal PY ID: ${dealId}`);
  console.log(`   LI1 (auto + mirror + cupo + IVA, 12p): ${li1.id}`);
  console.log(`   LI2 (manual + mirror + cupo, 1p):      ${li2.id}`);
  console.log(`   LI3 (auto + mirror + facturar_ahora):  ${li3.id}`);
  console.log('');
  console.log('▶️  Correr billing:');
  console.log(`   node src/jobs/cronDealsBatch.js --deal ${dealId}`);
  console.log('');
  console.log('🔍 Qué esperar:');
  console.log('   Phase 1  → inicializa cupo por monto, crea deal mirror UY,');
  console.log('              sincroniza LI1/LI2/LI3 al deal UY');
  console.log('   Phase P  → tickets forecast automáticos para LI1 y LI3 (PY)');
  console.log('   Phase 2  → ticket manual READY para LI2 (PY)');
  console.log('              deal UY mirror skip (es_mirror_de_py=true)');
  console.log('   Phase 3  → LI1: factura PY → promoteMirrorTicketToManualReady');
  console.log('                   ticket forecast UY → pipeline manual READY');
  console.log('                   aviso en billing_error del deal UY');
  console.log('   Urgente  → LI3: facturar_ahora=true → urgentBillingService');
  console.log('              → _propagateToMirror → promoteMirrorTicketToManualReady');
  console.log('              → mismo flujo: ticket UY a READY + aviso en deal UY');
  console.log('');
  console.log('🧹 Para limpiar (PY + mirror UY + tickets + invoices):');
  console.log('   node cleanupMirrorDeal.mjs');
  console.log('');

  // ── Guardar manifest ──────────────────────────────────────────────────────────
  if (!DRY_RUN) {
    const manifest = {
      prefix:    PREFIX,
      createdAt: new Date().toISOString(),
      today:     TODAY,
      pyDealId:  dealId,
      lineItems: {
        li1: li1.id,
        li2: li2.id,
        li3: li3.id,
      },
    };
    fs.writeFileSync('mirror-seed-manifest.json', JSON.stringify(manifest, null, 2));
    console.log('💾 Manifest guardado en mirror-seed-manifest.json');
    console.log('   (usado por cleanupMirrorDeal.mjs)');
  }
}

main().catch(err => {
  console.error('❌ Error fatal:', err.message);
  if (err.response?.data) console.error(JSON.stringify(err.response.data, null, 2));
  process.exit(1);
});
