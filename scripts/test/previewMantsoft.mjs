#!/usr/bin/env node
/**
 * previewMantsoft.mjs — render local (read-only) del mensaje Mantsoft de un deal.
 *
 * Replica lo que arma cronMensajeMantsoft para los LIs con mansoft_pendiente=true
 * de un deal, y escribe el HTML resultante a un archivo para abrirlo en el browser.
 * NO escribe nada en HubSpot ni resetea flags.
 *
 * Uso:  node scripts/test/previewMantsoft.mjs <DEAL_ID>
 */

import 'dotenv/config';
import fs from 'fs';
import { hubspotClient } from '../../src/hubspotClient.js';
import { buildMensajeMantsoft } from '../../src/services/billing/buildMensajeMantsoft.js';
import { parseBool } from '../../src/utils/parsers.js';
import { ASSOC_LABEL_EMPRESA_FACTURA } from '../../src/config/constants.js';

const LI_PROPS = [
  'hs_object_id', 'hs_lastmodifieddate',
  'name', 'description', 'of_rubro', 'rubro', 'unidad_de_negocio',
  'price', 'quantity', 'amount',
  'hs_discount_percentage', 'of_moneda', 'deal_currency_code',
  'of_iva', 'exonera_irae', 'hs_tax_rate_group_id',
  'recurringbillingfrequency', 'hs_recurring_billing_frequency',
  'hs_recurring_billing_start_date', 'fecha_inicio_de_facturacion',
  'billing_next_date', 'fecha_vencimiento_contrato',
  'hs_recurring_billing_number_of_payments', 'pagos_restantes',
  'renovacion_automatica', 'hs_recurring_billing_terms',
  'hs_product_id', 'pagos_emitidos', 'billing_anchor_date',
  'nombre_empresa', 'empresa_que_factura', 'persona_que_factura',
  'observaciones', 'nota',
  'mansoft_pendiente', 'facturacion_automatica',
  'fecha_de_baja', 'motivo_de_pausa', 'es_definitivo', 'pausa',
  'mansoft_tipo_aviso', 'mansoft_ultimo_snapshot',
];

const ASSOC_LABEL_PERSONA_FACTURA = 7;

const dealId = process.argv[2];
if (!dealId) {
  console.error('Falta el DEAL_ID. Uso: node scripts/test/previewMantsoft.mjs <DEAL_ID>');
  process.exit(1);
}

// 1) LIs del deal
const liAssoc = await hubspotClient.crm.associations.v4.basicApi.getPage('deals', String(dealId), 'line_items', 100);
const liIds = (liAssoc?.results || []).map(r => String(r.toObjectId));

const lineItems = [];
for (const id of liIds) {
  const li = await hubspotClient.crm.lineItems.basicApi.getById(id, LI_PROPS);
  if (parseBool(li?.properties?.mansoft_pendiente)) lineItems.push(li);
}

console.log(`LIs con mansoft_pendiente=true: ${lineItems.length} de ${liIds.length} totales`);
for (const li of lineItems) {
  const p = li.properties;
  console.log(`  · ${li.id} — tipo=${p.mansoft_tipo_aviso || '(vacío)'} — producto=${p.hs_product_id || '-'} — pausa=${p.pausa || '-'}`);
}

if (lineItems.length === 0) {
  console.log('Nada pendiente, no hay mensaje que renderizar.');
  process.exit(0);
}

// 2) Meta del deal (nombre + empresa/persona que factura)
const deal = await hubspotClient.crm.deals.basicApi.getById(String(dealId), ['dealname', 'dealstage']);
const [compAssoc, contAssoc] = await Promise.all([
  hubspotClient.crm.associations.v4.basicApi.getPage('deals', String(dealId), 'companies', 100),
  hubspotClient.crm.associations.v4.basicApi.getPage('deals', String(dealId), 'contacts', 100),
]);
const empresaId = (compAssoc?.results || [])
  .find(r => r.associationTypes?.some(t => t.typeId === ASSOC_LABEL_EMPRESA_FACTURA))?.toObjectId;
const personaId = (contAssoc?.results || [])
  .find(r => r.associationTypes?.some(t => t.typeId === ASSOC_LABEL_PERSONA_FACTURA))?.toObjectId;

const empresaName = empresaId
  ? await hubspotClient.crm.companies.basicApi.getById(String(empresaId), ['name']).then(r => r?.properties?.name || null).catch(() => null)
  : null;
const personaName = personaId
  ? await hubspotClient.crm.contacts.basicApi.getById(String(personaId), ['firstname', 'lastname']).then(r => {
      const pp = r?.properties || {}; return [pp.firstname, pp.lastname].filter(Boolean).join(' ') || null;
    }).catch(() => null)
  : null;

const dealName = deal?.properties?.dealname || `Deal ${dealId}`;
const dealMeta = { empresa_que_factura: empresaName, persona_que_factura: personaName };

// 3) Render
const html = buildMensajeMantsoft(lineItems, dealName, dealMeta);
const out = `mantsoft-preview-${dealId}.html`;
fs.writeFileSync(out, html, 'utf-8');
console.log(`\n✅ HTML (${html.length} chars) escrito en ${out} — abrilo en el browser.`);
