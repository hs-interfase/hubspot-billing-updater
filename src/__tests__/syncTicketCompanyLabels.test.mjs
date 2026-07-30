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
const SIN_ETIQUETA = 339;  // HUBSPOT_DEFINED ticket→company
const PRIMARY = 26;        // HUBSPOT_DEFINED "Primary" ticket→company

// ─────────────────────────────────────────────────────────────
// Fake client: asociaciones ticket→company con typeId Y CATEGORÍA.
//   estado: Map(ticketId, Map(companyId → Map(typeId → category)))
//
// ⚠️ Modela el comportamiento REAL del endpoint: el create con specs es un PUT que
// REEMPLAZA los tipos del par (verificado contra el sandbox el 29-jul: marcar
// Primary y luego aplicar una etiqueta dejaba el par sin Primary). Con un fake que
// sólo sumara tipos, ese bug pasaría desapercibido.
// En la notación de `estado`, un número suelto es USER_DEFINED; para HUBSPOT_DEFINED
// se escribe [typeId, 'HUBSPOT_DEFINED'].
// ─────────────────────────────────────────────────────────────
function makeFakeClient({ estado = {}, ticketsDelDeal = [] } = {}) {
  const asoc = new Map();
  for (const [tid, comps] of Object.entries(estado)) {
    const m = new Map();
    for (const [cid, tipos] of Object.entries(comps)) {
      const tm = new Map();
      // Toda asociación real trae el tipo "sin etiqueta".
      tm.set(SIN_ETIQUETA, 'HUBSPOT_DEFINED');
      for (const t of tipos) {
        if (Array.isArray(t)) tm.set(Number(t[0]), t[1]);
        else tm.set(Number(t), 'USER_DEFINED');
      }
      m.set(String(cid), tm);
    }
    asoc.set(String(tid), m);
  }

  const creates = [];
  const archived = [];

  return {
    creates,
    archived,
    estado: asoc,
    tipos: (tid, cid) => asoc.get(String(tid))?.get(String(cid)),
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
                  associationTypes: [...tipos.entries()].map(([typeId, category]) => ({ typeId, category })),
                })),
              };
            },
            async create(fromType, fromId, toType, toId, specs) {
              creates.push({ ticketId: String(fromId), companyId: String(toId), specs: specs || [] });
              if (!asoc.has(String(fromId))) asoc.set(String(fromId), new Map());
              const m = asoc.get(String(fromId));
              if (!(specs || []).length) {
                // create con [] = asociación default (no borra nada)
                if (!m.has(String(toId))) m.set(String(toId), new Map([[SIN_ETIQUETA, 'HUBSPOT_DEFINED']]));
                return;
              }
              // PUT con specs: REEMPLAZA el set de tipos del par (HubSpot repone el
              // "sin etiqueta" solo).
              const tm = new Map([[SIN_ETIQUETA, 'HUBSPOT_DEFINED']]);
              for (const s of specs) tm.set(Number(s.associationTypeId), s.associationCategory);
              m.set(String(toId), tm);
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
  assert.equal(client.creates.length, 1);
  assert.equal(client.creates[0].companyId, 'C_FACT');
  // Los specs llevan la etiqueta nueva y re-mandan lo que el par ya tenía (el PUT
  // reemplaza, ver specsPreservando).
  assert.deepEqual(client.creates[0].specs, [
    { associationCategory: 'HUBSPOT_DEFINED', associationTypeId: SIN_ETIQUETA },
    { associationCategory: 'USER_DEFINED', associationTypeId: EF },
  ]);
  assert.equal(client.tipos('T1', 'C_FACT').get(EF), 'USER_DEFINED');
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
  assert.equal(client.creates.length, 1, 'las dos etiquetas van en una sola llamada');
  const userDefined = client.creates[0].specs
    .filter(s => s.associationCategory === 'USER_DEFINED')
    .map(s => s.associationTypeId).sort((a, b) => a - b);
  assert.deepEqual(userDefined, [PARTNER, EF]);
  const tipos = client.tipos('T1', 'C_INTERFASE');
  assert.equal(tipos.get(EF), 'USER_DEFINED');
  assert.equal(tipos.get(PARTNER), 'USER_DEFINED');
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

// ─── No destruir nada al escribir (bug encontrado en sandbox el 29-jul) ───────

test('aplicar una etiqueta NO borra el Primary del par', async () => {
  // El PUT de etiquetas reemplaza los tipos del par: sin preservarlos, el Primary
  // (HUBSPOT_DEFINED 26) desaparecía en silencio.
  const client = makeFakeClient({ estado: { T1: { C_FACT: [[PRIMARY, 'HUBSPOT_DEFINED']] } } });
  const r = await syncTicketCompanyLabels(base(client, {
    ticketIds: ['T1'],
    getDealCompaniesFn: () => ({ ids: ['C_FACT'], facturaId: 'C_FACT', partnerId: null }),
  }));

  assert.equal(r.labelsAgregados, 1);
  const tipos = client.tipos('T1', 'C_FACT');
  assert.equal(tipos.get(PRIMARY), 'HUBSPOT_DEFINED', 'el Primary debe sobrevivir');
  assert.equal(tipos.get(EF), 'USER_DEFINED');
  assert.equal(tipos.get(SIN_ETIQUETA), 'HUBSPOT_DEFINED');
  // Y el spec enviado lo incluye explícitamente
  assert.ok(client.creates[0].specs.some(s => s.associationTypeId === PRIMARY && s.associationCategory === 'HUBSPOT_DEFINED'));
});

test('aplicar una etiqueta NO borra una etiqueta ajena del mismo par', async () => {
  const AJENA = 99;
  const client = makeFakeClient({ estado: { T1: { C_FACT: [AJENA] } } });
  const r = await syncTicketCompanyLabels(base(client, {
    ticketIds: ['T1'],
    getDealCompaniesFn: () => ({ ids: ['C_FACT'], facturaId: 'C_FACT', partnerId: null }),
  }));

  assert.equal(r.labelsAgregados, 1);
  const tipos = client.tipos('T1', 'C_FACT');
  assert.equal(tipos.get(AJENA), 'USER_DEFINED', 'la etiqueta ajena debe sobrevivir');
  assert.equal(tipos.get(EF), 'USER_DEFINED');
});

test('un par con etiqueta sobrante Y faltante queda correcto sin doble escritura', async () => {
  // C tiene EF (que ya no corresponde) y le falta Partner: el PUT deja el estado
  // final de una vez y el paso de archivado no vuelve a tocar lo mismo.
  const client = makeFakeClient({ estado: { T1: { C: [EF] } } });
  const r = await syncTicketCompanyLabels(base(client, {
    ticketIds: ['T1'],
    getDealCompaniesFn: () => ({ ids: ['C'], facturaId: null, partnerId: 'C' }),
  }));

  const tipos = client.tipos('T1', 'C');
  assert.equal(tipos.has(EF), false, 'EF ya no corresponde');
  assert.equal(tipos.get(PARTNER), 'USER_DEFINED');
  assert.equal(r.labelsAgregados, 1);
  assert.equal(client.archived.length, 0, 'el PUT ya lo dejó bien: no hace falta archivar');
});
