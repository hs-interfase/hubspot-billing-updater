#!/usr/bin/env node
/**
 * historialAvisosDE.mjs
 *
 * El HISTORIAL de `of_billing_error` de los tickets del espejo (y del original),
 * con timestamps.
 *
 * 🔴 POR QUÉ HACE FALTA, y no alcanza con leer la propiedad
 *
 * `writeTicketBillingError` (dealAlerts.js:136-147) REEMPLAZA el valor, no
 * agrega. Y una sola edición del original dispara DOS escrituras sobre el mismo
 * campo del mismo ticket espejo, con segundos de diferencia:
 *
 *   1. el aviso de la TANDA D  — «En el negocio ORIGINAL (PY), «X» pasó de A a B»
 *   2. el aviso del sync LI→ticket del ESPEJO — «El vendedor modificó el elemento
 *      de pedido …», que dispara la copia al LI espejo por su propio webhook
 *
 * O sea que si se mira la propiedad DESPUÉS, el aviso de la tanda D ya no está:
 * lo tapó el de la cascada. En el historial están los dos, y en orden — que es
 * además la única forma de verificar el «avisa ANTES de tocar el espejo» de las
 * props sensibles (escenario (b)).
 *
 * Uso:
 *   node scripts/seed/historialAvisosDE.mjs                 → todos los tickets del manifest
 *   node scripts/seed/historialAvisosDE.mjs <ticketId> ...  → sólo esos
 *   ... --desde 2026-08-02T01:00:00Z                        → sólo lo posterior
 */

import 'dotenv/config';
import fs from 'fs';
import { hubspotClient } from '../../src/hubspotClient.js';

const argv = process.argv.slice(2);
const iDesde = argv.indexOf('--desde');
const DESDE = iDesde >= 0 ? new Date(argv[iDesde + 1]) : null;
const ids = argv.filter(a => /^\d{6,}$/.test(a));

const PROPS = ['of_billing_error', 'of_descripcion_producto', 'monto_unitario_real', 'cantidad_real', 'of_costo', 'hs_pipeline_stage', 'of_propietario_secundario', 'of_moneda'];

async function ticketsDelManifest() {
  const m = JSON.parse(fs.readFileSync('ronda-de-manifest.json', 'utf8'));
  const out = [];
  for (const [slug, li] of Object.entries(m.lineItems)) {
    for (const [rol, lik] of [['ORIGINAL', li.lineItemKey], ['ESPEJO', li.mirrorLineItemKey]]) {
      if (!lik) continue;
      const r = await hubspotClient.crm.tickets.searchApi.doSearch({
        filterGroups: [{ filters: [{ propertyName: 'of_line_item_key', operator: 'EQ', value: lik }] }],
        properties: ['fecha_resolucion_esperada'], limit: 100,
      });
      for (const t of (r.results || [])) out.push({ id: String(t.id), etiqueta: `${slug} ${rol} ${t.properties.fecha_resolucion_esperada}` });
    }
  }
  return out.sort((a, b) => a.etiqueta.localeCompare(b.etiqueta));
}

async function historial(ticketId) {
  const r = await hubspotClient.apiRequest({
    method: 'GET',
    path: `/crm/v3/objects/tickets/${ticketId}?propertiesWithHistory=${PROPS.join(',')}`,
  });
  const j = await r.json();
  return j.propertiesWithHistory || {};
}

const objetivo = ids.length ? ids.map(id => ({ id, etiqueta: `ticket ${id}` })) : await ticketsDelManifest();

for (const t of objetivo) {
  const h = await historial(t.id);
  const eventos = [];
  for (const [prop, versiones] of Object.entries(h)) {
    for (const v of versiones) {
      const cuando = new Date(v.timestamp);
      if (DESDE && cuando < DESDE) continue;
      eventos.push({ cuando, prop, valor: v.value, quien: v.sourceType });
    }
  }
  if (!eventos.length) continue;
  eventos.sort((a, b) => a.cuando - b.cuando);

  console.log(`\n═══ ${t.etiqueta}  (${t.id}) ═══`);
  for (const e of eventos) {
    const val = String(e.valor ?? '').replace(/\s+/g, ' ');
    console.log(`  ${e.cuando.toISOString().slice(11, 23)}  ${e.prop.padEnd(26)} ${val.slice(0, 170)}${val.length > 170 ? '…' : ''}`);
  }
}
process.exit(0);
