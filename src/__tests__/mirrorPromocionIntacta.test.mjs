// src/__tests__/mirrorPromocionIntacta.test.mjs
//
// GUARDARRAÍL de la TANDA D — 🔴 la promoción del ticket UY NO se toca.
//
// El motor promueve el ticket del espejo a «Próximos a facturar»
// (mirrorUtils.js, promoteMirrorTicketToManualReady) A PROPÓSITO: es para que
// administración lo revise antes de facturar en UY. La tanda D avisa sobre ese
// ticket, pero no cambia su etapa ni deshace la promoción — ni con la llave
// prendida ni con la llave apagada.
//
// Es un test ESTRUCTURAL sobre el código: la función toca el singleton
// hubspotClient y montarla entera costaría más de lo que protege. Lo que se
// fija acá es lo que se puede romper por accidente en una tanda futura: que la
// promoción siga existiendo, siga apuntando a la etapa NEW y NO quede detrás de
// la llave del espejo.
//
//   DATABASE_URL='postgres://u:p@localhost:5432/x' node --test src/__tests__/mirrorPromocionIntacta.test.mjs

process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/x';

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../services/mirrorUtils.js', import.meta.url), 'utf8');

test('la promoción del ticket UY sigue existiendo y va a la etapa NEW', () => {
  assert.match(SRC, /export async function promoteMirrorTicketToManualReady/);
  const cuerpo = SRC.slice(SRC.indexOf('promoteMirrorTicketToManualReady'));
  assert.match(cuerpo, /hs_pipeline_stage:\s*TICKET_STAGES\.NEW/, 'debe promover a «Próximos a facturar»');
  assert.match(cuerpo, /hs_pipeline:\s*TICKET_PIPELINE/, 'y al pipeline manual');
});

test('🔴 la promoción NO quedó condicionada a la llave del espejo', () => {
  const desde = SRC.indexOf('export async function promoteMirrorTicketToManualReady');
  const hasta = SRC.indexOf('export function isNotaCreditoFromSignals');
  assert.ok(desde > 0 && hasta > desde, 'no se pudo acotar la función');
  const fn = SRC.slice(desde, hasta);
  assert.doesNotMatch(
    fn,
    /mirrorPuntualEnabled/,
    'la promoción del ticket UY no puede depender de MIRROR_PUNTUAL_ENABLED'
  );
});

test('el comentario que explica POR QUÉ no va a READY sigue en su lugar', () => {
  // Si alguien la "corrige" a READY, el ticket UY se emitiría sin revisión.
  assert.match(SRC, /NO va a TICKET_STAGES\.READY/);
});
