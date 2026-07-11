// scripts/fix/crearPropsValorTotal.mjs
//
// Crea (idempotente) en DEALS las dos propiedades del campo VALOR del negocio:
//   - valor_total                  (número) VALOR en USD, principal para reporting
//   - valor_total_moneda_original  (número) VALOR en la moneda del negocio
//
// Las escribe el motor (recalcValorTotal.js) al final de cada corrida del deal.
// NO son calc props: son números planos. Si ya existen, se saltan (no se borran).
//
// Uso (raíz del repo):
//   node scripts/fix/crearPropsValorTotal.mjs           → portal de .env (HUBSPOT_PRIVATE_TOKEN)
//   Para producción: usar el token de prod (HUBSPOT_PROD_TOKEN / .env.real).
import 'dotenv/config';

const TOKEN = process.env.HUBSPOT_PRIVATE_TOKEN;
if (!TOKEN) { console.error('Falta HUBSPOT_PRIVATE_TOKEN en .env.'); process.exit(1); }

const BASE = 'https://api.hubapi.com';
const OBJ = 'deals';

async function api(path, opts = {}) {
  const r = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  const body = r.status === 204 ? {} : await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, body };
}

async function grupoDe(obj, propRef, fallback) {
  const { ok, body } = await api(`/crm/v3/properties/${obj}/${propRef}`);
  return ok ? body.groupName : fallback;
}

// Confirmar el portal ANTES de mutar (pruebas=51101688, prod=50148277).
const acct = await api('/account-info/v3/details');
console.log(`Portal destino: ${acct.body?.portalId ?? '(desconocido)'}   (pruebas=51101688 · prod=50148277)`);

const groupName = await grupoDe(OBJ, 'amount', 'dealinformation');

const PROPS = [
  {
    name: 'valor_total',
    label: 'Valor total (USD)',
    type: 'number',
    fieldType: 'number',
    description: 'VALOR del negocio en USD (principal, para reporting). Lo calcula el motor desde los line items: Caso 1 (fin definido) = Σ precio×cantidad×nº de pagos; Caso 2 (auto-renew) = run-rate anual precio×cantidad×multiplicador de periodicidad. Convertido con el dólar del deal.',
  },
  {
    name: 'valor_total_moneda_original',
    label: 'Valor total (moneda original)',
    type: 'number',
    fieldType: 'number',
    description: 'VALOR del negocio en la moneda del negocio (referencia). Mismo cálculo que valor_total pero sin convertir a USD.',
  },
];

console.log(`\n── ${OBJ} (groupName: ${groupName}) ──`);
for (const p of PROPS) {
  const exists = await api(`/crm/v3/properties/${OBJ}/${p.name}`);
  if (exists.ok) {
    console.log(`= EXISTE   ${p.name} (${exists.body.type}/${exists.body.fieldType}) → saltado`);
    continue;
  }
  const res = await api(`/crm/v3/properties/${OBJ}`, {
    method: 'POST',
    body: JSON.stringify({ ...p, groupName }),
  });
  if (res.ok) console.log(`+ CREADA   ${p.name} (${p.type}/${p.fieldType})`);
  else console.log(`✖ ERROR    ${p.name} → HTTP ${res.status}: ${JSON.stringify(res.body?.message || res.body)}`);
}
console.log('\nListo.');
