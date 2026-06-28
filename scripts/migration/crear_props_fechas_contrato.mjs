// scripts/migration/crear_props_fechas_contrato.mjs
//
// Crea (idempotente) las props de FECHA DE CONTRATO a nivel LINE ITEM, usadas por
// la migración Mansoft (migracion_mansoft_pasoA.mjs). Separan la fecha de CONTRATO
// (manual, cruda) de la fecha de FACTURACIÓN (calculada por cuando_se_factura):
//   - inicio_del_contrato = Inicio   (fecha de inicio de contrato, manual)
//   - fin_del_contrato    = Vigencia (fecha de fin de contrato; auto-renew → 2099-12-31)
//
// La fecha de FACTURACIÓN va en props que YA existen:
//   - hs_recurring_billing_start_date = inicio de facturación (calculado)
//   - fecha_vencimiento_contrato      = vencimiento de FACTURACIÓN (calculado / 2099-12-31)
//
// Uso (parado en la raíz del repo, con .env sandbox):
//   node scripts/migration/crear_props_fechas_contrato.mjs
//   (para prod: cambiar el token o exportar HUBSPOT_PRIVATE_TOKEN del portal de prod)
import 'dotenv/config';

const TOKEN = process.env.HUBSPOT_PRIVATE_TOKEN;
if (!TOKEN) { console.error('Falta HUBSPOT_PRIVATE_TOKEN en .env (sandbox).'); process.exit(1); }

const OBJ = 'line_items';
const BASE = 'https://api.hubapi.com';

async function api(path, opts = {}) {
  const r = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  const body = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, body };
}

// Reutilizamos el grupo de una prop de fecha existente del line item para agrupar bien.
async function grupoDestino() {
  const { ok, body } = await api(`/crm/v3/properties/${OBJ}/fecha_vencimiento_contrato`);
  return ok ? body.groupName : 'lineiteminformation';
}

const PROPS = [
  { name: 'inicio_del_contrato', label: 'Inicio del contrato',
    description: 'Fecha de inicio de CONTRATO (manual). Distinta del inicio de facturación, que se calcula según "cuando se factura".' },
  { name: 'fin_del_contrato', label: 'Fin del contrato',
    description: 'Fecha de fin de CONTRATO / vigencia (manual). En auto-renovación se fija a 2099-12-31.' },
];

const groupName = await grupoDestino();
console.log(`groupName destino: ${groupName}\n`);

for (const p of PROPS) {
  const exists = await api(`/crm/v3/properties/${OBJ}/${p.name}`);
  if (exists.ok) { console.log(`= EXISTE   ${p.name} (${exists.body.type}/${exists.body.fieldType}) → saltado`); continue; }
  const res = await api(`/crm/v3/properties/${OBJ}`, {
    method: 'POST',
    body: JSON.stringify({
      name: p.name, label: p.label, description: p.description,
      groupName, type: 'date', fieldType: 'date',
    }),
  });
  if (res.ok) console.log(`+ CREADA   ${p.name} (date/date)`);
  else console.log(`✖ ERROR    ${p.name} → HTTP ${res.status}: ${JSON.stringify(res.body?.message || res.body)}`);
}
console.log('\nListo.');
