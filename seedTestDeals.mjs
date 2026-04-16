#!/usr/bin/env node
/**
 * seedTestDeals.mjs
 *
 * Crea deals + line items de prueba en HubSpot producción para validar
 * el Phase Engine end-to-end.
 *
 * DEALS:
 *   A — Manual UY: plan fijo pocos pagos + pago único + borde lookahead
 *   B — Automático UY: plan fijo pocos pagos + un auto-renew
 *   C — Cupo por Monto UY: para testear bug subtotal vs total
 *   D — Mirror PY: deal Paraguay con LIs uy=true (el motor crea el UY solo)
 *
 * Número de pagos: se controla con hs_recurring_billing_period en formato ISO 8601
 *   P2M = 2 pagos mensuales
 *   P3M = 3 pagos mensuales
 *   (sin hs_recurring_billing_period + sin recurringbillingfrequency = pago único)
 *
 * Uso:
 *   node seedTestDeals.mjs
 *   node seedTestDeals.mjs --dry
 *
 * Después:
 *   node src/jobs/cronDealsBatch.js --deal <DEAL_ID>
 *
 * Para limpiar:
 *   node cleanupTestDeals.mjs
 */

import 'dotenv/config';
import { hubspotClient } from './src/hubspotClient.js';
import fs from 'fs';

// ─── Config ────────────────────────────────────────────────────────────────────

const PREFIX     = '[TEST-SEED]';
const COMPANY_ID = '52069639218';
const DEAL_STAGE = 'closedwon';   // 85%
const DRY_RUN    = process.argv.includes('--dry');

// ─── Fechas ────────────────────────────────────────────────────────────────────

function todayPlus(days) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

const TODAY     = todayPlus(0);
const YESTERDAY = todayPlus(-1);
const PLUS_29   = todayPlus(29);
const PLUS_30   = todayPlus(30);
const PLUS_31   = todayPlus(31);

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
// ESCENARIOS
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  SEED TEST DEALS ${DRY_RUN ? '(DRY RUN)' : '— Producción'}`);
  console.log(`  Fecha base: ${TODAY}`);
  console.log('═══════════════════════════════════════════════════════════');

  const results = [];

  // ─────────────────────────────────────────────────────────────────────────
  // DEAL A — Manual UY: plan fijo + pago único + bordes de lookahead
  //
  // Verifica:
  //   - LI dentro de lookahead 30d → ticket READY
  //   - LI en borde exacto (start=+30) → entra; (start=+31) → no entra
  //   - Pago único (sin frequency ni period) → 1 ticket, no más
  //   - Número finito de pagos respetado (3p y 2p)
  //   - Idempotencia: 2da corrida no duplica tickets
  // ─────────────────────────────────────────────────────────────────────────
  results.push(await seedDeal(
    'A — Manual / Plan Fijo / UY',
    { pais_operativo: 'Uruguay' },
    [
      {
        // Mensual 3 pagos, start=ayer → 1er pago dentro del lookahead → 1 ticket READY
        name: `${PREFIX} A-LI1: Manual mensual 3p start=yesterday`,
        price:                           '1000',
        quantity:                        '1',
        recurringbillingfrequency:       'monthly',
        hs_recurring_billing_start_date: YESTERDAY,
        hs_recurring_billing_period:     'P3M',   // 3 pagos mensuales
        facturacion_automatica:          'false',
      },
      {
        // Mensual 2 pagos, start=+30 → borde exacto del lookahead → debe entrar
        name: `${PREFIX} A-LI2: Manual mensual 2p start=+30 (borde IN)`,
        price:                           '2000',
        quantity:                        '1',
        recurringbillingfrequency:       'monthly',
        hs_recurring_billing_start_date: PLUS_30,
        hs_recurring_billing_period:     'P2M',   // 2 pagos mensuales
        facturacion_automatica:          'false',
      },
      {
        // Mensual 2 pagos, start=+31 → fuera del lookahead → NO genera ticket aún
        name: `${PREFIX} A-LI3: Manual mensual 2p start=+31 (borde OUT)`,
        price:                           '1500',
        quantity:                        '1',
        recurringbillingfrequency:       'monthly',
        hs_recurring_billing_start_date: PLUS_31,
        hs_recurring_billing_period:     'P2M',   // 2 pagos mensuales
        facturacion_automatica:          'false',
      },
      {
        // Pago único start=today → exactamente 1 ticket, nunca más
        // Sin recurringbillingfrequency ni hs_recurring_billing_period = pago único
        name: `${PREFIX} A-LI4: Manual pago único start=today`,
        price:                           '5000',
        quantity:                        '1',
        hs_recurring_billing_start_date: TODAY,
        facturacion_automatica:          'false',
      },
    ]
  ));

  // ─────────────────────────────────────────────────────────────────────────
  // DEAL B — Automático UY: plan fijo + un solo auto-renew
  //
  // Verifica:
  //   - Fase 3 emite factura automática sin intervención
  //   - Plan fijo: exactamente N tickets, no más
  //   - Auto-renew: Phase P genera ventana de tickets hacia adelante
  //   - billing_anchor_date inicializada en cada LI
  //   - Idempotencia: 2da corrida no re-emite factura de B-LI1
  // ─────────────────────────────────────────────────────────────────────────
  results.push(await seedDeal(
    'B — Automático / Plan Fijo + Auto-Renew / UY',
    { pais_operativo: 'Uruguay' },
    [
      {
        // Auto mensual 3 pagos, start=ayer → fase 3 emite la 1ra factura hoy
        name: `${PREFIX} B-LI1: Auto mensual 3p start=yesterday`,
        price:                           '3000',
        quantity:                        '1',
        recurringbillingfrequency:       'monthly',
        hs_recurring_billing_start_date: YESTERDAY,
        hs_recurring_billing_period:     'P3M',   // 3 pagos mensuales
        facturacion_automatica:          'true',
      },
      {
        // Auto mensual 2 pagos, start=+29 → Phase P crea forecasts, fase 3 no ejecuta aún
        name: `${PREFIX} B-LI2: Auto mensual 2p start=+29`,
        price:                           '4000',
        quantity:                        '1',
        recurringbillingfrequency:       'monthly',
        hs_recurring_billing_start_date: PLUS_29,
        hs_recurring_billing_period:     'P2M',   // 2 pagos mensuales
        facturacion_automatica:          'true',
      },
      {
        // Auto mensual auto-renew, start=today → el único auto-renew del suite
        // Sin hs_recurring_billing_period → renovación indefinida
        // Phase P debe generar ventana acotada (no infinita)
        name: `${PREFIX} B-LI3: Auto mensual auto-renew start=today`,
        price:                           '2000',
        quantity:                        '1',
        recurringbillingfrequency:       'monthly',
        hs_recurring_billing_start_date: TODAY,
        facturacion_automatica:          'true',
        renovacion_automatica:           'true',
      },
    ]
  ));

  // ─────────────────────────────────────────────────────────────────────────
  // DEAL C — Cupo por Monto UY (testeo bug subtotal vs total)
  //
  // Diseño deliberado para que subtotal ≠ total:
  //   C-LI1: precio=1000, qty=2, descuento=10%, IVA=sí (UY, ID 16912720)
  //     subtotal_real         = 1000 × 2 = 2000
  //     con descuento 10%     = 1800
  //     con IVA 22%           ≈ 2196
  //     cupo debe consumir 2000 (subtotal), NO 2196 (total)
  //
  //   C-LI2: precio=500, qty=3, sin descuento, sin IVA
  //     subtotal_real = total = 1500
  //     cupo debe consumir 1500
  //
  //   Cupo total=10000 → estado correcto post-facturación: consumido=3500, restante=6500
  //   Si hay bug en C-LI1: consumido≠3500 → confirma la corrección necesaria
  // ─────────────────────────────────────────────────────────────────────────
  results.push(await seedDeal(
    'C — Cupo Monto / Bug Subtotal / UY',
    {
      pais_operativo:   'Uruguay',
      tipo_de_cupo:     'Por Monto',
      cupo_total_monto: '10000',
      cupo_activo:      'true',
      cupo_consumido:   '0',
      cupo_restante:    '10000',
    },
    [
      {
        // Auto 2 pagos, descuento 10% e IVA UY → subtotal(2000) ≠ total(~2196)
        // Permite verificar si cupo consume subtotal o total
        name: `${PREFIX} C-LI1: Cupo auto desc+IVA subtotal=2000`,
        price:                           '1000',
        quantity:                        '2',
        hs_discount_percentage:          '10',
        hs_tax_rate_group_id:            '17287244', // IVA Uruguay
        recurringbillingfrequency:       'monthly',
        hs_recurring_billing_start_date: TODAY,
        hs_recurring_billing_period:     'P2M',   // 2 pagos mensuales
        facturacion_automatica:          'true',
        parte_del_cupo:                  'true',
      },
      {
        // Manual pago único, sin descuento ni IVA → subtotal=total=1500 (caso control)
        // Sin recurringbillingfrequency ni hs_recurring_billing_period = pago único
        name: `${PREFIX} C-LI2: Cupo manual sin desc subtotal=1500`,
        price:                           '500',
        quantity:                        '3',
        hs_recurring_billing_start_date: TODAY,
        facturacion_automatica:          'false',
        parte_del_cupo:                  'true',
      },
    ]
  ));

  // ─────────────────────────────────────────────────────────────────────────
  // DEAL D — Mirror PY → UY (el motor crea el deal UY solo)
  //
  // Verifica:
  //   - Phase 1 crea deal espejo UY automáticamente (no lo creamos acá)
  //   - LIs con uy=true → sincronizados al espejo
  //   - LIs con uy=false → solo en PY, no se espeja
  //   - Espejo UY: facturacion_automatica siempre false (aunque PY sea auto)
  //   - Idempotencia: 2da corrida no duplica deal UY ni sus LIs
  // ─────────────────────────────────────────────────────────────────────────
  results.push(await seedDeal(
    'D — Mirror PY→UY (motor crea espejo)',
    { pais_operativo: 'Paraguay' },
    [
      {
        // PY auto 3p + UY → en UY queda manual (forzado por el motor)
        name: `${PREFIX} D-LI1: PY+UY auto 3p`,
        price:                           '800',
        quantity:                        '1',
        recurringbillingfrequency:       'monthly',
        hs_recurring_billing_start_date: TODAY,
        hs_recurring_billing_period:     'P3M',   // 3 pagos mensuales
        facturacion_automatica:          'true',
        uy:                              'true',
        pais_operativo:                  'Paraguay',
      },
      {
        // Solo PY, no se espeja (uy=false)
        name: `${PREFIX} D-LI2: Solo PY manual 2p`,
        price:                           '600',
        quantity:                        '1',
        recurringbillingfrequency:       'monthly',
        hs_recurring_billing_start_date: TODAY,
        hs_recurring_billing_period:     'P2M',   // 2 pagos mensuales
        facturacion_automatica:          'false',
        uy:                              'false',
        pais_operativo:                  'Paraguay',
      },
      {
        // PY+UY pago único manual
        // Sin recurringbillingfrequency ni hs_recurring_billing_period = pago único
        name: `${PREFIX} D-LI3: PY+UY pago único manual`,
        price:                           '1200',
        quantity:                        '1',
        hs_recurring_billing_start_date: TODAY,
        facturacion_automatica:          'false',
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
  console.log('  EXPECTATIVAS POST-BILLING (primera corrida)');
  console.log('═══════════════════════════════════════════════════════════\n');

  console.log(`Deal A — Manual / Plan Fijo
  A-LI1: 1 ticket READY  (mensual 3p, start=${YESTERDAY} → dentro lookahead)
  A-LI2: 1 ticket READY  (mensual 2p, start=${PLUS_30}  → borde IN)
  A-LI3: 0 tickets       (mensual 2p, start=${PLUS_31}  → borde OUT, no entra)
  A-LI4: 1 ticket READY  (pago único today)
  TOTAL: 3 tickets — idempotencia: 2da corrida = mismos 3, sin duplicados
`);

  console.log(`Deal B — Automático
  B-LI1: 1 factura EMITIDA (auto 3p, start=${YESTERDAY} → fase 3 ejecuta)
         2 tickets forecast restantes en Phase P
  B-LI2: 2 tickets forecast (auto 2p, start=${PLUS_29} → fuera de fase 3)
  B-LI3: ~3 tickets forecast (auto-renew, Phase P ventana ~90 días)
  billing_anchor_date: inicializada en cada LI
  Idempotencia: 2da corrida no re-emite factura de B-LI1
`);

  console.log(`Deal C — Cupo por Monto (bug subtotal)
  C-LI1: 1 factura EMITIDA (auto 2p)
         cupo_consumido esperado: 2000 (subtotal_real)
         si hay bug:              ~2196 (total con IVA y descuento)
  C-LI2: 1 ticket READY (manual pago único, pendiente de facturar)
  Estado cupo correcto post-C-LI1: consumido=2000, restante=8000
  Estado cupo correcto post-C-LI2 (al facturar): consumido=3500, restante=6500
`);

  console.log(`Deal D — Mirror PY→UY
  Motor crea deal UY espejo en Phase 1 (NO lo creamos manualmente)
  D-LI1: ticket PY (auto 3p) + LI espejo en UY + ticket UY (manual READY)
  D-LI2: ticket solo PY (manual 2p) — NO aparece en UY
  D-LI3: ticket PY (manual único) + LI espejo en UY + ticket UY (manual READY)
  Idempotencia: 2da corrida → mismo deal UY, mismos LIs UY, sin duplicados
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
