// inspectTicketSnapshot.mjs
// Diagnóstico: compara propiedades de deal, line item y ticket
// Uso: node src/__tests__/inspectTicketSnapshot.mjs

import { hubspotClient } from '../hubspotClient.js';

const DEAL_ID      = '59154607979';
const LINE_ITEM_ID = '54273480349';
const TICKET_ID    = '44376353822';

// ─── Propiedades a leer ──────────────────────────────────────────────────────

const DEAL_PROPS = [
  'dealname', 'dealstage', 'deal_currency_code', 'hubspot_owner_id',
  'tipo_de_cupo', 'pais_operativo', 'facturacion_activa', 'closed_lost_reason',
  'deal_py_origen_id', 'deal_uy_mirror_id', 'es_mirror_de_py',
];

const LINE_ITEM_PROPS = [
  // identidad
  'line_item_key', 'name', 'description',
  // pricing
  'price', 'quantity', 'amount', 'discount', 'hs_discount_percentage',
  'hs_cost_of_goods_sold', 'hs_post_tax_amount', 'hs_tax_rate_group_id',
  // facturación
  'facturacion_activa', 'facturacion_automatica', 'facturar_ahora',
  'billing_next_date', 'last_ticketed_date', 'last_billing_period',
  'hs_recurring_billing_start_date', 'hs_recurring_billing_number_of_payments',
  'recurringbillingfrequency', 'hs_recurring_billing_frequency',
  'billing_anchor_date', 'irregular', 'pausa', 'motivo_de_pausa', 'motivo_pausa',
  // snapshot sources
  'servicio', 'subrubro', 'mensaje_para_responsable', 'nota',
  'pais_operativo', 'parte_del_cupo', 'porcentaje_margen', 'reventa',
  'hubspot_owner_id', 'responsable_asignado',
  // mirror
  'of_line_item_py_origen_id', 'uy',
  // otros
  'forecast_signature', 'mantsoft_pendiente',
];

const TICKET_PROPS = [
  // identidad
  'of_ticket_key', 'of_line_item_key', 'of_deal_id', 'of_estado',
  'hs_pipeline', 'hs_pipeline_stage', 'subject',
  // snapshots de deal
  'of_moneda', 'of_tipo_de_cupo', 'of_pais_operativo', 'of_propietario_secundario',
  // snapshots de line item
  'of_producto_nombres', 'of_descripcion_producto',
  'of_rubro', 'of_subrubro',
  'observaciones', 'nota',
  'monto_unitario_real', 'cantidad_real',
  'descuento_en_porcentaje', 'descuento_por_unidad_real',
  'of_aplica_para_cupo', 'of_costo', 'of_margen', 'of_iva',
  'reventa', 'of_frecuencia_de_facturacion', 'repetitivo',
  'of_cantidad_de_pagos',
  // fechas
  'fecha_resolucion_esperada', 'of_fecha_de_facturacion',
  'of_fecha_facturacion_real',
  // factura
  'of_invoice_id', 'numero_de_factura',
  // otros
  'motivo_cancelacion_del_ticket',
  'hubspot_owner_id',
  'ticket_emitio_aviso_a_admin',
];

// ─── Mapeo: line item prop → ticket prop (según snapshotService) ─────────────
const SNAPSHOT_MAP = [
  // de extractLineItemSnapshots
  { from: 'hs_recurring_billing_number_of_payments', to: 'of_cantidad_de_pagos', source: 'lineItem' },
  { from: 'name',                     to: 'of_producto_nombres',         source: 'lineItem' },
  { from: 'description',              to: 'of_descripcion_producto',      source: 'lineItem' },
  { from: 'servicio',                 to: 'of_rubro',                     source: 'lineItem' },
  { from: 'subrubro',                 to: 'of_subrubro',                  source: 'lineItem' },
  { from: 'mensaje_para_responsable', to: 'observaciones',         source: 'lineItem' },
  { from: 'nota',                     to: 'nota',                         source: 'lineItem' },
  { from: 'pais_operativo',           to: 'of_pais_operativo',            source: 'lineItem', note: 'debería venir del deal' },
  { from: 'price',                    to: 'monto_unitario_real',          source: 'lineItem' },
  { from: 'quantity',                 to: 'cantidad_real',                source: 'lineItem' },
  { from: 'hs_discount_percentage',   to: 'descuento_en_porcentaje',      source: 'lineItem', note: 'dividido /100' },
  { from: 'discount',                 to: 'descuento_por_unidad_real',    source: 'lineItem' },
  { from: 'hs_tax_rate_group_id',     to: 'of_iva',                       source: 'lineItem', note: '16912720 → true' },
  { from: 'porcentaje_margen',        to: 'of_margen',                    source: 'lineItem' },
  { from: 'reventa',                  to: 'reventa',                      source: 'lineItem' },
  // de extractDealSnapshots
  { from: 'deal_currency_code',       to: 'of_moneda',                    source: 'deal' },
  { from: 'tipo_de_cupo',             to: 'of_tipo_de_cupo',              source: 'deal' },
  { from: 'pais_operativo',           to: 'of_pais_operativo',            source: 'deal' },
  { from: 'hubspot_owner_id',         to: 'of_propietario_secundario',    source: 'deal' },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmt(val) {
  if (val === null || val === undefined || val === '') return '(vacío)';
  return String(val);
}

function section(title) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('═'.repeat(60));
}

function printProps(label, props) {
  section(label);
  const entries = Object.entries(props).sort(([a], [b]) => a.localeCompare(b));
  for (const [k, v] of entries) {
    const display = fmt(v);
    const empty = display === '(vacío)';
    console.log(`  ${k.padEnd(45)} ${empty ? '\x1b[2m' : '\x1b[33m'}${display}\x1b[0m`);
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n🔍 DIAGNÓSTICO DE SNAPSHOT: DEAL → LINE ITEM → TICKET');
  console.log(`   Deal:      ${DEAL_ID}`);
  console.log(`   Line Item: ${LINE_ITEM_ID}`);
  console.log(`   Ticket:    ${TICKET_ID}`);

  // 1. Leer entidades
  const [dealResp, liResp, ticketResp] = await Promise.all([
    hubspotClient.crm.deals.basicApi.getById(DEAL_ID, DEAL_PROPS),
    hubspotClient.crm.lineItems.basicApi.getById(LINE_ITEM_ID, LINE_ITEM_PROPS),
    hubspotClient.crm.tickets.basicApi.getById(TICKET_ID, TICKET_PROPS),
  ]);

  const dp = dealResp.properties;
  const lp = liResp.properties;
  const tp = ticketResp.properties;

  // 2. Imprimir props crudas
  printProps(`DEAL ${DEAL_ID}`, dp);
  printProps(`LINE ITEM ${LINE_ITEM_ID}`, lp);
  printProps(`TICKET ${TICKET_ID}`, tp);

  // 3. Análisis de snapshot: qué debería haber llegado vs. qué hay
  section('ANÁLISIS DE SNAPSHOT (esperado vs. real en ticket)');

  let ok = 0, missing = 0, mismatch = 0;

  for (const { from, to, source, note } of SNAPSHOT_MAP) {
    const sourceProps = source === 'deal' ? dp : lp;
    const rawVal = sourceProps[from];
    const ticketVal = tp[to];

    // Calcular valor esperado
    let expectedVal = rawVal ?? '';
    if (to === 'of_iva') {
      expectedVal = rawVal === '16912720' ? 'true' : 'false';
    } else if (to === 'descuento_en_porcentaje' && rawVal) {
      expectedVal = String(parseFloat(rawVal) / 100);
    }

    const ticketEmpty = ticketVal === null || ticketVal === undefined || ticketVal === '';
    const srcEmpty    = rawVal   === null || rawVal   === undefined || rawVal   === '';

    let status;
    if (srcEmpty && ticketEmpty) {
      status = '⚪ AMBOS VACÍOS';
      ok++;
    } else if (srcEmpty && !ticketEmpty) {
      status = '🟣 TICKET TIENE VALOR (fuente vacía)';
      ok++;
    } else if (!srcEmpty && ticketEmpty) {
      status = '🔴 FALTA EN TICKET';
      missing++;
    } else {
      // ambos tienen valor — comparar
      const match = String(ticketVal).trim() === String(expectedVal).trim();
      status = match ? '✅ OK' : '🟡 DIFIERE';
      if (match) ok++; else mismatch++;
    }

    const noteStr = note ? ` (${note})` : '';
    console.log(`\n  [${source.toUpperCase()}] ${from} → ${to}${noteStr}`);
    console.log(`    Fuente  : ${fmt(rawVal)}`);
    if (to === 'of_iva' || to === 'descuento_en_porcentaje') {
      console.log(`    Esperado: ${fmt(expectedVal)}`);
    }
    console.log(`    Ticket  : ${fmt(ticketVal)}`);
    console.log(`    Estado  : ${status}`);
  }

  section('RESUMEN');
  console.log(`  ✅ OK / Ambos vacíos : ${ok}`);
  console.log(`  🔴 Falta en ticket   : ${missing}`);
  console.log(`  🟡 Valor distinto    : ${mismatch}`);

  // 4. Props del ticket no cubiertas por snapshot (extras)
  section('PROPS DEL TICKET (valores actuales completos)');
  const ticketNonEmpty = Object.entries(tp)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .sort(([a], [b]) => a.localeCompare(b));

  for (const [k, v] of ticketNonEmpty) {
    console.log(`  ${k.padEnd(45)} \x1b[36m${v}\x1b[0m`);
  }
}

main().catch(err => {
  console.error('ERROR:', err.message || err);
  process.exit(1);
});
