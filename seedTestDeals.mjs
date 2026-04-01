#!/usr/bin/env node
/**
 * seedTestDeals.mjs
 * 
 * Crea deals + line items de prueba en HubSpot producción para validar
 * el Phase Engine end-to-end.
 * 
 * Uso:
 *   node seedTestDeals.mjs
 * 
 * Después de correr, anotar los IDs y ejecutar billing manualmente:
 *   node src/runBilling.js --deal <DEAL_ID>
 * 
 * Para limpiar:
 *   node cleanupTestDeals.mjs
 */

import 'dotenv/config';
import { hubspotClient } from './src/hubspotClient.js';

// ─── Config ────────────────────────────────────────────────────────────────────

const PREFIX = '[TEST-SEED]';
const COMPANY_ID = '43833570850';
const DEAL_STAGE = 'closedwon';  // 85%

// ─── Helpers de fecha ──────────────────────────────────────────────────────────

function todayPlus(days) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

const TODAY      = todayPlus(0);
const YESTERDAY  = todayPlus(-1);
const PLUS_29    = todayPlus(29);
const PLUS_30    = todayPlus(30);
const PLUS_31    = todayPlus(31);
const MINUS_60   = todayPlus(-60);  // para simular LI con historial

// ─── HubSpot helpers ───────────────────────────────────────────────────────────

async function createDeal(props) {
  const resp = await hubspotClient.crm.deals.basicApi.create({ properties: props });
  console.log(`  ✅ Deal creado: ${resp.id} — ${props.dealname}`);
  return resp;
}

async function createLineItem(props) {
  const resp = await hubspotClient.crm.lineItems.basicApi.create({ properties: props });
  console.log(`    📦 Line Item: ${resp.id} — ${props.name}`);
  return resp;
}

async function associateLineItemToDeal(lineItemId, dealId) {
  await hubspotClient.crm.associations.v4.basicApi.create(
    'line_items', String(lineItemId),
    'deals', String(dealId),
    [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 20 }]
  );
}

async function associateCompanyToDeal(companyId, dealId) {
  try {
    await hubspotClient.crm.associations.v4.basicApi.create(
      'companies', String(companyId),
      'deals', String(dealId),
      [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 342 }]
    );
  } catch (err) {
    console.warn(`    ⚠️  No se pudo asociar company ${companyId} a deal ${dealId}: ${err.message}`);
  }
}

// ─── Creador de deal + line items ──────────────────────────────────────────────

async function seedDeal(dealName, dealProps, lineItemDefs) {
  console.log(`\n🏗️  ${dealName}`);

  const deal = await createDeal({
    dealname: `${PREFIX} ${dealName}`,
    dealstage: DEAL_STAGE,
    pipeline: 'default',
    facturacion_activa: 'true',
    ...dealProps,
  });

  const dealId = deal.id;

  // Asociar company
  await associateCompanyToDeal(COMPANY_ID, dealId);
  console.log(`    🔗 Company asociada`);

  // Crear line items
  const lineItems = [];
  for (const liDef of lineItemDefs) {
    const li = await createLineItem({
      facturacion_activa: 'true',
      ...liDef,
    });
    await associateLineItemToDeal(li.id, dealId);
    lineItems.push({ id: li.id, name: liDef.name });
  }

  return { dealId, dealName, lineItems };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ESCENARIOS
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  SEED TEST DEALS — Producción');
  console.log(`  Fecha base: ${TODAY}`);
  console.log('═══════════════════════════════════════════════════════════');

  const results = [];

  // ─────────────────────────────────────────────────────────────────────────
  // DEAL A: Manual, plan fijo, Uruguay
  // Verifica: lookahead 30 días, pago único, bordes de fecha
  // ─────────────────────────────────────────────────────────────────────────

  results.push(await seedDeal(
    'A — Manual / Plan Fijo / UY',
    { pais_operativo: 'Uruguay' },
    [
      {
        name: `${PREFIX} A-LI1: Mensual 6 pagos start=yesterday`,
        price: '1000',
        quantity: '10',
        recurringbillingfrequency: 'monthly',
        hs_recurring_billing_start_date: YESTERDAY,
        hs_recurring_billing_period: 'P6M',
        facturacion_automatica: 'false',
      },
      {
        name: `${PREFIX} A-LI2: Mensual 3 pagos start=+30`,
        price: '2000',
        quantity: '5',
        recurringbillingfrequency: 'monthly',
        hs_recurring_billing_start_date: PLUS_30,
        hs_recurring_billing_period: 'P3M',
        facturacion_automatica: 'false',
      },
      {
        name: `${PREFIX} A-LI3: Mensual 3 pagos start=+29`,
        price: '1500',
        quantity: '8',
        recurringbillingfrequency: 'monthly',
        hs_recurring_billing_start_date: PLUS_29,
        hs_recurring_billing_period: 'P3M',
        facturacion_automatica: 'false',
      },
      {
        name: `${PREFIX} A-LI4: Pago único start=today`,
        price: '5000',
        quantity: '1',
        hs_recurring_billing_start_date: TODAY,
        facturacion_automatica: 'false',
        // Sin frequency → pago único
      },
    ]
  ));

  // ─────────────────────────────────────────────────────────────────────────
  // DEAL B: Automático, plan fijo vs auto-renew
  // ─────────────────────────────────────────────────────────────────────────

  results.push(await seedDeal(
    'B — Automático / Plan Fijo + Auto-Renew',
    { pais_operativo: 'Uruguay' },
    [
      {
        name: `${PREFIX} B-LI1: Auto mensual 4 pagos start=yesterday`,
        price: '3000',
        quantity: '1',
        recurringbillingfrequency: 'monthly',
        hs_recurring_billing_start_date: YESTERDAY,
        hs_recurring_billing_period: 'P4M',
        facturacion_automatica: 'true',
      },
      {
        name: `${PREFIX} B-LI2: Auto mensual auto-renew start=today`,
        price: '4000',
        quantity: '1',
        recurringbillingfrequency: 'monthly',
        hs_recurring_billing_start_date: TODAY,
        facturacion_automatica: 'true',
        renovacion_automatica: 'true',
      },
      {
        name: `${PREFIX} B-LI3: Auto trimestral 2 pagos start=+31`,
        price: '10000',
        quantity: '1',
        recurringbillingfrequency: 'quarterly',
        hs_recurring_billing_start_date: PLUS_31,
        hs_recurring_billing_period: 'P6M',
        facturacion_automatica: 'true',
      },
    ]
  ));

  // ─────────────────────────────────────────────────────────────────────────
  // DEAL C: Paraguay con mirror UY + cupo por horas
  // ─────────────────────────────────────────────────────────────────────────

  results.push(await seedDeal(
    'C — Paraguay / Mirror UY / Cupo Horas',
    {
      pais_operativo: 'Paraguay',
      tipo_de_cupo: 'Por Horas',
      cupo_total: '100',
      cupo_activo: 'true',
    },
    [
      {
        name: `${PREFIX} C-LI1: PY+UY cupo=true mensual 12p`,
        price: '500',
        quantity: '10',
        recurringbillingfrequency: 'monthly',
        hs_recurring_billing_start_date: TODAY,
        hs_recurring_billing_period: 'P12M',
        facturacion_automatica: 'false',
        uy: 'true',
        pais_operativo: 'Uruguay',
        parte_del_cupo: 'true',
      },
      {
        name: `${PREFIX} C-LI2: Solo PY cupo=true mensual 12p`,
        price: '700',
        quantity: '8',
        recurringbillingfrequency: 'monthly',
        hs_recurring_billing_start_date: TODAY,
        hs_recurring_billing_period: 'P12M',
        facturacion_automatica: 'false',
        uy: 'false',
        pais_operativo: 'Paraguay',
        parte_del_cupo: 'true',
      },
      {
        name: `${PREFIX} C-LI3: PY+UY cupo=false mensual 6p`,
        price: '2000',
        quantity: '1',
        recurringbillingfrequency: 'monthly',
        hs_recurring_billing_start_date: TODAY,
        hs_recurring_billing_period: 'P6M',
        facturacion_automatica: 'false',
        uy: 'true',
        pais_operativo: 'Uruguay',
        parte_del_cupo: 'false',
      },
    ]
  ));

  // ─────────────────────────────────────────────────────────────────────────
  // DEAL D: Cupo por monto + fecha ancla + fechas_completas
  // ─────────────────────────────────────────────────────────────────────────

  results.push(await seedDeal(
    'D — Cupo Monto / Fecha Ancla / Bordes',
    {
      pais_operativo: 'Uruguay',
      tipo_de_cupo: 'Por Monto',
      cupo_total_monto: '50000',
      cupo_activo: 'true',
    },
    [
      {
        name: `${PREFIX} D-LI1: Auto-renew mensual cupo=true`,
        price: '8000',
        quantity: '1',
        recurringbillingfrequency: 'monthly',
        hs_recurring_billing_start_date: TODAY,
        facturacion_automatica: 'true',
        renovacion_automatica: 'true',
        parte_del_cupo: 'true',
      },
      {
        name: `${PREFIX} D-LI2: Pago único start=yesterday (ya pasó)`,
        price: '15000',
        quantity: '1',
        hs_recurring_billing_start_date: YESTERDAY,
        facturacion_automatica: 'false',
        parte_del_cupo: 'true',
      },
      {
        name: `${PREFIX} D-LI3: fechas_completas=true (hard stop)`,
        price: '3000',
        quantity: '5',
        recurringbillingfrequency: 'monthly',
        hs_recurring_billing_start_date: MINUS_60,
        hs_recurring_billing_period: 'P12M',
        facturacion_automatica: 'false',
        fechas_completas: 'true',
        parte_del_cupo: 'false',
      },
    ]
  ));

  // ─── Resumen ─────────────────────────────────────────────────────────────

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  RESUMEN — IDs para billing');
  console.log('═══════════════════════════════════════════════════════════\n');

  for (const r of results) {
    console.log(`📋 ${r.dealName}`);
    console.log(`   Deal ID: ${r.dealId}`);
    console.log(`   Comando: node src/runBilling.js --deal ${r.dealId}`);
    for (const li of r.lineItems) {
      console.log(`   └─ LI ${li.id}: ${li.name}`);
    }
    console.log('');
  }

  // Guardar IDs para cleanup
  const manifest = {
    prefix: PREFIX,
    createdAt: new Date().toISOString(),
    today: TODAY,
    deals: results.map(r => ({
      dealId: r.dealId,
      dealName: r.dealName,
      lineItemIds: r.lineItems.map(li => li.id),
    })),
  };

  const fs = await import('fs');
  fs.writeFileSync('test-seed-manifest.json', JSON.stringify(manifest, null, 2));
  console.log('💾 Manifest guardado en test-seed-manifest.json');
  console.log('   (usado por cleanupTestDeals.mjs para borrar)');

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  EXPECTATIVAS POST-BILLING');
  console.log('═══════════════════════════════════════════════════════════\n');

  console.log(`Deal A (Manual/Plan Fijo):
  A-LI1: 6 forecast tickets (mensual desde ${YESTERDAY})
  A-LI2: 3 forecast tickets (mensual desde ${PLUS_30})
  A-LI3: 3 forecast tickets (mensual desde ${PLUS_29})
  A-LI4: 1 forecast ticket  (pago único ${TODAY})
  TOTAL: 13 tickets

Deal B (Automático/Plan Fijo + Auto-Renew):
  B-LI1: 4 forecast tickets (mensual desde ${YESTERDAY}, plan fijo 4)
  B-LI2: ~24 forecast tickets (auto-renew mensual desde ${TODAY})
  B-LI3: 2 forecast tickets (trimestral desde ${PLUS_31}, plan fijo 2)
  TOTAL: ~30 tickets

Deal C (Paraguay + Mirror):
  Mirror UY creado: SÍ (C-LI1 y C-LI3 tienen uy=true)
  C-LI1: 12 forecast tickets PY + 12 mirror UY
  C-LI2: 12 forecast tickets (solo PY, uy=false)
  C-LI3: 6 forecast tickets PY + 6 mirror UY
  Cupo inicializado: cupo_consumido=0, cupo_restante=100
  TOTAL PY: 30 tickets, TOTAL mirror UY: 18 tickets

Deal D (Cupo Monto + Bordes):
  D-LI1: ~24 forecast tickets (auto-renew)
  D-LI2: 1 forecast ticket (pago único, start=yesterday)
  D-LI3: 0 tickets (fechas_completas=true → hard stop)
  Cupo monto inicializado: 50000
  TOTAL: ~25 tickets
`);
}

main().catch(err => {
  console.error('❌ Error fatal:', err.message);
  if (err.response?.data) console.error(JSON.stringify(err.response.data, null, 2));
  process.exit(1);
});
