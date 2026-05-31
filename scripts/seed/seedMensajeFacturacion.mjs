#!/usr/bin/env node
/**
 * seedMensajeFacturacion.mjs
 *
 * Crea 1 deal manual UY con 3 line items en HubSpot para testear
 * el cron de mensajes de facturación (cronMensajeFacturacion.js).
 *
 * Cubre:
 *   LI1 — mensual 3 pagos, empresa_que_factura poblado
 *   LI2 — pago único, persona_que_factura poblado
 *   LI3 — mensual auto-renew, sin contacto factura (prueba vacío)
 *
 * Uso:
 *   node seedMensajeFacturacion.mjs          # real
 *   node seedMensajeFacturacion.mjs --dry    # dry run (sin crear)
 *
 * Después:
 *   node src/jobs/cronMensajeFacturacion.js --deal <DEAL_ID>
 */

import 'dotenv/config';
import fs from 'fs';
import { hubspotClient } from './src/hubspotClient.js';

// ─── Config ────────────────────────────────────────────────────────────────────

const DRY_RUN   = process.argv.includes('--dry');
const PREFIX    = '[MSG-SEED]';
const COMPANY_ID = '43833570850';
const DEAL_STAGE = 'closedwon';  // 85%

// IDs de productos reales en el portal
const PRODUCT_IDS = {
  LI1: '33695807329',  // Portal / ISA
  LI2: '33688695865',  // PayRoll / Interfase
  LI3: '33688943634',  // Proyectos / ISA Proyectos
};

// ─── Helpers de fecha ──────────────────────────────────────────────────────────

function todayPlus(days) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

const TODAY = todayPlus(0);

// ─── HubSpot helpers ───────────────────────────────────────────────────────────

async function createDeal(props) {
  if (DRY_RUN) {
    console.log(`  [DRY] Deal: ${props.dealname}`);
    return { id: 'DRY-DEAL' };
  }
  const resp = await hubspotClient.crm.deals.basicApi.create({ properties: props });
  console.log(`  ✅ Deal creado: ${resp.id} — ${props.dealname}`);
  return resp;
}

async function createLineItem(props) {
  if (DRY_RUN) {
    console.log(`    [DRY] Line Item: ${props.name}`);
    return { id: `DRY-LI-${Math.random().toString(36).slice(2, 6)}` };
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
  if (DRY_RUN) {
    console.log(`    [DRY] Company ${companyId} → deal ${dealId}`);
    return;
  }
  try {
    await hubspotClient.crm.associations.v4.basicApi.create(
      'companies', String(companyId),
      'deals',     String(dealId),
      [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 342 }]
    );
    console.log(`    🔗 Company asociada`);
  } catch (err) {
    console.warn(`    ⚠️  No se pudo asociar company: ${err.message}`);
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  SEED MENSAJE FACTURACIÓN${DRY_RUN ? ' — DRY RUN' : ''}`);
  console.log(`  Fecha base: ${TODAY}`);
  console.log('═══════════════════════════════════════════════════════════\n');

  // ── Deal ────────────────────────────────────────────────────────────────────

  console.log('🏗️  Creando deal manual UY...');
  const deal = await createDeal({
    dealname:           `${PREFIX} Mensaje Facturación Test — ${TODAY}`,
    dealstage:          DEAL_STAGE,
    pipeline:           'default',
    facturacion_activa: 'true',
    pais_operativo:     'Uruguay',     // ← nombre correcto
    deal_currency_code: 'UYU',
  });

  const dealId = deal.id;
  await associateCompanyToDeal(COMPANY_ID, dealId);

  // ── Line items ──────────────────────────────────────────────────────────────

  const lineItems = [];

  // LI1: mensual 3 pagos — empresa_que_factura poblado
  console.log('\n  📦 LI1: Mensual 3 pagos (empresa_que_factura)');
  const li1 = await createLineItem({
    name:                          `${PREFIX} Portal ISA — mensual 3 pagos`,
    hs_product_id:                 PRODUCT_IDS.LI1,
    price:                         '15000',
    quantity:                      '1',
    recurringbillingfrequency:     'monthly',
    hs_recurring_billing_start_date: TODAY,
    hs_recurring_billing_period:   'P3M',      // 3 pagos
    facturacion_automatica:        'false',
    facturacion_activa:            'true',
    of_moneda:                     'UYU',
    of_descripcion_producto:       'Licencia mensual sistema Portal ISA para gestión de RRHH',
    of_rubro:                      'Software',
    of_iva:                        'true',
    of_frecuencia_de_facturacion:  'Frecuente',
    empresa_que_factura:           'Mishi Systems SRL',
    mensaje_para_responsable:      'Enviar factura antes del 5 de cada mes. Contacto: admin@cliente.com',
  });
  await associateLineItemToDeal(li1.id, dealId);
  lineItems.push({ id: li1.id, name: 'LI1 Portal ISA' });

  // LI2: pago único — persona_que_factura poblado
  console.log('\n  📦 LI2: Pago único (persona_que_factura)');
  const li2 = await createLineItem({
    name:                          `${PREFIX} PayRoll Interfase — pago único`,
    hs_product_id:                 PRODUCT_IDS.LI2,
    price:                         '50000',
    quantity:                      '1',
    hs_recurring_billing_start_date: TODAY,
    facturacion_automatica:        'false',
    facturacion_activa:            'true',
    of_moneda:                     'UYU',
    of_descripcion_producto:       'Implementación y configuración inicial PayRoll Interfase',
    of_rubro:                      'Consultoría',
    of_iva:                        'false',
    of_frecuencia_de_facturacion:  'Único',
    persona_que_factura:           'Juan Pérez',
    mensaje_para_responsable:      'Pago único post-implementación. Requiere conformidad del cliente.',
  });
  await associateLineItemToDeal(li2.id, dealId);
  lineItems.push({ id: li2.id, name: 'LI2 PayRoll' });

  // LI3: mensual auto-renew — sin contacto factura (prueba vacío)
  console.log('\n  📦 LI3: Mensual auto-renew (sin contacto factura)');
  const li3 = await createLineItem({
    name:                          `${PREFIX} ISA Proyectos — mensual auto-renew`,
    hs_product_id:                 PRODUCT_IDS.LI3,
    price:                         '8000',
    quantity:                      '3',
    recurringbillingfrequency:     'monthly',
    hs_recurring_billing_start_date: TODAY,
    // Sin hs_recurring_billing_period → auto-renew indefinido
    facturacion_automatica:        'false',
    facturacion_activa:            'true',
    of_moneda:                     'UYU',
    of_descripcion_producto:       'Soporte mensual proyectos ISA — 3 horas técnico senior',
    of_rubro:                      'Mantenimiento',
    of_iva:                        'true',
    of_frecuencia_de_facturacion:  'Frecuente',
    // empresa_que_factura y persona_que_factura vacíos → prueba fallback en mensaje
    mensaje_para_responsable:      '',
  });
  await associateLineItemToDeal(li3.id, dealId);
  lineItems.push({ id: li3.id, name: 'LI3 ISA Proyectos' });

  // ── Manifest ────────────────────────────────────────────────────────────────

  const manifest = {
    prefix:    PREFIX,
    createdAt: new Date().toISOString(),
    today:     TODAY,
    dryRun:    DRY_RUN,
    deal: {
      dealId,
      dealName: `${PREFIX} Mensaje Facturación Test — ${TODAY}`,
    },
    lineItems,
  };

  if (!DRY_RUN) {
    fs.writeFileSync('mensajefacturacion-seed-manifest.json', JSON.stringify(manifest, null, 2));
    console.log('\n💾 Manifest guardado en mensajefacturacion-seed-manifest.json');
  }

  // ── Resumen ─────────────────────────────────────────────────────────────────

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  RESULTADO');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`\n  Deal ID  : ${dealId}`);
  for (const li of lineItems) {
    console.log(`  LI ${li.id.toString().padEnd(16)} : ${li.name}`);
  }

  console.log('\n─── PRÓXIMOS PASOS ─────────────────────────────────────────');
  console.log('\n  1. Correr phases para generar tickets READY:');
  console.log(`     node src/jobs/cronDealsBatch.js --deal ${dealId}\n`);
  console.log('  2. Correr el cron de mensajes:');
  console.log(`     node src/jobs/cronMensajeFacturacion.js --deal ${dealId}\n`);
  console.log('  3. Verificar en HubSpot:');
  console.log(`     → Deal ${dealId} → propiedad mensaje_de_facturacion`);
  console.log('─────────────────────────────────────────────────────────────\n');
}

main().catch(err => {
  console.error('❌ Error fatal:', err.message);
  if (err.response?.data) console.error(JSON.stringify(err.response.data, null, 2));
  process.exit(1);
});
