// src/__tests__/syncTicketCompanyLabels.test.mjs
//
// Re-sync de etiquetas ticket→empresa (pedido 29-jul). Ejercita
// syncTicketCompanyLabels con un client FALSO (in-memory), sin tocar HubSpot ni la DB:
// se inyectan client / getDealCompaniesFn / typeIds / flag.
//
// Requiere un DATABASE_URL dummy (el grafo de imports carga src/db.js, que resuelve la
// conexión en tiempo de import; el Pool no conecta si no se consulta).
//
// Correr con:
//   DATABASE_URL='postgres://u:p@localhost:5432/x' \
//     node --test src/__tests__/syncTicketCompanyLabels.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syncTicketCompanyLabels } from '../services/tickets/syncTicketCompanyLabels.js';

const EF = 13;        // typeId "Empresa Factura" ticket→company (PROD)
const PARTNER = 11;   // typeId "Partner" ticket→company (PROD)

// ─────────────────────────────────────────────────────────────
// Fake client: asociaciones ticket→company CON sus typeIds.
//   estado: Map(`${ticketId}`, Map(companyId → Set(typeId)))
// Registra creates y archiveLabels para poder afirmar exactamente qué se escribió.
// ─────────────────────────────────────────────────────────────
function makeFakeClient({ estado = {}, ticketsDelDeal = [] } = {}) {
  const asoc = new Map();
  for (const [tid, comps] of Object.entries(estado)) {
    const m = new Map();
    for (const [cid, tipos] of Object.entries(comps)) m.set(String(cid), new Set(tipos));
    asoc.set(String(tid), m);
  }

  const creates = [];
  const archived = [];

  return {
    creates,
    archived,
    estado: asoc,
    crm: {
      associations: {
        v4: {
          basicApi: {
            async getPage(fromType, fromId, toType, _after, _limit) {
              if (fromType === 'deals' && toType === 'tickets') {
                return { results: ticketsDelDeal.map(id => ({ toObjectId: String(id) })) };
              }
              const m = asoc.get(String(fromId)) || new Map();
              return {
                results: [...m.entries()].map(([cid, tipos]) => ({
                  toObjectId: cid,
                  associationTypes: [...tipos].map(t => ({ typeId: t, category: 'USER_DEFINED' })),
                })),
              };
            },
            async create(fromType, fromId, toType, toId, specs) {
              creates.push({ ticketId: String(fromId), companyId: String(toId), specs: specs || [] });
              if (!asoc.has(String(fromId))) asoc.set(String(fromId), new Map());
              const m = asoc.get(String(fromId));
              if (!m.has(String(toId))) m.set(String(toId), new Set());
              for (const s of specs || []) m.get(String(toId)).add(Number(s.associationTypeId));
            },
            async archive() {
              throw new Error('El re-sync NO debe desasociar empresas del ticket');
            },
          },
          batchApi: {
            async archiveLabels(fromType, toType, body) {
              for (const inp of body?.inputs || []) {
                for (const t of inp.types || []) {
                  archived.push({
                    ticketId: String(inp._from?.id),
                    companyId: String(inp.to?.id),
                    typeId: Number(t.associationTypeId),
                  });
                  asoc.get(String(inp._from?.id))?.get(String(inp.to?.id))?.delete(Number(t.associationTypeId));
                }
              }
            },
          },
        },
      },
    },
  };
}

const base = (client, over = {}) => ({
  dealId: 'D1',
  client,
  labelEmpresaFactura: EF,
  labelPartner: PARTNER,
  enabled: true,
  ...over,
});

// ─────────────────────────────────────────────────────────────

test('flag apagado → no toca nada', async () => {
  const client = makeFakeClient({ estado: { T1: { C_BENEF: [] } } });
  const r = await syncTicketCompanyLabels(base(client, {
    enabled: false,
    ticketIds: ['T1'],
    getDealCompaniesFn: () => ({ ids: ['C_BENEF', 'C_FACT'], facturaId: 'C_FACT', partnerId: null }),
  }));
  assert.equal(r.skipped, true);
  assert.equal(r.reason, 'flag_off');
  assert.equal(client.creates.length, 0);
});

test('sin typeIds configurados → no toca nada (equivale a la feature apagada)', async () => {
  const client = makeFakeClient({ estado: { T1: { C_BENEF: [] } } });
  const r = await syncTicketCompanyLabels(base(client, {
    labelEmpresaFactura: 0,
    labelPartner: 0,
    ticketIds: ['T1'],
    getDealCompaniesFn: () => ({ ids: ['C_BENEF'], facturaId: 'C_FACT', partnerId: null }),
  }));
  assert.equal(r.skipped, true);
  assert.equal(r.reason, 'labels_no_configurados');
  assert.equal(client.creates.length, 0);
});

test('EL GAP: ticket ya asociado sin etiqueta → recibe "Empresa Factura"', async () => {
  // Es el caso de todos los tickets de PROD anteriores al 29-jul.
  const client = makeFakeClient({ estado: { T1: { C_BENEF: [], C_FACT: [] } } });
  const r = await syncTicketCompanyLabels(base(client, {
    ticketIds: ['T1'],
    getDealCompaniesFn: () => ({ ids: ['C_BENEF', 'C_FACT'], facturaId: 'C_FACT', partnerId: null }),
  }));

  assert.equal(r.labelsAgregados, 1);
  assert.equal(r.labelsQuitados, 0);
  assert.equal(r.companiesAsociadas, 0);
  assert.deepEqual(client.creates, [{
    ticketId: 'T1', companyId: 'C_FACT',
    specs: [{ associationCategory: 'USER_DEFINED', associationTypeId: EF }],
  }]);
});

test('cambió la empresa que factura → quita la etiqueta vieja y la pone en la nueva', async () => {
  const client = makeFakeClient({ estado: { T1: { C_BENEF: [], C_VIEJA: [EF], C_NUEVA: [] } } });
  const r = await syncTicketCompanyLabels(base(client, {
    ticketIds: ['T1'],
    getDealCompaniesFn: () => ({
      ids: ['C_BENEF', 'C_VIEJA', 'C_NUEVA'], facturaId: 'C_NUEVA', partnerId: null,
    }),
  }));

  assert.equal(r.labelsAgregados, 1);
  assert.equal(r.labelsQuitados, 1);
  assert.deepEqual(client.archived, [{ ticketId: 'T1', companyId: 'C_VIEJA', typeId: EF }]);
  assert.equal(client.creates.length, 1);
  assert.equal(client.creates[0].companyId, 'C_NUEVA');
});

test('empresa del negocio que el ticket no tiene → se asocia (sin etiqueta si no le toca)', async () => {
  const client = makeFakeClient({ estado: { T1: { C_BENEF: [] } } });
  const r = await syncTicketCompanyLabels(base(client, {
    ticketIds: ['T1'],
    getDealCompaniesFn: () => ({
      ids: ['C_BENEF', 'C_FACT', 'C_PART'], facturaId: 'C_FACT', partnerId: 'C_PART',
    }),
  }));

  assert.equal(r.companiesAsociadas, 2);          // C_FACT y C_PART
  assert.equal(r.labelsAgregados, 2);             // una etiqueta cada una
  const sinLabel = client.creates.filter(c => c.specs.length === 0).map(c => c.companyId).sort();
  assert.deepEqual(sinLabel, ['C_FACT', 'C_PART']);
});

test('espejo: la MISMA empresa lleva Empresa Factura y Partner en una sola llamada', async () => {
  // dealMirroring etiqueta a Interfase UY con las dos a la vez.
  const client = makeFakeClient({ estado: { T1: { C_INTERFASE: [] } } });
  const r = await syncTicketCompanyLabels(base(client, {
    ticketIds: ['T1'],
    getDealCompaniesFn: () => ({
      ids: ['C_INTERFASE'], facturaId: 'C_INTERFASE', partnerId: 'C_INTERFASE',
    }),
  }));

  assert.equal(r.labelsAgregados, 2);
  assert.equal(client.creates.length, 1);
  assert.deepEqual(client.creates[0].specs.map(s => s.associationTypeId).sort((a, b) => a - b), [PARTNER, EF]);
});

test('idempotente: ya está todo bien → cero escrituras', async () => {
  const client = makeFakeClient({
    estado: { T1: { C_BENEF: [], C_FACT: [EF], C_PART: [PARTNER] } },
  });
  const r = await syncTicketCompanyLabels(base(client, {
    ticketIds: ['T1'],
    getDealCompaniesFn: () => ({
      ids: ['C_BENEF', 'C_FACT', 'C_PART'], facturaId: 'C_FACT', partnerId: 'C_PART',
    }),
  }));

  assert.equal(r.labelsAgregados, 0);
  assert.equal(r.labelsQuitados, 0);
  assert.equal(r.companiesAsociadas, 0);
  assert.equal(client.creates.length, 0);
  assert.equal(client.archived.length, 0);
});

test('empresa que salió del negocio: pierde la etiqueta pero NO se desasocia', async () => {
  // El fake tira si se llama a basicApi.archive → el test falla si se desasocia.
  const client = makeFakeClient({ estado: { T1: { C_BENEF: [], C_EX: [PARTNER] } } });
  const r = await syncTicketCompanyLabels(base(client, {
    ticketIds: ['T1'],
    getDealCompaniesFn: () => ({ ids: ['C_BENEF'], facturaId: null, partnerId: null }),
  }));

  assert.equal(r.labelsQuitados, 1);
  assert.deepEqual(client.archived, [{ ticketId: 'T1', companyId: 'C_EX', typeId: PARTNER }]);
  assert.ok(client.estado.get('T1').has('C_EX'), 'la asociación sin etiqueta debe sobrevivir');
});

test('no toca etiquetas ajenas (typeIds que el motor no gestiona)', async () => {
  const AJENA = 99;
  const client = makeFakeClient({ estado: { T1: { C_BENEF: [AJENA] } } });
  const r = await syncTicketCompanyLabels(base(client, {
    ticketIds: ['T1'],
    getDealCompaniesFn: () => ({ ids: ['C_BENEF'], facturaId: null, partnerId: null }),
  }));

  assert.equal(r.labelsQuitados, 0);
  assert.equal(client.archived.length, 0);
});

test('sin ticketIds: los busca por asociación al negocio', async () => {
  const client = makeFakeClient({
    estado: { T1: { C_FACT: [] }, T2: { C_FACT: [EF] } },
    ticketsDelDeal: ['T1', 'T2'],
  });
  const r = await syncTicketCompanyLabels(base(client, {
    getDealCompaniesFn: () => ({ ids: ['C_FACT'], facturaId: 'C_FACT', partnerId: null }),
  }));

  assert.equal(r.ticketsRevisados, 2);
  assert.equal(r.labelsAgregados, 1);             // sólo T1 necesitaba
  assert.deepEqual(client.creates.map(c => c.ticketId), ['T1']);
});

test('negocio sin empresas → skip (no borra nada del ticket)', async () => {
  const client = makeFakeClient({ estado: { T1: { C_FACT: [EF] } } });
  const r = await syncTicketCompanyLabels(base(client, {
    ticketIds: ['T1'],
    getDealCompaniesFn: () => ({ ids: [], facturaId: null, partnerId: null }),
  }));

  assert.equal(r.skipped, true);
  assert.equal(r.reason, 'sin_empresas_del_deal');
  assert.equal(client.archived.length, 0);
});

test('dryRun: calcula y no escribe', async () => {
  const client = makeFakeClient({ estado: { T1: { C_BENEF: [], C_VIEJA: [EF] } } });
  const r = await syncTicketCompanyLabels(base(client, {
    dryRun: true,
    ticketIds: ['T1'],
    getDealCompaniesFn: () => ({
      ids: ['C_BENEF', 'C_VIEJA', 'C_FACT'], facturaId: 'C_FACT', partnerId: null,
    }),
  }));

  assert.equal(r.companiesAsociadas, 1);
  assert.equal(r.labelsAgregados, 1);
  assert.equal(r.labelsQuitados, 1);
  assert.equal(client.creates.length, 0);
  assert.equal(client.archived.length, 0);
});

test('un ticket que falla no frena a los demás', async () => {
  const client = makeFakeClient({ estado: { T1: { C_FACT: [] }, T2: { C_FACT: [] } } });
  const original = client.crm.associations.v4.basicApi.create;
  client.crm.associations.v4.basicApi.create = async (ft, fid, tt, tid, specs) => {
    if (String(fid) === 'T1') throw new Error('boom');
    return original(ft, fid, tt, tid, specs);
  };

  const r = await syncTicketCompanyLabels(base(client, {
    ticketIds: ['T1', 'T2'],
    getDealCompaniesFn: () => ({ ids: ['C_FACT'], facturaId: 'C_FACT', partnerId: null }),
  }));

  assert.equal(r.errors, 1);
  assert.equal(r.labelsAgregados, 1);             // T2 sí se etiquetó
  assert.deepEqual(client.creates.map(c => c.ticketId), ['T2']);
});
