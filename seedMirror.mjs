#!/usr/bin/env node
/**
 * seedTestDeals.mjs
 *
 * Crea deal + line items de prueba en HubSpot para validar
 * el flujo Mirror PY→UY end-to-end.
 *
 * DEAL E — Mirror PY→UY: Verificación Completa
 *   E-LI1: Manual, cupo por monto, mensual 3p, uy=true
 *   E-LI2: Automático, 3p, fecha inicio futura cercana, uy=true
 *
 * Flujo de prueba:
 *   1. node seedTestDeals.mjs              → deal PY + 2 LIs
 *   2. node src/jobs/cronDealsBatch.js --deal <DEAL_ID>  → mirror UY creado
 *   3. Verificar: price mirror = cogs/qty, empresas, editar costo mirror
 *   4. Cambiar fecha_inicio_facturacion de E-LI2 a hoy en HubSpot
 *   5. Correr cron de nuevo → Phase 3 factura PY, ticket UY promovido + nota
 *
 * Uso:
 *   node seedTestDeals.mjs
 *   node seedTestDeals.mjs --dry
 *
 * Para limpiar:
 *   node cleanupTestDeals.mjs
 */

import 'dotenv/config';
import { hubspotClient } from './src/hubspotClient.js';
import fs from 'fs';

// ─── Config ────────────────────────────────────────────────────────────────────

const PREFIX     = '[TEST-SEED]';
const COMPANY_ID = process.env.TEST_COMPANY_ID || '43833570850';
const DEAL_STAGE = 'closedwon';   // 85%
const DRY_RUN    = process.argv.includes('--dry');

// ─── Fechas ────────────────────────────────────────────────────────────────────

function todayPlus(days) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

const TODAY  = todayPlus(0);
const PLUS_5 = todayPlus(5);

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

async function seedDeal(dealName, dealProps, lineItemDefs) {
  console.log(`\n🏗️  ${dealName}`);

  const deal = await createDeal({
    dealname:           `${PREFIX} ${dealName}`,
    dealstage:          DEAL_STAGE,
    pipeline:           'default',
    facturacion_activa: 'true',
    ...dealProps,
  });

  const dealId = deal.id;
  await associateCompanyToDeal(COMPANY_ID, dealId);
  console.log(`    🔗 Company asociada`);

  const lineItems = [];
  for (const liDef of lineItemDefs) {
    const li = await createLineItem({ facturacion_activa: 'true', ...liDef });
    await associateLineItemToDeal(li.id, dealId);
    lineItems.push({ id: li.id, name: liDef.name });
  }

  return { dealId, dealName, lineItems };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ESCENARIO E — Mirror PY→UY: Verificación Completa
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  SEED TEST DEALS ${DRY_RUN ? '(DRY RUN)' : '— Producción'}`);
  console.log(`  Fecha base: ${TODAY}`);
  console.log('═══════════════════════════════════════════════════════════');

  const results = [];

  // ─────────────────────────────────────────────────────────────────────────
  // DEAL E — Mirror PY→UY: Verificación Completa
  //
  // Deal PY con cupo por monto, 2 LIs con uy=true.
  // El motor crea el deal UY espejo automáticamente.
  //
  // E-LI1: Manual, cupo por monto, mensual 3p
  //   PY: price=1000, qty=3, cogs=1500, parte_del_cupo=true
  //   Mirror UY esperado: price = cogs/qty = 500, sin cupo, manual
  //   Verifica:
  //     - Cupo se calcula correctamente al cambiar cantidad
  //     - Mirror copia sin cupo (parte_del_cupo no se copia)
  //     - Costo editable en mirror no se sobreescribe en siguiente corrida
  //
  // E-LI2: Automático en PY, 3p, fecha inicio +5 días
  //   PY: price=2000, qty=1, cogs=800, facturacion_automatica=true
  //   Mirror UY esperado: price = cogs/qty = 800, manual, 3 pagos
  //   Verifica:
  //     - Mirror queda manual (facturacion_automatica=false forzado)
  //     - Cambiar fecha_inicio_facturacion antes del 1er promotion → acepta
  //     - billing_anchor_date + fecha vencimiento se actualizan al cambiar inicio
  //     - Cambiar fecha inicio a hoy → Phase 3 factura PY
  //     - Ticket UY promovido a READY manual + nota en deal mirror
  //     - Post-primer-promotion: solo billing_anchor_date cuenta
  //
  // Empresas en mirror UY:
  //   Primary = cliente final (TEST_COMPANY_ID / 52069639218)
  //   Empresa Factura = ISA PY (INTERFASE_PY_COMPANY_ID)
  // ─────────────────────────────────────────────────────────────────────────
  results.push(await seedDeal(
    'E — Mirror PY→UY Verificación Completa',
    {
      pais_operativo:   'Paraguay',
      tipo_de_cupo:     'Por Monto',
      cupo_total_monto: '50000',
      cupo_activo:      'true',
      cupo_consumido:   '0',
      cupo_restante:    '50000',
    },
    [
      {
        name: `${PREFIX} E-LI1: Manual cupo×monto mensual 3p`,
        price:                           '1000',
        quantity:                        '3',
        hs_cost_of_goods_sold:           '1500',
        recurringbillingfrequency:       'monthly',
        hs_recurring_billing_start_date: TODAY,
        hs_recurring_billing_period:     'P3M',
        facturacion_automatica:          'false',
        parte_del_cupo:                  'true',
        uy:                              'true',
        pais_operativo:                  'Paraguay',
      },
      {
        name: `${PREFIX} E-LI2: Auto 3p inicio +5d`,
        price:                           '2000',
        quantity:                        '1',
        hs_cost_of_goods_sold:           '800',
        recurringbillingfrequency:       'monthly',
        hs_recurring_billing_start_date: PLUS_5,
        hs_recurring_billing_period:     'P3M',
        facturacion_automatica:          'true',
        uy:                              'true',
        pais_operativo:                  'Paraguay',
      },
    ]
  ));

  // ─── Resumen ──────────────────────────────────────────────────────────────

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  RESUMEN — IDs para billing');
  console.log('═══════════════════════════════════════════════════════════\n');

  for (const r of results) {
    console.log(`📋 ${r.dealName}`);
    console.log(`   Deal ID: ${r.dealId}`);
    console.log(`   Comando: node src/jobs/cronDealsBatch.js --deal ${r.dealId}`);
    for (const li of r.lineItems) {
      console.log(`   └─ LI ${li.id}: ${li.name}`);
    }
    console.log('');
  }

  // ─── Expectativas ─────────────────────────────────────────────────────────

  console.log('═══════════════════════════════════════════════════════════');
  console.log('  EXPECTATIVAS POST-BILLING');
  console.log('═══════════════════════════════════════════════════════════\n');

  console.log(`Deal E — Mirror PY→UY Verificación Completa

  === Primera corrida ===

  PY Deal:
    E-LI1: 1 ticket READY manual (start=${TODAY}, dentro lookahead)
           cupo_consumido actualizado
    E-LI2: 3 tickets forecast auto (start=${PLUS_5}, Phase P crea, Phase 3 no ejecuta aún)

  Mirror UY (creado por el motor):
    E-LI1 mirror: price=500 (cogs 1500 / qty 3), manual, SIN cupo
    E-LI2 mirror: price=800 (cogs 800 / qty 1), manual, 3 pagos

  Empresas UY:
    Primary = cliente final (${COMPANY_ID})
    Empresa Factura = ISA PY (${process.env.INTERFASE_PY_COMPANY_ID || 'INTERFASE_PY_COMPANY_ID'})

  === Verificaciones manuales ===

  1. Editar hs_cost_of_goods_sold del mirror E-LI1 a un valor custom (ej: 2000)
     → Correr cron de nuevo → verificar que NO se sobreescribió (sigue en 2000)

  2. Cambiar cantidad de E-LI1 PY → verificar que cupo se recalcula

  3. Cambiar fecha_inicio_facturacion de E-LI2 PY a hoy
     → Correr cron → Phase 3 factura PY
     → Ticket UY promovido a READY manual
     → Nota en deal mirror avisando facturación PY

  4. Verificar que billing_anchor_date de E-LI2 se actualizó al cambiar fecha inicio

  5. Post-primer-promotion de E-LI2: cambiar fecha_inicio → no debe tener efecto
     Solo billing_anchor_date cuenta después del primer promotion
`);

  // ─── Manifest ─────────────────────────────────────────────────────────────

  if (!DRY_RUN) {
    const manifest = {
      prefix:    PREFIX,
      createdAt: new Date().toISOString(),
      today:     TODAY,
      deals:     results.map(r => ({
        dealId:      r.dealId,
        dealName:    r.dealName,
        lineItemIds: r.lineItems.map(li => li.id),
      })),
    };
    fs.writeFileSync('test-seed-manifest.json', JSON.stringify(manifest, null, 2));
    console.log('💾 Manifest guardado en test-seed-manifest.json');
    console.log('   (usado por cleanupTestDeals.mjs para borrar)');
  }
}

main().catch(err => {
  console.error('❌ Error fatal:', err.message);
  if (err.response?.data) console.error(JSON.stringify(err.response.data, null, 2));
  process.exit(1);
});
