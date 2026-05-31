#!/usr/bin/env node
/**
 * fixSealedInvoices.mjs
 *
 * Corrige facturas de migración que:
 * 1. Tienen monto_a_facturar = 0 o null
 * 2. No tienen id_factura_nodum
 * 3. Están en etapa "Pendiente" cuando deberían estar en "Emitida"
 *
 * Estrategia:
 * - Busca TODAS las invoices con monto_a_facturar = 0 (o null) vía Search API
 * - Lee el ticket asociado (ticket_id de la factura)
 * - Copia todos los campos FREEZE RULE del ticket → factura
 * - Setea id_factura_nodum = '11', etapa = 'Emitida'
 * - Propaga campos de la factura → ticket (mapeo INVOICE_TO_TICKET_MAP inline)
 *
 * Uso:
 *   node fixSealedInvoices.mjs                        # dry run
 *   node fixSealedInvoices.mjs --execute              # ejecución real
 *   node fixSealedInvoices.mjs --deal 60542271080     # solo facturas de un deal
 */

import 'dotenv/config';
import { Client } from '@hubspot/api-client';
import { writeFileSync } from 'fs';

const TOKEN = process.env.HUBSPOT_PRIVATE_TOKEN;
if (!TOKEN) { console.error('❌ Falta HUBSPOT_PRIVATE_TOKEN'); process.exit(1); }

const hubspot = new Client({ accessToken: TOKEN });
const sleep = ms => new Promise(r => setTimeout(r, ms));

const DRY_RUN = !process.argv.includes('--execute');

function getArg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : null;
}

const SINGLE_DEAL = getArg('deal');

// ─── Pipeline detection ──────────────────────────────────────────────────────

const AUTO_PIPELINE = process.env.BILLING_AUTOMATED_PIPELINE || '829156883';

// ─── Mapeo invoice → ticket (inline de syncInvoiceToTicket.js) ───────────────

const INVOICE_TO_TICKET_MAP = {
  id_factura_nodum:     'numero_de_factura',
  fecha_de_emision:     'fecha_real_de_facturacion',
  cantidad:             'cantidad_real',
  monto_unitario:       'monto_unitario_real',
  descuento:            'descuento_en_porcentaje',
  descuento_por_unidad: 'descuento_por_unidad_real',
  iva:                  'of_iva',
};

function buildTicketPropsFromInvoice(invoiceProps) {
  const ticketProps = {};
  for (const [invoiceField, ticketField] of Object.entries(INVOICE_TO_TICKET_MAP)) {
    if (invoiceField in invoiceProps && invoiceProps[invoiceField] !== null) {
      ticketProps[ticketField] = invoiceProps[invoiceField];
    }
  }
  return ticketProps;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function safeNum(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

// ─── Invoice properties to fetch ─────────────────────────────────────────────

const INVOICE_PROPS = [
  'of_invoice_key', 'ticket_id', 'line_item_key',
  'etapa_de_la_factura', 'id_factura_nodum',
  'monto_a_facturar', 'hs_amount_billed', 'cantidad',
  'monto_unitario', 'descuento', 'descuento_por_unidad',
  'iva', 'exonera_irae',
  'hs_invoice_date', 'hs_currency', 'hs_title',
  'pais_operativo', 'nombre_producto',
];

// ─── Fetchers ────────────────────────────────────────────────────────────────

/**
 * Busca todas las invoices con monto_a_facturar = 0 o null.
 * Usa keyset pagination (hs_object_id GT lastId) para superar el límite de 10K.
 * Si SINGLE_DEAL está definido, filtra por id_empresa = dealId.
 */
async function fetchInvoicesWithZeroMonto() {
  const all = [];

  // Grupo 1: monto = 0, Grupo 2: monto null (NOT_HAS_PROPERTY)
  const filterGroupsBase = [
    {
      filters: [
        { propertyName: 'monto_a_facturar', operator: 'EQ', value: '0' },
      ],
    },
    {
      filters: [
        { propertyName: 'monto_a_facturar', operator: 'NOT_HAS_PROPERTY' },
      ],
    },
  ];

  // Si hay deal, agregar filtro a cada grupo
  if (SINGLE_DEAL) {
    for (const fg of filterGroupsBase) {
      fg.filters.push({ propertyName: 'id_empresa', operator: 'EQ', value: SINGLE_DEAL });
    }
  }

  let lastId = '0';
  let page = 0;

  while (true) {
    page++;
    // Keyset pagination: agregar GT lastId a cada grupo
    const filterGroups = filterGroupsBase.map(fg => ({
      filters: [
        ...fg.filters,
        { propertyName: 'hs_object_id', operator: 'GT', value: lastId },
      ],
    }));

    const body = {
      filterGroups,
      properties: INVOICE_PROPS,
      sorts: [{ propertyName: 'hs_object_id', direction: 'ASCENDING' }],
      limit: 100,
    };

    const resp = await hubspot.crm.objects.searchApi.doSearch('invoices', body);
    const results = resp?.results || [];

    if (!results.length) break;

    all.push(...results);
    lastId = results[results.length - 1].id;

    console.log(`     📄 Página ${page}: ${results.length} invoices (total acumulado: ${all.length})`);

    if (results.length < 100) break;
    await sleep(250);
  }

  return all;
}

async function fetchTicket(ticketId) {
  try {
    return await hubspot.crm.tickets.basicApi.getById(ticketId, [
      'total_real_a_facturar', 'subtotal_real', 'cantidad_real',
      'monto_unitario_real', 'descuento_en_porcentaje', 'descuento_por_unidad_real',
      'of_iva', 'exonera_irae', 'of_moneda', 'of_pais_operativo',
      'of_monto_total', 'of_cantidad',
      'hs_pipeline', 'hs_pipeline_stage',
      'of_ticket_key', 'of_line_item_key',
    ]);
  } catch (err) {
    if (err?.code === 404 || err?.response?.status === 404) return null;
    throw err;
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const startTime = Date.now();

  console.log('═'.repeat(70));
  console.log('  🔧 FIX SEALED INVOICES (v2 — busca todas las invoices con monto 0)');
  console.log(`  Modo:  ${DRY_RUN ? '🔍 DRY RUN' : '🚀 EJECUCIÓN REAL'}`);
  console.log(`  Scope: ${SINGLE_DEAL ? `Deal ${SINGLE_DEAL}` : 'TODAS las invoices con monto 0/null'}`);
  console.log('═'.repeat(70));
  console.log();

  const stats = {
    invoicesChecked: 0,
    invoicesFixed: 0,
    invoicesSkipped: 0,
    ticketNotFound: 0,
    ticketSinMonto: 0,
    ticketsPropagated: 0,
    errors: 0,
  };

  const fixes = [];

  // ─── Buscar invoices ─────────────────────────────────────────────────────

  console.log('  🔍 Buscando invoices con monto 0 o null...');
  let invoices;
  try {
    invoices = await fetchInvoicesWithZeroMonto();
  } catch (err) {
    console.error(`  ❌ Error buscando invoices: ${err.message}`);
    process.exit(1);
  }

  console.log(`\n  📦 ${invoices.length} factura(s) encontrada(s)\n`);

  if (!invoices.length) {
    console.log('  ✅ No hay facturas con monto 0 — nada que hacer');
    return;
  }

  // ─── Procesar cada invoice ───────────────────────────────────────────────

  for (const inv of invoices) {
    stats.invoicesChecked++;
    const ip = inv.properties || {};
    const ticketId = (ip.ticket_id || '').trim();
    const currentMonto = safeNum(ip.monto_a_facturar);
    const currentEtapa = (ip.etapa_de_la_factura || '').trim();
    const currentNodum = (ip.id_factura_nodum || '').trim();

    // ¿Necesita fix?
    const needsMontoFix = (currentMonto === null || currentMonto === 0);
    const needsEtapaFix = (currentEtapa !== 'Emitida' && currentEtapa !== 'Enviada' &&
                           currentEtapa !== 'Paga' && currentEtapa !== 'Cancelada');
    const needsNodumFix = !currentNodum;

    if (!needsMontoFix && !needsEtapaFix && !needsNodumFix) {
      stats.invoicesSkipped++;
      continue;
    }

    // ─── Buscar ticket ───────────────────────────────────────────────────

    if (!ticketId) {
      console.log(`     ⚠️  Factura ${inv.id} sin ticket_id`);
      fixes.push({ invoiceId: inv.id, problem: 'NO_TICKET_ID', action: 'NEEDS_MANUAL_REVIEW' });
      stats.errors++;
      continue;
    }

    const ticket = await fetchTicket(ticketId);

    if (!ticket) {
      stats.ticketNotFound++;
      console.log(`     👻 Factura ${inv.id} → ticket ${ticketId} NO EXISTE`);
      fixes.push({ invoiceId: inv.id, ticketId, problem: 'TICKET_NOT_FOUND', action: 'NEEDS_MANUAL_REVIEW' });
      continue;
    }

    const tp = ticket.properties || {};
    let ticketMonto = safeNum(tp.total_real_a_facturar);

    // Fallback: of_monto_total
    if (ticketMonto === null || ticketMonto === 0) {
      ticketMonto = safeNum(tp.of_monto_total);
    }

    if (ticketMonto === null || ticketMonto === 0) {
      stats.ticketSinMonto++;
      console.log(`     💰 Factura ${inv.id} → ticket ${ticketId} también tiene monto 0`);
      fixes.push({ invoiceId: inv.id, ticketId, problem: 'TICKET_ALSO_NO_MONTO', action: 'NEEDS_MANUAL_REVIEW' });
      continue;
    }

    // ─── Construir update de invoice ─────────────────────────────────────

    const invoiceUpdate = {};

    // FREEZE RULE: copiar todos los campos del ticket
    if (needsMontoFix) {
      invoiceUpdate.monto_a_facturar = String(ticketMonto);
      invoiceUpdate.hs_amount_billed = String(ticketMonto);
    }

    // Copiar campos adicionales del ticket → invoice (siempre, no solo si vacíos)
    if (tp.cantidad_real)              invoiceUpdate.cantidad = tp.cantidad_real;
    if (tp.monto_unitario_real)        invoiceUpdate.monto_unitario = tp.monto_unitario_real;
    if (tp.descuento_en_porcentaje)    invoiceUpdate.descuento = tp.descuento_en_porcentaje;
    if (tp.descuento_por_unidad_real)  invoiceUpdate.descuento_por_unidad = tp.descuento_por_unidad_real;
    if (tp.of_iva)                     invoiceUpdate.iva = tp.of_iva;
    if (tp.exonera_irae)               invoiceUpdate.exonera_irae = tp.exonera_irae;
    if (tp.of_pais_operativo)          invoiceUpdate.pais_operativo = tp.of_pais_operativo;

    // Marca de migración
    if (needsNodumFix) {
      invoiceUpdate.id_factura_nodum = '11';
    }

    // Etapa → Emitida
    if (needsEtapaFix) {
      invoiceUpdate.etapa_de_la_factura = 'Emitida';
    }

    if (Object.keys(invoiceUpdate).length === 0) {
      stats.invoicesSkipped++;
      continue;
    }

    // ─── Construir propagación invoice → ticket ──────────────────────────

    const ticketUpdate = buildTicketPropsFromInvoice(invoiceUpdate);

    // ─── Ejecutar ────────────────────────────────────────────────────────

    const fixRecord = {
      invoiceId: inv.id,
      ticketId,
      before: {
        monto_a_facturar: ip.monto_a_facturar,
        etapa: currentEtapa,
        id_factura_nodum: currentNodum,
      },
      invoiceUpdate,
      ticketUpdate,
      applied: !DRY_RUN,
    };

    if (DRY_RUN) {
      console.log(`     🔍 [DRY] Factura ${inv.id} → ${JSON.stringify(invoiceUpdate)}`);
      if (Object.keys(ticketUpdate).length) {
        console.log(`             → ticket ${ticketId}: ${JSON.stringify(ticketUpdate)}`);
      }
    } else {
      try {
        // 1. Actualizar invoice
        await hubspot.crm.objects.basicApi.update('invoices', inv.id, { properties: invoiceUpdate });

        // 2. Propagar a ticket
        if (Object.keys(ticketUpdate).length) {
          await hubspot.crm.tickets.basicApi.update(String(ticketId), { properties: ticketUpdate });
          stats.ticketsPropagated++;
        }

        console.log(`     ✅ Factura ${inv.id} → monto=${invoiceUpdate.monto_a_facturar || '—'} | ticket ${ticketId} actualizado`);
      } catch (err) {
        console.error(`     ❌ Error factura ${inv.id}: ${err.message}`);
        fixRecord.error = err.message;
        stats.errors++;
      }
    }

    fixes.push(fixRecord);
    stats.invoicesFixed++;
    await sleep(250);
  }

  // ─── Resumen ───────────────────────────────────────────────────────────────

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log();
  console.log('═'.repeat(70));
  console.log('  📊 RESUMEN');
  console.log('═'.repeat(70));
  console.log(`  Facturas revisadas:      ${stats.invoicesChecked}`);
  console.log(`  Facturas corregidas:     ${stats.invoicesFixed}`);
  console.log(`  Facturas OK (skip):      ${stats.invoicesSkipped}`);
  console.log(`  Ticket no encontrado:    ${stats.ticketNotFound}`);
  console.log(`  Ticket sin monto:        ${stats.ticketSinMonto}`);
  console.log(`  Tickets propagados:      ${stats.ticketsPropagated}`);
  console.log(`  Errores:                 ${stats.errors}`);
  console.log(`  Duración:                ${elapsed}s`);
  console.log('═'.repeat(70));

  if (DRY_RUN && stats.invoicesFixed > 0) {
    console.log('\n  💡 Para ejecutar: node fixSealedInvoices.mjs --execute');
  }

  const filename = `fix-invoices-report-${new Date().toISOString().slice(0, 10)}.json`;
  writeFileSync(filename, JSON.stringify({ stats, fixes }, null, 2));
  console.log(`\n📄 Reporte: ${filename}`);
}

main().catch(err => {
  console.error('\n❌ Error fatal:', err.message);
  process.exit(1);
});
