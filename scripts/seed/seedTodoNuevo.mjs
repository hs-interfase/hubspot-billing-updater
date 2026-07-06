#!/usr/bin/env node
/**
 * seedTodoNuevo.mjs
 *
 * Crea deals + line items de prueba en HubSpot SANDBOX para validar el paquete
 * de features nuevos (commits 975fb5d / d2fa68d / fab5d3a / dce9fbd / 5752f92
 * + mirror seal sin commitear) antes de la re-migración.
 *
 * ESCENARIOS:
 *   F — Área por país (AREA_BY_COUNTRY_ENABLED) + Costo USD (COSTO_USD_ENABLED)
 *   G — Zero-emission: auto del pasado SIN facturacion_activa → ticket NO nace READY
 *   G2 — Control: mismo LI CON facturacion_activa → ticket nace READY
 *   H — Aviso vendedor: deal 50% con facturación a ≤10 días → billing_error en deal
 *   I — Sanitizer clon: LI con "(Copia)" + line_item_key ajena → nombre limpio + reset
 *   J — cliente_partner: empresa con etiqueta Partner (typeId 3 sandbox) → prop en ticket
 *   K — Mirror PY→UY: LI uy=true → espejo; --fase2 agrega K-LI2 (espejo de LI nueva)
 *
 * Uso:
 *   node scripts/seed/seedTodoNuevo.mjs            → crea todo
 *   node scripts/seed/seedTodoNuevo.mjs --dry      → solo muestra
 *   node scripts/seed/seedTodoNuevo.mjs --fase2    → agrega K-LI2 al deal K del manifest
 *
 * Después (flags prendidos SOLO en la sesión):
 *   AREA_BY_COUNTRY_ENABLED=true COSTO_USD_ENABLED=true node src/jobs/cronDealsBatch.js --deal <ID>
 *
 * Para limpiar:
 *   node scripts/cleanup/cleanupTestDeals.mjs --prefix "[TEST-NUEVO]"
 *   (las 2 companies del manifest se archivan con --cleanup-companies)
 */

import 'dotenv/config';
import { hubspotClient } from '../../src/hubspotClient.js';
import fs from 'fs';
import { IVA_PY_TAX_GROUP_ID } from '../../src/config/constants.js';

// ─── Config ────────────────────────────────────────────────────────────────────

const PREFIX   = '[TEST-NUEVO]';
const MANIFEST = 'test-nuevo-manifest.json';
const DRY_RUN  = process.argv.includes('--dry');
const FASE2    = process.argv.includes('--fase2');
const CLEANUP_COMPANIES = process.argv.includes('--cleanup-companies');

const PARTNER_LABEL_TYPE_ID = parseInt(process.env.ASSOC_LABEL_EMPRESA_PARTNER || '3', 10);

if (String(process.env.HUBSPOT_ENV || '').toLowerCase() !== 'sandbox') {
  console.error('❌ Este seed es SOLO para sandbox (HUBSPOT_ENV=sandbox). Abortando.');
  process.exit(1);
}

// ─── Fechas ────────────────────────────────────────────────────────────────────

function todayPlus(days) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

const TODAY     = todayPlus(0);
const YESTERDAY = todayPlus(-1);
const PLUS_5    = todayPlus(5);
const PLUS_40   = todayPlus(40);

// ─── Helpers HubSpot ───────────────────────────────────────────────────────────

async function createCompany(name) {
  if (DRY_RUN) {
    console.log(`  🔍 [DRY] Crearía company: ${name}`);
    return { id: `DRY_CO_${Math.random().toString(36).slice(2, 6)}` };
  }
  const resp = await hubspotClient.crm.companies.basicApi.create({ properties: { name } });
  console.log(`  🏢 Company creada: ${resp.id} — ${name}`);
  return resp;
}

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

// Partner: misma dirección que usa el motor al leer (deals→companies, USER_DEFINED)
async function associatePartnerToDeal(companyId, dealId) {
  if (DRY_RUN) return;
  await hubspotClient.crm.associations.v4.basicApi.create(
    'deals',     String(dealId),
    'companies', String(companyId),
    [{ associationCategory: 'USER_DEFINED', associationTypeId: PARTNER_LABEL_TYPE_ID }]
  );
  console.log(`    🤝 Partner asociado (label typeId ${PARTNER_LABEL_TYPE_ID})`);
}

async function seedDeal(dealName, dealProps, lineItemDefs, { companyId } = {}) {
  console.log(`\n🏗️  ${dealName}`);

  const deal = await createDeal({
    dealname:           `${PREFIX} ${dealName}`,
    dealstage:          'closedwon',
    pipeline:           'default',
    facturacion_activa: 'true',
    ...dealProps,
  });

  const dealId = deal.id;
  if (companyId) {
    await associateCompanyToDeal(companyId, dealId);
    console.log(`    🔗 Company asociada`);
  }

  const lineItems = [];
  for (const liDef of lineItemDefs) {
    const li = await createLineItem({ facturacion_activa: 'true', ...liDef });
    await associateLineItemToDeal(li.id, dealId);
    lineItems.push({ id: li.id, name: liDef.name });
  }

  return { dealId, dealName, lineItems };
}

function loadManifest() {
  if (!fs.existsSync(MANIFEST)) {
    console.error(`❌ No existe ${MANIFEST} — correr primero el seed sin --fase2`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
}

// ═══════════════════════════════════════════════════════════════════════════════
// FASE 2 — agregar K-LI2 al deal K ya espejado (prueba "LI nueva sí se espeja")
// ═══════════════════════════════════════════════════════════════════════════════

async function fase2() {
  const manifest = loadManifest();
  const dealK = manifest.deals.find(d => d.escenario === 'K');
  if (!dealK) {
    console.error('❌ No hay deal K en el manifest');
    process.exit(1);
  }
  console.log(`\n🏗️  FASE 2 — K-LI2 nueva en deal ${dealK.dealId} (mirror ya creado)`);
  const li = await createLineItem({
    name:                            `${PREFIX} K-LI2: PY+UY nueva post-mirror`,
    price:                           '900',
    quantity:                        '1',
    hs_cost_of_goods_sold:           '300',
    hs_recurring_billing_start_date: TODAY,
    facturacion_automatica:          'false',
    facturacion_activa:              'true',
    uy:                              'true',
    pais_operativo:                  'Paraguay',
    hs_tax_rate_group_id:            IVA_PY_TAX_GROUP_ID,
  });
  await associateLineItemToDeal(li.id, dealK.dealId);
  dealK.lineItemIds.push(li.id);
  if (!DRY_RUN) fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));
  console.log(`\n▶️  Ahora: node src/jobs/cronDealsBatch.js --deal ${dealK.dealId}`);
  console.log('   Esperado: K-LI2 aparece espejada en el deal UY (price = cogs/qty = 300).');
}

// ═══════════════════════════════════════════════════════════════════════════════
// CLEANUP COMPANIES — archivar las companies del manifest (el resto lo hace
// cleanupTestDeals.mjs --prefix "[TEST-NUEVO]")
// ═══════════════════════════════════════════════════════════════════════════════

async function cleanupCompanies() {
  const manifest = loadManifest();
  for (const [rol, id] of Object.entries(manifest.companies || {})) {
    if (DRY_RUN) { console.log(`🔍 [DRY] Archivaría company ${id} (${rol})`); continue; }
    try {
      await hubspotClient.crm.companies.basicApi.archive(String(id));
      console.log(`🗑️  Company ${id} (${rol}) archivada`);
    } catch (err) {
      console.warn(`⚠️  Company ${id}: ${err.message}`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SEED PRINCIPAL
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  SEED TODO-LO-NUEVO ${DRY_RUN ? '(DRY RUN)' : '— SANDBOX'}`);
  console.log(`  Fecha base: ${TODAY}`);
  console.log('═══════════════════════════════════════════════════════════');

  // Companies de prueba
  console.log('\n🏢 Companies');
  const cliente = await createCompany(`${PREFIX} Cliente SA`);
  const partner = await createCompany(`${PREFIX} Partner SRL`);

  const results = [];

  // ── F — Área por país + Costo USD ──────────────────────────────────────────
  // Flags ON: área de TODOS los LIs = Paraguay (deal PY); dolar deal=1 (USD),
  // dolar_cierre_asignado=true, LI.dolar=1, cogs = costo_total_usd × 1 ÷ qty.
  // monto_usd / margen_usd los calcula HubSpot solo (props de cálculo).
  results.push({ escenario: 'F', ...await seedDeal(
    'F — Área país PY + Costo USD',
    { pais_operativo: 'Paraguay' },
    [
      {
        // qty=2 → cogs esperado = 100×1÷2 = 50; monto_usd = 1000×2÷1 = 2000
        name: `${PREFIX} F-LI1: costo_total_usd=100 qty=2`,
        price:                           '1000',
        quantity:                        '2',
        costo_total_usd:                 '100',
        hs_recurring_billing_start_date: TODAY,
        facturacion_automatica:          'false',
      },
      {
        // start lejano: sin tickets; solo valida área + conversión (cogs=30)
        name: `${PREFIX} F-LI2: costo_total_usd=30 qty=1 start=+40`,
        price:                           '500',
        quantity:                        '1',
        costo_total_usd:                 '30',
        recurringbillingfrequency:       'monthly',
        hs_recurring_billing_start_date: PLUS_40,
        hs_recurring_billing_period:     'P2M',
        facturacion_automatica:          'false',
      },
    ],
    { companyId: cliente.id }
  )});

  // ── G — Zero-emission: auto del pasado SIN facturacion_activa ──────────────
  // Esperado: ticket NACE en forecast 85 (1330252330), NO en READY (1311404151).
  results.push({ escenario: 'G', ...await seedDeal(
    'G — Auto pasado sin facturacion_activa',
    { pais_operativo: 'Uruguay', facturacion_activa: 'false' },
    [
      {
        name: `${PREFIX} G-LI1: auto mensual 3p start=yesterday`,
        price:                           '1000',
        quantity:                        '1',
        recurringbillingfrequency:       'monthly',
        hs_recurring_billing_start_date: YESTERDAY,
        hs_recurring_billing_period:     'P3M',
        facturacion_automatica:          'true',
      },
    ],
    { companyId: cliente.id }
  )});

  // ── G2 — Control: mismo LI CON facturacion_activa ───────────────────────────
  // Esperado: ticket del pasado nace READY (o CREATED si Phase 3 llega a emitir).
  results.push({ escenario: 'G2', ...await seedDeal(
    'G2 — Control: auto pasado con facturacion_activa',
    { pais_operativo: 'Uruguay' },
    [
      {
        name: `${PREFIX} G2-LI1: auto mensual 3p start=yesterday`,
        price:                           '1000',
        quantity:                        '1',
        recurringbillingfrequency:       'monthly',
        hs_recurring_billing_start_date: YESTERDAY,
        hs_recurring_billing_period:     'P3M',
        facturacion_automatica:          'true',
      },
    ],
    { companyId: cliente.id }
  )});

  // ── H — Aviso vendedor: no-ganado con facturación a ≤10 días ───────────────
  // Deal en 50% → warnFacturacionDealNoGanado escribe billing_error en el deal.
  results.push({ escenario: 'H', ...await seedDeal(
    'H — No ganado, factura en 5 días',
    {
      dealstage:          'decisionmakerboughtin', // 50%
      facturacion_activa: 'false',
      pais_operativo:     'Uruguay',
    },
    [
      {
        name: `${PREFIX} H-LI1: manual mensual 2p start=+5`,
        price:                           '700',
        quantity:                        '1',
        recurringbillingfrequency:       'monthly',
        hs_recurring_billing_start_date: PLUS_5,
        hs_recurring_billing_period:     'P2M',
        facturacion_automatica:          'false',
      },
    ],
    { companyId: cliente.id }
  )});

  // ── I — Sanitizer clon: "(Copia)" + key ajena ───────────────────────────────
  // line_item_key '1:1:seed' ≠ (dealId:liId) → SUCIO → limpia nombre + resetea ops.
  results.push({ escenario: 'I', ...await seedDeal(
    'I — Clon con (Copia) y key ajena',
    { pais_operativo: 'Uruguay' },
    [
      {
        name: `${PREFIX} I-LI1: Servicio Clonado (Copia)`,
        price:                           '400',
        quantity:                        '1',
        line_item_key:                   '1:1:seedclon',
        billing_error:                   'residuo del original',
        hs_recurring_billing_start_date: TODAY,
        facturacion_automatica:          'false',
      },
    ],
    { companyId: cliente.id }
  )});

  // ── J — cliente_partner en ticket ───────────────────────────────────────────
  // Cliente SA = primaria (asociada primero), Partner SRL = etiqueta Partner.
  const dealJ = await seedDeal(
    'J — Ticket con cliente_partner',
    { pais_operativo: 'Uruguay' },
    [
      {
        name: `${PREFIX} J-LI1: manual único today`,
        price:                           '1200',
        quantity:                        '1',
        hs_recurring_billing_start_date: TODAY,
        facturacion_automatica:          'false',
      },
    ],
    { companyId: cliente.id }
  );
  await associatePartnerToDeal(partner.id, dealJ.dealId);
  results.push({ escenario: 'J', ...dealJ });

  // ── K — Mirror PY→UY + Partner en mirror ────────────────────────────────────
  // Motor crea el deal UY espejo (price = cogs/qty). Con el cambio nuevo, la
  // Interfase PY del mirror lleva Empresa Factura (2) + Partner (3).
  results.push({ escenario: 'K', ...await seedDeal(
    'K — Mirror PY→UY',
    { pais_operativo: 'Paraguay' },
    [
      {
        name: `${PREFIX} K-LI1: PY+UY manual mensual 3p`,
        price:                           '1500',
        quantity:                        '3',
        hs_cost_of_goods_sold:           '500',
        recurringbillingfrequency:       'monthly',
        hs_recurring_billing_start_date: TODAY,
        hs_recurring_billing_period:     'P3M',
        facturacion_automatica:          'false',
        uy:                              'true',
        pais_operativo:                  'Paraguay',
        hs_tax_rate_group_id:            IVA_PY_TAX_GROUP_ID,
      },
    ],
    { companyId: cliente.id }
  )});

  // ─── Resumen + manifest ─────────────────────────────────────────────────────

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  RESUMEN — comandos por deal (flags en la misma sesión)');
  console.log('═══════════════════════════════════════════════════════════\n');
  for (const r of results) {
    console.log(`📋 [${r.escenario}] ${r.dealName}`);
    console.log(`   node src/jobs/cronDealsBatch.js --deal ${r.dealId}`);
  }

  if (!DRY_RUN) {
    const manifest = {
      prefix:    PREFIX,
      createdAt: new Date().toISOString(),
      today:     TODAY,
      companies: { cliente: cliente.id, partner: partner.id },
      deals:     results.map(r => ({
        escenario:   r.escenario,
        dealId:      r.dealId,
        dealName:    r.dealName,
        lineItemIds: r.lineItems.map(li => li.id),
      })),
    };
    fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));
    console.log(`\n💾 Manifest: ${MANIFEST}`);
  }
}

const run = CLEANUP_COMPANIES ? cleanupCompanies : FASE2 ? fase2 : main;
run().catch(err => {
  console.error('❌ Error fatal:', err.message);
  if (err.response?.data) console.error(JSON.stringify(err.response.data, null, 2));
  process.exit(1);
});
