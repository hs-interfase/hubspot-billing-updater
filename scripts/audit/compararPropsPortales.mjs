// scripts/audit/compararPropsPortales.mjs
//
// Compara las propiedades CUSTOM de PROD vs SANDBOX, objeto por objeto,
// para detectar qué falta en cada entorno y poder normalizarlos.
//
// READ-ONLY: solo lee definiciones de propiedades. No escribe nada, no toca datos.
//
// Uso:  node scripts/audit/compararPropsPortales.mjs
//       node scripts/audit/compararPropsPortales.mjs --todas   (incluye las nativas de HubSpot)
//
// Tokens: PROD desde .env.real · SANDBOX desde .env

import dotenv from 'dotenv';
import fs from 'node:fs';

const INCLUIR_NATIVAS = process.argv.includes('--todas');

const OBJETOS = ['deals', 'tickets', 'line_items', 'companies', 'contacts', 'products'];

function cargarToken(path) {
  const parsed = dotenv.parse(fs.readFileSync(path));
  return parsed.HUBSPOT_PRIVATE_TOKEN;
}

async function traerProps(token, objeto) {
  const r = await fetch(`https://api.hubapi.com/crm/v3/properties/${objeto}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error(`${objeto}: HTTP ${r.status} ${await r.text()}`);
  const { results = [] } = await r.json();
  const map = new Map();
  for (const p of results) {
    if (!INCLUIR_NATIVAS && p.hubspotDefined) continue;
    if (p.calculated && p.hubspotDefined) continue;
    map.set(p.name, {
      name: p.name,
      label: p.label,
      type: p.type,
      fieldType: p.fieldType,
      groupName: p.groupName,
      calculated: !!p.calculated,
      formula: p.calculationFormula || null,
      options: (p.options || []).map(o => `${o.label}:${o.value}`).join(' | '),
      description: p.description || '',
    });
  }
  return map;
}

// Diferencias de definición que importan (no comparamos description ni groupName:
// cambian seguido y no afectan comportamiento).
function difDefinicion(a, b) {
  const difs = [];
  if (a.type !== b.type) difs.push(`type: prod=${a.type} / sandbox=${b.type}`);
  if (a.fieldType !== b.fieldType) difs.push(`fieldType: prod=${a.fieldType} / sandbox=${b.fieldType}`);
  if (a.calculated !== b.calculated) difs.push(`calculada: prod=${a.calculated} / sandbox=${b.calculated}`);
  if ((a.formula || '') !== (b.formula || '')) difs.push('FÓRMULA distinta');
  if (a.options !== b.options) difs.push(`opciones: prod=[${a.options}] / sandbox=[${b.options}]`);
  return difs;
}

const tokProd = cargarToken('.env.real');
const tokSbx = cargarToken('.env');
if (!tokProd || !tokSbx) { console.error('Falta HUBSPOT_PRIVATE_TOKEN en .env.real o .env'); process.exit(1); }

const out = [];
const push = (s = '') => { out.push(s); console.log(s); };

push(`# Comparación de propiedades PROD vs SANDBOX`);
push(`> ${INCLUIR_NATIVAS ? 'Todas las propiedades' : 'Solo propiedades CUSTOM (las nativas de HubSpot se omiten)'}`);
push();

const resumen = [];

for (const objeto of OBJETOS) {
  let prod, sbx;
  try {
    [prod, sbx] = await Promise.all([traerProps(tokProd, objeto), traerProps(tokSbx, objeto)]);
  } catch (err) {
    push(`## ${objeto} — ERROR: ${err.message}`);
    continue;
  }

  const soloProd = [...prod.keys()].filter(k => !sbx.has(k)).sort();
  const soloSbx = [...sbx.keys()].filter(k => !prod.has(k)).sort();
  const comunes = [...prod.keys()].filter(k => sbx.has(k));
  const distintas = comunes
    .map(k => ({ name: k, difs: difDefinicion(prod.get(k), sbx.get(k)) }))
    .filter(x => x.difs.length)
    .sort((a, b) => a.name.localeCompare(b.name));

  resumen.push({ objeto, prod: prod.size, sbx: sbx.size, soloProd: soloProd.length, soloSbx: soloSbx.length, distintas: distintas.length });

  push(`\n---\n\n## ${objeto.toUpperCase()}`);
  push(`PROD: ${prod.size} custom · SANDBOX: ${sbx.size} custom · comunes: ${comunes.length}`);

  if (soloSbx.length) {
    push(`\n### ❌ FALTAN EN PROD (${soloSbx.length}) — están en sandbox`);
    for (const k of soloSbx) {
      const p = sbx.get(k);
      push(`- \`${k}\` — "${p.label}" · ${p.type}/${p.fieldType}${p.calculated ? ' · CALCULADA' : ''}${p.options ? ` · [${p.options}]` : ''}`);
      if (p.calculated && p.formula) push(`    fórmula: \`${p.formula.replace(/\n/g, ' ')}\``);
    }
  }

  if (soloProd.length) {
    push(`\n### ⚠️ FALTAN EN SANDBOX (${soloProd.length}) — están en prod`);
    for (const k of soloProd) {
      const p = prod.get(k);
      push(`- \`${k}\` — "${p.label}" · ${p.type}/${p.fieldType}${p.calculated ? ' · CALCULADA' : ''}${p.options ? ` · [${p.options}]` : ''}`);
    }
  }

  if (distintas.length) {
    push(`\n### 🔶 EXISTEN EN AMBOS PERO DIFIEREN (${distintas.length})`);
    for (const d of distintas) push(`- \`${d.name}\` — ${d.difs.join(' · ')}`);
  }

  if (!soloProd.length && !soloSbx.length && !distintas.length) push(`\n✅ Idénticos.`);
}

push(`\n---\n\n# RESUMEN\n`);
push(`| Objeto | PROD | SANDBOX | Faltan en PROD | Faltan en SANDBOX | Difieren |`);
push(`|---|---|---|---|---|---|`);
for (const r of resumen) push(`| ${r.objeto} | ${r.prod} | ${r.sbx} | ${r.soloSbx} | ${r.soloProd} | ${r.distintas} |`);

const dest = 'C:/Users/promi/OneDrive/Escritorio/definitivos/COMPARACION_props_portales.md';
fs.writeFileSync(dest, out.join('\n'), 'utf8');
console.log(`\n\n→ Guardado en ${dest}`);
