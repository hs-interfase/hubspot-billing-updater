// scripts/audit/normalizarPropsPortales.mjs
//
// Normaliza las propiedades entre PROD y SANDBOX según las decisiones del 20-jul.
// Deriva del informe de compararPropsPortales.mjs.
//
// ⚠️ DRY-RUN POR DEFECTO. Para ejecutar de verdad:  --apply
//    Filtros opcionales:  --solo-prod  |  --solo-sandbox  |  --sin-borrados
//
// Uso:  node scripts/audit/normalizarPropsPortales.mjs           (muestra el plan)
//       node scripts/audit/normalizarPropsPortales.mjs --apply   (ejecuta)
//
// Idempotente: si la prop ya existe / ya tiene el valor correcto, no hace nada.

import dotenv from 'dotenv';
import fs from 'node:fs';

const APPLY = process.argv.includes('--apply');
const SOLO_PROD = process.argv.includes('--solo-prod');
const SOLO_SBX = process.argv.includes('--solo-sandbox');
const SIN_BORRADOS = process.argv.includes('--sin-borrados');

const TOK = {
  PROD: dotenv.parse(fs.readFileSync('.env.real')).HUBSPOT_PRIVATE_TOKEN,
  SANDBOX: dotenv.parse(fs.readFileSync('.env')).HUBSPOT_PRIVATE_TOKEN,
};

const GRUPO = { deals: 'dealinformation', tickets: 'ticketinformation', line_items: 'lineiteminformation', contacts: 'contactinformation', products: 'productinformation', companies: 'companyinformation' };

// Opciones estándar Sí/No con valores true/false (las que espera el código:
// buildMensajeFacturacion.js:94 → fmtIrae acepta 'true'/'false')
const OPC_SI_NO = [
  { label: 'Sí', value: 'true', displayOrder: 0 },
  { label: 'No', value: 'false', displayOrder: 1 },
];

// ── EL PLAN ─────────────────────────────────────────────────────────────────
const PLAN = [
  // ══ PROD: crear lo que falta ══
  { portal: 'PROD', obj: 'deals', accion: 'crear', name: 'mig_espejo_independiente',
    payload: { label: 'Espejo migrado independiente', type: 'enumeration', fieldType: 'booleancheckbox', options: OPC_SI_NO,
      description: 'Seteada por la migración: las líneas de este mirror son históricas y el motor no las sincroniza desde el PY; solo avisa si el PY cambia costo/cantidad' },
    porque: '🔴 BLOQUEANTE — sin esto ningún espejo se puede sellar en prod' },

  { portal: 'PROD', obj: 'deals', accion: 'crear', name: 'mig_py_li_snapshot',
    payload: { label: 'Snapshot LIs PY (mirror sellado)', type: 'string', fieldType: 'text',
      description: 'Último snapshot costo/cantidad de las líneas UY del deal PY origen. El motor lo usa para avisar una sola vez por cambio en mirrors sellados.' },
    porque: '🔴 BLOQUEANTE — par de la anterior' },

  { portal: 'PROD', obj: 'tickets', accion: 'crear', name: 'descripcion',
    payload: { label: 'Descripción', type: 'string', fieldType: 'textarea',
      description: 'Descripción propia de la orden de facturación (distinta de la descripción del producto).' },
    porque: 'ítem 17 — el export ya la lee; en prod la columna sale siempre vacía' },

  { portal: 'PROD', obj: 'tickets', accion: 'crear', name: 'inicio_del_contrato',
    payload: { label: 'Inicio del contrato', type: 'date', fieldType: 'date' },
    porque: 'vista Victoria (ítem 23) — sin esto no se puede replicar en prod' },

  { portal: 'PROD', obj: 'tickets', accion: 'crear', name: 'fin_del_contrato',
    payload: { label: 'Fin del contrato', type: 'date', fieldType: 'date' },
    porque: 'vista Victoria (ítem 23)' },

  { portal: 'PROD', obj: 'line_items', accion: 'crear', name: 'fecha_ultimo_ajuste',
    payload: { label: 'Fecha último ajuste', type: 'date', fieldType: 'date' },
    porque: 'paramétricas (ítem 106) — props PROD' },

  { portal: 'PROD', obj: 'line_items', accion: 'crear', name: 'porcentaje_ultimo_ajuste',
    payload: { label: 'Porcentaje último ajuste', type: 'number', fieldType: 'number' },
    porque: 'paramétricas (ítem 106) — props PROD' },

  // costo_total_en_dolares: ARCHIVADA en los dos portales el 2-ago-2026 (0 line items con valor,
  // duplicaba a costo_total_usd, que es la que lee el motor). No recrearla.

  { portal: 'PROD', obj: 'line_items', accion: 'crear', name: 'mig_monto_moneda_orig',
    payload: { label: 'mig_monto_moneda_orig', type: 'string', fieldType: 'text' }, porque: 'prop de migración' },
  { portal: 'PROD', obj: 'line_items', accion: 'crear', name: 'mig_observacion',
    payload: { label: 'mig_observacion', type: 'string', fieldType: 'text' }, porque: 'prop de migración' },
  { portal: 'PROD', obj: 'line_items', accion: 'crear', name: 'mig_producto_supuesto',
    payload: { label: 'mig_producto_supuesto', type: 'string', fieldType: 'text' }, porque: 'prop de migración' },

  { portal: 'PROD', obj: 'companies', accion: 'crear', name: 'codigo_cliente_comercial',
    payload: { label: 'Código Cliente Comercial', type: 'number', fieldType: 'number' }, porque: 'paridad' },
  { portal: 'PROD', obj: 'companies', accion: 'crear', name: 'codigo_contactos',
    payload: { label: 'Código Contactos', type: 'number', fieldType: 'number' }, porque: 'paridad' },
  ...[4, 5, 6, 7].map(n => ({ portal: 'PROD', obj: 'companies', accion: 'crear', name: `telefono_${n}`,
    payload: { label: `telefono_${n}`, type: 'string', fieldType: 'text' }, porque: 'paridad' })),

  // ══ PROD: corregir ══
  { portal: 'PROD', obj: 'tickets', accion: 'opciones', name: 'of_producto',
    fix: { renombrar: { 'ISCert ISA': { label: 'iSCert ISA', value: 'iSCert ISA' } } },
    porque: 'casing mal: debe escribirse igual que iSCert, con el extra ISA' },

  { portal: 'PROD', obj: 'deals', accion: 'opciones', name: 'producto',
    fix: { agregar: [{ label: 'Liferay', value: 'Liferay' }] },
    porque: 'falta la opción Liferay en prod' },

  { portal: 'PROD', obj: 'tickets', accion: 'modificar', name: 'revisado_por',
    payload: { fieldType: 'select' },
    porque: 'debe ser select, no checkbox' },

  // ══ PROD: borrar (verificado que son huérfanas) ══
  { portal: 'PROD', obj: 'contacts', accion: 'borrar', name: 'valor_total_moneda_original',
    porque: '⚠️ copia errónea en CONTACTOS. La legítima vive en NEGOCIOS (recalcValorTotal.js:78) y NO se toca' },
  { portal: 'PROD', obj: 'products', accion: 'borrar', name: 'uy',
    porque: '⚠️ huérfana en PRODUCTOS. El `uy` real vive en line items y negocios, y existe en ambos portales' },

  // ══ SANDBOX: corregir ══
  { portal: 'SANDBOX', obj: 'tickets', accion: 'modificar', name: 'exonera_irae',
    payload: { type: 'enumeration', fieldType: 'select', options: OPC_SI_NO },
    porque: 'unificar a true/false como prod, pero SELECT para que pueda quedar VACÍO (= no se cargó)' },
  { portal: 'SANDBOX', obj: 'line_items', accion: 'modificar', name: 'exonera_irae',
    payload: { type: 'enumeration', fieldType: 'select', options: OPC_SI_NO },
    porque: 'idem ticket' },
  { portal: 'PROD', obj: 'tickets', accion: 'modificar', name: 'exonera_irae',
    payload: { fieldType: 'select' },
    porque: 'pasar de booleancheckbox a select para permitir vacío' },
  { portal: 'PROD', obj: 'line_items', accion: 'modificar', name: 'exonera_irae',
    payload: { fieldType: 'select' },
    porque: 'idem ticket' },

  { portal: 'SANDBOX', obj: 'deals', accion: 'modificar', name: 'cliente_nodum',
    payload: { type: 'string', fieldType: 'text' },
    porque: 'los códigos Nodum tienen CEROS A LA IZQUIERDA (0006690) — como número se pierden' },

  ...['deals', 'tickets', 'line_items'].map(obj => ({ portal: 'SANDBOX', obj, accion: 'opciones', name: 'area',
    fix: { quitar: ['ISA PY'] },
    porque: 'opción obsoleta tras el split iSCert / iSCert ISA' })),
];

// ── Ejecución ───────────────────────────────────────────────────────────────
async function api(portal, method, path, body) {
  const r = await fetch(`https://api.hubapi.com/crm/v3/properties/${path}`, {
    method,
    headers: { Authorization: `Bearer ${TOK[portal]}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await r.text();
  return { ok: r.ok, status: r.status, body: txt ? JSON.parse(txt) : null };
}

const cuenta = { crear: 0, modificar: 0, opciones: 0, borrar: 0, saltado: 0, error: 0 };

for (const p of PLAN) {
  if (SOLO_PROD && p.portal !== 'PROD') continue;
  if (SOLO_SBX && p.portal !== 'SANDBOX') continue;
  if (SIN_BORRADOS && p.accion === 'borrar') continue;

  const ref = `${p.portal.padEnd(7)} ${p.obj}.${p.name}`;
  const actual = await api(p.portal, 'GET', `${p.obj}/${p.name}`);
  const existe = actual.ok;

  // ── crear ──
  if (p.accion === 'crear') {
    if (existe) { console.log(`⏭️  ${ref} — ya existe`); cuenta.saltado++; continue; }
    console.log(`➕ ${ref}\n     ${p.porque}`);
    if (APPLY) {
      const r = await api(p.portal, 'POST', p.obj, { name: p.name, groupName: GRUPO[p.obj], ...p.payload });
      if (r.ok) { console.log(`     ✅ creada`); cuenta.crear++; }
      else { console.log(`     ❌ ${r.status}: ${JSON.stringify(r.body?.message || r.body)}`); cuenta.error++; }
    } else cuenta.crear++;
    continue;
  }

  if (!existe) { console.log(`⏭️  ${ref} — no existe, nada que hacer`); cuenta.saltado++; continue; }

  // ── borrar ──
  if (p.accion === 'borrar') {
    console.log(`🗑️  ${ref}\n     ${p.porque}`);
    if (APPLY) {
      const r = await api(p.portal, 'DELETE', `${p.obj}/${p.name}`);
      if (r.ok || r.status === 204) { console.log(`     ✅ borrada`); cuenta.borrar++; }
      else { console.log(`     ❌ ${r.status}: ${JSON.stringify(r.body?.message || r.body)}`); cuenta.error++; }
    } else cuenta.borrar++;
    continue;
  }

  // ── opciones (agregar / quitar / renombrar) ──
  if (p.accion === 'opciones') {
    let opts = [...(actual.body.options || [])];
    const antes = JSON.stringify(opts.map(o => o.value));

    for (const [viejo, nuevo] of Object.entries(p.fix.renombrar || {})) {
      const i = opts.findIndex(o => o.value === viejo);
      if (i >= 0) opts[i] = { ...opts[i], ...nuevo };
    }
    for (const q of p.fix.quitar || []) opts = opts.filter(o => o.value !== q);
    for (const a of p.fix.agregar || []) if (!opts.some(o => o.value === a.value)) opts.push(a);

    if (JSON.stringify(opts.map(o => o.value)) === antes) { console.log(`⏭️  ${ref} — opciones ya correctas`); cuenta.saltado++; continue; }
    console.log(`🔧 ${ref} — opciones\n     ${p.porque}`);
    console.log(`     antes:   ${antes}`);
    console.log(`     después: ${JSON.stringify(opts.map(o => o.value))}`);
    if (APPLY) {
      const r = await api(p.portal, 'PATCH', `${p.obj}/${p.name}`, { options: opts.map((o, i) => ({ label: o.label, value: o.value, displayOrder: i })) });
      if (r.ok) { console.log(`     ✅ actualizada`); cuenta.opciones++; }
      else { console.log(`     ❌ ${r.status}: ${JSON.stringify(r.body?.message || r.body)}`); cuenta.error++; }
    } else cuenta.opciones++;
    continue;
  }

  // ── modificar definición ──
  if (p.accion === 'modificar') {
    const dif = Object.entries(p.payload).filter(([k, v]) =>
      k === 'options' ? JSON.stringify((actual.body.options || []).map(o => o.value)) !== JSON.stringify(v.map(o => o.value)) : actual.body[k] !== v);
    if (!dif.length) { console.log(`⏭️  ${ref} — ya está como corresponde`); cuenta.saltado++; continue; }
    console.log(`🔧 ${ref}\n     ${p.porque}`);
    for (const [k, v] of dif) console.log(`     ${k}: ${JSON.stringify(actual.body[k])} → ${JSON.stringify(k === 'options' ? v.map(o => o.value) : v)}`);
    if (APPLY) {
      const r = await api(p.portal, 'PATCH', `${p.obj}/${p.name}`, p.payload);
      if (r.ok) { console.log(`     ✅ actualizada`); cuenta.modificar++; }
      else {
        console.log(`     ❌ ${r.status}: ${JSON.stringify(r.body?.message || r.body)}`);
        console.log(`     ↳ si HubSpot no permite cambiar el tipo, hay que BORRAR y RECREAR (los datos de esa prop se pierden)`);
        cuenta.error++;
      }
    } else cuenta.modificar++;
  }
}

console.log(`\n${'─'.repeat(60)}`);
console.log(APPLY ? '✅ APLICADO' : '🔍 DRY-RUN (nada se ejecutó — usá --apply)');
console.log(`crear:${cuenta.crear} · modificar:${cuenta.modificar} · opciones:${cuenta.opciones} · borrar:${cuenta.borrar} · saltado:${cuenta.saltado} · errores:${cuenta.error}`);
console.log(`\nNO incluido (pendiente de decisión): companies.industria__rubro — ~85 opciones heredadas con duplicados.`);
