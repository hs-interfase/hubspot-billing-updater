// crear_prop_nota_migracion.mjs
// Crea la propiedad de deal `nota_migracion` (textarea multilínea) para volcar
// notas/anomalías de migración SIN usar billing_error (que lo pisa el runtime).
// Idempotente: si ya existe, no hace nada. Solo toca el ESQUEMA, no datos.
// Node 18+ (fetch nativo), ESM, sin dependencias.
//
// Uso (parado en la carpeta del repo donde está el .env):
//   node crear_prop_nota_migracion.mjs
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

const TOKEN =
  process.env.HUBSPOT_PRIVATE_TOKEN ||
  process.env.HUBSPOT_TOKEN ||
  process.env.HUBSPOT_SANDBOX_TOKEN ||
  process.env.HUBSPOT_ACCESS_TOKEN ||
  process.env.HUBSPOT_API_TOKEN;

if (!TOKEN) {
  console.error('Falta el token. Definí HUBSPOT_TOKEN con el de SANDBOX (o PROD).');
  process.exit(1);
}

const BASE = 'https://api.hubapi.com';
const OBJECT = 'deals';
const NAME = 'nota_migracion';

const DEF = {
  name: NAME,
  label: 'Nota de migración',
  type: 'string',
  fieldType: 'textarea',
  groupName: 'dealinformation', // grupo default de deals
  description: 'Notas y anomalías de la migración Interfase → HubSpot. No la usa el runtime de billing.',
};

async function api(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  const body = await res.text();
  return { ok: res.ok, status: res.status, body };
}

async function main() {
  // 1. ¿Ya existe?
  const get = await api(`/crm/v3/properties/${OBJECT}/${NAME}`);
  if (get.ok) {
    console.log(`✓ La propiedad "${NAME}" ya existe en ${OBJECT}. No hago nada.`);
    return;
  }
  if (get.status !== 404) {
    console.error(`✗ Error inesperado al chequear: ${get.status} ${get.body}`);
    process.exit(1);
  }

  // 2. No existe → crearla.
  const post = await api(`/crm/v3/properties/${OBJECT}`, {
    method: 'POST',
    body: JSON.stringify(DEF),
  });
  if (post.ok) {
    console.log(`✔ Propiedad "${NAME}" creada en ${OBJECT} (${DEF.fieldType}).`);
  } else {
    console.error(`✗ No se pudo crear: ${post.status} ${post.body}`);
    console.error('  Si el error es por groupName, listá los grupos con:');
    console.error(`  GET ${BASE}/crm/v3/properties/${OBJECT}/groups`);
    process.exit(1);
  }
}

main();
