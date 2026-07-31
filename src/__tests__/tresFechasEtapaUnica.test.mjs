// src/__tests__/tresFechasEtapaUnica.test.mjs
//
// TANDA C — LAS TRES FECHAS Y LOS CONTADORES
// (definitivos/PLAN_proximos_cambios_tickets_2026-07-29.md §2.5).
//
// Las cuatro fechas derivadas de etapas pasan a ser tres, alineadas con la
// frontera de la notificación:
//
//   PRÓXIMA    billing_next_date        = la próxima fecha NO NOTIFICADA
//   NOTIFICADO last_billing_period      = la última que cruzó la frontera
//   CONFIRMADO billing_last_billed_date = la última fecha REAL de Nodum
//   last_ticketed_date                  → SE ELIMINA (no se escribe más)
//   pagos_restantes                     = total − consumidos (derivado)
//
// Acá se prueban los TRES BLOQUEANTES que anotó la tanda B en
// src/config/etapaUnicaFlags.js y que son los que frenaban prender la llave:
//
//   1. promotedCount incluía «Próximos» ⇒ I3 daba el plan por completo y vaciaba
//      billing_next_date sin haber facturado nada.
//   2. billing_next_date salía sólo de etapas forecast ⇒ con la etapa única se
//      congelaba.
//   3. pagos_restantes dejaba de descontarse (la promoción de Phase 2 ya no
//      ocurre) ⇒ el número quedaba clavado en el total.
//
// Criterio de aceptación de la tanda: con ETAPA_UNICA_ENABLED apagada, TODO se
// comporta exactamente como hoy. Cada bloque tiene su par OFF/ON.
//
// Correr con: node --test src/__tests__/tresFechasEtapaUnica.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@127.0.0.1:1/dummy';

// constants.js lee process.env a nivel de módulo → se fuerza ANTES de importar.
process.env.BILLING_TICKET_PIPELINE_ID = 'PIPE_MANUAL';
process.env.BILLING_AUTOMATED_PIPELINE_ID = 'PIPE_AUTO';
process.env.BILLING_TICKET_FORECAST = 'F25';
process.env.BILLING_TICKET_FORECAST_50 = 'F50';
process.env.BILLING_TICKET_FORECAST_75 = 'F75';
process.env.BILLING_TICKET_FORECAST_85 = 'F85';       // PROD: «Backlog cierre ganado»
process.env.BILLING_TICKET_FORECAST_95 = 'F95';       // PROD: «Backlog avanzado»
process.env.BILLING_TICKET_STAGE_ID = 'PROXIMOS';
process.env.BILLING_TICKET_STAGE_READY = 'NOTIFICADO';
process.env.BILLING_TICKET_STAGE_ID_BILLED = 'EMITIDO';
process.env.BILLING_TICKET_STAGE_ID_LATE = 'ATRASADO';
process.env.BILLING_TICKET_PIPELINE_ID_PAID = 'COBRADO';
process.env.BILLING_TICKET_STAGE_CANCELLED = 'CANCELADO';
process.env.BILLING_AUTOMATED_FORECAST = 'AF25';
process.env.BILLING_AUTOMATED_FORECAST_95 = 'AF95';
process.env.BILLING_AUTOMATED_READY = 'AUTO_NOTIFICADO';
process.env.BILLING_AUTOMATED_CANCELLED = 'AUTO_CANCELADO';

// Sin correos reales en los tests: la alerta de pagos completos es fire-and-forget
// y `alertasApagadas` corta antes de tocar red.
process.env.DEAL_ALERTS_ENABLED = 'false';

const {
  fechaUltimaNotificada,
  fechaProximaNoNotificada,
  contarConsumidos,
  fechaNotificadaDelLineItem,
} = await import('../utils/ticketFrontera.js');

const { resolveFloorSourceYmd } = await import('../phases/phasep.js');
const { recalcFromTickets } = await import('../services/lineItems/recalcFromTickets.js');

const OFF = () => { delete process.env.ETAPA_UNICA_ENABLED; };
const ON = () => { process.env.ETAPA_UNICA_ENABLED = 'true'; };

const HOY = '2026-07-31';

function ticket(stage, fecha, extra = {}) {
  return {
    id: extra.id || `T-${stage}-${fecha}`,
    properties: {
      hs_pipeline: extra.pipeline || 'PIPE_MANUAL',
      hs_pipeline_stage: stage,
      fecha_resolucion_esperada: fecha,
      of_ticket_key: extra.key ?? `D1::LIK:L1::${fecha}`,
      ...extra.props,
    },
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// 1) NOTIFICADO — la última fecha que cruzó la frontera
// ═════════════════════════════════════════════════════════════════════════════

test('NOTIFICADO: «Próximos» y forecast NO cuentan; notificado y emitido sí', () => {
  ON();
  const tickets = [
    ticket('EMITIDO', '2026-03-31'),
    ticket('NOTIFICADO', '2026-04-30'),
    ticket('PROXIMOS', '2026-05-31'),   // no notificado: NO puede levantar el piso
    ticket('F85', '2026-06-30'),
  ];
  assert.equal(fechaUltimaNotificada(tickets), '2026-04-30');
  OFF();
});

test('NOTIFICADO: el CANCELADO con factura (período cerrado) SÍ cuenta; sin factura NO', () => {
  ON();
  const conFactura = [
    ticket('NOTIFICADO', '2026-04-30'),
    ticket('CANCELADO', '2026-05-31', { props: { of_invoice_id: '9988' } }),
  ];
  assert.equal(fechaUltimaNotificada(conFactura), '2026-05-31');

  const sinFactura = [
    ticket('NOTIFICADO', '2026-04-30'),
    ticket('CANCELADO', '2026-05-31'),   // lo canceló el motor: esa fecha se puede rearmar
  ];
  assert.equal(fechaUltimaNotificada(sinFactura), '2026-04-30');
  OFF();
});

test('NOTIFICADO: el pipeline automático cruza en «Listo para facturar»', () => {
  ON();
  const tickets = [
    ticket('AUTO_NOTIFICADO', '2026-06-30', { pipeline: 'PIPE_AUTO' }),
    ticket('AF25', '2026-07-31', { pipeline: 'PIPE_AUTO' }),
  ];
  assert.equal(fechaUltimaNotificada(tickets), '2026-06-30');
  OFF();
});

test('NOTIFICADO: sin nada notificado devuelve vacío (no inventa piso)', () => {
  ON();
  assert.equal(fechaUltimaNotificada([ticket('PROXIMOS', '2026-05-31')]), '');
  assert.equal(fechaUltimaNotificada([]), '');
  OFF();
});

// ═════════════════════════════════════════════════════════════════════════════
// 2) PRÓXIMA — la próxima fecha no notificada
// ═════════════════════════════════════════════════════════════════════════════

test('PRÓXIMA (flag ON): «Próximos a facturar» ES candidato — el bloqueante #2', () => {
  ON();
  const tickets = [
    ticket('NOTIFICADO', '2026-06-30'),
    ticket('PROXIMOS', '2026-08-31'),
    ticket('PROXIMOS', '2026-09-30'),
  ];
  assert.equal(fechaProximaNoNotificada(tickets, HOY), '2026-08-31');
  OFF();
});

test('PRÓXIMA: sólo fechas estrictamente futuras (la ventana no cambia)', () => {
  ON();
  const tickets = [
    ticket('PROXIMOS', '2026-06-30'),   // vencido
    ticket('PROXIMOS', HOY),            // hoy: tampoco
    ticket('PROXIMOS', '2026-08-31'),
  ];
  assert.equal(fechaProximaNoNotificada(tickets, HOY), '2026-08-31');
  OFF();
});

test('PRÓXIMA: lo que cruzó la frontera nunca es candidato', () => {
  ON();
  const tickets = [
    ticket('NOTIFICADO', '2026-08-31'),
    ticket('EMITIDO', '2026-09-30'),
    ticket('PROXIMOS', '2026-10-31'),
  ];
  assert.equal(fechaProximaNoNotificada(tickets, HOY), '2026-10-31');
  OFF();
});

// ═════════════════════════════════════════════════════════════════════════════
// 3) CONSUMIDOS — el punto de descuento es el paso a «Notificado»
// ═════════════════════════════════════════════════════════════════════════════

test('CONSUMIDOS: cuenta lo notificado y los períodos cerrados, no «Próximos»', () => {
  ON();
  const tickets = [
    ticket('EMITIDO', '2026-03-31'),
    ticket('NOTIFICADO', '2026-04-30'),
    ticket('CANCELADO', '2026-05-31', { props: { of_invoice_id: '77' } }), // período cerrado
    ticket('CANCELADO', '2026-06-30'),                                     // lo canceló el motor
    ticket('PROXIMOS', '2026-07-31'),
    ticket('F85', '2026-08-31'),
  ];
  assert.equal(contarConsumidos(tickets), 3);
  OFF();
});

test('CONSUMIDOS: un ticket sin of_ticket_key no es una cuota del cronograma', () => {
  ON();
  const tickets = [
    ticket('NOTIFICADO', '2026-04-30'),
    ticket('NOTIFICADO', '2026-05-31', { key: '' }),
  ];
  assert.equal(contarConsumidos(tickets), 1);
  OFF();
});

// ═════════════════════════════════════════════════════════════════════════════
// 4) El accesor que reemplaza a last_ticketed_date
// ═════════════════════════════════════════════════════════════════════════════

test('flag OFF: fechaNotificadaDelLineItem devuelve last_ticketed_date, como hoy', () => {
  OFF();
  const props = { last_ticketed_date: '2026-06-30', last_billing_period: '2026-04-30' };
  assert.equal(fechaNotificadaDelLineItem(props), '2026-06-30');
});

test('flag ON: devuelve last_billing_period y NO cae de vuelta en el valor viejo', () => {
  ON();
  // El caso peligroso: la línea todavía arrastra el last_ticketed_date de antes
  // (contaminado con «Próximos»). Si hubiera fallback, ganaría para siempre y
  // volvería a levantar el piso por encima de un ticket no notificado.
  assert.equal(
    fechaNotificadaDelLineItem({ last_ticketed_date: '2026-06-30', last_billing_period: '' }),
    ''
  );
  assert.equal(
    fechaNotificadaDelLineItem({ last_ticketed_date: '2026-06-30', last_billing_period: '2026-04-30' }),
    '2026-04-30'
  );
  OFF();
});

test('el accesor tolera epoch/ISO y props ausentes', () => {
  OFF();
  assert.equal(fechaNotificadaDelLineItem({}), '');
  assert.equal(fechaNotificadaDelLineItem({ last_ticketed_date: '2026-06-30T00:00:00Z' }), '2026-06-30');
});

// ═════════════════════════════════════════════════════════════════════════════
// 5) El piso del cronograma y la fecha NOTIFICADO son EL MISMO número
// ═════════════════════════════════════════════════════════════════════════════

test('flag ON: resolveFloorSourceYmd == fechaUltimaNotificada sobre los mismos tickets', () => {
  ON();
  const tickets = [
    ticket('EMITIDO', '2026-03-31'),
    ticket('NOTIFICADO', '2026-04-30'),
    ticket('PROXIMOS', '2026-05-31'),
  ];
  const props = { last_ticketed_date: '2026-05-31', last_billing_period: '2026-04-30' };
  assert.equal(resolveFloorSourceYmd(props, tickets), fechaUltimaNotificada(tickets));
  assert.equal(resolveFloorSourceYmd(props, tickets), '2026-04-30');
  OFF();
});

test('flag ON: con la búsqueda vacía la red de seguridad prefiere last_billing_period', () => {
  ON();
  assert.equal(
    resolveFloorSourceYmd({ last_ticketed_date: '2026-05-31', last_billing_period: '2026-04-30' }, []),
    '2026-04-30'
  );
  // Y si NOTIFICADO todavía no existe, se usa el histórico antes que quedarse sin
  // piso: con la lista vacía no hay ticket vivo que proteger y un piso de menos
  // regenera el cronograma desde el arranque del contrato.
  assert.equal(
    resolveFloorSourceYmd({ last_ticketed_date: '2026-05-31', last_billing_period: '' }, []),
    '2026-05-31'
  );
  OFF();
});

// ═════════════════════════════════════════════════════════════════════════════
// 6) recalcFromTickets — el camino real, con cliente inyectado
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Cliente falso: devuelve `manual`/`auto` según el pipeline del search y
 * registra el PATCH del line item.
 */
function makeClient({ manual = [], auto = [], liProps = {} } = {}) {
  const updates = [];
  return {
    updates,
    crm: {
      tickets: {
        searchApi: {
          doSearch: async (body) => {
            const pipe = body.filterGroups[0].filters
              .find(f => f.propertyName === 'hs_pipeline')?.value;
            const results = pipe === 'PIPE_MANUAL' ? manual : auto;
            return { results, paging: null };
          },
        },
        basicApi: { update: async () => ({}) },
      },
      deals: { basicApi: { getById: async () => ({ properties: {} }) } },
      lineItems: {
        basicApi: {
          getById: async () => ({ properties: liProps }),
          update: async (id, body) => { updates.push({ id, properties: body.properties }); return {}; },
        },
      },
    },
  };
}

/** Ticket con la forma que devuelve el Search API. */
function raw(stage, fecha, extra = {}) {
  return {
    id: extra.id || `T-${stage}-${fecha}`,
    properties: {
      hs_pipeline_stage: stage,
      fecha_resolucion_esperada: fecha,
      of_ticket_key: extra.key ?? `D1::LIK:L1::${fecha}`,
      ...extra.props,
    },
  };
}

/** Plan fijo de 12 cuotas: 2 emitidas, 1 notificada, 9 esperando en «Próximos». */
function plan12() {
  return [
    raw('EMITIDO', '2026-01-31'),
    raw('EMITIDO', '2026-02-28'),
    raw('NOTIFICADO', '2026-03-31'),
    raw('PROXIMOS', '2026-04-30'),
    raw('PROXIMOS', '2026-05-31'),
    raw('PROXIMOS', '2026-06-30'),
    raw('PROXIMOS', '2026-07-31'),
    raw('PROXIMOS', '2026-08-31'),
    raw('PROXIMOS', '2026-09-30'),
    raw('PROXIMOS', '2026-10-31'),
    raw('PROXIMOS', '2026-11-30'),
    raw('PROXIMOS', '2026-12-31'),
  ];
}

const LI_PROPS_12 = { hs_recurring_billing_number_of_payments: '12' };

test('BLOQUEANTE #1 (flag OFF): un plan ganado y sin facturar YA parece completo', async () => {
  OFF();
  const client = makeClient({ manual: plan12(), liProps: { billing_next_date: '2026-08-31' } });

  const r = await recalcFromTickets({
    lineItemKey: 'L1', dealId: 'D1', lineItemId: 'LI1', overrideToday: HOY,
    lineItemProps: LI_PROPS_12, client,
  });

  // Éste es el bug que documentó la tanda B: 12 tickets en PROMOTED_STAGES
  // («Próximos» incluida) ⇒ I3 lo toma por completo.
  assert.equal(r.promotedCount, 12);
  assert.equal(r.consumidos, 12);
  assert.equal(r.billingNextDate, '');
  assert.equal(r.updates.billing_next_date, '');
});

test('BLOQUEANTE #1 (flag ON): consumido es lo notificado ⇒ el plan NO está completo', async () => {
  ON();
  const client = makeClient({ manual: plan12(), liProps: { billing_next_date: '2026-04-30' } });

  const r = await recalcFromTickets({
    lineItemKey: 'L1', dealId: 'D1', lineItemId: 'LI1', overrideToday: HOY,
    lineItemProps: LI_PROPS_12, client,
  });

  // 2 emitidas + 1 notificada = 3 consumidas de 12. Los 9 de «Próximos» son futuro.
  assert.equal(r.consumidos, 3);
  assert.notEqual(r.billingNextDate, '');
  OFF();
});

test('BLOQUEANTE #2 (flag ON): billing_next_date avanza — sale de «Próximos», no de forecast', async () => {
  ON();
  const client = makeClient({ manual: plan12(), liProps: { billing_next_date: '2026-04-30' } });

  const r = await recalcFromTickets({
    lineItemKey: 'L1', dealId: 'D1', lineItemId: 'LI1', overrideToday: HOY,
    lineItemProps: LI_PROPS_12, client,
  });

  // La primera fecha no notificada y futura respecto de 2026-07-31.
  assert.equal(r.billingNextDate, '2026-08-31');
  assert.equal(r.updates.billing_next_date, '2026-08-31');
  OFF();
});

test('NOTIFICADO se escribe en last_billing_period y last_ticketed_date NO se escribe', async () => {
  ON();
  const client = makeClient({
    manual: plan12(),
    liProps: { last_ticketed_date: '2026-12-31', last_billing_period: '' },
  });

  const r = await recalcFromTickets({
    lineItemKey: 'L1', dealId: 'D1', lineItemId: 'LI1', overrideToday: HOY,
    lineItemProps: LI_PROPS_12, client,
  });

  assert.equal(r.lastBillingPeriod, '2026-03-31');
  assert.equal(r.updates.last_billing_period, '2026-03-31');
  // La propiedad eliminada no se toca ni para vaciarla.
  assert.equal('last_ticketed_date' in r.updates, false);
  assert.equal(r.lastTicketedDate, '');
  OFF();
});

test('flag OFF: last_ticketed_date se sigue escribiendo, igual que hoy', async () => {
  OFF();
  const client = makeClient({ manual: plan12(), liProps: { last_ticketed_date: '' } });

  const r = await recalcFromTickets({
    lineItemKey: 'L1', dealId: 'D1', lineItemId: 'LI1', overrideToday: HOY,
    lineItemProps: LI_PROPS_12, client,
  });

  assert.equal(r.lastTicketedDate, '2026-12-31'); // el máximo de PROMOTED, «Próximos» incluida
  assert.equal(r.updates.last_ticketed_date, '2026-12-31');
});

test('BLOQUEANTE #3 (flag ON): pagos_restantes se deriva = total − consumidos', async () => {
  ON();
  const client = makeClient({
    manual: plan12(),
    liProps: { pagos_restantes: '12', hs_recurring_billing_number_of_payments: '12' },
  });

  const r = await recalcFromTickets({
    lineItemKey: 'L1', dealId: 'D1', lineItemId: 'LI1', overrideToday: HOY,
    lineItemProps: LI_PROPS_12, client,
  });

  assert.equal(r.pagosRestantes, 9);          // 12 − 3 consumidas
  assert.equal(r.updates.pagos_restantes, '9');
  OFF();
});

test('flag OFF: pagos_restantes NO se toca acá (lo maneja syncAfterPromotion)', async () => {
  OFF();
  const client = makeClient({ manual: plan12(), liProps: { pagos_restantes: '12' } });

  const r = await recalcFromTickets({
    lineItemKey: 'L1', dealId: 'D1', lineItemId: 'LI1', overrideToday: HOY,
    lineItemProps: LI_PROPS_12, client,
  });

  assert.equal(r.pagosRestantes, null);
  assert.equal('pagos_restantes' in r.updates, false);
});

test('flag ON: el total se lee del line item aunque el call site no pase lineItemProps', async () => {
  ON();
  // phase2/phase3 llaman sin `lineItemProps`; sin esto el contador no se derivaría.
  const client = makeClient({
    manual: plan12(),
    liProps: { hs_recurring_billing_number_of_payments: '12', pagos_restantes: '12' },
  });

  const r = await recalcFromTickets({
    lineItemKey: 'L1', dealId: 'D1', lineItemId: 'LI1', overrideToday: HOY, client,
  });

  assert.equal(r.pagosRestantes, 9);
  OFF();
});

test('flag ON: auto-renew (sin total) no inventa pagos_restantes', async () => {
  ON();
  const client = makeClient({ manual: plan12(), liProps: {} });

  const r = await recalcFromTickets({
    lineItemKey: 'L1', dealId: 'D1', lineItemId: 'LI1', overrideToday: HOY,
    lineItemProps: { renovacion_automatica: 'true' }, client,
  });

  assert.equal(r.pagosRestantes, null);
  assert.equal('pagos_restantes' in r.updates, false);
  OFF();
});

test('flag ON: plan agotado ⇒ pagos_restantes 0 y billing_next_date vacía', async () => {
  ON();
  const manual = [
    raw('EMITIDO', '2026-01-31'),
    raw('EMITIDO', '2026-02-28'),
    raw('NOTIFICADO', '2026-03-31'),
  ];
  const client = makeClient({
    manual,
    liProps: { pagos_restantes: '1', billing_next_date: '2026-04-30' },
  });

  const r = await recalcFromTickets({
    lineItemKey: 'L1', dealId: 'D1', lineItemId: 'LI1', overrideToday: HOY,
    lineItemProps: { hs_recurring_billing_number_of_payments: '3' }, client,
  });

  assert.equal(r.consumidos, 3);
  assert.equal(r.pagosRestantes, 0);
  assert.equal(r.updates.pagos_restantes, '0');
  assert.equal(r.updates.billing_next_date, '');
  OFF();
});

test('flag ON: el período cerrado (cancelado CON factura) consume cuota y no se refactura', async () => {
  ON();
  const manual = [
    raw('EMITIDO', '2026-01-31'),
    raw('CANCELADO', '2026-02-28', { props: { of_invoice_id: '4455' } }), // cancelación definitiva
    raw('PROXIMOS', '2026-08-31'),
  ];
  const client = makeClient({ manual, liProps: {} });

  const r = await recalcFromTickets({
    lineItemKey: 'L1', dealId: 'D1', lineItemId: 'LI1', overrideToday: HOY,
    lineItemProps: { hs_recurring_billing_number_of_payments: '3' }, client,
  });

  assert.equal(r.consumidos, 2);              // el cancelado con factura gastó su cuota
  assert.equal(r.lastBillingPeriod, '2026-02-28');
  assert.equal(r.pagosRestantes, 1);
  OFF();
});

test('flag ON: el cancelado SIN factura no consume ni fija el piso', async () => {
  ON();
  const manual = [
    raw('EMITIDO', '2026-01-31'),
    raw('CANCELADO', '2026-02-28'),           // lo canceló el motor
    raw('PROXIMOS', '2026-08-31'),
  ];
  const client = makeClient({ manual, liProps: {} });

  const r = await recalcFromTickets({
    lineItemKey: 'L1', dealId: 'D1', lineItemId: 'LI1', overrideToday: HOY,
    lineItemProps: { hs_recurring_billing_number_of_payments: '3' }, client,
  });

  assert.equal(r.consumidos, 1);
  assert.equal(r.lastBillingPeriod, '2026-01-31');
  assert.equal(r.pagosRestantes, 2);
  OFF();
});

test('flag OFF: los CANCELADO se siguen descartando enteros', async () => {
  OFF();
  const manual = [
    raw('EMITIDO', '2026-01-31'),
    raw('CANCELADO', '2026-02-28', { props: { of_invoice_id: '4455' } }),
  ];
  const client = makeClient({ manual, liProps: {} });

  const r = await recalcFromTickets({
    lineItemKey: 'L1', dealId: 'D1', lineItemId: 'LI1', overrideToday: HOY,
    lineItemProps: { hs_recurring_billing_number_of_payments: '3' }, client,
  });

  assert.equal(r.promotedCount, 1);
  assert.equal(r.lastBillingPeriod, '2026-01-31');
});

test('I2 (flag ON): la PRÓXIMA nunca queda por detrás de lo ya NOTIFICADO', async () => {
  ON();
  // Un «Próximos» quedó con fecha anterior a la última notificada (rearmado a mano).
  const manual = [
    raw('NOTIFICADO', '2026-09-30'),
    raw('PROXIMOS', '2026-08-31'),
    raw('PROXIMOS', '2026-10-31'),
  ];
  const client = makeClient({ manual, liProps: {} });

  const r = await recalcFromTickets({
    lineItemKey: 'L1', dealId: 'D1', lineItemId: 'LI1', overrideToday: HOY,
    lineItemProps: { hs_recurring_billing_number_of_payments: '12' }, client,
  });

  assert.equal(r.lastBillingPeriod, '2026-09-30');
  assert.equal(r.billingNextDate, '2026-10-31');
  OFF();
});

test('I4 (flag ON): sin candidatos no se vacía la próxima fecha existente', async () => {
  ON();
  // Todo notificado pero el plan es de 12: no se puede confirmar que esté completo.
  const manual = [raw('NOTIFICADO', '2026-03-31')];
  const client = makeClient({ manual, liProps: { billing_next_date: '2026-04-30' } });

  const r = await recalcFromTickets({
    lineItemKey: 'L1', dealId: 'D1', lineItemId: 'LI1', overrideToday: HOY,
    lineItemProps: { hs_recurring_billing_number_of_payments: '12' }, client,
  });

  assert.equal('billing_next_date' in r.updates, false);
  OFF();
});

test('flag ON: el pipeline automático conserva su comportamiento (NOTIFICADO == lo de hoy)', async () => {
  ON();
  // Para una línea 100% automática, la fecha NOTIFICADO coincide con lo que hoy
  // daba last_ticketed_date: PROMOTED y la frontera sólo difieren en «Próximos
  // a facturar», que es una etapa MANUAL.
  const auto = [
    raw('AUTO_NOTIFICADO', '2026-05-31'),
    raw('AF25', '2026-08-31'),
  ];
  const client = makeClient({ auto, liProps: {} });

  const r = await recalcFromTickets({
    lineItemKey: 'L1', dealId: 'D1', lineItemId: 'LI1', overrideToday: HOY,
    lineItemProps: { hs_recurring_billing_number_of_payments: '12' }, client,
  });

  assert.equal(r.lastBillingPeriod, '2026-05-31');
  assert.equal(r.billingNextDate, '2026-08-31');
  assert.equal(r.consumidos, 1);
  OFF();
});
