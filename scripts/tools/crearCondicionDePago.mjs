// scripts/tools/crearCondicionDePago.mjs
//
// 🔴 OBSOLETO — NO CORRER (8-ago-2026). Se deja como registro, no como herramienta.
//
// Este script crea `condicion_de_pago` en SINGULAR, y ese nombre NO EXISTE en
// ningún objeto de ningún portal: la propiedad real, con datos y con las 6
// opciones, es `condiciones_de_pago` en PLURAL, tanto en line item como en ticket
// (verificado contra los dos portales el 8-ago).
//
// El script nunca llegó a correrse, pero el CÓDIGO sí quedó escrito contra el
// singular, y como `safeUpdateTicket` borra del payload la prop que HubSpot no
// reconoce y reintenta, la escritura "funcionaba" mientras el valor no llegaba
// nunca: la fila «Condición de Pago» salía vacía en los dos mensajes.
//
// Correrlo AHORA sería peor que no hacer nada: crearía una segunda propiedad,
// vacía y en singular, al lado de la que tiene los datos. Por eso aborta solo.
//
// ─────────────────────────────────────────────────────────────────────────────
//
// (Documentación original, para contexto:)
// Crea el select `condicion_de_pago` en LINE ITEM y en TICKET.
//
// Origen: PDF "Definición Vistas v2" de María — aparece en las dos secciones,
// "Condiciones comerciales" (ticket) y "Condiciones de facturación" (line item),
// y va en los DOS mensajes (manual y mansoft, lista del 5-ago-2026).
//
// El valor viaja del LINE ITEM al TICKET por el snapshot, igual que
// opera_trading y exonera_irae (ver LI_PROP_TO_TICKET_KEYS).
//
// Uso:
//   node scripts/tools/crearCondicionDePago.mjs --dry      ← muestra y no escribe
//   node scripts/tools/crearCondicionDePago.mjs            ← crea de verdad
//
// Es idempotente: si la propiedad ya existe, no la pisa (avisa y sigue). Para
// AGREGAR opciones a una que ya existe hay que hacerlo desde el panel — este
// script no modifica props existentes a propósito.

console.error(
  '\n🔴 OBSOLETO — este script no debe correrse.\n' +
  '   La propiedad real es `condiciones_de_pago` (PLURAL) y ya existe en los dos\n' +
  '   portales, en line item y en ticket, con sus 6 opciones y con datos.\n' +
  '   Correr esto crearía una segunda prop vacía en singular. Ver la cabecera.\n'
);
process.exit(1);

import 'dotenv/config';
import { hubspotClient } from '../../src/hubspotClient.js';

const DRY = process.argv.includes('--dry');

// Textuales del PDF. El "45días" del original va separado — es un typo de ahí.
const OPCIONES = [
  'Contado',
  '8 días de fecha factura',
  '30 días de fecha factura',
  '45 días de fecha factura',
  '60 días de fecha factura',
  '90 días de fecha factura',
];

// El grupo cambia según el objeto: hay que usar uno que exista en cada uno.
const OBJETOS = [
  { objectType: 'line_items', groupName: 'line_item_information' },
  { objectType: 'tickets',    groupName: 'ticketinformation' },
];

function definicion(groupName) {
  return {
    name: 'condicion_de_pago',
    label: 'Condición de Pago',
    type: 'enumeration',
    fieldType: 'select',
    groupName,
    description: 'Plazo de pago acordado con el cliente. Sale en el mensaje de facturación manual y en el aviso Mantsoft.',
    options: OPCIONES.map((label, i) => ({
      label,
      value: label,
      displayOrder: i,
      hidden: false,
    })),
  };
}

async function existe(objectType) {
  try {
    await hubspotClient.crm.properties.coreApi.getByName(objectType, 'condicion_de_pago');
    return true;
  } catch (err) {
    if (err?.code === 404 || err?.statusCode === 404) return false;
    throw err;
  }
}

async function main() {
  console.log(DRY ? '— DRY RUN: no se escribe nada —\n' : '— Creando propiedades —\n');

  for (const { objectType, groupName } of OBJETOS) {
    const def = definicion(groupName);

    if (await existe(objectType)) {
      console.log(`⏭  ${objectType}: condicion_de_pago YA EXISTE — no se toca`);
      continue;
    }

    if (DRY) {
      console.log(`＋ ${objectType}: se crearía con ${OPCIONES.length} opciones`);
      console.log(JSON.stringify(def, null, 2));
      continue;
    }

    await hubspotClient.crm.properties.coreApi.create(objectType, def);
    console.log(`✅ ${objectType}: condicion_de_pago creada con ${OPCIONES.length} opciones`);
  }

  console.log('\nDespués de crearla, falta suscribir el webhook:');
  console.log('  line_item.propertyChange / condicion_de_pago');
  console.log('sin eso, editarla en el line item no la baja al ticket.');
}

main().catch((err) => {
  console.error('❌', err?.message || err);
  process.exit(1);
});
