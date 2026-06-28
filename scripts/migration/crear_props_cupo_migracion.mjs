// scripts/migration/crear_props_cupo_migracion.mjs
//
// Crea (idempotente) las props mig_ de cupo a nivel DEAL para registrar el
// estado de cupo MIGRADO (respaldo de auditoría), separadas de las operativas:
//   - mig_cupo_total    = Cupo (total contratado)
//   - mig_cupo_restante = Cupo Saldo (saldo migrado)
//   - mig_cupo_faltante = Cupo - Saldo (consumido migrado)
//
// Las operativas (cupo_total/_monto, cupo_activo, tipo_de_cupo, cupo_umbral)
// las sigue seteando Paso A; cupo_restante/cupo_consumido YA NO se precargan
// (el motor reconstruye el saldo consumiendo los LIs parte_del_cupo).
//
// Uso (parado en la raíz del repo, con .env sandbox):
//   node scripts/migration/crear_props_cupo_migracion.mjs
import 'dotenv/config';

const TOKEN = process.env.HUBSPOT_PRIVATE_TOKEN;
if (!TOKEN) { console.error('Falta HUBSPOT_PRIVATE_TOKEN en .env (sandbox).'); process.exit(1); }

const OBJ = 'deals';
const BASE = 'https://api.hubapi.com';

async function api(path, opts = {}) {
  const r = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  const body = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, body };
}

// Tomamos el groupName de una prop de cupo existente para agrupar bien.
async function grupoDeCupo() {
  const { ok, body } = await api(`/crm/v3/properties/${OBJ}/cupo_total`);
  return ok ? body.groupName : 'dealinformation';
}

const PROPS = [
  { name: 'mig_cupo_total',    label: 'mig cupo total',    description: 'Cupo total contratado, migrado del CRM viejo (respaldo de auditoría).' },
  { name: 'mig_cupo_restante', label: 'mig cupo restante', description: 'Cupo Saldo migrado del CRM viejo (respaldo de auditoría).' },
  { name: 'mig_cupo_faltante', label: 'mig cupo faltante', description: 'Cupo consumido migrado (= total - saldo) del CRM viejo (respaldo de auditoría).' },
];

const groupName = await grupoDeCupo();
console.log(`groupName destino: ${groupName}\n`);

for (const p of PROPS) {
  const exists = await api(`/crm/v3/properties/${OBJ}/${p.name}`);
  if (exists.ok) { console.log(`= EXISTE   ${p.name} (${exists.body.type}/${exists.body.fieldType}) → saltado`); continue; }
  const res = await api(`/crm/v3/properties/${OBJ}`, {
    method: 'POST',
    body: JSON.stringify({
      name: p.name, label: p.label, description: p.description,
      groupName, type: 'number', fieldType: 'number',
    }),
  });
  if (res.ok) console.log(`+ CREADA   ${p.name} (number/number)`);
  else console.log(`✖ ERROR    ${p.name} → HTTP ${res.status}: ${JSON.stringify(res.body?.message || res.body)}`);
}
console.log('\nListo.');
