// buscar_empresa.mjs
// Busca companies en HubSpot por token de nombre (read-only). Para diagnosticar
// por qué un mansoft no matcheó empresa (el match de definitivos es por NOMBRE).
// Muestra id + name + props de código, para comparar contra el nombre del deal.
//
// Uso (parado en la raíz del repo, con el .env):
//   node scripts/migration/buscar_empresa.mjs "Puertos" "Patco" "Granja Avicola"
import { readFileSync } from 'node:fs';

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
  process.env.HUBSPOT_PRIVATE_TOKEN || process.env.HUBSPOT_TOKEN ||
  process.env.HUBSPOT_SANDBOX_TOKEN || process.env.HUBSPOT_ACCESS_TOKEN;
if (!TOKEN) { console.error('Falta el token (HUBSPOT_PRIVATE_TOKEN).'); process.exit(1); }

const BASE = 'https://api.hubapi.com';
const PROPS = ['name', 'codigo_empresa_contactos', 'codigo_cliente_comercial', 'codigo_contactos', 'pais'];

async function api(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  const text = await res.text();
  let json = {}; try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(json)}`);
  return json;
}

const fragmentos = process.argv.slice(2);
if (!fragmentos.length) { console.error('Pasá uno o más fragmentos de nombre.'); process.exit(1); }

for (const frag of fragmentos) {
  console.log(`\n=== "${frag}" ===`);
  try {
    const r = await api('/crm/v3/objects/companies/search', {
      method: 'POST',
      body: JSON.stringify({
        filterGroups: [{ filters: [{ propertyName: 'name', operator: 'CONTAINS_TOKEN', value: frag }] }],
        properties: PROPS,
        limit: 20,
      }),
    });
    const results = r.results || [];
    if (!results.length) { console.log('  (sin resultados)'); continue; }
    for (const c of results) {
      const p = c.properties || {};
      console.log(`  id=${c.id} · name="${p.name || ''}" · cod_emp_contactos=${p.codigo_empresa_contactos || '—'} · cod_cli_comercial=${p.codigo_cliente_comercial || '—'} · cod_contactos=${p.codigo_contactos || '—'} · pais=${p.pais || '—'}`);
    }
  } catch (e) {
    console.log(`  ✖ error: ${e.message}`);
  }
}
