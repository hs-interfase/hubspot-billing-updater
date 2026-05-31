// diagnostico_migration_ext.mjs
// Solo lectura. Cierra el §6: vuelca las OPCIONES de cada enum select y las
// PROPS custom de line items y tickets, marca cuáles son read-only, y lista
// los pipelines de tickets (para confirmar el MANUAL 832539959).
// No escribe nada. Node 18+ (fetch nativo), ESM, sin dependencias.
//
// Uso (PowerShell, parado en la carpeta del repo donde está el .env):
//   node diagnostico_migration_ext.mjs
import { readFileSync } from 'node:fs';

// Carga el .env del directorio actual si existe (sin dependencias).
try {
  for (const raw of readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i === -1) continue;
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    if (k && !(k in process.env)) process.env[k] = v;
  }
} catch {}

// Token: toma el primero que encuentre (orden de preferencia).
const TOKEN =
  process.env.HUBSPOT_PRIVATE_TOKEN ||
  process.env.HUBSPOT_TOKEN ||
  process.env.HUBSPOT_SANDBOX_TOKEN ||
  process.env.HUBSPOT_ACCESS_TOKEN ||
  process.env.HUBSPOT_API_TOKEN;

if (!TOKEN) {
  console.error(
    'Falta el token. Definí HUBSPOT_TOKEN (o HUBSPOT_SANDBOX_TOKEN / HUBSPOT_ACCESS_TOKEN) con el de SANDBOX.'
  );
  process.exit(1);
}

const BASE = 'https://api.hubapi.com';

async function api(path) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GET ${path} → ${res.status} ${res.statusText} ${body}`);
  }
  return res.json();
}

// Marca de solo lectura: si no se puede escribir vía API, lo avisamos.
function flagsDeProp(p) {
  const m = p.modificationMetadata || {};
  const flags = [];
  if (m.readOnlyValue) flags.push('READ-ONLY (no escribible vía API)');
  if (p.calculated) flags.push('CALCULADA');
  if (p.hubspotDefined) flags.push('default HubSpot');
  return flags.length ? `  [${flags.join(' · ')}]` : '';
}

function esEnumSelect(p) {
  return p.type === 'enumeration' && (p.fieldType === 'select' || p.fieldType === 'radio');
}

// ── 1. Opciones de cada enum select (lo crítico para no romper el writer) ──
async function volcarEnumsSelect(objectType, titulo) {
  console.log(`\n══════════════════════════════════════`);
  console.log(`ENUMS SELECT — ${titulo} (${objectType})`);
  console.log(`══════════════════════════════════════`);
  const { results = [] } = await api(`/crm/v3/properties/${objectType}`);
  const selects = results.filter(esEnumSelect);
  if (!selects.length) {
    console.log('  (ninguna prop enumeration/select)');
    return;
  }
  for (const p of selects.sort((a, b) => a.name.localeCompare(b.name))) {
    console.log(`\n  ${p.name}  | Label: "${p.label}"${flagsDeProp(p)}`);
    const opts = p.options || [];
    if (!opts.length) {
      console.log('    (sin opciones definidas)');
      continue;
    }
    for (const o of opts) {
      const oculto = o.hidden ? ' (oculta)' : '';
      // value es lo que hay que MANDAR; label es lo que se ve en la UI.
      console.log(`    value="${o.value}"  ←  label="${o.label}"${oculto}`);
    }
  }
}

// ── 2. Todas las props custom de un objeto (para line items y tickets) ──
async function volcarPropsCustom(objectType, titulo) {
  console.log(`\n══════════════════════════════════════`);
  console.log(`PROPS CUSTOM — ${titulo} (${objectType})`);
  console.log(`══════════════════════════════════════`);
  const { results = [] } = await api(`/crm/v3/properties/${objectType}`);
  const custom = results
    .filter((p) => !p.hubspotDefined)
    .sort((a, b) => a.name.localeCompare(b.name));
  if (!custom.length) {
    console.log('  (sin props custom)');
  } else {
    for (const p of custom) {
      console.log(
        `  ${p.name} | Label: "${p.label}" | Type: ${p.type}/${p.fieldType}${flagsDeProp(p)}`
      );
      if (esEnumSelect(p) && (p.options || []).length) {
        for (const o of p.options) {
          console.log(`      value="${o.value}"  ←  label="${o.label}"`);
        }
      }
    }
    console.log(`  Total custom: ${custom.length}`);
  }
}

// ── 3. Props puntuales que el writer toca y conviene confirmar escribibles ──
async function chequearPropsClave(objectType, nombres) {
  console.log(`\n  Chequeo de props clave en ${objectType}:`);
  const { results = [] } = await api(`/crm/v3/properties/${objectType}`);
  const byName = new Map(results.map((p) => [p.name, p]));
  for (const n of nombres) {
    const p = byName.get(n);
    if (!p) {
      console.log(`    ✗ "${n}" NO existe`);
    } else {
      const ro = p.modificationMetadata?.readOnlyValue ? ' (READ-ONLY)' : '';
      console.log(`    ✓ "${n}" → ${p.type}/${p.fieldType}${ro}`);
    }
  }
}

// ── 4. Pipelines de tickets (confirmar MANUAL 832539959) ──
async function volcarPipelinesTickets() {
  console.log(`\n══════════════════════════════════════`);
  console.log(`PIPELINES DE TICKETS`);
  console.log(`══════════════════════════════════════`);
  const { results = [] } = await api(`/crm/v3/pipelines/tickets`);
  for (const pl of results) {
    console.log(`\nPipeline: "${pl.label}" (ID: ${pl.id})`);
    for (const s of pl.stages.sort((a, b) => a.displayOrder - b.displayOrder)) {
      console.log(`  Stage: "${s.label}" | ID: ${s.id}`);
    }
  }
}

async function main() {
  try {
    // Enums select de DEALS (pais_operativo, tipo_de_cupo, tipo_negocio,
    // facturacion_automatica, unidad_de_negocio, criterio_moneda, etc.)
    await volcarEnumsSelect('deals', 'DEALS');

    // Line items: props custom + chequeo de las que toca el writer.
    await volcarPropsCustom('line_items', 'LINE ITEMS');
    await chequearPropsClave('line_items', [
      'hs_margin',
      'of_iva',
      'line_item_key',
      'of_frecuencia_de_facturacion',
      'facturacion_automatica',
      'facturacion_activa',
    ]);
    // También los enums select de line items (servicio, frecuencia, etc.)
    await volcarEnumsSelect('line_items', 'LINE ITEMS');

    // Tickets: props custom + chequeo + enums select.
    await volcarPropsCustom('tickets', 'TICKETS');
    await chequearPropsClave('tickets', ['of_ticket_key']);
    await volcarEnumsSelect('tickets', 'TICKETS');

    // Pipelines de tickets (confirmar MANUAL 832539959).
    await volcarPipelinesTickets();

    console.log('\n✔ Diagnóstico extendido completo (no se escribió nada).');
    console.log(
      'Nota: "createdate vía API" no se puede confirmar por lectura; se valida recién al escribir el piloto.'
    );
  } catch (e) {
    console.error('\n✗ Error:', e.message);
    process.exit(1);
  }
}

main();
