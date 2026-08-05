// src/__tests__/mensajeFacturacionIndexLag.test.mjs
//
// REGRESIÓN del 4-ago-2026 — la carrera contra el índice de HubSpot.
//
// processUrgentTicket mueve el ticket a READY y ~170 ms después llama a
// refreshMensajeFacturacionParaDeal. El Search API todavía no indexó el cambio
// de etapa y devuelve 0 resultados ⇒ no se escribía `mensaje_de_facturacion`
// y el workflow de PROD que se inscribe por esa propiedad nunca salía.
//
// El arreglo: el ticket que disparó la acción se lee POR ID (inmediatamente
// consistente) y se une al resultado de la búsqueda.
//
// Correr con:  node --test src/__tests__/mensajeFacturacionIndexLag.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refreshMensajeFacturacionParaDeal } from '../jobs/cronMensajeFacturacion.js';
import { TICKET_PIPELINE, TICKET_STAGES } from '../config/constants.js';

const DEAL = '63433773463';
const TICKET = '47439077540';

/** Ticket en el pipeline manual y en la etapa READY. */
function ticketReady(id = TICKET, extra = {}) {
  return {
    id,
    properties: {
      hs_object_id: id,
      hs_pipeline: String(TICKET_PIPELINE),
      hs_pipeline_stage: String(TICKET_STAGES.READY),
      of_deal_id: DEAL,
      of_producto_nombres: 'MiFactura',
      cantidad_real: '2',
      subtotal_real: '2400',
      total_real_a_facturar: '2928',
      ...extra,
    },
  };
}

/** deps con la búsqueda VACÍA (el índice atrasado) salvo que se diga lo contrario. */
function makeDeps({ searchResults = [], ticketPorId = null, markFalla = false } = {}) {
  const escrito = [];
  const marcados = [];
  return {
    escrito,
    marcados,
    deps: {
      markNotified: async (id) => {
        if (markFalla) throw new Error('403 forbidden');
        marcados.push(String(id));
      },
      doSearch: async () => ({ results: searchResults }),
      getTicketById: async (id) => {
        if (!ticketPorId) throw new Error('404 not found');
        return { ...ticketPorId, id: String(id) };
      },
      fetchDealInfo: async () => ({
        dealName: 'Prueba mich para vicky',
        empresa_que_factura: 'ACME SRL',
        persona_que_factura: null,
      }),
      fetchPortalId: async () => '50148277',
      write: async (dealId, html) => { escrito.push({ dealId, html }); },
    },
  };
}

test('índice atrasado: sin hint NO se escribe nada (el bug original)', async () => {
  const { escrito, deps } = makeDeps({ searchResults: [], ticketPorId: ticketReady() });
  await refreshMensajeFacturacionParaDeal(DEAL, { deps });
  assert.equal(escrito.length, 0, 'sin el hint el mensaje no se escribe — era exactamente el bug');
});

test('índice atrasado: CON hint el ticket se recupera por ID y se escribe el mensaje', async () => {
  const { escrito, deps } = makeDeps({ searchResults: [], ticketPorId: ticketReady() });
  await refreshMensajeFacturacionParaDeal(DEAL, { ticketIdHint: TICKET, deps });

  assert.equal(escrito.length, 1, 'se escribió mensaje_de_facturacion');
  assert.equal(escrito[0].dealId, DEAL);
  assert.match(escrito[0].html, /MiFactura/);
  assert.match(escrito[0].html, /Ver ticket #47439077540/, 'el mensaje trae el link al ticket');
});

test('el hint NO se duplica si la búsqueda ya lo trajo', async () => {
  const { escrito, deps } = makeDeps({
    searchResults: [ticketReady()],
    ticketPorId: ticketReady(),
  });
  await refreshMensajeFacturacionParaDeal(DEAL, { ticketIdHint: TICKET, deps });

  assert.equal(escrito.length, 1);
  const veces = escrito[0].html.split('Ver ticket #47439077540').length - 1;
  assert.equal(veces, 1, 'el ticket aparece una sola vez');
});

test('el hint se suma a los que ya trajo la búsqueda', async () => {
  const otro = ticketReady('99999999', { of_producto_nombres: 'PayRoll' });
  const { escrito, deps } = makeDeps({ searchResults: [otro], ticketPorId: ticketReady() });
  await refreshMensajeFacturacionParaDeal(DEAL, { ticketIdHint: TICKET, deps });

  assert.equal(escrito.length, 1);
  assert.match(escrito[0].html, /Ver ticket #47439077540/);
  assert.match(escrito[0].html, /Ver ticket #99999999/);
  assert.match(escrito[0].html, /2 elemento\(s\) de pedido/);
});

test('el hint se descarta si el ticket NO está en la etapa READY', async () => {
  const enOtraEtapa = ticketReady(TICKET, { hs_pipeline_stage: 'OTRA_ETAPA' });
  const { escrito, deps } = makeDeps({ searchResults: [], ticketPorId: enOtraEtapa });
  await refreshMensajeFacturacionParaDeal(DEAL, { ticketIdHint: TICKET, deps });

  assert.equal(escrito.length, 0, 'no se avisa por un ticket que no está listo para facturar');
});

test('el hint se descarta si el ticket ya emitió aviso', async () => {
  const yaAvisado = ticketReady(TICKET, { ticket_emitio_aviso_a_admin: 'true' });
  const { escrito, deps } = makeDeps({ searchResults: [], ticketPorId: yaAvisado });
  await refreshMensajeFacturacionParaDeal(DEAL, { ticketIdHint: TICKET, deps });

  assert.equal(escrito.length, 0, 'no se repite el aviso de un ticket ya notificado');
});

test('si la lectura por ID falla, no rompe: sigue con lo que trajo la búsqueda', async () => {
  const otro = ticketReady('99999999');
  const { escrito, deps } = makeDeps({ searchResults: [otro], ticketPorId: null }); // getById tira 404
  await refreshMensajeFacturacionParaDeal(DEAL, { ticketIdHint: TICKET, deps });

  assert.equal(escrito.length, 1, 'el 404 del hint no bloquea el resto');
  assert.match(escrito[0].html, /Ver ticket #99999999/);
});

// ── ticket_emitio_aviso_a_admin ──────────────────────────────────────────────
// Es la condición que usa el workflow de HubSpot para detectar que alguien
// arrastró la etapa sin seguir el procedimiento (5-ago-2026). Si el camino
// puntual no la marca, el flag queda vacío siempre y el workflow no distingue.

test('el camino puntual MARCA los tickets como ya avisados', async () => {
  const { escrito, marcados, deps } = makeDeps({ searchResults: [], ticketPorId: ticketReady() });
  await refreshMensajeFacturacionParaDeal(DEAL, { ticketIdHint: TICKET, deps });

  assert.equal(escrito.length, 1);
  assert.deepEqual(marcados, [TICKET], 'se marcó ticket_emitio_aviso_a_admin');
});

test('marca TODOS los tickets que entraron en el mensaje, no sólo el del hint', async () => {
  const otro = ticketReady('99999999');
  const { marcados, deps } = makeDeps({ searchResults: [otro], ticketPorId: ticketReady() });
  await refreshMensajeFacturacionParaDeal(DEAL, { ticketIdHint: TICKET, deps });

  assert.deepEqual(marcados.sort(), [TICKET, '99999999'].sort());
});

test('si no se escribió mensaje, no marca nada', async () => {
  const { escrito, marcados, deps } = makeDeps({ searchResults: [], ticketPorId: null });
  await refreshMensajeFacturacionParaDeal(DEAL, { ticketIdHint: TICKET, deps });

  assert.equal(escrito.length, 0);
  assert.deepEqual(marcados, [], 'sin mensaje no hay nada que marcar');
});

test('si el marcado falla, el mensaje igual queda escrito', async () => {
  const { escrito, marcados, deps } = makeDeps({
    searchResults: [], ticketPorId: ticketReady(), markFalla: true,
  });
  await refreshMensajeFacturacionParaDeal(DEAL, { ticketIdHint: TICKET, deps });

  assert.equal(escrito.length, 1, 'el fallo al marcar no revierte el mensaje');
  assert.deepEqual(marcados, []);
});
