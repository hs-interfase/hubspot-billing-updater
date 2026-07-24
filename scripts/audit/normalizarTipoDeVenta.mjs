// Normaliza las opciones de `tipo_de_venta` en DEALS: agrega las 4 etiquetas acordadas,
// conservando las opciones viejas (CONT/UP/CROSS/NCL) para no huerfanar datos existentes.
//
// Por defecto es DRY-RUN: muestra el plan y cuenta cuantos negocios usan cada valor.
// Con --write aplica el PATCH. Con --solo=PROD|PRUEBAS limita el portal.
import fs from 'node:fs';

const REPO = 'C:/Users/promi/OneDrive/Documentos/GitHub/hubspot-billing-updater';
const WRITE = process.argv.includes('--write');
const SOLO = (process.argv.find(a => a.startsWith('--solo=')) || '').split('=')[1] || null;

const NUEVAS = ['Up Selling', 'Cross Selling', 'Nuevo Cliente', 'Continuación de Negocio'];

const tok = (p) => {
  for (const raw of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = raw.match(/^\s*HUBSPOT_PRIVATE_TOKEN\s*=\s*(.*)$/);
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  }
  throw new Error(`sin HUBSPOT_PRIVATE_TOKEN en ${p}`);
};
const PORTALES = { PROD: tok(`${REPO}/.env.real`), PRUEBAS: tok(`${REPO}/.env`) };

async function api(token, path, init = {}) {
  const r = await fetch(`https://api.hubapi.com${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${await r.text()}`);
  return r.json();
}

// cuenta negocios por valor de tipo_de_venta (para saber si una opcion esta en uso)
async function contarUso(token, valor) {
  const body = {
    filterGroups: [{ filters: [{ propertyName: 'tipo_de_venta', operator: 'EQ', value: valor }] }],
    limit: 1,
  };
  const r = await api(token, '/crm/v3/objects/deals/search', { method: 'POST', body: JSON.stringify(body) });
  return r.total ?? 0;
}

for (const [nombre, token] of Object.entries(PORTALES)) {
  if (SOLO && SOLO.toUpperCase() !== nombre) continue;
  console.log(`\n${'='.repeat(70)}\n${nombre}\n${'='.repeat(70)}`);

  const prop = await api(token, '/crm/v3/properties/deals/tipo_de_venta');
  const actuales = prop.options || [];
  console.log('opciones actuales:', actuales.map(o => o.value).join(' | ') || '(ninguna)');

  for (const o of actuales) {
    const n = await contarUso(token, o.value);
    console.log(`   ${o.value.padEnd(26)} → ${n} negocio(s)`);
  }

  const faltan = NUEVAS.filter(v => !actuales.some(o => o.value === v));
  if (!faltan.length) { console.log('\n✅ ya tiene las 4 etiquetas, nada que hacer'); continue; }
  console.log('\nfaltan agregar:', faltan.join(' | '));

  if (!WRITE) { console.log('(dry-run — usar --write para aplicar)'); continue; }

  // additivo: conserva las viejas y agrega las nuevas al final
  const options = [
    ...actuales.map((o, i) => ({ label: o.label, value: o.value, displayOrder: i, hidden: !!o.hidden })),
    ...faltan.map((v, i) => ({ label: v, value: v, displayOrder: actuales.length + i, hidden: false })),
  ];
  await api(token, '/crm/v3/properties/deals/tipo_de_venta', {
    method: 'PATCH',
    body: JSON.stringify({ options }),
  });
  const verif = await api(token, '/crm/v3/properties/deals/tipo_de_venta');
  console.log('✅ aplicado. ahora:', (verif.options || []).map(o => o.value).join(' | '));
}
console.log('\nFin.');
