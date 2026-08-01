// src/__tests__/syncDealPropToTicket.test.mjs
//
// TANDA E (§5.bis) — sync quirúrgico por-propiedad NEGOCIO→ticket: el VENDEDOR
// (`hubspot_owner_id` del negocio → `of_propietario_secundario`) y la MONEDA
// (`deal_currency_code` → `of_moneda`). Partes puras + el handler con un client
// FALSO in-memory (sin tocar HubSpot ni DB): se inyectan client / updateTicketFn.
//
// Cada pieza va con su PAR OFF/ON: con DEAL_PROP_SYNC_ENABLED apagada el motor no
// escribe NADA (neutralidad), que es la condición para mergear sin cambiar producción.
//
// Requiere DATABASE_URL dummy (el grafo de imports carga src/db.js).
//   node --test src/__tests__/syncDealPropToTicket.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isTransferableDealProp,
  buildDesiredTicketPropsFromDeal,
  syncDealPropToTickets,
  DEAL_PROP_TO_TICKET_KEY,
} from '../services/deal/syncDealPropToTicket.js';
import { dealPropSyncEnabled } from '../config/transferPropsFlags.js';
import {
  TICKET_PIPELINE,
  PROXIMOS_A_FACTURAR_STAGE,
  BILLING_TICKET_FORECAST,
  TICKET_STAGE_LISTO_MANUAL,
} from '../config/constants.js';

const MANUAL = TICKET_PIPELINE;
const PROXIMOS = PROXIMOS_A_FACTURAR_STAGE;
const FORECAST = BILLING_TICKET_FORECAST;
const NOTIFICADO = TICKET_STAGE_LISTO_MANUAL;

// ── Helpers de entorno (las llaves se leen POR LLAMADA, sin cache) ────────────
function conLlaves({ dealSync, etapaUnica }, fn) {
  const prevDeal = process.env.DEAL_PROP_SYNC_ENABLED;
  const prevEtapa = process.env.ETAPA_UNICA_ENABLED;
  if (dealSync === undefined) delete process.env.DEAL_PROP_SYNC_ENABLED;
  else process.env.DEAL_PROP_SYNC_ENABLED = dealSync;
  if (etapaUnica === undefined) delete process.env.ETAPA_UNICA_ENABLED;
  else process.env.ETAPA_UNICA_ENABLED = etapaUnica;
  return (async () => {
    try { return await fn(); }
    finally {
      if (prevDeal === undefined) delete process.env.DEAL_PROP_SYNC_ENABLED;
      else process.env.DEAL_PROP_SYNC_ENABLED = prevDeal;
      if (prevEtapa === undefined) delete process.env.ETAPA_UNICA_ENABLED;
      else process.env.ETAPA_UNICA_ENABLED = prevEtapa;
    }
  })();
}

// ── Partes puras ─────────────────────────────────────────────────────────────

test('el mapeo es EXACTAMENTE el pedido: vendedor y moneda, nada más', () => {
  assert.deepEqual(DEAL_PROP_TO_TICKET_KEY, {
    hubspot_owner_id: 'of_propietario_secundario',
    deal_currency_code: 'of_moneda',
  });
});

test('isTransferableDealProp: sólo las dos mapeadas; el resto del negocio NO se escucha', () => {
  assert.equal(isTransferableDealProp('hubspot_owner_id'), true);
  assert.equal(isTransferableDealProp('deal_currency_code'), true);
  // Las otras claves de extractDealSnapshots NO están en la lista del cliente (regla 29-jul:
  // se escucha lo que está puntualmente puesto a la escucha, se agrega prop por prop).
  for (const p of ['tipo_de_cupo', 'pais_operativo', 'id_crm_origen', 'id_cliente_nodum', 'dealstage', 'amount']) {
    assert.equal(isTransferableDealProp(p), false, `${p} NO se escucha`);
  }
  assert.equal(isTransferableDealProp(''), false);
  assert.equal(isTransferableDealProp(undefined), false);
});

test('buildDesiredTicketPropsFromDeal: normaliza igual que extractDealSnapshots', () => {
  assert.deepEqual(
    buildDesiredTicketPropsFromDeal({ hubspot_owner_id: '77', deal_currency_code: 'UYU' }),
    { of_propietario_secundario: '77', of_moneda: 'UYU' }
  );
  // moneda vacía → 'USD' (mismo default que extractDealSnapshots), NO ''
  assert.deepEqual(
    buildDesiredTicketPropsFromDeal({ hubspot_owner_id: '77', deal_currency_code: '' }),
    { of_propietario_secundario: '77', of_moneda: 'USD' }
  );
});

test('buildDesiredTicketPropsFromDeal: sin vendedor NO se escribe la clave (no se vacía el ticket)', () => {
  // El negocio quedó sin owner: vaciar of_propietario_secundario dejaría al workflow
  // 1771473309 sin a quién avisar → el valor viejo es mejor dato que ninguno.
  const desired = buildDesiredTicketPropsFromDeal({ hubspot_owner_id: '  ', deal_currency_code: 'USD' });
  assert.equal('of_propietario_secundario' in desired, false);
  assert.deepEqual(desired, { of_moneda: 'USD' });
});

// ── Handler con client falso ─────────────────────────────────────────────────

function makeCtx({ tickets, dealProps = { hubspot_owner_id: '77', deal_currency_code: 'UYU' }, dealThrows = false }) {
  const updateCalls = [];
  const searchArgs = [];
  const client = {
    crm: {
      deals: {
        basicApi: {
          async getById() {
            if (dealThrows) throw new Error('boom');
            return { id: 'D1', properties: dealProps };
          },
        },
      },
      tickets: {
        searchApi: {
          async doSearch(args) { searchArgs.push(args); return { results: tickets }; },
        },
      },
    },
  };
  const updateTicketFn = async (id, patch) => { updateCalls.push({ id: String(id), patch }); };
  return { client, updateTicketFn, updateCalls, searchArgs };
}

// tk(id, stage, pipeline, props) — por default pipeline MANUAL
const tk = (id, stage, pipeline = MANUAL, props = {}) => ({
  id: String(id),
  properties: { hs_pipeline: pipeline, hs_pipeline_stage: stage, of_deal_id: 'D1', ...props },
});

test('flag OFF (default): NO aplica, no lee el negocio ni escribe nada', async () => {
  await conLlaves({ dealSync: undefined }, async () => {
    const ctx = makeCtx({ tickets: [tk('T1', PROXIMOS, MANUAL, { of_moneda: 'USD' })] });
    const r = await syncDealPropToTickets({ dealId: 'D1', propertyName: 'hubspot_owner_id', ...ctx });
    assert.equal(r.applies, false);
    assert.equal(r.reason, 'flag_off');
    assert.equal(ctx.updateCalls.length, 0);
    assert.equal(ctx.searchArgs.length, 0);
  });
});

test('flag OFF con "false"/basura: sigue apagada (parser estricto)', async () => {
  for (const v of ['false', '', 'FALSO', '0', 'si']) {
    await conLlaves({ dealSync: v }, async () => {
      const ctx = makeCtx({ tickets: [tk('T1', PROXIMOS)] });
      const r = await syncDealPropToTickets({ dealId: 'D1', propertyName: 'deal_currency_code', ...ctx });
      assert.equal(r.reason, 'flag_off', `"${v}" no debe prender la llave`);
      assert.equal(ctx.updateCalls.length, 0);
    });
  }
});

test('flag ON con "true"/"1"/"yes": prende', async () => {
  for (const v of ['true', 'TRUE', ' 1 ', 'yes']) {
    await conLlaves({ dealSync: v }, async () => {
      const ctx = makeCtx({ tickets: [] });
      const r = await syncDealPropToTickets({ dealId: 'D1', propertyName: 'hubspot_owner_id', ...ctx });
      assert.notEqual(r.reason, 'flag_off', `"${v}" debe prender la llave`);
    });
  }
});

test('prop del negocio no mapeada: no aplica aunque la llave esté prendida', async () => {
  await conLlaves({ dealSync: 'true' }, async () => {
    const ctx = makeCtx({ tickets: [tk('T1', PROXIMOS)] });
    const r = await syncDealPropToTickets({ dealId: 'D1', propertyName: 'amount', ...ctx });
    assert.equal(r.applies, false);
    assert.equal(r.reason, 'not_mapped');
    assert.equal(ctx.updateCalls.length, 0);
  });
});

test('flag ON: baja vendedor y moneda al forecast manual, saltea el resto, y sólo lo que difiere', async () => {
  await conLlaves({ dealSync: 'true', etapaUnica: undefined }, async () => {
    const tickets = [
      // forecast manual, las dos difieren → update de las dos
      tk('T1', FORECAST, MANUAL, { of_propietario_secundario: '11', of_moneda: 'USD' }),
      // forecast manual, sólo difiere la moneda → patch de una sola clave
      tk('T2', FORECAST, MANUAL, { of_propietario_secundario: '77', of_moneda: 'USD' }),
      // forecast manual pero ya está todo igual → NO se escribe
      tk('T3', FORECAST, MANUAL, { of_propietario_secundario: '77', of_moneda: 'UYU' }),
      // pipeline automático → fuera de alcance
      tk('T4', FORECAST, 'PIPE_AUTO', { of_propietario_secundario: '11', of_moneda: 'USD' }),
      // ya cruzó la frontera (Notificado) → CONGELADO, no se toca
      tk('T5', NOTIFICADO, MANUAL, { of_propietario_secundario: '11', of_moneda: 'USD' }),
    ];
    const ctx = makeCtx({ tickets });
    const r = await syncDealPropToTickets({ dealId: 'D1', propertyName: 'hubspot_owner_id', ...ctx });

    assert.equal(r.applies, true);
    assert.equal(r.ticketsScanned, 5);
    assert.equal(r.ticketsUpdated, 2);
    assert.equal(r.skipped, 2);          // T4 (auto) + T5 (notificado)
    assert.equal(r.errors, 0);
    assert.deepEqual(ctx.updateCalls, [
      { id: 'T1', patch: { of_propietario_secundario: '77', of_moneda: 'UYU' } },
      { id: 'T2', patch: { of_moneda: 'UYU' } },
    ]);
  });
});

test('🔴 el job sincroniza LAS DOS props aunque lo dispare una sola (la cola colapsa por deal+action_type)', async () => {
  // Si cada job escribiera sólo su prop, el colapso de webhookQueue.js:163-173 haría
  // desaparecer el otro cambio EN SILENCIO. Disparado por la moneda, el vendedor también baja.
  await conLlaves({ dealSync: 'true' }, async () => {
    const ctx = makeCtx({ tickets: [tk('T1', FORECAST, MANUAL, { of_propietario_secundario: '11', of_moneda: 'USD' })] });
    const r = await syncDealPropToTickets({ dealId: 'D1', propertyName: 'deal_currency_code', ...ctx });
    assert.equal(r.ticketsUpdated, 1);
    assert.deepEqual(ctx.updateCalls[0].patch, { of_propietario_secundario: '77', of_moneda: 'UYU' });
  });
});

test('ETAPA_UNICA OFF: «Próximos a facturar» queda FUERA de alcance (idéntico a hoy)', async () => {
  await conLlaves({ dealSync: 'true', etapaUnica: 'false' }, async () => {
    const ctx = makeCtx({ tickets: [tk('T1', PROXIMOS, MANUAL, { of_propietario_secundario: '11', of_moneda: 'USD' })] });
    const r = await syncDealPropToTickets({ dealId: 'D1', propertyName: 'hubspot_owner_id', ...ctx });
    assert.equal(r.ticketsUpdated, 0);
    assert.equal(r.skipped, 1);
    assert.equal(ctx.updateCalls.length, 0);
  });
});

test('ETAPA_UNICA ON: «Próximos a facturar» ENTRA (misma frontera que el sync LI→ticket)', async () => {
  await conLlaves({ dealSync: 'true', etapaUnica: 'true' }, async () => {
    const ctx = makeCtx({ tickets: [tk('T1', PROXIMOS, MANUAL, { of_propietario_secundario: '11', of_moneda: 'USD' })] });
    const r = await syncDealPropToTickets({ dealId: 'D1', propertyName: 'hubspot_owner_id', ...ctx });
    assert.equal(r.ticketsUpdated, 1);
    assert.deepEqual(ctx.updateCalls[0].patch, { of_propietario_secundario: '77', of_moneda: 'UYU' });
  });
});

test('negocio sin owner: NO se vacía el vendedor del ticket, la moneda igual baja', async () => {
  await conLlaves({ dealSync: 'true' }, async () => {
    const ctx = makeCtx({
      tickets: [tk('T1', FORECAST, MANUAL, { of_propietario_secundario: '11', of_moneda: 'USD' })],
      dealProps: { hubspot_owner_id: '', deal_currency_code: 'UYU' },
    });
    const r = await syncDealPropToTickets({ dealId: 'D1', propertyName: 'hubspot_owner_id', ...ctx });
    assert.equal(r.ticketsUpdated, 1);
    assert.deepEqual(ctx.updateCalls[0].patch, { of_moneda: 'UYU' });   // el vendedor '11' sobrevive
  });
});

test('error leyendo el negocio: no escribe nada y lo reporta como error, sin lanzar', async () => {
  await conLlaves({ dealSync: 'true' }, async () => {
    const ctx = makeCtx({ tickets: [tk('T1', FORECAST)], dealThrows: true });
    const r = await syncDealPropToTickets({ dealId: 'D1', propertyName: 'hubspot_owner_id', ...ctx });
    assert.equal(r.applies, false);
    assert.equal(r.reason, 'deal_read_error');
    assert.equal(r.errors, 1);
    assert.equal(ctx.updateCalls.length, 0);
  });
});

test('un ticket que falla NO frena a los demás', async () => {
  await conLlaves({ dealSync: 'true' }, async () => {
    const tickets = [
      tk('T1', FORECAST, MANUAL, { of_propietario_secundario: '11', of_moneda: 'USD' }),
      tk('T2', FORECAST, MANUAL, { of_propietario_secundario: '11', of_moneda: 'USD' }),
    ];
    const ctx = makeCtx({ tickets });
    const okCalls = [];
    const r = await syncDealPropToTickets({
      dealId: 'D1',
      propertyName: 'hubspot_owner_id',
      client: ctx.client,
      updateTicketFn: async (id, patch) => {
        if (String(id) === 'T1') throw new Error('400 propiedad archivada');
        okCalls.push({ id: String(id), patch });
      },
    });
    assert.equal(r.errors, 1);
    assert.equal(r.ticketsUpdated, 1);
    assert.deepEqual(okCalls.map(c => c.id), ['T2']);
  });
});

test('la búsqueda pide las claves que va a comparar (si no, el patch mínimo escribiría siempre)', async () => {
  await conLlaves({ dealSync: 'true' }, async () => {
    const ctx = makeCtx({ tickets: [] });
    await syncDealPropToTickets({ dealId: 'D1', propertyName: 'hubspot_owner_id', ...ctx });
    const props = ctx.searchArgs[0].properties;
    assert.ok(props.includes('of_propietario_secundario'));
    assert.ok(props.includes('of_moneda'));
    assert.ok(props.includes('hs_pipeline'));
    assert.ok(props.includes('hs_pipeline_stage'));
  });
});

// ── Composición de la RUTA 0b del router ─────────────────────────────────────
// El handler decide con `objectType === 'deal' && dealPropSyncEnabled() &&
// isTransferableDealProp(propertyName)` (mismo patrón que la RUTA 4 con
// isTransferableLiProp). Acá se fija esa composición, incluida la neutralidad:
// con la llave apagada el evento vuelve a caer en "Property not supported".

const rutea = (objectType, propertyName) =>
  objectType === 'deal' && dealPropSyncEnabled() && isTransferableDealProp(propertyName);

test('RUTA 0b — flag OFF: los eventos del negocio NO se encolan (neutralidad del router)', async () => {
  await conLlaves({ dealSync: undefined }, async () => {
    assert.equal(rutea('deal', 'hubspot_owner_id'), false);
    assert.equal(rutea('deal', 'deal_currency_code'), false);
  });
});

test('RUTA 0b — flag ON: encola las dos props del negocio y sólo esas', async () => {
  await conLlaves({ dealSync: 'true' }, async () => {
    assert.equal(rutea('deal', 'hubspot_owner_id'), true);
    assert.equal(rutea('deal', 'deal_currency_code'), true);
    // dealstage sigue siendo de la RUTA 0 (cancelación): esta ruta no se lo lleva
    assert.equal(rutea('deal', 'dealstage'), false);
    assert.equal(rutea('deal', 'amount'), false);
    // el mismo nombre de prop en OTRO objeto no entra: el line item tiene su propio
    // hubspot_owner_id (responsable), que NO es el vendedor del negocio
    assert.equal(rutea('line_item', 'hubspot_owner_id'), false);
    assert.equal(rutea('ticket', 'hubspot_owner_id'), false);
  });
});
