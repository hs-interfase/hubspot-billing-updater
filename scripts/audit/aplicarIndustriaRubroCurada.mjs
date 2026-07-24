// scripts/audit/aplicarIndustriaRubroCurada.mjs
//
// Deja `industria__rubro` con la LISTA CURADA en ambos portales:
//   - PROD: la crea (no existe).
//   - SANDBOX: reemplaza las ~85 opciones auto-generadas por las 38 curadas.
//
// La lista canónica vive en definitivos/4_PROGRAMAS/_shared/industriaRubro.mjs
// (misma fuente que usa la migración → no se pueden desincronizar).
//
// ⚠️ DRY-RUN POR DEFECTO. Ejecutar con --apply
//
// OJO en SANDBOX: quitar opciones NO borra los valores ya escritos en las fichas,
// pero esos valores quedan fuera de la lista y HubSpot los muestra como inválidos.
// Como los datos se van a limpiar igual, no es un problema — pero conviene saberlo.

import dotenv from 'dotenv';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

// Ruta absoluta: el repo y `definitivos` viven en árboles distintos de OneDrive,
// así que un path relativo se rompe. Override con INDUSTRIA_RUBRO_MODULE si hace falta.
const MOD = process.env.INDUSTRIA_RUBRO_MODULE
  || 'C:/Users/promi/OneDrive/Escritorio/definitivos/4_PROGRAMAS/_shared/industriaRubro.mjs';
const { OPCIONES_CURADAS } = await import(pathToFileURL(MOD).href);

const APPLY = process.argv.includes('--apply');
const TOK = {
  PROD: dotenv.parse(fs.readFileSync('.env.real')).HUBSPOT_PRIVATE_TOKEN,
  SANDBOX: dotenv.parse(fs.readFileSync('.env')).HUBSPOT_PRIVATE_TOKEN,
};

const options = OPCIONES_CURADAS.map((o, i) => ({ label: o, value: o, displayOrder: i }));

const DEF = {
  name: 'industria__rubro',
  label: 'Industria / Rubro',
  type: 'enumeration',
  fieldType: 'checkbox',   // MULTI-SELECT (decisión usuaria 20-jul)
  groupName: 'companyinformation',
  description: 'Rubro CURADO de la empresa (multi-select). El valor crudo del origen se conserva en `giro_comercial`. Mapeo en definitivos/4_PROGRAMAS/_shared/industriaRubro.mjs',
  options,
};

async function api(portal, method, path, body) {
  const r = await fetch(`https://api.hubapi.com/crm/v3/properties/${path}`, {
    method,
    headers: { Authorization: `Bearer ${TOK[portal]}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await r.text();
  return { ok: r.ok, status: r.status, body: t ? JSON.parse(t) : null };
}

console.log(`Lista curada: ${OPCIONES_CURADAS.length} opciones\n`);

for (const portal of ['PROD', 'SANDBOX']) {
  const actual = await api(portal, 'GET', 'companies/industria__rubro');

  if (!actual.ok) {
    console.log(`➕ ${portal} — no existe, se CREA con las ${options.length} opciones curadas`);
    if (APPLY) {
      const r = await api(portal, 'POST', 'companies', DEF);
      console.log(r.ok ? '   ✅ creada' : `   ❌ ${r.status}: ${JSON.stringify(r.body?.message)}`);
    }
    continue;
  }

  const viejas = (actual.body.options || []).map(o => o.value);
  const aQuitar = viejas.filter(v => !OPCIONES_CURADAS.includes(v));
  const aAgregar = OPCIONES_CURADAS.filter(v => !viejas.includes(v));

  if (!aQuitar.length && !aAgregar.length) { console.log(`⏭️  ${portal} — ya tiene la lista curada`); continue; }

  console.log(`🔧 ${portal} — ${viejas.length} opciones → ${options.length} curadas`);
  console.log(`   quita ${aQuitar.length}: ${aQuitar.slice(0, 12).join(' · ')}${aQuitar.length > 12 ? ` … y ${aQuitar.length - 12} más` : ''}`);
  console.log(`   agrega ${aAgregar.length}: ${aAgregar.join(' · ') || '(ninguna)'}`);
  if (APPLY) {
    const r = await api(portal, 'PATCH', 'companies/industria__rubro', { options, fieldType: 'checkbox', description: DEF.description });
    console.log(r.ok ? '   ✅ actualizada' : `   ❌ ${r.status}: ${JSON.stringify(r.body?.message)}`);
  }
}

console.log(`\n${APPLY ? '✅ APLICADO' : '🔍 DRY-RUN — usá --apply para ejecutar'}`);
